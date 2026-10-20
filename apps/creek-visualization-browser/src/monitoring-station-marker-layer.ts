import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import type SceneView from '@arcgis/core/views/SceneView';
import type { CreekSegment, MonitoringStation } from './creek-data-contract';
import { STREAM_GAUGE_MAST, stationMarkerSymbol } from './station-marker-models';

export interface StationMarkerAttributes {
  readonly stationId: string;
  readonly name: string;
  readonly segmentId: string;
  readonly longitude: number;
  readonly latitude: number;
  /** Link to the USGS monitoring-location page for this station. */
  readonly websiteUrl: string | null;
}

/**
 * Derives the USGS waterdata monitoring-location URL from the station ID
 * when it follows the `USGS-{site_no}` naming convention.
 */
function usgsWebsiteUrl(stationId: string): string | null {
  const match = stationId.match(/^USGS-(\d+)$/);
  if (!match) return null;
  return `https://waterdata.usgs.gov/monitoring-location/${match[1]}`;
}

export const MONITORING_STATION_MARKER_LAYER_ID = 'monitoring-station-markers';

/**
 * The mast model's radar arm points east (+x) at heading 0. Turning by
 * `bearing - 90` swings it to face that bearing.
 */
const ARM_BEARING_AT_ZERO_HEADING_DEGREES = 90;

/**
 * Draws a stream gauge mast at each monitoring station's published location,
 * with its radar arm turned toward the station's Creek Segment. Returns the
 * layer and each placed station's attributes.
 */
export async function addMonitoringStationMarkers(
  view: SceneView,
  stations: readonly MonitoringStation[],
  segmentsById: ReadonlyMap<string, CreekSegment>,
): Promise<{ layer: GraphicsLayer; stations: StationMarkerAttributes[] }> {
  const placed: StationMarkerAttributes[] = [];
  const layer = new GraphicsLayer({
    id: MONITORING_STATION_MARKER_LAYER_ID,
    title: 'Monitoring stations',
    elevationInfo: { mode: 'relative-to-ground' },
  });
  view.map?.add(layer);

  for (const station of stations) {
    const [longitude, latitude] = station.locationWgs84;
    const segment = segmentsById.get(station.segmentId);
    const bearingToCreek = segment ? bearingToNearestPathPoint(station.locationWgs84, segment.pathWgs84) : null;
    const symbol = await stationMarkerSymbol(STREAM_GAUGE_MAST, {
      headingDegrees: bearingToCreek === null ? 0 : bearingToCreek - ARM_BEARING_AT_ZERO_HEADING_DEGREES,
    });
    const attrs: StationMarkerAttributes = {
      stationId: station.stationId,
      name: station.name,
      segmentId: station.segmentId,
      longitude,
      latitude,
      websiteUrl: usgsWebsiteUrl(station.stationId),
    };
    layer.add(
      new Graphic({
        geometry: new Point({ longitude, latitude, z: 0, spatialReference: { wkid: 4326 } }),
        symbol,
        attributes: attrs,
      }),
    );
    placed.push(attrs);
  }
  return { layer, stations: placed };
}

/**
 * Bearing (degrees clockwise from north) from `origin` to the closest point on
 * `path`. Null when the origin already sits on the path. Uses a local flat
 * projection, which is accurate over the few meters between a gauge and its creek.
 */
function bearingToNearestPathPoint(
  origin: readonly [number, number],
  path: readonly (readonly [number, number])[],
): number | null {
  const metersPerDegreeLon = 111320 * Math.cos((origin[1] * Math.PI) / 180);
  const metersPerDegreeLat = 110540;
  const toLocal = ([lon, lat]: readonly [number, number]): [number, number] => [
    (lon - origin[0]) * metersPerDegreeLon,
    (lat - origin[1]) * metersPerDegreeLat,
  ];

  let nearest: [number, number] | null = null;
  let nearestDistanceM = Infinity;
  for (let index = 0; index < path.length - 1; index += 1) {
    const [ax, ay] = toLocal(path[index]);
    const [bx, by] = toLocal(path[index + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    const candidate: [number, number] = [ax + t * dx, ay + t * dy];
    const distanceM = Math.hypot(candidate[0], candidate[1]);
    if (distanceM < nearestDistanceM) {
      nearestDistanceM = distanceM;
      nearest = candidate;
    }
  }
  if (!nearest || nearestDistanceM < 0.01) return null;
  const [east, north] = nearest;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}
