// Channel ribbon water (WSE Polygon Generation Method `flowline-channel-ribbon`, browserDrawing
// `channel-ribbon-depth`). A Creek Segment's buckets are depth rungs, and every bucket holds one
// ring with the same vertices in the same order: the left edge of the ribbon at stations
// 0…n−1 from upstream to downstream, then the right edge from n−1 back to 0, each vertex
// `[lon, lat, bedProfileM]`. At the selected time every station has its own water depth (the
// segment's junction depths, interpolated along the segment). This file slides each station's two
// edge vertices between the two rungs around that depth, at z = bed profile + depth, so the ribbon's
// width and height change continuously with time, and two neighbouring segments meet exactly
// because they share the boundary station and the junction depth.
//
// Display exaggeration (labeled, never stored in the data): on a steep segment the true depth is a
// few centimeters, thinner than the drawn terrain mesh is accurate (the mesh sits a median 0.13 m,
// 95th percentile 0.57 m, above the lidar on 20–40% slopes), so true-depth water hides. The method's
// declared display rule draws a steep segment at least `floor` deep (the width follows that depth) and
// lifts its surface by `lift`. Both ramp in with the bed slope between 3% and 8%, so neighbouring
// segments of similar slope get the same exaggeration and meet without a step. `?ribbonDisplayFloorM=`
// and `?ribbonDisplayLiftM=` set the full-ramp values; `0` for both draws true water. The Time Series
// and the chart keep true values.

import type { ElevationBucket } from './creek-data-contract';
import type { BedParallelWaterDepth } from './sloped-water-surface';

/** `?ribbonDisplayFloorM=0.15`: drawn-depth floor (meters) of fully steep ribbon segments; 0 turns it off. */
export const RIBBON_DISPLAY_FLOOR_QUERY_PARAM = 'ribbonDisplayFloorM';
/** `?ribbonDisplayLiftM=0.3`: surface lift (meters) of fully steep ribbon segments; 0 turns it off. */
export const RIBBON_DISPLAY_LIFT_QUERY_PARAM = 'ribbonDisplayLiftM';

/** The method's declared display rule (`DISPLAY_RULE` in flowline-channel-ribbon/method-config.ts): keep the two in step. */
const DEFAULT_FLOOR_M = 0.15;
const DEFAULT_LIFT_M = 0.3;
const RAMP_START_SLOPE = 0.03;
const RAMP_FULL_SLOPE = 0.08;

function requestedMeters(parameter: string, fallbackM: number): number {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(parameter);
  const requested = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(requested) && requested >= 0 ? requested : fallbackM;
}

/** The display floor and lift for a segment with this bed slope (m/m): 0 below 3%, the full values above 8%, smooth in between. */
export function ribbonDisplayAdjustmentForSlope(bedSlope: number): { floorM: number; liftM: number } {
  const t = Math.min(1, Math.max(0, (bedSlope - RAMP_START_SLOPE) / (RAMP_FULL_SLOPE - RAMP_START_SLOPE)));
  const ramp = t * t * (3 - 2 * t);
  return {
    floorM: ramp * requestedMeters(RIBBON_DISPLAY_FLOOR_QUERY_PARAM, DEFAULT_FLOOR_M),
    liftM: ramp * requestedMeters(RIBBON_DISPLAY_LIFT_QUERY_PARAM, DEFAULT_LIFT_M),
  };
}

/** One line for the dev tools: what the display rule is doing. */
export function ribbonDisplayRuleDescription(): string {
  const floorM = requestedMeters(RIBBON_DISPLAY_FLOOR_QUERY_PARAM, DEFAULT_FLOOR_M);
  const liftM = requestedMeters(RIBBON_DISPLAY_LIFT_QUERY_PARAM, DEFAULT_LIFT_M);
  if (floorM === 0 && liftM === 0) return 'channel ribbon drawn at true depth (no display exaggeration)';
  return (
    `display exaggeration on steep segments (ramping in from ${RAMP_START_SLOPE * 100}% to ${RAMP_FULL_SLOPE * 100}% bed slope): ` +
    `drawn at least ${floorM} m deep and lifted ${liftM} m; chart and data keep true values`
  );
}

type Vertex = readonly number[];

