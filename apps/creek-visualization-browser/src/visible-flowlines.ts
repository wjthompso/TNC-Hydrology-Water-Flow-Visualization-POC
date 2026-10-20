// Picks the TNC flowlines near the current camera view. The view extent (or,
// when the scene has none, the camera altitude) sets a search radius around the
// view center; flowlines are ranked by distance from that center to their
// bounding box and capped so a zoomed-out preserve never loads every file.

import type Point from '@arcgis/core/geometry/Point';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import type SceneView from '@arcgis/core/views/SceneView';
import type { FlowlineIndexEntry } from './modeled-water-data-store';

/** Most flowlines fetched for one camera view. */
export const MAX_FLOWLINES_IN_VIEW = 16;
const MIN_RADIUS_M = 300;
const MAX_RADIUS_M = 20000;
const EARTH_RADIUS_M = 6378137;

export interface VisibleFlowlineSelection {
  /** Nearest first, within the search radius, capped. */
  tncComids: string[];
  /** Flowlines inside the radius before the cap, for the status line. */
  inRadiusCount: number;
  centerWgs84: readonly [number, number] | null;
  radiusM: number;
}

export function selectVisibleFlowlines(
  view: SceneView,
  flowlines: readonly FlowlineIndexEntry[],
): VisibleFlowlineSelection {
  const center = view.center ? toLonLat(view.center) : null;
  if (!center) return { tncComids: [], inRadiusCount: 0, centerWgs84: null, radiusM: 0 };
  const radiusM = searchRadiusM(view);
  const ranked = flowlines
    .map((flowline) => ({ flowline, distanceM: distanceToBboxM(center, flowline.bboxWgs84) }))
    .filter((item) => item.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
  return {
    tncComids: ranked.slice(0, MAX_FLOWLINES_IN_VIEW).map((item) => item.flowline.tncComid),
    inRadiusCount: ranked.length,
    centerWgs84: center,
    radiusM,
  };
}

function searchRadiusM(view: SceneView): number {
  const extent = view.extent;
  let radiusM: number | null = null;
  if (extent && Number.isFinite(extent.width) && Number.isFinite(extent.height)) {
    const wkid = extent.spatialReference?.wkid;
    if (wkid === 4326 || wkid === 4269) {
      const latRadians = (((extent.ymin + extent.ymax) / 2) * Math.PI) / 180;
      const widthM = ((extent.width * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(latRadians);
      const heightM = ((extent.height * Math.PI) / 180) * EARTH_RADIUS_M;
      radiusM = Math.max(widthM, heightM) / 2;
    } else {
      radiusM = Math.max(extent.width, extent.height) / 2;
    }
  }
  if (radiusM == null || !Number.isFinite(radiusM)) {
    const altitudeM = view.camera?.position?.z;
    radiusM = typeof altitudeM === 'number' && Number.isFinite(altitudeM) ? altitudeM * 1.5 : MIN_RADIUS_M;
  }
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, radiusM));
}

/** Equirectangular distance in meters from a point to the nearest edge of a lon/lat box. Zero inside. */
function distanceToBboxM(
  [lon, lat]: readonly [number, number],
  [minLon, minLat, maxLon, maxLat]: readonly [number, number, number, number],
): number {
  const nearestLon = Math.min(Math.max(lon, minLon), maxLon);
  const nearestLat = Math.min(Math.max(lat, minLat), maxLat);
  const latRadians = (lat * Math.PI) / 180;
  const dx = ((nearestLon - lon) * Math.PI / 180) * EARTH_RADIUS_M * Math.cos(latRadians);
  const dy = ((nearestLat - lat) * Math.PI / 180) * EARTH_RADIUS_M;
  return Math.hypot(dx, dy);
}

function toLonLat(point: Point): readonly [number, number] | null {
  const wkid = point.spatialReference?.wkid;
  let geographic: Point | null = point;
  if (!(wkid === 4326 || wkid === 4269 || (Math.abs(point.x) <= 180 && Math.abs(point.y) <= 90))) {
    const converted = webMercatorUtils.webMercatorToGeographic(point);
    geographic = converted && converted.type === 'point' ? (converted as Point) : null;
  }
  if (!geographic) return null;
  const { longitude, latitude } = geographic;
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return [longitude, latitude];
}
