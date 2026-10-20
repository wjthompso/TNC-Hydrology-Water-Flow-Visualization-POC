import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  ASSIGNMENT_FILE,
  ELEVATION_SNAPSHOT_FILE,
  FLOWLINE_SNAPSHOT_FILE,
  OBSERVED_POLYGON_SET_SNAPSHOT_FILE,
  OBSERVED_SOURCE_ID,
  OBSERVED_SOURCE_NAME,
  OBSERVATIONS_SNAPSHOT_FILE,
  PUBLISHED_STATION_NAME,
  SEGMENT_NETWORK_VERSION,
  STATION_SNAPSHOT_FILE,
  publishedDirectory,
  retainedSourceDirectory,
} from './constants.ts';
import { adjacentSegmentsById } from './creek-segment-adjacency.ts';
import { readJson, writeCompactJson, writePrettyJson } from './json-files.ts';
import { assignMonitoringStation, readMonitoringStation } from './monitoring-station-assignment.ts';
import { buildObservedTimeSeries } from './observed-time-series-publication.ts';
import {
  validateSegmentNetworkRelease,
  type PublishedWaterSurfacePolygonSets,
} from './segment-network-release-validation.ts';
import type { CreekSegment } from './tnc-flowline-segmentation.ts';
import { segmentTncFlowline } from './tnc-flowline-segmentation.ts';
import { generateWaterSurfacePolygons } from './water-surface-polygon-generation.ts';

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

export interface PublishCreekVisualizationDataOptions {
  /** Where the published browser files go. Default: the app's public published-creek-visualization-data folder. */
  outputDirectory?: string;
  /** Where the reviewed monitoring-station assignment is written. Default: the retained source snapshot folder. */
  assignmentOutputPath?: string;
}

/**
 * Rebuild the published Creek Visualization Data from the retained source snapshots (no network).
 * Importing this module does not run it; `npm run pipeline:publish` does. Tests pass temp
 * directories so the committed files are never overwritten.
 */
export async function publishCreekVisualizationData(options: PublishCreekVisualizationDataOptions = {}): Promise<void> {
  const outputDirectory = options.outputDirectory ?? publishedDirectory;
  const assignmentOutputPath = options.assignmentOutputPath ?? path.join(retainedSourceDirectory, ASSIGNMENT_FILE);
  const flowline = await readJson(path.join(retainedSourceDirectory, FLOWLINE_SNAPSHOT_FILE));
  const stationResponse = await readJson(path.join(retainedSourceDirectory, STATION_SNAPSHOT_FILE));
  const observations = await readJson(path.join(retainedSourceDirectory, OBSERVATIONS_SNAPSHOT_FILE));
  const segments = segmentTncFlowline(flowline);
  const station = readMonitoringStation(stationResponse);
  const assignment = assignMonitoringStation(station, segments);
  const observed = buildObservedTimeSeries(observations, assignment.reviewed.segmentId);
  const series = observed.document.segments[0];
  if (!series) throw new Error('Observed time series did not include the assigned Creek Segment.');

  // Observed water draws the modeled pipeline's Stage 4 polygons for the gauge's Creek Segment,
  // copied from a reviewed retained snapshot, so observed and modeled water share one polygon set.
  const polygonSetSnapshotPath = path.join(retainedSourceDirectory, OBSERVED_POLYGON_SET_SNAPSHOT_FILE);
  const waterSurfacePolygonSets = (await readJson(polygonSetSnapshotPath)) as PublishedWaterSurfacePolygonSets;
  const snapshotSegmentIds = waterSurfacePolygonSets.waterSurfacePolygonSets.map((polygonSet) => polygonSet.segmentId);
  if (snapshotSegmentIds.length !== 1 || snapshotSegmentIds[0] !== assignment.segment.segmentId) {
    throw new Error(
      `${OBSERVED_POLYGON_SET_SNAPSHOT_FILE} must hold exactly the assigned Creek Segment ${assignment.segment.segmentId}; it holds ${snapshotSegmentIds.join(', ') || 'none'}.`,
    );
  }
  const elevationBuckets = waterSurfacePolygonSets.waterSurfacePolygonSets[0]?.elevationBuckets ?? [];

  // Stage 4 cuts each corridor end at the junction bisector, so the corridor bounding box the
  // release validation checks rings against must use the same neighbours. Tracing zero buckets
  // only measures that corridor on the retained USGS 3DEP window; it draws no polygon.
  const corridor = await generateWaterSurfacePolygons({
    elevationRasterPath: path.join(retainedSourceDirectory, ELEVATION_SNAPSHOT_FILE),
    segment: assignment.segment,
    buckets: [],
    adjacentSegments: adjacentSegmentsById(segments).get(assignment.segment.segmentId) ?? {},
    logProgress: false,
  });

  const creekSegments = {
    segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    creekSegments: segments.map(publishedCreekSegment),
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
    corridorBboxBySegmentId: new Map([[assignment.segment.segmentId, corridor.corridorBboxWgs84]]),
  });

  await writePrettyJson(path.join(outputDirectory, 'creek-segments.json'), creekSegments);
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(polygonSetSnapshotPath, path.join(outputDirectory, 'water-surface-polygon-sets.json'));
  await writePrettyJson(path.join(outputDirectory, 'monitoring-stations.json'), monitoringStations);
  await writePrettyJson(path.join(outputDirectory, 'data-source-metadata.json'), dataSourceMetadata);
  await writeCompactJson(
    path.join(outputDirectory, 'creek-segment-time-series', `${OBSERVED_SOURCE_ID}.json`),
    observed.document,
  );
  await writePrettyJson(assignmentOutputPath, assignment.reviewed);

  const firstBucket = elevationBuckets[0];
  const lastBucket = elevationBuckets[elevationBuckets.length - 1];
  const emptyBuckets = elevationBuckets.filter((bucket) => bucket.ringsWgs84.length === 0);
  const emptyText =
    emptyBuckets.length === 0
      ? 'none'
      : emptyBuckets.map((bucket) => `${bucket.minWaterSurfaceElevationM}–${bucket.maxWaterSurfaceElevationM}`).join(', ');
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
    `Water-surface polygons copied from ${OBSERVED_POLYGON_SET_SNAPSHOT_FILE}: ${elevationBuckets.length} elevation buckets from ${firstBucket?.minWaterSurfaceElevationM} to ${lastBucket?.maxWaterSurfaceElevationM} m. Empty polygons: ${emptyText}.`,
  );
  console.log(
    `Centerline ground elevation: ${corridor.centerlineElevationM.min.toFixed(2)}–${corridor.centerlineElevationM.max.toFixed(2)} m (${corridor.centerlineNoDataSamples} no-data samples).`,
  );
  console.log(`Published Creek Visualization Data in ${outputDirectory}.`);
}

const isCommandLineEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCommandLineEntryPoint) {
  try {
    await publishCreekVisualizationData();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
