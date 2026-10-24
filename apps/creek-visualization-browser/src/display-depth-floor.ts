// Display depth floor: a visual-exaggeration experiment for bed-parallel-depth
// water (WSE Polygon Generation Method `height-above-nearest-drainage-fill`).
//
// On a steep Creek Segment the modeled water is a few centimeters deep, thinner
// than the drawn terrain mesh is accurate (the mesh differed from the 1 m lidar
// by 1-33 cm at three checked points), so true-depth water hides under the
// ground. Two off-by-default URL parameters raise the drawn depth; the drawn
// depth is max(modeled depth, constant floor, slope floor):
//
// - `?displayDepthFloorM=0.3`: a constant floor in meters for every segment
//   that has water. It also thickens flat creeks.
// - `?displayDepthSlopeFloorM=1`: a factor k in meters; the floor is
//   k × the segment's local bed slope (rise ÷ run between its two junction bed
//   elevations, over its chord). Terrain mismatch grows with slope, so k = 1
//   gives 0.29 m on a 0.29 slope and 0.005 m on a flat 0.005 slope.
//
// - `?displayDepthFloorMinSlope=0.05`: the constant floor applies only to
//   segments whose local bed slope is at least this (0.05 = 5%), so flat creeks
//   keep their true depth. A segment with unknown slope gets no constant floor
//   when this is set. Default 0: the constant floor applies everywhere.
//
// The footprint (bucket choice) and the surface both use the floored depth.
// Water that is truly absent stays absent: a segment whose modeled depth is
// below `DRY_BELOW_DEPTH_M` is not drawn, with or without a floor. The chart
// and click readouts keep the true modeled WSE and depth. With neither URL
// parameter nothing here changes the drawing.

import type { BedParallelWaterDepth } from './sloped-water-surface';

/** `?displayDepthFloorM=0.3`: minimum drawn depth in meters for any segment that has water. */
export const DISPLAY_DEPTH_FLOOR_QUERY_PARAM = 'displayDepthFloorM';

/** `?displayDepthSlopeFloorM=1`: factor k in meters; the segment's minimum drawn depth is k × its local bed slope. */
export const DISPLAY_DEPTH_SLOPE_FLOOR_QUERY_PARAM = 'displayDepthSlopeFloorM';

/** `?displayDepthFloorMinSlope=0.05`: the constant floor applies only to segments at least this steep (m/m). */
export const DISPLAY_DEPTH_FLOOR_MIN_SLOPE_QUERY_PARAM = 'displayDepthFloorMinSlope';

/** A modeled depth under 1 cm is "no water", so a floor never turns it into a visible stream. */
export const DRY_BELOW_DEPTH_M = 0.01;

interface DisplayDepthFloorSettings {
  /** `?displayDepthFloorM=`, meters; 0 when off. */
  constantFloorM: number;
  /** `?displayDepthSlopeFloorM=`, meters of floor per unit of bed slope; 0 when off. */
  slopeFactorM: number;
  /** `?displayDepthFloorMinSlope=`, bed slope (m/m) below which the constant floor is not applied; 0 applies it everywhere. */
  constantFloorMinSlope: number;
}

let cachedSearch: string | null = null;
let cachedSettings: DisplayDepthFloorSettings = { constantFloorM: 0, slopeFactorM: 0, constantFloorMinSlope: 0 };

function settings(): DisplayDepthFloorSettings {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  if (search !== cachedSearch) {
    cachedSearch = search;
    const params = new URLSearchParams(search);
    cachedSettings = {
      constantFloorM: positiveNumberOrZero(params.get(DISPLAY_DEPTH_FLOOR_QUERY_PARAM)),
      slopeFactorM: positiveNumberOrZero(params.get(DISPLAY_DEPTH_SLOPE_FLOOR_QUERY_PARAM)),
      constantFloorMinSlope: positiveNumberOrZero(params.get(DISPLAY_DEPTH_FLOOR_MIN_SLOPE_QUERY_PARAM)),
    };
  }
  return cachedSettings;
}

/** The number in a URL parameter; 0 (off) when absent, unreadable, or not positive. */
function positiveNumberOrZero(raw: string | null): number {
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** The constant floor from the page URL; 0 (no floor) when absent, unreadable, or negative. */
export function displayDepthFloorM(): number {
  return settings().constantFloorM;
}

/**
 * Local bed slope of a segment: |upstream bed − downstream bed| ÷ chord length (meters per meter).
 * 0 when either bed elevation or a positive chord length is missing.
 */
export function localBedSlope(
  upstreamBedM: number | undefined,
  downstreamBedM: number | undefined,
  chordLengthM: number | null,
): number {
  if (upstreamBedM === undefined || downstreamBedM === undefined) return 0;
  if (chordLengthM === null || !(chordLengthM > 0)) return 0;
  return Math.abs(upstreamBedM - downstreamBedM) / chordLengthM;
}

/**
 * The floor for one segment: the larger of the constant floor and k × its local bed slope; 0 when both are off.
 * The constant floor is skipped on a segment flatter than `?displayDepthFloorMinSlope=`.
 */
export function displayDepthFloorForSlope(bedSlope: number): number {
  const { constantFloorM, slopeFactorM, constantFloorMinSlope } = settings();
  const constantFloorForThisSegmentM = bedSlope >= constantFloorMinSlope ? constantFloorM : 0;
  return Math.max(constantFloorForThisSegmentM, slopeFactorM * bedSlope);
}

/** One line naming the active parameters for the dev tools, or null when no floor is on. */
export function displayDepthFloorDescription(): string | null {
  const { constantFloorM, slopeFactorM, constantFloorMinSlope } = settings();
  const parts: string[] = [];
  if (constantFloorM > 0) {
    parts.push(
      constantFloorMinSlope > 0
        ? `constant ${constantFloorM} m on slopes ≥ ${constantFloorMinSlope}`
        : `constant ${constantFloorM} m`,
    );
  }
  if (slopeFactorM > 0) parts.push(`slope-scaled ${slopeFactorM} m × bed slope`);
  return parts.length === 0 ? null : `Display depth floor active: ${parts.join(' + ')}; visual exaggeration`;
}

/**
 * The depth to draw. With no floor it is the modeled depth unchanged. With a floor, a segment
 * whose anchor depth is under `DRY_BELOW_DEPTH_M` gets depth 0 (nothing drawn); any other segment
 * gets at least the floor at the anchor and at both ends. `waterSurfaceElevationM` stays the
 * modeled WSE, so charts and click readouts keep showing the true value. `floorM` is the
 * segment's floor from `displayDepthFloorForSlope`; it defaults to the constant floor.
 */
export function withDisplayDepthFloor(depth: BedParallelWaterDepth, floorM = displayDepthFloorM()): BedParallelWaterDepth {
  if (floorM <= 0) return depth;
  if (depth.anchorDepthM < DRY_BELOW_DEPTH_M) {
    return { ...depth, anchorDepthM: 0, junctionDepth: depth.junctionDepth ? { upstreamM: 0, downstreamM: 0 } : null };
  }
  return {
    ...depth,
    anchorDepthM: Math.max(depth.anchorDepthM, floorM),
    junctionDepth: depth.junctionDepth
      ? {
          upstreamM: Math.max(depth.junctionDepth.upstreamM, floorM),
          downstreamM: Math.max(depth.junctionDepth.downstreamM, floorM),
        }
      : null,
  };
}
