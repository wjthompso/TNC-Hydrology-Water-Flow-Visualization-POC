// The direction a creek runs at a point, read from the water the scene draws there (the prepared
// water-surface polygons) instead of from the TNC stream flowline.
//
// Why: the flowline is a 1:24K map line. Beside a bend it can run well off the channel the water
// follows, so a barrier turned to the flowline's direction lies along the creek when it should lie
// across it. The drawn water is the channel the viewer actually sees.
//
// How: the vertices of the water polygons within WATER_SEARCH_RADIUS_M of the point trace the two
// banks. A narrow creek's vertices stretch along the creek, so the long axis of that cloud of vertices
// (its principal axis) is the creek's axis. That axis has no end, so the flowline's direction only picks
// which end is downstream. Where the water is too round to have a clear axis (a wide pool), or there is
// none within reach (a dry segment, a creek the camera has not loaded), the flowline's direction is kept.

import type { LonLatPair } from './geographic-path-geometry';

/** Water vertices farther than this from the barrier do not vote, m. */
export const WATER_SEARCH_RADIUS_M = 30;
/** Fewer distinct vertices than this cannot show an axis. */
export const MIN_WATER_VERTICES = 6;
/** The water must stretch this many times farther along its axis than across it. */
export const MIN_ELONGATION = 2.5;
/** Elongation above this is reported as this; a dry creek's water is a line, so its ratio is unbounded. */
const MAX_REPORTED_ELONGATION = 99;

export type CreekDirectionSource = 'water' | 'flowline' | 'none';

export interface CreekDirection {
  /** Downstream direction, degrees clockwise from north; null when neither the water nor a flowline gives one. */
  bearingDegrees: number | null;
  source: CreekDirectionSource;
  /** One plain sentence saying where the direction came from, or why the water did not give one. */
  detail: string;
}

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

/** Smallest angle between two directions, degrees in [0, 180]. */
export function angularDifferenceDegrees(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
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

/** The end of an axis that points the way the flowline runs; the axis as given when there is no flowline direction. */
export function orientAlongFlow(axisBearingDegrees: number, flowlineBearingDegrees: number | null): number {
  if (flowlineBearingDegrees === null) return axisBearingDegrees;
  return angularDifferenceDegrees(axisBearingDegrees, flowlineBearingDegrees) <= 90
    ? axisBearingDegrees
    : (axisBearingDegrees + 180) % 360;
}

/**
 * The creek's downstream direction at `point`: from the drawn water when it shows a clear axis, else the flowline's.
 * `flowlineBearingDegrees` is the downstream direction of the nearest TNC flowline leg, or null when none is near.
 */
export function resolveCreekDirection(
  point: LonLatPair,
  flowlineBearingDegrees: number | null,
  waterVertices: Iterable<readonly number[]>,
): CreekDirection {
  const water = estimateWaterAxis(point, waterVertices);
  if (water.kind === 'axis') {
    const bearingDegrees = orientAlongFlow(water.axisBearingDegrees, flowlineBearingDegrees);
    const offMapLine =
      flowlineBearingDegrees === null
        ? 'no map line near enough to say which end is downstream'
        : `${Math.round(angularDifferenceDegrees(bearingDegrees, flowlineBearingDegrees))}° off the map line`;
    return {
      bearingDegrees,
      source: 'water',
      detail: `read from the drawn water (${water.vertexCount} vertices within ${WATER_SEARCH_RADIUS_M} m, ${water.elongation.toFixed(1)}x longer than wide; ${offMapLine})`,
    };
  }
  if (flowlineBearingDegrees !== null) {
    return { bearingDegrees: flowlineBearingDegrees, source: 'flowline', detail: `read from the map line, because ${water.reason}` };
  }
  return { bearingDegrees: null, source: 'none', detail: `no direction: ${water.reason}, and no map line is near` };
}