/** The ring of a bucket when it is a usable ribbon rung: one ring, an even number of vertices (n left + n right), n ≥ 2. */
function rungVertices(bucket: ElevationBucket): readonly Vertex[] | null {
  const ring = bucket.ringsWgs84[0] as readonly Vertex[] | undefined;
  if (!ring || bucket.ringsWgs84.length !== 1 || ring.length < 4 || ring.length % 2 !== 0) return null;
  return ring;
}

/**
 * The ribbon of one segment at the given depths, as rings with z on every vertex (closed). Null when the buckets are not
 * vertex-aligned rungs, so the caller can fall back to the plain bed-parallel drawing.
 *
 * Between rungs the edge vertices move linearly with depth. Below the first rung (1 cm) the ribbon tapers to the midline of that rung;
 * a station with no depth collapses onto it. Above the top rung the top rung's width is kept.
 */
export function channelRibbonRingsWgs84(
  buckets: readonly ElevationBucket[],
  depth: BedParallelWaterDepth,
  /** Display lift added to every vertex's z (0 for true water). */
  liftM = 0,
): number[][][] | null {
  const rungs: { depthM: number; ring: readonly Vertex[] }[] = [];
  for (const bucket of buckets) {
    const ring = rungVertices(bucket);
    if (!ring) return null;
    rungs.push({ depthM: bucket.minWaterSurfaceElevationM, ring });
  }
  const first = rungs[0];
  if (!first) return null;
  const vertexCount = first.ring.length;
  if (rungs.some((rung) => rung.ring.length !== vertexCount)) return null;
  const stationCount = vertexCount / 2;

  const junction = depth.junctionDepth;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let station = 0; station < stationCount; station += 1) {
    const fraction = stationCount === 1 ? 0 : station / (stationCount - 1);
    const depthM = Math.max(0, junction ? junction.upstreamM + (junction.downstreamM - junction.upstreamM) * fraction : depth.anchorDepthM);
    const leftIndex = station;
    const rightIndex = vertexCount - 1 - station;
    const firstLeft = first.ring[leftIndex] as Vertex;
    const firstRight = first.ring[rightIndex] as Vertex;
    const bedM = firstLeft[2] as number;
    // The two rungs around this depth and the way between them; below the first rung the lower "rung" is the midline.
    let lowerLeft: Vertex;
    let lowerRight: Vertex;
    let upperLeft: Vertex;
    let upperRight: Vertex;
    let t: number;
    if (depthM < first.depthM) {
      const midLon = ((firstLeft[0] as number) + (firstRight[0] as number)) / 2;
      const midLat = ((firstLeft[1] as number) + (firstRight[1] as number)) / 2;
      lowerLeft = lowerRight = [midLon, midLat];
      upperLeft = firstLeft;
      upperRight = firstRight;
      t = first.depthM > 0 ? depthM / first.depthM : 1;
    } else {
      let rung = 0;
      while (rung + 1 < rungs.length && (rungs[rung + 1] as (typeof rungs)[number]).depthM <= depthM) rung += 1;
      const lower = rungs[rung] as (typeof rungs)[number];
      const upper = rungs[Math.min(rungs.length - 1, rung + 1)] as (typeof rungs)[number];
      lowerLeft = lower.ring[leftIndex] as Vertex;
      lowerRight = lower.ring[rightIndex] as Vertex;
      upperLeft = upper.ring[leftIndex] as Vertex;
      upperRight = upper.ring[rightIndex] as Vertex;
      t = upper === lower ? 0 : Math.min(1, (depthM - lower.depthM) / (upper.depthM - lower.depthM));
    }
    const z = bedM + depthM + liftM;
    left.push([
      (lowerLeft[0] as number) + t * ((upperLeft[0] as number) - (lowerLeft[0] as number)),
      (lowerLeft[1] as number) + t * ((upperLeft[1] as number) - (lowerLeft[1] as number)),
      z,
    ]);
    right.push([
      (lowerRight[0] as number) + t * ((upperRight[0] as number) - (lowerRight[0] as number)),
      (lowerRight[1] as number) + t * ((upperRight[1] as number) - (lowerRight[1] as number)),
      z,
    ]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push([...(ring[0] as number[])]);
  return [ring];
}
