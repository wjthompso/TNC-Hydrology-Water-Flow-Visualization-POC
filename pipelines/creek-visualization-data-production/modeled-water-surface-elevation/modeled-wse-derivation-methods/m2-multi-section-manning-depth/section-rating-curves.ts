import { roundToDecimals } from '../../../utm-geometry.ts';
import type { NetworkCreekSegment } from '../../creek-segment-network.ts';
import { CROSS_SECTION } from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { buildRatingCurveRecord } from '../../rating-curve-inversion.ts';
import type { CrossSectionRecord, DownstreamVertexDirection, RatingCurveRecord } from '../../stage-file-formats.ts';
import type { TerrainSampler } from '../../terrain-tiles.ts';
import { JUNCTION_BED_SECTIONS, LOCAL_BED_SLOPE, SOLVED_SECTIONS } from './method-config.ts';

/**
 * The rating curve at the solved (anchor) Stage 1 cross-section of one Creek Segment, plus the beds of
 * its first and last sections for the junction beds. Stage 1 stores only the representative section's
 * profile, so the anchor's profile is resampled from the terrain at the exact position Stage 1 used,
 * then trimmed to the valley-edge offsets Stage 1 saved for that section. The section gets its own bed
 * and a local bed slope, and the curve is built with m1's `buildRatingCurveRecord` (same Manning's n,
 * ladder step, cap, and running-maximum rule). m2-v1 also solved the first and last sections; v2 does not.
 */

type StageOneSection = CrossSectionRecord['sections'][number];

/** The solved section: its Stage 1 bed and its rating curve (null when the section has no usable profile). */
export interface SolvedSection {
  sectionIndex: number;
  bedElevationM: number;
  slope: number;
  slopeFloored: boolean;
  curve: RatingCurveRecord | null;
  /** Why `curve` is null, for a warning. */
  problem: string | null;
}

export interface SegmentSolvedSections {
  segmentId: string;
  anchor: SolvedSection;
  /** Stage 1 bed of the section at the segment's start vertex end (vertex order, not flow order), m NAVD88. */
  startEndBedElevationM: number;
  /** Stage 1 bed of the section at the segment's end vertex end, m NAVD88. */
  endEndBedElevationM: number;
}

/** A Stage 1 section's bed and network distance, for the local slope fit. */
export interface BedProfilePoint {
  distanceM: number;
  bedM: number;
}

/**
 * Same position rule as Stage 1's private `sampleSection`: the section center sits on the chord
 * from the start vertex to the end vertex at ((index + 0.5) / sectionsPerSegment) × length, and the
 * section runs along the chord's left normal (−unitY, unitX), every sampleSpacingM out to ±halfWidthM.
 * NoData samples are skipped, as Stage 1 skips them.
 */
function resampledSectionProfile(
  terrain: TerrainSampler,
  segment: NetworkCreekSegment,
  sectionIndex: number,
): { offsetM: number; elevationM: number }[] {
  const dx = segment.endUtm.x - segment.startUtm.x;
  const dy = segment.endUtm.y - segment.startUtm.y;
  const length = Math.hypot(dx, dy);
  const unitX = dx / length;
  const unitY = dy / length;
  const normalX = -unitY;
  const normalY = unitX;
  const alongSegmentM = ((sectionIndex + 0.5) / CROSS_SECTION.sectionsPerSegment) * segment.preciseLengthM;
  const centerX = segment.startUtm.x + unitX * alongSegmentM;
  const centerY = segment.startUtm.y + unitY * alongSegmentM;
  const profile: { offsetM: number; elevationM: number }[] = [];
  const steps = Math.round(CROSS_SECTION.halfWidthM / CROSS_SECTION.sampleSpacingM);
  for (let step = -steps; step <= steps; step += 1) {
    const offsetM = step * CROSS_SECTION.sampleSpacingM;
    const elevation = terrain.elevationAt({ x: centerX + normalX * offsetM, y: centerY + normalY * offsetM });
    if (elevation !== null) profile.push({ offsetM, elevationM: elevation });
  }
  return profile;
}

/** The resampled profile trimmed to the valley-edge offsets Stage 1 saved, elevations rounded as Stage 1 stores them. */
export function trimmedSectionProfile(
  terrain: TerrainSampler,
  segment: NetworkCreekSegment,
  sectionIndex: number,
  section: StageOneSection,
): { profileOffsetsM: number[]; profileElevationsM: number[] } {
  const trimmed = resampledSectionProfile(terrain, segment, sectionIndex).filter(
    (sample) => sample.offsetM >= section.valleyEdgeLeftOffsetM && sample.offsetM <= section.valleyEdgeRightOffsetM,
  );
  return {
    profileOffsetsM: trimmed.map((sample) => sample.offsetM),
    profileElevationsM: trimmed.map((sample) => roundToDecimals(sample.elevationM, 3)),
  };
}

