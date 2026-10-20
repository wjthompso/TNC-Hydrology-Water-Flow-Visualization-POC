import { SEGMENT_NETWORK_VERSION } from './constants.ts';
import type { ReviewedMonitoringStationAssignment } from './monitoring-station-assignment.ts';
import type { ObservedTimeSeriesDocument } from './observed-time-series-publication.ts';
import type { CorridorBoundingBox, WaterSurfacePolygonBucket } from './water-surface-polygon-generation.ts';

export interface PublishedCreekSegment {
  segmentId: string;
  comid: number;
  vertexIndexStart: number;
  vertexIndexEnd: number;
  lengthM: number;
  pathWgs84: number[][];
}

export interface PublishedCreekSegments {
  segmentNetworkVersion: string;
  creekSegments: PublishedCreekSegment[];
}

export interface PublishedWaterSurfacePolygonSets {
  segmentNetworkVersion: string;
  waterSurfacePolygonSets: Array<{
    segmentId: string;
    elevationBuckets: WaterSurfacePolygonBucket[];
  }>;
}

export interface PublishedMonitoringStations {
  segmentNetworkVersion: string;
  monitoringStations: Array<{
    stationId: string;
    name: string;
    segmentId: string;
    observedSourceId: string;
    locationWgs84: [number, number];
    snapDistanceM: number;
  }>;
}

export interface PublishedDataSourceMetadata {
  dataSources: Array<{
    sourceId: string;
    name: string;
    kind: string;
  }>;
}

export interface SegmentNetworkRelease {
  creekSegments: PublishedCreekSegments;
  waterSurfacePolygonSets: PublishedWaterSurfacePolygonSets;
  monitoringStations: PublishedMonitoringStations;
  dataSourceMetadata: PublishedDataSourceMetadata;
  timeSeries: ObservedTimeSeriesDocument;
  assignment: ReviewedMonitoringStationAssignment;
  corridorBboxBySegmentId: ReadonlyMap<string, CorridorBoundingBox>;
}

function containsWaterSurfaceElevation(bucket: WaterSurfacePolygonBucket, elevation: number): boolean {
  const value = Math.round(elevation * 1000);
  const minimum = Math.round(bucket.minWaterSurfaceElevationM * 1000);
  const maximum = Math.round(bucket.maxWaterSurfaceElevationM * 1000);
  return value >= minimum && value < maximum;
}

function validateBuckets(buckets: WaterSurfacePolygonBucket[], segmentId: string, problems: string[]): void {
  if (buckets.length === 0) {
    problems.push(`${segmentId} has no elevation buckets.`);
    return;
  }
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (!bucket) continue;
    const minimum = Math.round(bucket.minWaterSurfaceElevationM * 1000);
    const maximum = Math.round(bucket.maxWaterSurfaceElevationM * 1000);
    if (!(maximum > minimum)) {
      problems.push(`${segmentId} bucket ${bucket.minWaterSurfaceElevationM} is not a positive interval.`);
    }
    const previous = buckets[index - 1];
    if (!previous) continue;
    const previousMinimum = Math.round(previous.minWaterSurfaceElevationM * 1000);
    const previousMaximum = Math.round(previous.maxWaterSurfaceElevationM * 1000);
    if (minimum <= previousMinimum) {
      problems.push(`${segmentId} buckets are not ascending at ${bucket.minWaterSurfaceElevationM} m.`);
    }
    if (minimum < previousMaximum) {
      problems.push(`${segmentId} buckets overlap at ${previous.maxWaterSurfaceElevationM} m.`);
    }
    if (minimum > previousMaximum) {
      problems.push(
        `${segmentId} buckets have a gap between ${previous.maxWaterSurfaceElevationM} and ${bucket.minWaterSurfaceElevationM} m.`,
      );
    }
  }
}

function validateRings(
  buckets: WaterSurfacePolygonBucket[],
  segmentId: string,
  bbox: CorridorBoundingBox,
  problems: string[],
): void {
  const epsilon = 1e-6;
  for (const bucket of buckets) {
    for (const ring of bucket.ringsWgs84) {
      if (ring.length < 4) {
        problems.push(
          `${segmentId} bucket ${bucket.minWaterSurfaceElevationM} m has a ring with ${ring.length} positions.`,
        );
        continue;
      }
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
        problems.push(`${segmentId} bucket ${bucket.minWaterSurfaceElevationM} m has a ring that is not closed.`);
      }
      for (const position of ring) {
        const longitude = position[0];
        const latitude = position[1];
        if (
          typeof longitude !== 'number' ||
          typeof latitude !== 'number' ||
          !Number.isFinite(longitude) ||
          !Number.isFinite(latitude)
        ) {
          problems.push(
            `${segmentId} bucket ${bucket.minWaterSurfaceElevationM} m has a non-finite ring coordinate.`,
          );
          break;
        }
        if (
          longitude < bbox.west - epsilon ||
          longitude > bbox.east + epsilon ||
          latitude < bbox.south - epsilon ||
          latitude > bbox.north + epsilon
        ) {
          problems.push(
            `${segmentId} bucket ${bucket.minWaterSurfaceElevationM} m coordinate [${longitude}, ${latitude}] is outside the corridor bounding box.`,
          );
          break;
        }
      }
    }
  }
}

