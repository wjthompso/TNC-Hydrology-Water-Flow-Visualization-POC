// Camera fit: where to put a north-up, tilted camera so a set of ground points lands inside a
// chosen rectangle of the screen. ArcGIS `goTo` can fit points to the whole map, but a sidebar
// covers part of the map, so a creek fitted to the whole map ends up partly under the sidebar.
// This solves for the camera against the rectangle that is actually visible.
//
// The camera is a pinhole looking at a ground point from a distance, tilted from straight down and
// facing north. For a ground point `e` meters east and `n` meters north of the look-at point, with
// the camera `distance` meters from it:
//
//   depth = distance + n * sin(tilt)
//   x     = width / 2  + focal * e / depth
//   y     = height / 2 - focal * n * cos(tilt) / depth
//
// The terrain is treated as flat at one height. A creek a few kilometers across then lands within a
// few percent of where this puts it, which the margin around the rectangle absorbs.

import type { LonLat } from './creek-data-contract';

/** A rectangle of the map in pixels, measured from the map's top-left corner. */
export interface ScreenRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CameraFitRequest {
  pointsWgs84: readonly LonLat[];
  viewWidthPx: number;
  viewHeightPx: number;
  /** ArcGIS `Camera.fov`: the field of view across the map's diagonal, in degrees. */
  diagonalFovDegrees: number;
  /** Degrees from straight down. */
  tiltDegrees: number;
  /** Where the points should land. */
  region: ScreenRegion;
  /** Ground height under the points, m. */
  groundElevationM: number;
}

export interface CameraFit {
  longitude: number;
  latitude: number;
  /** Camera height, m, same datum as `groundElevationM`. */
  altitudeM: number;
}

const EARTH_RADIUS_M = 6378137;
const MAX_ITERATIONS = 60;
/** Fitted when the region is within this fraction of its size and the points are within this many pixels of its center. */
const SIZE_TOLERANCE = 0.01;
const CENTER_TOLERANCE_PX = 1.5;
/** Never closer than this, so a short creek does not put the camera into the ground. */
const MIN_DISTANCE_M = 1000;

/**
 * The camera, facing north, whose view puts the points' bounding rectangle in the middle of `region`
 * and as large as `region` allows. Each pass moves the look-at point to center the points and scales
 * the distance by how much too large or small they appear; both settle in a few passes.
 */
export function fitNorthUpCamera(request: CameraFitRequest): CameraFit {
  const { pointsWgs84, viewWidthPx, viewHeightPx, region } = request;
  if (pointsWgs84.length === 0) throw new Error('A camera fit needs at least one point.');

  const originLon = (Math.min(...pointsWgs84.map((p) => p[0])) + Math.max(...pointsWgs84.map((p) => p[0]))) / 2;
  const originLat = (Math.min(...pointsWgs84.map((p) => p[1])) + Math.max(...pointsWgs84.map((p) => p[1]))) / 2;
  const metersPerDegreeLon = ((Math.PI / 180) * EARTH_RADIUS_M) * Math.cos((originLat * Math.PI) / 180);
  const metersPerDegreeLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const ground = pointsWgs84.map(([lon, lat]) => ({
    e: (lon - originLon) * metersPerDegreeLon,
    n: (lat - originLat) * metersPerDegreeLat,
  }));

  const tilt = (request.tiltDegrees * Math.PI) / 180;
  const sinTilt = Math.sin(tilt);
  const cosTilt = Math.cos(tilt);
  const focalPx = Math.hypot(viewWidthPx, viewHeightPx) / 2 / Math.tan((request.diagonalFovDegrees * Math.PI) / 360);
  const regionWidthPx = region.right - region.left;
  const regionHeightPx = region.bottom - region.top;
  const regionCenterX = (region.left + region.right) / 2;
  const regionCenterY = (region.top + region.bottom) / 2;

  const spanM = Math.max(
    Math.max(...ground.map((p) => p.e)) - Math.min(...ground.map((p) => p.e)),
    Math.max(...ground.map((p) => p.n)) - Math.min(...ground.map((p) => p.n)),
    1,
  );
  // Start well back, so every point is in front of the camera.
  let distanceM = Math.max(MIN_DISTANCE_M, spanM * 3);
  let lookAtE = 0;
  let lookAtN = 0;

  for (let pass = 0; pass < MAX_ITERATIONS; pass += 1) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let behindCamera = false;
    for (const point of ground) {
      const depth = distanceM + (point.n - lookAtN) * sinTilt;
      if (depth <= 1) {
        behindCamera = true;
        break;
      }
      const x = viewWidthPx / 2 + (focalPx * (point.e - lookAtE)) / depth;
      const y = viewHeightPx / 2 - (focalPx * (point.n - lookAtN) * cosTilt) / depth;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (behindCamera) {
      distanceM *= 2;
      continue;
    }

    const offCenterX = (minX + maxX) / 2 - regionCenterX;
    const offCenterY = (minY + maxY) / 2 - regionCenterY;
    const sizeRatio = Math.max((maxX - minX) / regionWidthPx, (maxY - minY) / regionHeightPx);
    const settled =
      Math.abs(sizeRatio - 1) < SIZE_TOLERANCE &&
      Math.abs(offCenterX) < CENTER_TOLERANCE_PX &&
      Math.abs(offCenterY) < CENTER_TOLERANCE_PX;
    if (settled) break;

    // Points too far right on screen: the look-at point moves east. Too low on screen: it moves south.
    lookAtE += (offCenterX * distanceM) / focalPx;
    lookAtN -= (offCenterY * distanceM) / (focalPx * cosTilt);
    distanceM = Math.max(MIN_DISTANCE_M, distanceM * (sizeRatio > 0 ? sizeRatio : 1));
  }

  // Facing north, the camera sits south of the look-at point.
  const cameraE = lookAtE;
  const cameraN = lookAtN - distanceM * sinTilt;
  return {
    longitude: originLon + cameraE / metersPerDegreeLon,
    latitude: originLat + cameraN / metersPerDegreeLat,
    altitudeM: request.groundElevationM + distanceM * cosTilt,
  };
}
