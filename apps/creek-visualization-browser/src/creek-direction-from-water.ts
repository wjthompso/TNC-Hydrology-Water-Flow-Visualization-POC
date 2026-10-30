// The direction a creek runs at a point, from the best of four sources, in this order. A barrier is
// only 5 to 25 m long, so every source is judged by how well it gives the creek's direction AT the
// barrier, not its average over the neighbourhood:
//
//   1a. The midline of the nearest drawn water ribbon, read over WATER_MIDLINE_HALF_SPAN_M each side of
//       the barrier. The modeled water is drawn as a ribbon with a left and a right vertex at every
//       station along the creek (channel-ribbon-surface.ts), so the line through the middles of those
//       cross-sections is the creek's own centerline, and its direction over about 12 m is the local
//       tangent, even on a bend. Failure modes: a ribbon is recognised only from its ring structure (a
//       polygon of another shape gives no midline, and a ribbon split in two rings is not read); at a
//       confluence the nearest ribbon can be the side creek's; and a ribbon that folds on a tight bend
//       has a midline that doubles back, which shortens the chord it is read from.
//   1b. The principal axis of the drawn water's vertices within WATER_SEARCH_RADIUS_M. It needs no
//       ribbon structure, so it covers observed water and the other drawings. Failure modes: a bend
//       inside the radius pulls it toward the bend's chord, a wide pool is too round to have an axis,
//       and a neighbouring creek's water inside the radius skews it. The radius is small because an
//       earlier 30 m radius measured the average direction of about 60 m of creek, not the creek at
//       the barrier, which is 5 to 25 m long.
//   Both water sources fail the same way when no water is drawn: water draws only for the creeks near
//   the camera, and a creek with no modeled water at the selected time draws none.
//   2. The channel the terrain shows: the lowest ground on each line across the creek (the thalweg),
//      from the lines the barrier snap already reads (channel-thalweg-snap.ts). It needs no drawn water,
//      so it covers the small tributaries and the creeks out of the camera's reach. Failure modes: the
//      lowest ground on a line can be a road embankment's ditch or a side gully instead of the channel,
//      and an unconfined or braided reach has no single thalweg; a fit that is too short or too loose
//      is refused.
//   3. The TNC stream flowline's direction. It always exists near a barrier, but it is a 1:24K map
//      line: beside a bend it can run well off the channel, so a barrier turned to it lies along the
//      creek when it should lie across it. It is also the only source that knows which way is downstream.
//
// How the water gives a direction: the ribbon's midline is a line, and its chord around the barrier is
// the direction. Without a ribbon, the vertices of the water polygons within WATER_SEARCH_RADIUS_M of the
// point trace the two banks; a narrow creek's vertices stretch along the creek, so the long axis of that
// cloud of vertices (its principal axis) is the creek's axis. Both directions have no trusted end, so the
// flowline's direction picks which end is downstream.
//
// How the terrain gives a direction: each line across the creek sits at a known distance along the
// flowline, and its thalweg sits some distance to the right of the flowline. A line through those
// points, fitted so one wrong line cannot bend it (Theil-Sen: the median of the slopes between every two
// points), is the channel. Its angle to the flowline, added to the flowline's direction, is the channel's
// direction; the points are measured downstream along the flowline, so the result already points downstream.

import { ribbonRingJoinedFromStationIntervals } from './channel-ribbon-surface';
import type { LonLatPair } from './geographic-path-geometry';

/** Water vertices farther than this from the barrier do not vote, m. Small, because a barrier is 5 to 25 m long. */
export const WATER_SEARCH_RADIUS_M = 10;
/**
 * A ribbon whose midline passes farther than this from the barrier is not the creek it stands in, m. Wider
 * than the vertex radius because the barrier is drawn on the terrain's channel, a median 6 m from the map
 * line the ribbon follows.
 */
