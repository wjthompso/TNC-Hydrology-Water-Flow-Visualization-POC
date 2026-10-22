import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  ASSIGNMENT_FILE,
  CROSS_SECTION_BEDS_SNAPSHOT_FILE,
  ELEVATION_SNAPSHOT_FILE,
  NEIGHBOUR_POLYGON_SET_SNAPSHOT_FILE,
  OBSERVED_WSE_PROPAGATION_PUBLISHED_FILE,
  FLOWLINE_SNAPSHOT_FILE,
  OBSERVED_POLYGON_SET_SNAPSHOT_FILE,
  OBSERVED_SOURCE_ID,
  OBSERVED_SOURCE_NAME,
  OBSERVATIONS_SNAPSHOT_FILE,
  PUBLISHED_STATION_NAME,
  SEGMENT_NETWORK_VERSION,
  STATION_SNAPSHOT_FILE,
  publishedDirectory,
  sourceInputsDirectory,
} from './constants.ts';
import { adjacentSegmentsById } from './creek-segment-adjacency.ts';
import { readJson, writeCompactJson, writePrettyJson } from './json-files.ts';
import { assignMonitoringStation, readMonitoringStation } from './monitoring-station-assignment.ts';
import { buildObservedTimeSeries } from './observed-time-series-publication.ts';
import {
  buildObservedWsePropagationDocument,
  corridorReachBoundingBox,
  countReadingsWithoutPropagation,
  inferredReadingsOutsideLadders,
  propagationNodesById,
  readCrossSectionBedsSnapshot,
} from './observed-wse-propagation-publication.ts';
import { OBSERVED_WSE_PROPAGATION } from './observed-wse-propagation.ts';
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
  /** Where the reviewed monitoring-station assignment is written. Default: the tracked source inputs folder, data/source-inputs/. */
  assignmentOutputPath?: string;
}

/**
 * Rebuild the published Creek Visualization Data from the retained source snapshots (no network).
 * Importing this module does not run it; `npm run pipeline:publish` does. Tests pass temp
 * directories so the committed files are never overwritten.
 */