/**
 * Least-squares slope of bed versus network distance over the points inside the local window,
 * oriented so positive = the bed falls downstream. A window holding fewer than
 * `minimumSectionsInFit` points uses that many nearest points instead.
 */
export function localBedSlope(
  profile: readonly BedProfilePoint[],
  centerM: number,
  direction: DownstreamVertexDirection,
): { rawSlope: number; slope: number; slopeFloored: boolean } {
  let points = profile.filter((point) => Math.abs(point.distanceM - centerM) <= LOCAL_BED_SLOPE.halfWindowM);
  if (points.length < LOCAL_BED_SLOPE.minimumSectionsInFit) {
    points = [...profile]
      .sort((a, b) => Math.abs(a.distanceM - centerM) - Math.abs(b.distanceM - centerM))
      .slice(0, LOCAL_BED_SLOPE.minimumSectionsInFit);
  }
  const meanX = points.reduce((sum, point) => sum + point.distanceM, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.bedM, 0) / points.length;
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    covariance += (point.distanceM - meanX) * (point.bedM - meanY);
    variance += (point.distanceM - meanX) ** 2;
  }
  // Bed falling with increasing network distance gives a negative covariance; flip so a falling bed is positive in vertex order.
  const slopeInVertexOrder = variance === 0 ? 0 : -covariance / variance;
  const rawSlope = direction * slopeInVertexOrder;
  const slopeFloored = rawSlope < LOCAL_BED_SLOPE.minimumSlope;
  return { rawSlope, slope: Math.max(rawSlope, LOCAL_BED_SLOPE.minimumSlope), slopeFloored };
}

function solveSection(input: {
  terrain: TerrainSampler;
  segment: NetworkCreekSegment;
  record: CrossSectionRecord;
  sectionIndex: number;
  bedProfile: readonly BedProfilePoint[];
  direction: DownstreamVertexDirection;
}): SolvedSection {
  const section = input.record.sections[input.sectionIndex];
  if (!section) throw new Error(`Creek Segment ${input.record.segmentId} has no Stage 1 section ${input.sectionIndex}.`);
  const slope = localBedSlope(input.bedProfile, section.networkDistanceM, input.direction);
  const base = {
    sectionIndex: input.sectionIndex,
    bedElevationM: section.bedElevationM,
    slope: roundToDecimals(slope.slope, 6),
    slopeFloored: slope.slopeFloored,
  };
  const profile = trimmedSectionProfile(input.terrain, input.segment, input.sectionIndex, section);
  if (profile.profileOffsetsM.length < 3) {
    return { ...base, curve: null, problem: `section ${input.sectionIndex} has ${profile.profileOffsetsM.length} terrain samples after the valley-edge trim` };
  }
  // A one-section CrossSectionRecord: buildRatingCurveRecord reads the representative section's fallback flags.
  const sectionRecord: CrossSectionRecord = {
    segmentId: input.record.segmentId,
    networkDistanceMidM: section.networkDistanceM,
    bedElevationM: section.bedElevationM,
    rawSlope: roundToDecimals(slope.rawSlope, 6),
    slope: base.slope,
    slopeFloored: slope.slopeFloored,
    representativeSectionIndex: 0,
    lowestBankTopM: Number.NaN,
    sections: [section],
    ...profile,
    warnings: [],
  };
  const curve = buildRatingCurveRecord(sectionRecord);
  if (curve.dischargeM3s.length < 2) {
    return { ...base, curve: null, problem: `section ${input.sectionIndex} rating curve has ${curve.dischargeM3s.length} ladder step(s)` };
  }
  return { ...base, curve, problem: null };
}

export function solveSegmentSections(input: {
  terrain: TerrainSampler;
  segment: NetworkCreekSegment;
  record: CrossSectionRecord;
  bedProfile: readonly BedProfilePoint[];
  direction: DownstreamVertexDirection;
}): SegmentSolvedSections {
  const bedOfSection = (sectionIndex: number): number => {
    const section = input.record.sections[sectionIndex];
    if (!section) throw new Error(`Creek Segment ${input.record.segmentId} has no Stage 1 section ${sectionIndex}.`);
    return section.bedElevationM;
  };
  return {
    segmentId: input.record.segmentId,
    anchor: solveSection({ ...input, sectionIndex: SOLVED_SECTIONS.anchorSectionIndex }),
    startEndBedElevationM: bedOfSection(JUNCTION_BED_SECTIONS.startEndSectionIndex),
    endEndBedElevationM: bedOfSection(JUNCTION_BED_SECTIONS.endEndSectionIndex),
  };
}
