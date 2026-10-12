import path from 'node:path';
import process from 'node:process';
import {
  ASSIGNMENT_FILE,
  ELEVATION_SNAPSHOT_FILE,
  FLOWLINE_SNAPSHOT_FILE,
  OBSERVED_SOURCE_ID,
  OBSERVED_SOURCE_NAME,
  OBSERVATIONS_SNAPSHOT_FILE,
  PUBLISHED_STATION_NAME,
  SEGMENT_NETWORK_VERSION,
  STATION_SNAPSHOT_FILE,
  publishedDirectory,
  retainedSourceDirectory,
} from './constants.ts';
import { readJson, writeCompactJson, writePrettyJson } from './json-files.ts';
import { assignMonitoringStation, readMonitoringStation } from './monitoring-station-assignment.ts';
import { buildObservedTimeSeries } from './observed-time-series-publication.ts';
import { validateSegmentNetworkRelease } from './segment-network-release-validation.ts';
import type { CreekSegment } from './tnc-flowline-segmentation.ts';
import { segmentTncFlowline } from './tnc-flowline-segmentation.ts';
import { buildWaterSurfaceElevationBuckets, generateWaterSurfacePolygons } from './water-surface-polygon-generation.ts';

function publishedCreekSegment(segment: CreekSegment) {
  return {
    segmentId: segment.segmentId,
    comid: segment.comid,
    vertexIndexStart: segment.vertexIndexStart,
    vertexIndexEnd: segment.vertexIndexEnd,
    lengthM: segment.lengthM,
    pathWgs84: segment.pathWgs84,
  };
}

async function publishCreekVisualizationData(): Promise<void> {
  const flowline = await readJson(path.join(retainedSourceDirectory, FLOWLINE_SNAPSHOT_FILE));
  const stationResponse = await readJson(path.join(retainedSourceDirectory, STATION_SNAPSHOT_FILE));
  const observations = await readJson(path.join(retainedSourceDirectory, OBSERVATIONS_SNAPSHOT_FILE));
  const segments = segmentTncFlowline(flowline);
  const station = readMonitoringStation(stationResponse);
  const assignment = assignMonitoringStation(station, segments);
  const observed = buildObservedTimeSeries(observations, assignment.reviewed.segmentId);
  const series = observed.document.segments[0];
  if (!series) throw new Error('Observed time series did not include the assigned Creek Segment.');
  const buckets = buildWaterSurfaceElevationBuckets(series.waterSurfaceElevationM);
  const polygons = await generateWaterSurfacePolygons({
    elevationRasterPath: path.join(retainedSourceDirectory, ELEVATION_SNAPSHOT_FILE),
    segment: assignment.segment,
    buckets,
  });

  const creekSegments = {
    segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    creekSegments: segments.map(publishedCreekSegment),
  };
  const waterSurfacePolygonSets = {
    segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    waterSurfacePolygonSets: [
      {
        segmentId: assignment.segment.segmentId,
        elevationBuckets: polygons.elevationBuckets,
      },
    ],
  };
  const monitoringStations = {
    segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    monitoringStations: [
      {
        stationId: assignment.reviewed.stationId,
        name: PUBLISHED_STATION_NAME,
        segmentId: assignment.reviewed.segmentId,
        observedSourceId: OBSERVED_SOURCE_ID,
        locationWgs84: assignment.locationWgs84,
        snapDistanceM: assignment.reviewed.snapDistanceM,
      },
    ],
  };
  const dataSourceMetadata = {
    dataSources: [
      {
        sourceId: OBSERVED_SOURCE_ID,
        name: OBSERVED_SOURCE_NAME,
        kind: 'observed',
      },
    ],
  };

  validateSegmentNetworkRelease({
    creekSegments,
    waterSurfacePolygonSets,
    monitoringStations,
    dataSourceMetadata,
    timeSeries: observed.document,
    assignment: assignment.reviewed,
    corridorBboxBySegmentId: new Map([[assignment.segment.segmentId, polygons.corridorBboxWgs84]]),
  });

  await writePrettyJson(path.join(publishedDirectory, 'creek-segments.json'), creekSegments);
  await writePrettyJson(path.join(publishedDirectory, 'water-surface-polygon-sets.json'), waterSurfacePolygonSets);
  await writePrettyJson(path.join(publishedDirectory, 'monitoring-stations.json'), monitoringStations);
  await writePrettyJson(path.join(publishedDirectory, 'data-source-metadata.json'), dataSourceMetadata);
  await writeCompactJson(
    path.join(publishedDirectory, 'creek-segment-time-series', `${OBSERVED_SOURCE_ID}.json`),
    observed.document,
  );
  await writePrettyJson(path.join(retainedSourceDirectory, ASSIGNMENT_FILE), assignment.reviewed);

  const firstBucket = buckets[0];
  const lastBucket = buckets[buckets.length - 1];
  const emptyText =
    polygons.emptyBuckets.length === 0
      ? 'none'
      : polygons.emptyBuckets
          .map((bucket) => `${bucket.minWaterSurfaceElevationM}–${bucket.maxWaterSurfaceElevationM}`)
          .join(', ');
  const duplicateText =
    observed.droppedDuplicateIds.length === 0
      ? 'no duplicate timestamps'
      : `${observed.duplicateTimestampCount} duplicate timestamps, dropped ids ${observed.droppedDuplicateIds.join(', ')}`;
  console.log('Segment Network Release Validation passed.');
  console.log(
    `Assigned ${assignment.reviewed.stationId} (${assignment.sourceName}) to Creek Segment ${assignment.reviewed.segmentId} at ${assignment.reviewed.snapDistanceM} m; runner-up ${assignment.reviewed.runnerUpSegmentId} at ${assignment.reviewed.runnerUpSnapDistanceM} m.`,
  );
  console.log(
    `Observed series: ${observed.rowCount} timestamps, ${observed.nullCount} null water-surface elevations, ${duplicateText}.`,
  );
  console.log(
    `Elevation buckets: ${buckets.length} from ${firstBucket?.minWaterSurfaceElevationM} to ${lastBucket?.maxWaterSurfaceElevationM} m. Empty polygons: ${emptyText}.`,
  );
  console.log(
    `Centerline ground elevation: ${polygons.centerlineElevationM.min.toFixed(2)}–${polygons.centerlineElevationM.max.toFixed(2)} m (${polygons.centerlineNoDataSamples} no-data samples).`,
  );
  console.log(`Published Creek Visualization Data in ${publishedDirectory}.`);
}

try {
  await publishCreekVisualizationData();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