export const WATER_MIDLINE_MAX_DISTANCE_M = 15;
/** The ribbon's midline is read this far upstream and downstream of its point nearest the barrier, m. */
export const WATER_MIDLINE_HALF_SPAN_M = 6;
/** A midline chord shorter than this is a ribbon end or a fold, not a direction, m. */
export const MIN_MIDLINE_CHORD_M = 3;
/** Fewer distinct vertices than this cannot show an axis. */
export const MIN_WATER_VERTICES = 6;
/** The water must stretch this many times farther along its axis than across it. */
export const MIN_ELONGATION = 2.5;
/** Elongation above this is reported as this; a dry creek's water is a line, so its ratio is unbounded. */
const MAX_REPORTED_ELONGATION = 99;
/** Lines across the creek that must agree on a straight channel before the terrain gives a direction. */
export const MIN_TERRAIN_LINES = 3;
/** The agreeing lines must span this much creek, m. Closer lines turn a 1 m ground-grid wobble into a large angle. */
export const MIN_TERRAIN_ALONG_SPREAD_M = 20;
/** A line across the creek agrees with the fitted channel when its lowest ground is this close to it, m. */
export const TERRAIN_AGREEMENT_M = 2;
/**
 * Lowest ground farther than this from the flowline is where the ground simply keeps falling toward the
 * edge of the search, not a channel. Measured against the drawn water at the 29 barriers: the two worst
 * readings (38 and 48 degrees off) came from lines at 25 to 28 m, and with them dropped none was over 8 degrees off.
 */
export const TERRAIN_MAX_OFFSET_M = 24;

export type CreekDirectionSource = 'water' | 'terrain' | 'flowline' | 'none';

export interface CreekDirection {
  /** Downstream direction, degrees clockwise from north; null when no source gives one. */
  bearingDegrees: number | null;
  source: CreekDirectionSource;
  /** One plain sentence saying where the direction came from, or why the better sources did not give one. */
  detail: string;
}

/**
 * The lowest ground on one line across the creek, placed in the frame of the flowline leg the lines were
 * laid on: `alongM` is how far downstream of the barrier the line sits, `acrossM` how far right of the
 * flowline (looking downstream) its lowest ground lies.
 */
export interface ThalwegPoint {
  alongM: number;
  acrossM: number;
}

export type TerrainAxis =
  | {
      kind: 'axis';
      /** How far the channel turns clockwise from the flowline leg's downstream direction, degrees in (-90, 90). */
      turnFromFlowlineDegrees: number;
      /** How many lines across the creek lie on the fitted channel. */
      agreeingLines: number;
      /** How far apart along the creek the agreeing lines are, m. */
      alongSpreadM: number;
    }
  | { kind: 'none'; reason: string };

export type WaterAxis =
  | {
      kind: 'axis';
      /** Direction of the creek's axis, degrees clockwise from north, in [0, 180): the axis has no end. */
      axisBearingDegrees: number;
      /** How many times longer the water stretches along its axis than across it. */
      elongation: number;
      vertexCount: number;
    }
  | { kind: 'none'; reason: string };

export type MidlineAxis =
  | {
      kind: 'axis';
      /** Direction the ribbon's midline runs near the barrier, degrees clockwise from north. Not yet confirmed downstream. */
      bearingDegrees: number;
      /** Length of the midline chord the direction was read from, m. */
      chordM: number;
      /** How many stations the ribbon has. */
      stationCount: number;
    }
  | { kind: 'none'; reason: string };

/** One drawn water polygon, as the water sources read it. */
export interface DrawnWaterPolygon {
  rings: readonly (readonly (readonly number[])[])[];
  /** `ribbonMidline(rings)`, computed at most once per polygon: a barrier near the polygon asks for it on every camera rest. */
  midline(): readonly LonLatPair[] | null;
}

