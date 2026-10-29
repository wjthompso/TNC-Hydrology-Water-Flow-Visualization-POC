// Finds where the creek channel really lies beside a point on a TNC stream flowline, so a thing
// placed "on the creek" sits in the channel the scene draws and not on the flowline beside it.
//
// Why it is needed: the TNC Digital Catalog places its fish barriers exactly on the 1:24K NHD
// (National Hydrography Dataset) stream flowline, and that line runs a median 6 m (maximum 28 m) from
// the lowest ground in the channel. The pipeline measured this in Stage 1
// (data/pipeline-working-output/jalama-gauge-reach/01-cross-sections/manifest.json,
// `thalwegOffsetFromFlowlineM`), and the water polygons are drawn from that lowest ground.
//
// The rule is the pipeline's own: the channel is the lowest ground within THALWEG_SEARCH_HALF_WIDTH_M of
// the flowline, measured on a line across the creek. Two guards keep it honest at barriers:
//   - A road crossing or dam sits in fill, so one line across the creek AT the barrier can read the
//     embankment. Lines are taken at several stations up and down the creek and the median offset wins.
//   - A line whose lowest ground falls on the end of the search is a slope, not a channel. It is dropped.
// With too few good lines the point is left on the flowline, and the caller is told why.

import { offsetPoint, type LonLatPair } from './geographic-path-geometry';

/** Same as the pipeline's `CROSS_SECTION.thalwegSearchHalfWidthM`. */
export const THALWEG_SEARCH_HALF_WIDTH_M = 30;
/** Ground is read this often across each line, m. The terrain is 1 m. */
export const LATERAL_STEP_M = 1;
/** Where the lines across the creek sit, m along the creek from the point (negative is upstream). */
export const SECTION_STATIONS_ALONG_M: readonly number[] = [-20, -10, 0, 10, 20];
/** Lines needed before the point is moved. */
export const MIN_USABLE_SECTIONS = 3;
/** A line with more than this share of its ground missing is dropped. */
const MAX_MISSING_SHARE = 0.2;

/** Number of ground readings on one line across the creek. */
export const SAMPLES_PER_SECTION = Math.round((2 * THALWEG_SEARCH_HALF_WIDTH_M) / LATERAL_STEP_M) + 1;

/** Offset of reading `index` on a line across the creek, m; positive is right of the downstream direction. */
export function lateralOffsetOfSample(index: number): number {
  return -THALWEG_SEARCH_HALF_WIDTH_M + index * LATERAL_STEP_M;
}

/** Every place ground is read to find the channel at one point, grouped by line across the creek. */
export function sectionSamplePoints(flowlinePoint: LonLatPair, downstreamBearingDegrees: number): LonLatPair[] {
  const acrossBearing = (downstreamBearingDegrees + 90) % 360;
  const points: LonLatPair[] = [];
  for (const stationM of SECTION_STATIONS_ALONG_M) {
    const station = offsetPoint(flowlinePoint, downstreamBearingDegrees, stationM);
    for (let index = 0; index < SAMPLES_PER_SECTION; index += 1) {
      points.push(offsetPoint(station, acrossBearing, lateralOffsetOfSample(index)));
    }
  }
  return points;
}

/**
 * Offset of the lowest ground on one line across the creek, m. Null when the line has too much ground
 * missing, or when the lowest ground is on the end of the search (a slope, with no channel in range).
 * A tie goes to the reading nearer the flowline, as in the pipeline.
 */
export function lowestGroundOffsetM(groundM: readonly (number | null)[]): number | null {
  const missing = groundM.filter((value) => value === null).length;
  if (groundM.length === 0 || missing / groundM.length > MAX_MISSING_SHARE) return null;
  let lowestIndex = -1;
  for (const [index, value] of groundM.entries()) {
    if (value === null) continue;
    const best = lowestIndex === -1 ? null : groundM[lowestIndex];
    const lower = best === null || value < best;
    const equalButNearer =
      best !== null &&
      value === best &&
      Math.abs(lateralOffsetOfSample(index)) < Math.abs(lateralOffsetOfSample(lowestIndex));
    if (lower || equalButNearer) lowestIndex = index;
  }
  if (lowestIndex === -1) return null;
  const offsetM = lateralOffsetOfSample(lowestIndex);
  return Math.abs(offsetM) > THALWEG_SEARCH_HALF_WIDTH_M - LATERAL_STEP_M ? null : offsetM;
}

export type ChannelSnap =
  | {
      kind: 'channel';
      /** How far the channel lies from the flowline, m; positive is right of the downstream direction. */
      lateralOffsetM: number;
      sectionsUsed: number;
      /** Spread of the usable lines' offsets (largest minus smallest), m. A wide spread means a wandering or braided channel. */
      spreadM: number;
    }
  | { kind: 'none'; reason: string };

/** The channel offset from the usable lines across the creek (median), or why the point stays on the flowline. */
export function findChannelOffset(sectionGroundM: readonly (readonly (number | null)[])[]): ChannelSnap {
  const offsets = sectionGroundM
    .map((ground) => lowestGroundOffsetM(ground))
    .filter((offset): offset is number => offset !== null)
    .sort((a, b) => a - b);
  if (offsets.length < MIN_USABLE_SECTIONS) {
    return {
      kind: 'none',
      reason: `only ${offsets.length} of ${sectionGroundM.length} lines across the creek found a channel low inside ±${THALWEG_SEARCH_HALF_WIDTH_M - LATERAL_STEP_M} m (${MIN_USABLE_SECTIONS} needed)`,
    };
  }
  const middle = Math.floor(offsets.length / 2);
  const lateralOffsetM = offsets.length % 2 === 1 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
  return {
    kind: 'channel',
    lateralOffsetM,
    sectionsUsed: offsets.length,
    spreadM: offsets[offsets.length - 1] - offsets[0],
  };
}
