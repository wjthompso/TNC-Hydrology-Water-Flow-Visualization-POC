import {
  ASSIGNMENT_METHOD,
  GAUGE_DATUM_FT,
  MONITORING_LOCATION_ID,
  OBSERVATION_STATION_ID,
  SEGMENT_NETWORK_VERSION,
} from './constants.ts';
import { expectNumber, expectRecord, expectString, isRecord } from './json-files.ts';
import type { CreekSegment } from './tnc-flowline-segmentation.ts';
import {
  distancePointToSegment,
  roundToDecimals,
  utm10nToWgs84,
  type UtmPoint,
} from './utm-geometry.ts';

export interface MonitoringStationLocation {
  stationId: string;
  sourceName: string;
  observationStationId: number;
  utm: UtmPoint;
  locationWgs84: [number, number];
}

export interface ReviewedMonitoringStationAssignment {
  stationId: string;
  comid: number;
  segmentId: string;
  vertexIndexStart: number;
  vertexIndexEnd: number;
  snapDistanceM: number;
  method: string;
  runnerUpSegmentId: string;
  runnerUpSnapDistanceM: number;
  segmentNetworkVersion: string;
}

export interface MonitoringStationAssignment {
  reviewed: ReviewedMonitoringStationAssignment;
  segment: CreekSegment;
  locationWgs84: [number, number];
  sourceName: string;
}

function expectWkid32610(response: Record<string, unknown>): void {
  if (!('spatialReference' in response)) throw new Error('Monitoring station spatial reference is missing.');
  const spatialReference = response.spatialReference;
  if (!isRecord(spatialReference)) throw new Error('Monitoring station spatial reference is not an object.');
  const wkid = spatialReference.wkid ?? spatialReference.latestWkid;
  if (wkid !== 32610) {
    throw new Error(`Monitoring station spatial reference is ${String(wkid)}, expected EPSG 32610.`);
  }
}

export function readMonitoringStation(stationResponse: unknown): MonitoringStationLocation {
  const response = expectRecord(stationResponse, 'Monitoring station');
  expectWkid32610(response);
  if (!Array.isArray(response.features) || response.features.length !== 1) {
    throw new Error(
      `Monitoring station returned ${Array.isArray(response.features) ? response.features.length : 0} features, expected 1.`,
    );
  }
  const feature = expectRecord(response.features[0], 'Monitoring station feature');
  const attributes = expectRecord(feature.attributes, 'Monitoring station attributes');
  const stationId = expectString(attributes, 'monitoring_location_id', 'Monitoring station');
  if (stationId !== MONITORING_LOCATION_ID) {
    throw new Error(`Monitoring station id is ${stationId}, expected ${MONITORING_LOCATION_ID}.`);
  }
  const observationStationId = expectNumber(attributes, 'station_id', 'Monitoring station');
  if (observationStationId !== OBSERVATION_STATION_ID) {
    throw new Error(
      `Monitoring station table id is ${observationStationId}, expected ${OBSERVATION_STATION_ID}.`,
    );
  }
  const elevationFt = expectNumber(attributes, 'elevation', 'Monitoring station');
  if (roundToDecimals(elevationFt, 2) !== GAUGE_DATUM_FT) {
    throw new Error(
      `Monitoring station elevation is ${elevationFt} ft, expected gauge datum ${GAUGE_DATUM_FT} ft NAVD88.`,
    );
  }

  const geometry = expectRecord(feature.geometry, 'Monitoring station geometry');
  const utm = {
    x: expectNumber(geometry, 'x', 'Monitoring station geometry'),
    y: expectNumber(geometry, 'y', 'Monitoring station geometry'),
  };
  const longitude = expectNumber(attributes, 'longitude', 'Monitoring station');
  const latitude = expectNumber(attributes, 'latitude', 'Monitoring station');
  const [projectedLongitude, projectedLatitude] = utm10nToWgs84(utm.x, utm.y);
  if (
    Math.abs(projectedLongitude - longitude) > 1e-6 ||
    Math.abs(projectedLatitude - latitude) > 1e-6
  ) {
    throw new Error(
      `Monitoring station WGS84 attributes (${longitude}, ${latitude}) disagree with the EPSG 32610 point.`,
    );
  }

  return {
    stationId,
    sourceName: expectString(attributes, 'station_name', 'Monitoring station'),
    observationStationId,
    utm,
    locationWgs84: [roundToDecimals(longitude, 7), roundToDecimals(latitude, 7)],
  };
}

/** Nearest original-vertex Creek Segment, measured in EPSG 32610. */
export function assignMonitoringStation(
  station: MonitoringStationLocation,
  segments: CreekSegment[],
): MonitoringStationAssignment {
  if (segments.length < 2) {
    throw new Error('Monitoring Station Assignment needs at least two Creek Segments so a runner-up exists.');
  }
  const ranked = segments
    .map((segment) => ({
      segment,
      distanceM: distancePointToSegment(station.utm, segment.startUtm, segment.endUtm),
    }))
    .sort(
      (left, right) =>
        left.distanceM - right.distanceM ||
        left.segment.vertexIndexStart - right.segment.vertexIndexStart,
    );
  const nearest = ranked[0];
  const runnerUp = ranked[1];
  if (!nearest || !runnerUp) {
    throw new Error('Monitoring Station Assignment could not rank Creek Segments.');
  }

  return {
    reviewed: {
      stationId: station.stationId,
      comid: nearest.segment.comid,
      segmentId: nearest.segment.segmentId,
      vertexIndexStart: nearest.segment.vertexIndexStart,
      vertexIndexEnd: nearest.segment.vertexIndexEnd,
      snapDistanceM: roundToDecimals(nearest.distanceM, 2),
      method: ASSIGNMENT_METHOD,
      runnerUpSegmentId: runnerUp.segment.segmentId,
      runnerUpSnapDistanceM: roundToDecimals(runnerUp.distanceM, 2),
      segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    },
    segment: nearest.segment,
    locationWgs84: station.locationWgs84,
    sourceName: station.sourceName,
  };
}
