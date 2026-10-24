import { roundToDecimals } from '../../../utm-geometry.ts';
import { valleyEdgeIndices, type ProfileSample } from '../../cross-section-geometry.ts';
import { buildRatingCurveRecord } from '../../rating-curve-inversion.ts';
import type { CrossSectionRecord, RatingCurveRecord } from '../../stage-file-formats.ts';
import { bedAt, bedSlopeAt, localLowestGround, type RunChannel } from './flowline-channel.ts';
import { ANCHOR_SECTION, ANCHOR_SLOPE } from './method-config.ts';

/**
 * The rating curve of one Creek Segment of m3: Manning's equation on the cross-section cut perpendicular to the smoothed centerline at the
 * middle of the segment, with the slope of the bed profile there. The section, valley-edge trim, bank tops, ladder, roughness, and running-maximum
 * rule are Stage 1 and Stage 2's (this builds a one-section `CrossSectionRecord` and hands it to `buildRatingCurveRecord`); only where the
 * section is cut and which slope it gets differ from m1 and m2.
 */

/** Position and left normal at a fractional station index (linear between stations, normal renormalized). */
export function frameAt(channel: RunChannel, stationIndex: number): { x: number; y: number; normalX: number; normalY: number } {
  const clamped = Math.max(0, Math.min(channel.stationCount - 1, stationIndex));
  const low = Math.floor(clamped);
  const high = Math.min(channel.stationCount - 1, low + 1);
  const t = clamped - low;
  const mix = (array: Float64Array): number => (array[low] as number) + t * ((array[high] as number) - (array[low] as number));
  const normalX = mix(channel.normalX);
  const normalY = mix(channel.normalY);
  const length = Math.hypot(normalX, normalY) || 1;
  return { x: mix(channel.x), y: mix(channel.y), normalX: normalX / length, normalY: normalY / length };
}

export interface AnchorRating {
  /** Rating curve whose bed is the channel floor of the anchor cross-section (`localLowestGround`). */
  curve: RatingCurveRecord | null;
  /** Why `curve` is null, for a warning. */
  problem: string | null;
  /** Bed profile elevation at the anchor point, m NAVD88: what the Time Series calls `anchorBedElevationM`. */
  anchorBedM: number;
  /** Channel floor of the anchor cross-section, m NAVD88: the bed the rating curve's depths are measured from. */
  thalwegBedM: number;
  slope: number;
  slopeFloored: boolean;
}

/** The anchor rating of one segment, cut at fractional station `anchorIndex` of its run's channel. */
export function anchorRating(channel: RunChannel, segmentId: string, anchorIndex: number): AnchorRating {
  const anchorBedM = bedAt(channel, anchorIndex);
  const rawSlope = bedSlopeAt(channel, Math.round(anchorIndex), ANCHOR_SLOPE.halfWindowM);
  const slopeFloored = rawSlope < ANCHOR_SLOPE.minimumSlope;
  const slope = Math.max(rawSlope, ANCHOR_SLOPE.minimumSlope);
  const base = { anchorBedM, thalwegBedM: Number.NaN, slope: roundToDecimals(slope, 6), slopeFloored };

  const frame = frameAt(channel, anchorIndex);
  const sampled: ProfileSample[] = [];
  const steps = Math.round(ANCHOR_SECTION.halfWidthM / ANCHOR_SECTION.profileSpacingM);
  for (let step = -steps; step <= steps; step += 1) {
    const offsetM = step * ANCHOR_SECTION.profileSpacingM;
    const elevation = channel.window.bilinear(frame.x + frame.normalX * offsetM, frame.y + frame.normalY * offsetM);
    if (elevation !== null) sampled.push({ offsetM, elevationM: elevation });
  }
  // The channel floor found the same way as along the bed profile, then the lowest profile sample within one sample spacing of it.
  const floor = localLowestGround(channel, Math.round(anchorIndex));
  let thalwegIndex = -1;
  sampled.forEach((sample, index) => {
    if (!floor || Math.abs(sample.offsetM - floor.offsetM) > ANCHOR_SECTION.profileSpacingM) return;
    if (thalwegIndex < 0 || sample.elevationM < (sampled[thalwegIndex] as ProfileSample).elevationM) thalwegIndex = index;
  });
  if (thalwegIndex < 0) return { ...base, curve: null, problem: 'no lidar at the channel floor of the anchor cross-section' };
  const thalweg = sampled[thalwegIndex] as ProfileSample;

  // Valley-edge guard and fallback, as Stage 1.
  const edges = valleyEdgeIndices(sampled, thalwegIndex);
  const bankHeightAt = (index: number): number => (sampled[index] as ProfileSample).elevationM - thalweg.elevationM;
  const fallbackLeft = edges.leftIndex > 0 && bankHeightAt(edges.leftIndex) < ANCHOR_SECTION.valleyEdgeMinimumBankHeightM;
  const fallbackRight = edges.rightIndex < sampled.length - 1 && bankHeightAt(edges.rightIndex) < ANCHOR_SECTION.valleyEdgeMinimumBankHeightM;
  const leftIndex = fallbackLeft ? 0 : edges.leftIndex;
  const rightIndex = fallbackRight ? sampled.length - 1 : edges.rightIndex;
  const profile = sampled.slice(leftIndex, rightIndex + 1);
  if (profile.length < 3) return { ...base, thalwegBedM: thalweg.elevationM, curve: null, problem: `anchor cross-section has ${profile.length} lidar samples after the valley-edge trim` };

  const section: CrossSectionRecord['sections'][number] = {
    alongSegmentM: 0,
    networkDistanceM: 0,
    thalwegOffsetM: thalweg.offsetM,
    thalwegUtm: { x: roundToDecimals(frame.x + frame.normalX * thalweg.offsetM, 3), y: roundToDecimals(frame.y + frame.normalY * thalweg.offsetM, 3) },
    bedElevationM: roundToDecimals(thalweg.elevationM, 3),
    areaAtReferenceDepthM2: 0,
    valleyEdgeLeftOffsetM: (profile[0] as ProfileSample).offsetM,
    valleyEdgeRightOffsetM: (profile[profile.length - 1] as ProfileSample).offsetM,
    trimmedAtValleyEdge: leftIndex > 0 || rightIndex < sampled.length - 1,
    valleyEdgeTrimFallbackLeft: fallbackLeft,
    valleyEdgeTrimFallbackRight: fallbackRight,
    leftBankTopOffsetM: 0,
    rightBankTopOffsetM: 0,
  };
  const record: CrossSectionRecord = {
    segmentId,
    networkDistanceMidM: 0,
    bedElevationM: section.bedElevationM,
    rawSlope: roundToDecimals(rawSlope, 6),
    slope: base.slope,
    slopeFloored,
    representativeSectionIndex: 0,
    lowestBankTopM: Number.NaN,
    sections: [section],
    profileOffsetsM: profile.map((sample) => sample.offsetM),
    profileElevationsM: profile.map((sample) => roundToDecimals(sample.elevationM, 3)),
    warnings: [],
  };
  const curve = buildRatingCurveRecord(record);
  if (curve.dischargeM3s.length < 2) {
    return { ...base, thalwegBedM: section.bedElevationM, curve: null, problem: `anchor rating curve has ${curve.dischargeM3s.length} ladder step(s)` };
  }
  return { ...base, thalwegBedM: section.bedElevationM, curve, problem: null };
}