/** Smallest angle between two directions, degrees in [0, 180]. */
export function angularDifferenceDegrees(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/**
 * The middle of each station of a drawn ribbon, upstream to downstream, or null when the rings are not a
 * ribbon. A ribbon's ring holds n left-edge vertices, then n right-edge vertices in reverse, then the first
 * vertex again (channel-ribbon-surface.ts), so station i's pair is ring[i] and ring[length - 2 - i]. The
 * ribbon drawn one quad per station interval is joined back into that ring first. Any other ring structure,
 * such as a ribbon split in two at its anchor station, is not read.
 */
export function ribbonMidline(rings: readonly (readonly (readonly number[])[])[]): LonLatPair[] | null {
  // A lone ring with more than 5 vertices is the whole ribbon; 5 is a one-interval quad, which may be wound the other way.
  const ring = rings.length === 1 && rings[0].length > 5 ? rings[0] : ribbonRingJoinedFromStationIntervals(rings as number[][][], rings.length + 1);
  if (!ring || ring.length < 5 || ring.length % 2 === 0) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return null;
  return Array.from({ length: (ring.length - 1) / 2 }, (_, station): LonLatPair => {
    const left = ring[station];
    const right = ring[ring.length - 2 - station];
    return [(left[0] + right[0]) / 2, (right[1] + left[1]) / 2];
  });
}

/** The point on a drawn ribbon's midline nearest a barrier, where the barrier is centred on the water. */
export interface RibbonMidlineFoot {
  point: LonLatPair;
  /** How far `point` is from the point asked about, m. */
  distanceM: number;
  /** How many stations the ribbon has. */
  stationCount: number;
}

/**
 * The nearest point on any drawn ribbon's midline to `point`, or null when no ribbon midline passes within
 * WATER_MIDLINE_MAX_DISTANCE_M (the water may be another creek's) or no polygon is a plain ribbon. It is the
 * foot of the perpendicular on the midline, not a stretched projection, so it moves `point` across the creek
 * and only along it by as much as it takes to reach the line.
 */
export function nearestPointOnRibbonMidline(point: LonLatPair, polygons: readonly DrawnWaterPolygon[]): RibbonMidlineFoot | null {
  const metersPerDegreeLon = 111320 * Math.cos((point[1] * Math.PI) / 180);
  let nearest: { eastM: number; northM: number; distanceM: number; stationCount: number } | null = null;
  for (const polygon of polygons) {
    const midline = polygon.midline();
    if (!midline || midline.length < 2) continue;
    const eastM = midline.map(([longitude]) => (longitude - point[0]) * metersPerDegreeLon);
    const northM = midline.map(([, latitude]) => (latitude - point[1]) * 110540);
    for (let index = 0; index + 1 < midline.length; index += 1) {
      const stepEast = eastM[index + 1] - eastM[index];
      const stepNorth = northM[index + 1] - northM[index];
      const stepSquared = stepEast * stepEast + stepNorth * stepNorth;
      // Where the point's foot falls on this step of the midline, 0 at its start and 1 at its end.
      const fraction = stepSquared === 0 ? 0 : Math.min(1, Math.max(0, -(eastM[index] * stepEast + northM[index] * stepNorth) / stepSquared));
      const footEastM = eastM[index] + fraction * stepEast;
      const footNorthM = northM[index] + fraction * stepNorth;
      const distanceM = Math.hypot(footEastM, footNorthM);
      if (nearest === null || distanceM < nearest.distanceM) {
        nearest = { eastM: footEastM, northM: footNorthM, distanceM, stationCount: midline.length };
      }
    }
  }
  if (nearest === null || nearest.distanceM > WATER_MIDLINE_MAX_DISTANCE_M) return null;
  return {
    point: [point[0] + nearest.eastM / metersPerDegreeLon, point[1] + nearest.northM / 110540],
    distanceM: nearest.distanceM,
    stationCount: nearest.stationCount,
  };
}

/**
 * The creek's direction at `point` from the nearest drawn ribbon's midline: the chord of the midline from
 * WATER_MIDLINE_HALF_SPAN_M upstream to WATER_MIDLINE_HALF_SPAN_M downstream of the midline's point nearest
 * `point` (shorter where the ribbon ends). The midline runs upstream to downstream, but the caller still
 * orients the result by the flowline, so a ribbon stored the other way cannot turn a barrier around.
 */
export function estimateRibbonMidlineAxis(point: LonLatPair, polygons: readonly DrawnWaterPolygon[]): MidlineAxis {
  const metersPerDegreeLon = 111320 * Math.cos((point[1] * Math.PI) / 180);
  let nearest: { eastM: number[]; northM: number[]; alongM: number[]; distanceM: number; nearestAlongM: number } | null = null;
  for (const polygon of polygons) {
    const midline = polygon.midline();
    if (!midline || midline.length < 2) continue;
    const eastM = midline.map(([longitude]) => (longitude - point[0]) * metersPerDegreeLon);
    const northM = midline.map(([, latitude]) => (latitude - point[1]) * 110540);
    const alongM = [0];
    for (let index = 1; index < midline.length; index += 1) {
      alongM.push(alongM[index - 1] + Math.hypot(eastM[index] - eastM[index - 1], northM[index] - northM[index - 1]));
    }
    for (let index = 0; index + 1 < midline.length; index += 1) {
      const stepEast = eastM[index + 1] - eastM[index];
      const stepNorth = northM[index + 1] - northM[index];
      const stepSquared = stepEast * stepEast + stepNorth * stepNorth;
      // Where the barrier's foot falls on this step of the midline, 0 at its start and 1 at its end.
      const fraction = stepSquared === 0 ? 0 : Math.min(1, Math.max(0, -(eastM[index] * stepEast + northM[index] * stepNorth) / stepSquared));
      const distanceM = Math.hypot(eastM[index] + fraction * stepEast, northM[index] + fraction * stepNorth);
      if (nearest === null || distanceM < nearest.distanceM) {
        nearest = { eastM, northM, alongM, distanceM, nearestAlongM: alongM[index] + fraction * Math.sqrt(stepSquared) };
      }
    }
  }
  if (nearest === null || nearest.distanceM > WATER_MIDLINE_MAX_DISTANCE_M) {
    return { kind: 'none', reason: `no drawn water ribbon passes within ${WATER_MIDLINE_MAX_DISTANCE_M} m` };
  }

  const best = nearest;
  const midlineLengthM = best.alongM[best.alongM.length - 1];
  const at = (targetAlongM: number): { east: number; north: number } => {
    let step = 0;
    while (step + 2 < best.alongM.length && best.alongM[step + 1] < targetAlongM) step += 1;
    const stepLengthM = best.alongM[step + 1] - best.alongM[step];
    const fraction = stepLengthM === 0 ? 0 : (targetAlongM - best.alongM[step]) / stepLengthM;
    return {
      east: best.eastM[step] + fraction * (best.eastM[step + 1] - best.eastM[step]),
      north: best.northM[step] + fraction * (best.northM[step + 1] - best.northM[step]),
    };
  };
  const upstreamEnd = at(Math.max(0, best.nearestAlongM - WATER_MIDLINE_HALF_SPAN_M));
  const downstreamEnd = at(Math.min(midlineLengthM, best.nearestAlongM + WATER_MIDLINE_HALF_SPAN_M));
  const chordEastM = downstreamEnd.east - upstreamEnd.east;
  const chordNorthM = downstreamEnd.north - upstreamEnd.north;
  const chordM = Math.hypot(chordEastM, chordNorthM);
  if (chordM < MIN_MIDLINE_CHORD_M) {
    return { kind: 'none', reason: `the drawn ribbon's midline near here is ${chordM.toFixed(1)} m long, too short for a direction (${MIN_MIDLINE_CHORD_M} m needed)` };
  }
  return {
    kind: 'axis',
    bearingDegrees: (((Math.atan2(chordEastM, chordNorthM) * 180) / Math.PI) + 360) % 360,
    chordM,
    stationCount: best.alongM.length,
  };
}

/**
 * The creek's axis near `point`, from water polygon vertices as `[longitude, latitude, ...]`. Only vertices
 * within WATER_SEARCH_RADIUS_M count, and a corner shared by two polygons counts once.
 */
export function estimateWaterAxis(point: LonLatPair, vertices: Iterable<readonly number[]>): WaterAxis {
  const metersPerDegreeLon = 111320 * Math.cos((point[1] * Math.PI) / 180);
  const seen = new Set<string>();
  const eastM: number[] = [];
  const northM: number[] = [];
  for (const vertex of vertices) {
    const east = (vertex[0] - point[0]) * metersPerDegreeLon;
    const north = (vertex[1] - point[1]) * 110540;
    if (Math.hypot(east, north) > WATER_SEARCH_RADIUS_M) continue;
    // Centimeter keys: adjacent polygons repeat their shared corners, and a repeat would count double.
    const key = `${Math.round(east * 100)},${Math.round(north * 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eastM.push(east);
    northM.push(north);
  }
  const count = eastM.length;
  if (count < MIN_WATER_VERTICES) {
    return { kind: 'none', reason: `no drawn water within ${WATER_SEARCH_RADIUS_M} m (${count} vertices, ${MIN_WATER_VERTICES} needed)` };
  }

  const meanEast = eastM.reduce((sum, value) => sum + value, 0) / count;
  const meanNorth = northM.reduce((sum, value) => sum + value, 0) / count;
  let varianceEast = 0;
  let varianceNorth = 0;
  let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const east = eastM[index] - meanEast;
    const north = northM[index] - meanNorth;
    varianceEast += east * east;
    varianceNorth += north * north;
    covariance += east * north;
  }
  varianceEast /= count;
  varianceNorth /= count;
  covariance /= count;

  // Eigenvalues of the 2 x 2 covariance matrix: the spread along the axis and across it.
  const half = (varianceEast - varianceNorth) / 2;
  const root = Math.hypot(half, covariance);
  const alongSpread = (varianceEast + varianceNorth) / 2 + root;
  const acrossSpread = (varianceEast + varianceNorth) / 2 - root;
  if (alongSpread <= 0) return { kind: 'none', reason: 'the drawn water here is a single point' };
  const elongation = acrossSpread <= 1e-9 ? MAX_REPORTED_ELONGATION : Math.min(MAX_REPORTED_ELONGATION, Math.sqrt(alongSpread / acrossSpread));
  if (elongation < MIN_ELONGATION) {
    return {
      kind: 'none',
      reason: `the drawn water here is too round to give a direction (${elongation.toFixed(1)}x longer than wide, ${MIN_ELONGATION}x needed)`,
    };
  }

  // Angle of the long axis counterclockwise from east; a bearing runs clockwise from north.
  const angleFromEast = 0.5 * Math.atan2(2 * covariance, varianceEast - varianceNorth);
  const axisBearingDegrees = ((((90 - (angleFromEast * 180) / Math.PI) % 180) + 180) % 180);
  return { kind: 'axis', axisBearingDegrees, elongation, vertexCount: count };
}

/**
 * The channel's direction relative to the flowline leg, from the lowest ground on lines across the creek.
 * The line is fitted by the median of the slopes between every two points (Theil-Sen), so one line that
 * read an embankment ditch or a side gully instead of the channel cannot bend it. Lines whose lowest ground is
 * farther than TERRAIN_MAX_OFFSET_M from the flowline are ignored first. Lines that then lie
 * farther than TERRAIN_AGREEMENT_M from it are dropped and the rest refitted; fewer than MIN_TERRAIN_LINES
 * agreeing lines, or lines closer together than MIN_TERRAIN_ALONG_SPREAD_M, give no direction.
 * Positions run downstream, so the turn already points downstream and needs no orienting.
 */
export function estimateTerrainAxis(allPoints: readonly ThalwegPoint[]): TerrainAxis {
  const points = allPoints.filter((point) => Math.abs(point.acrossM) <= TERRAIN_MAX_OFFSET_M);
  if (points.length < MIN_TERRAIN_LINES) {
    return { kind: 'none', reason: `${points.length} of the lines across the creek found a channel low within ${TERRAIN_MAX_OFFSET_M} m of the map line (${MIN_TERRAIN_LINES} needed)` };
  }
  const first = fitTheilSen(points);
  const agreeing = points.filter((point) => Math.abs(point.acrossM - (first.interceptM + first.slope * point.alongM)) <= TERRAIN_AGREEMENT_M);
  if (agreeing.length < MIN_TERRAIN_LINES) {
    return {
      kind: 'none',
      reason: `${agreeing.length} of ${points.length} lines across the creek agree on one channel line within ${TERRAIN_AGREEMENT_M} m (${MIN_TERRAIN_LINES} needed)`,
    };
  }
  const alongPositions = agreeing.map((point) => point.alongM);
  const alongSpreadM = Math.max(...alongPositions) - Math.min(...alongPositions);
  if (alongSpreadM < MIN_TERRAIN_ALONG_SPREAD_M) {
    return {
      kind: 'none',
      reason: `the agreeing lines across the creek span only ${alongSpreadM.toFixed(0)} m along it (${MIN_TERRAIN_ALONG_SPREAD_M} m needed)`,
    };
  }
  const { slope } = fitTheilSen(agreeing);
  return {
    kind: 'axis',
    turnFromFlowlineDegrees: (Math.atan(slope) * 180) / Math.PI,
    agreeingLines: agreeing.length,
    alongSpreadM,
  };
}

/** Line `across = intercept + slope * along` through the points: median slope, then median intercept. Points must differ in `alongM`. */
function fitTheilSen(points: readonly ThalwegPoint[]): { slope: number; interceptM: number } {
  const slopes: number[] = [];
  for (let from = 0; from < points.length; from += 1) {
    for (let to = from + 1; to < points.length; to += 1) {
      const alongStepM = points[to].alongM - points[from].alongM;
      if (alongStepM !== 0) slopes.push((points[to].acrossM - points[from].acrossM) / alongStepM);
    }
  }
  const slope = median(slopes);
  return { slope, interceptM: median(points.map((point) => point.acrossM - slope * point.alongM)) };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The end of an axis that points the way the flowline runs; the axis as given when there is no flowline direction. */
export function orientAlongFlow(axisBearingDegrees: number, flowlineBearingDegrees: number | null): number {
  if (flowlineBearingDegrees === null) return axisBearingDegrees;
  return angularDifferenceDegrees(axisBearingDegrees, flowlineBearingDegrees) <= 90
    ? axisBearingDegrees
    : (axisBearingDegrees + 180) % 360;
}

function offMapLineSentence(bearingDegrees: number, flowlineBearingDegrees: number | null): string {
  return flowlineBearingDegrees === null
    ? 'no map line near enough to say which end is downstream'
    : `${Math.round(angularDifferenceDegrees(bearingDegrees, flowlineBearingDegrees))}° off the map line`;
}

/**
 * The creek's downstream direction at `point`, from the best source that gives one (see the file header).
 * `flowlineBearingDegrees` is the downstream direction of the nearest TNC flowline leg, or null when none is near.
 * `waterPolygons` are the drawn water polygons that may lie near the point. `thalwegPoints` are the lowest ground
 * on each line across the creek, laid on that leg.
 */
export function resolveCreekDirection(
  point: LonLatPair,
  flowlineBearingDegrees: number | null,
  waterPolygons: readonly DrawnWaterPolygon[],
  thalwegPoints: readonly ThalwegPoint[],
): CreekDirection {
  const midline = estimateRibbonMidlineAxis(point, waterPolygons);
  if (midline.kind === 'axis') {
    const bearingDegrees = orientAlongFlow(midline.bearingDegrees, flowlineBearingDegrees);
    return {
      bearingDegrees,
      source: 'water',
      detail: `read from the drawn water's centerline (${midline.chordM.toFixed(0)} m of a ${midline.stationCount}-station ribbon beside the barrier; ${offMapLineSentence(bearingDegrees, flowlineBearingDegrees)})`,
    };
  }
  const water = estimateWaterAxis(
    point,
    waterPolygons.flatMap((polygon) => polygon.rings.flat()),
  );
  if (water.kind === 'axis') {
    const bearingDegrees = orientAlongFlow(water.axisBearingDegrees, flowlineBearingDegrees);
    return {
      bearingDegrees,
      source: 'water',
      detail: `read from the drawn water (${water.vertexCount} vertices within ${WATER_SEARCH_RADIUS_M} m, ${water.elongation.toFixed(1)}x longer than wide; ${offMapLineSentence(bearingDegrees, flowlineBearingDegrees)})`,
    };
  }
  if (flowlineBearingDegrees === null) {
    return { bearingDegrees: null, source: 'none', detail: `no direction: ${water.reason}, and no map line is near` };
  }
  const terrain = estimateTerrainAxis(thalwegPoints);
  if (terrain.kind === 'axis') {
    return {
      bearingDegrees: (flowlineBearingDegrees + terrain.turnFromFlowlineDegrees + 360) % 360,
      source: 'terrain',
      detail: `read from the lowest ground across the creek (${terrain.agreeingLines} lines over ${terrain.alongSpreadM.toFixed(0)} m, ${Math.round(Math.abs(terrain.turnFromFlowlineDegrees))}° off the map line), because ${water.reason}`,
    };
  }
  return {
    bearingDegrees: flowlineBearingDegrees,
    source: 'flowline',
    detail: `read from the map line, because ${water.reason} and ${terrain.reason}`,
  };
}