export function validateSegmentNetworkRelease(release: SegmentNetworkRelease): void {
  const problems: string[] = [];
  const versions: Array<[string, string]> = [
    ['creek-segments.json', release.creekSegments.segmentNetworkVersion],
    ['water-surface-polygon-sets.json', release.waterSurfacePolygonSets.segmentNetworkVersion],
    ['monitoring-stations.json', release.monitoringStations.segmentNetworkVersion],
    ['usgs-11120600-observed-wse.json', release.timeSeries.segmentNetworkVersion],
    ['monitoring-station-assignment-usgs-11120600.json', release.assignment.segmentNetworkVersion],
  ];
  for (const [fileName, version] of versions) {
    if (version !== SEGMENT_NETWORK_VERSION) {
      problems.push(`${fileName} segmentNetworkVersion is ${version}, expected ${SEGMENT_NETWORK_VERSION}.`);
    }
  }

  const segmentsById = new Map<string, PublishedCreekSegment>();
  for (const segment of release.creekSegments.creekSegments) {
    if (segmentsById.has(segment.segmentId)) problems.push(`Duplicate Creek Segment id ${segment.segmentId}.`);
    segmentsById.set(segment.segmentId, segment);
  }

  const resolveSegment = (segmentId: string, owner: string) => {
    if (!segmentsById.has(segmentId)) problems.push(`${owner} segmentId ${segmentId} does not resolve.`);
  };

  resolveSegment(release.assignment.segmentId, 'Monitoring Station Assignment');
  const assigned = segmentsById.get(release.assignment.segmentId);
  if (
    assigned &&
    (assigned.vertexIndexStart !== release.assignment.vertexIndexStart ||
      assigned.vertexIndexEnd !== release.assignment.vertexIndexEnd ||
      assigned.comid !== release.assignment.comid)
  ) {
    problems.push('Monitoring Station Assignment vertices do not match the Creek Segment record.');
  }

  const polygonSets = new Map<string, WaterSurfacePolygonBucket[]>();
  for (const polygonSet of release.waterSurfacePolygonSets.waterSurfacePolygonSets) {
    resolveSegment(polygonSet.segmentId, 'Water-surface polygon set');
    polygonSets.set(polygonSet.segmentId, polygonSet.elevationBuckets);
    validateBuckets(polygonSet.elevationBuckets, polygonSet.segmentId, problems);
    const bbox = release.corridorBboxBySegmentId.get(polygonSet.segmentId);
    if (!bbox) {
      problems.push(`No corridor bounding box for Creek Segment ${polygonSet.segmentId}.`);
    } else {
      validateRings(polygonSet.elevationBuckets, polygonSet.segmentId, bbox, problems);
    }
  }

  const sourceIds = new Set(release.dataSourceMetadata.dataSources.map((source) => source.sourceId));
  for (const station of release.monitoringStations.monitoringStations) {
    resolveSegment(station.segmentId, `Monitoring station ${station.stationId}`);
    if (!sourceIds.has(station.observedSourceId)) {
      problems.push(
        `Monitoring station ${station.stationId} observedSourceId ${station.observedSourceId} is missing from data-source-metadata.json.`,
      );
    }
    if (station.segmentId === release.assignment.segmentId && station.snapDistanceM !== release.assignment.snapDistanceM) {
      problems.push('Published snap distance does not match the Monitoring Station Assignment.');
    }
  }
  if (!sourceIds.has(release.timeSeries.sourceId)) {
    problems.push(`Time series sourceId ${release.timeSeries.sourceId} is missing from data-source-metadata.json.`);
  }

  const timestamps = release.timeSeries.timestampsUtcMs;
  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1];
    const current = timestamps[index];
    if (previous === undefined || current === undefined || !(current > previous)) {
      problems.push(`timestampsUtcMs is not strictly ascending at index ${index}.`);
      break;
    }
  }

  for (const series of release.timeSeries.segments) {
    resolveSegment(series.segmentId, 'Observed time series');
    if (series.waterSurfaceElevationM.length !== timestamps.length) {
      problems.push(
        `${series.segmentId} waterSurfaceElevationM length ${series.waterSurfaceElevationM.length} does not match ${timestamps.length} timestamps.`,
      );
    }
    const buckets = polygonSets.get(series.segmentId);
    if (!buckets) {
      problems.push(
        `Time series segment ${series.segmentId} has no water-surface polygon set, so its elevations cannot be checked against buckets.`,
      );
      continue;
    }
    for (const elevation of series.waterSurfaceElevationM) {
      if (elevation === null) continue;
      if (!Number.isFinite(elevation)) {
        problems.push(`${series.segmentId} has a non-finite water-surface elevation.`);
        break;
      }
      if (!buckets.some((bucket) => containsWaterSurfaceElevation(bucket, elevation))) {
        problems.push(
          `Water-surface elevation ${elevation} m on ${series.segmentId} does not fall in any bucket.`,
        );
        break;
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Segment Network Release Validation failed:\n- ${problems.join('\n- ')}`);
  }
}
