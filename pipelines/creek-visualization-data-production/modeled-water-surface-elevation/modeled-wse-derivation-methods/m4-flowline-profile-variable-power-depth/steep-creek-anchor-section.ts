import { roundToDecimals } from '../../../utm-geometry.ts';
import { valleyEdgeIndices, type ProfileSample } from '../../cross-section-geometry.ts';
import type { CrossSectionRecord } from '../../stage-file-formats.ts';
import type { AnchorRating } from '../m3-flowline-profile-manning-depth/anchor-section.ts';
import { bedSlopeAt, thalwegPoint, type RunChannel } from '../m3-flowline-profile-manning-depth/flowline-channel.ts';
import { ANCHOR_SECTION, ANCHOR_SLOPE } from '../m3-flowline-profile-manning-depth/method-config.ts';
import type { SubsectionRoughnessN } from './flow-resistance.ts';
import { buildSteepCreekRatingCurveRecord, type SteepCreekRatingCurveRecord } from './steep-creek-rating-curve.ts';

/**
 * m3 v2's anchor rating (`anchorRating` in m3's anchor-section.ts) with a roughness function: the same cross-section through the
 * creek's lowest point at the anchor station, the same valley-edge trim and slope, handed to `buildSteepCreekRatingCurveRecord`
 * instead of the shared builder. m3's function calls the shared builder directly and m3 v2's fingerprint covers its file, so the
 * section cut is copied here rather than changed there; a difference from m3 v2 can then only come from the roughness.
 */

export interface SteepCreekAnchorRating extends Omit<AnchorRating, 'curve'> {
  curve: SteepCreekRatingCurveRecord | null;
}

/** The anchor rating of one segment, cut at table station `anchorIndex` of its run's channel, with `roughnessN` per subsection. */
export function steepCreekAnchorRating(
  channel: RunChannel,
  segmentId: string,
  anchorIndex: number,
  roughnessN: SubsectionRoughnessN,
): SteepCreekAnchorRating {
  const anchorBedM = channel.bedM[anchorIndex] as number;
  const rawSlope = bedSlopeAt(channel, anchorIndex, ANCHOR_SLOPE.halfWindowM);
  const slopeFloored = rawSlope < ANCHOR_SLOPE.minimumSlope;
  const slope = Math.max(rawSlope, ANCHOR_SLOPE.minimumSlope);
  const base = { anchorBedM, thalwegBedM: Number.NaN, slope: roundToDecimals(slope, 6), slopeFloored };

  // Sampled from the anchor point outward, so offset 0 is the anchor point itself and the section's bed is the anchor bed.
  const anchor = thalwegPoint(channel, anchorIndex);
  const normalX = channel.normalX[anchorIndex] as number;
  const normalY = channel.normalY[anchorIndex] as number;
  const sampled: ProfileSample[] = [];
  const steps = Math.round(ANCHOR_SECTION.halfWidthM / ANCHOR_SECTION.profileSpacingM);
  let thalwegIndex = -1;
  for (let step = -steps; step <= steps; step += 1) {
    const offsetM = step * ANCHOR_SECTION.profileSpacingM;
    const elevation = channel.window.bilinear(anchor.x + normalX * offsetM, anchor.y + normalY * offsetM);
    if (elevation === null) continue;
    if (step === 0) thalwegIndex = sampled.length;
    sampled.push({ offsetM, elevationM: elevation });
  }
  if (thalwegIndex < 0) return { ...base, curve: null, problem: 'no lidar at the anchor point' };
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
    thalwegUtm: { x: roundToDecimals(anchor.x, 3), y: roundToDecimals(anchor.y, 3) },
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
  const curve = buildSteepCreekRatingCurveRecord(record, roughnessN);
  if (curve.dischargeM3s.length < 2) {
    return { ...base, thalwegBedM: section.bedElevationM, curve: null, problem: `anchor rating curve has ${curve.dischargeM3s.length} ladder step(s)` };
  }
  return { ...base, thalwegBedM: section.bedElevationM, curve, problem: null };
}
