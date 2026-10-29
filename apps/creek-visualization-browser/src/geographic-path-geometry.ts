// Distance, position, and bearing along a longitude/latitude vertex chain. Uses a local flat
// projection, which is accurate to well under a meter over the few hundred meters the developer
// galleries span. Not for long paths.

export type LonLatPair = readonly [longitude: number, latitude: number];

/** Point `distanceM` meters along the path from its first vertex; past the end, extends the last leg. */
export function pointAlongPath(path: readonly LonLatPair[], distanceM: number): [number, number] {
  const { from, to, t } = locateAlongPath(path, distanceM);
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/** Direction of travel at `distanceM` along the path, degrees clockwise from north. */
export function bearingAlongPath(path: readonly LonLatPair[], distanceM: number): number {
  const { from, to } = locateAlongPath(path, distanceM);
  const [east, north] = localOffsetM(from, to);
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

export interface NearestPathPoint {
  /** Meters from the query point to the closest spot on any path. */
  distanceM: number;
  /** The closest spot itself, on the path. */
  point: LonLatPair;
  /** Direction of the closest leg, degrees clockwise from north, in the path's vertex order. */
  bearingDegrees: number;
}

/**
 * Closest spot on any path to `point`, and the direction that leg runs in vertex order. Paths are
 * flowlines digitized downstream, so the bearing is the downstream direction.
 */
export function nearestPointOnPaths(
  point: LonLatPair,
  paths: readonly (readonly LonLatPair[])[],
): NearestPathPoint | null {
  let best: NearestPathPoint | null = null;
  for (const path of paths) {
    for (let index = 0; index < path.length - 1; index += 1) {
      const [startEast, startNorth] = localOffsetM(point, path[index]);
      const [endEast, endNorth] = localOffsetM(point, path[index + 1]);
      const legEast = endEast - startEast;
      const legNorth = endNorth - startNorth;
      const legLengthSquared = legEast * legEast + legNorth * legNorth;
      // Position along the leg of the spot closest to the point, clamped to the leg.
      const along =
        legLengthSquared === 0
          ? 0
          : Math.max(0, Math.min(1, -(startEast * legEast + startNorth * legNorth) / legLengthSquared));
      const distanceM = Math.hypot(startEast + legEast * along, startNorth + legNorth * along);
      if (best === null || distanceM < best.distanceM) {
        const [legStartLongitude, legStartLatitude] = path[index];
        const [legEndLongitude, legEndLatitude] = path[index + 1];
        best = {
          distanceM,
          point: [
            legStartLongitude + (legEndLongitude - legStartLongitude) * along,
            legStartLatitude + (legEndLatitude - legStartLatitude) * along,
          ],
          bearingDegrees: ((Math.atan2(legEast, legNorth) * 180) / Math.PI + 360) % 360,
        };
      }
    }
  }
  return best;
}

/** Point `distanceM` meters from `origin` on `bearingDegrees` (clockwise from north). */
export function offsetPoint(origin: LonLatPair, bearingDegrees: number, distanceM: number): [number, number] {
  const radians = (bearingDegrees * Math.PI) / 180;
  const metersPerDegreeLon = 111320 * Math.cos((origin[1] * Math.PI) / 180);
  return [
    origin[0] + (Math.sin(radians) * distanceM) / metersPerDegreeLon,
    origin[1] + (Math.cos(radians) * distanceM) / 110540,
  ];
}

/** Path segment containing `distanceM`; past the end, extends the last segment. */
function locateAlongPath(
  path: readonly LonLatPair[],
  distanceM: number,
): { from: LonLatPair; to: LonLatPair; t: number } {
  let remainingM = distanceM;
  for (let index = 0; index < path.length - 1; index += 1) {
    const lengthM = Math.hypot(...localOffsetM(path[index], path[index + 1]));
    if (remainingM <= lengthM || index === path.length - 2) {
      return { from: path[index], to: path[index + 1], t: lengthM === 0 ? 0 : remainingM / lengthM };
    }
    remainingM -= lengthM;
  }
  return { from: path[0], to: path[0], t: 0 };
}

function localOffsetM(from: LonLatPair, to: LonLatPair): [east: number, north: number] {
  const metersPerDegreeLon = 111320 * Math.cos((from[1] * Math.PI) / 180);
  return [(to[0] - from[0]) * metersPerDegreeLon, (to[1] - from[1]) * 110540];
}