export async function publishCreekVisualizationData(options: PublishCreekVisualizationDataOptions = {}): Promise<void> {
  const outputDirectory = options.outputDirectory ?? publishedDirectory;
  const assignmentOutputPath = options.assignmentOutputPath ?? path.join(sourceInputsDirectory, ASSIGNMENT_FILE);
  const flowline = await readJson(path.join(sourceInputsDirectory, FLOWLINE_SNAPSHOT_FILE));
  const stationResponse = await readJson(path.join(sourceInputsDirectory, STATION_SNAPSHOT_FILE));
  const observations = await readJson(path.join(sourceInputsDirectory, OBSERVATIONS_SNAPSHOT_FILE));
  const segments = segmentTncFlowline(flowline);
  const station = readMonitoringStation(stationResponse);
  const assignment = assignMonitoringStation(station, segments);
  const observed = buildObservedTimeSeries(observations, assignment.reviewed.segmentId);
  const series = observed.document.segments[0];
  if (!series) throw new Error('Observed time series did not include the assigned Creek Segment.');

  // Observed water draws the modeled pipeline's Stage 4 polygons for the gauge's Creek Segment,
  // copied from a reviewed retained snapshot, so observed and modeled water share one polygon set.
  const polygonSetSnapshotPath = path.join(sourceInputsDirectory, OBSERVED_POLYGON_SET_SNAPSHOT_FILE);
  const waterSurfacePolygonSets = (await readJson(polygonSetSnapshotPath)) as PublishedWaterSurfacePolygonSets;
  const snapshotSegmentIds = waterSurfacePolygonSets.waterSurfacePolygonSets.map((polygonSet) => polygonSet.segmentId);
  if (snapshotSegmentIds.length !== 1 || snapshotSegmentIds[0] !== assignment.segment.segmentId) {
    throw new Error(
      `${OBSERVED_POLYGON_SET_SNAPSHOT_FILE} must hold exactly the assigned Creek Segment ${assignment.segment.segmentId}; it holds ${snapshotSegmentIds.join(', ') || 'none'}.`,
    );
  }
  const elevationBuckets = waterSurfacePolygonSets.waterSurfacePolygonSets[0]?.elevationBuckets ?? [];

  // Creek Segment Observed WSE Propagation (UCS-300): the gauge segment's neighbours get inferred
  // water. Their polygons are a reviewed Stage 4 snapshot, published after the gauge segment's set.
  const beds = readCrossSectionBedsSnapshot(await readJson(path.join(sourceInputsDirectory, CROSS_SECTION_BEDS_SNAPSHOT_FILE)));
  const propagationNodes = propagationNodesById(segments, beds);
  const propagation = buildObservedWsePropagationDocument(
    assignment.segment.segmentId,
    propagationNodes,
    beds.flowDirection,
    OBSERVED_WSE_PROPAGATION.hopsPerDirection,
  );
  const neighbourPolygonSetsPath = path.join(sourceInputsDirectory, NEIGHBOUR_POLYGON_SET_SNAPSHOT_FILE);
  const neighbourPolygonSets = (await readJson(neighbourPolygonSetsPath)) as PublishedWaterSurfacePolygonSets;
  const expectedNeighbourIds = propagation.segments.filter((segment) => segment.role !== 'gauge').map((segment) => segment.segmentId);
  const retainedNeighbourIds = neighbourPolygonSets.waterSurfacePolygonSets.map((polygonSet) => polygonSet.segmentId);
  if (expectedNeighbourIds.join() !== retainedNeighbourIds.join()) {
    throw new Error(
      `${NEIGHBOUR_POLYGON_SET_SNAPSHOT_FILE} holds ${retainedNeighbourIds.join(', ') || 'none'} but ${OBSERVED_WSE_PROPAGATION.hopsPerDirection} hops each way need ${expectedNeighbourIds.join(', ')}. ` +
        'Rerun retain-observed-wse-propagation-inputs.ts.',
    );
  }
  const publishedPolygonSets: PublishedWaterSurfacePolygonSets = {
    segmentNetworkVersion: waterSurfacePolygonSets.segmentNetworkVersion,
    waterSurfacePolygonSets: [...waterSurfacePolygonSets.waterSurfacePolygonSets, ...neighbourPolygonSets.waterSurfacePolygonSets],
  };

  // Stage 4 cuts each corridor end at the junction bisector, so the corridor bounding box the
  // release validation checks rings against must use the same neighbours. Tracing zero buckets
  // only measures that corridor on the retained USGS 3DEP window; it draws no polygon.
  const corridor = await generateWaterSurfacePolygons({
    elevationRasterPath: path.join(sourceInputsDirectory, ELEVATION_SNAPSHOT_FILE),
    segment: assignment.segment,
    buckets: [],
    adjacentSegments: adjacentSegmentsById(segments).get(assignment.segment.segmentId) ?? {},
    logProgress: false,
  });

  const corridorBboxBySegmentId = new Map([[assignment.segment.segmentId, corridor.corridorBboxWgs84]]);
  for (const segment of segments) {
    if (expectedNeighbourIds.includes(segment.segmentId)) corridorBboxBySegmentId.set(segment.segmentId, corridorReachBoundingBox(segment.pathWgs84));
  }

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
    waterSurfacePolygonSets: publishedPolygonSets,
    monitoringStations,
    dataSourceMetadata,
    timeSeries: observed.document,
    assignment: assignment.reviewed,
    corridorBboxBySegmentId,
  });
  const propagationProblems = inferredReadingsOutsideLadders(
    propagation,
    series.waterSurfaceElevationM,
    new Map(publishedPolygonSets.waterSurfacePolygonSets.map((polygonSet) => [polygonSet.segmentId, polygonSet.elevationBuckets])),
  );
  if (propagationProblems.length > 0) {
    throw new Error(`Observed WSE propagation validation failed:\n- ${propagationProblems.join('\n- ')}`);
  }

  await writePrettyJson(path.join(outputDirectory, 'creek-segments.json'), creekSegments);
  await mkdir(outputDirectory, { recursive: true });
  await writePrettyJson(path.join(outputDirectory, 'water-surface-polygon-sets.json'), publishedPolygonSets);
  await writePrettyJson(path.join(outputDirectory, OBSERVED_WSE_PROPAGATION_PUBLISHED_FILE), propagation);
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
  const gaugeBedM = propagation.segments.find((segment) => segment.role === 'gauge')?.bedElevationM ?? Number.NaN;
  console.log(
    `Observed WSE propagation: ${OBSERVED_WSE_PROPAGATION.hopsPerDirection} Creek Segments each way (${expectedNeighbourIds.join(', ')}); ` +
      `${countReadingsWithoutPropagation(series.waterSurfaceElevationM, gaugeBedM)} readings sit at or below the gauge segment bed (${gaugeBedM} m) and propagate nothing.`,
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
