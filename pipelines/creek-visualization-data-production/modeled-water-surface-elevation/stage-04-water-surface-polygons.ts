import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeCompactJson } from '../json-files.ts';
import {
  corridorInsideElevationGrid,
  cropElevationGridToCorridor,
  generateWaterSurfacePolygons,
  readElevationGrid,
  type ElevationBucket,
  type ElevationBucketToTrace,
  type ElevationGrid,
} from '../water-surface-polygon-generation.ts';
import { roundToDecimals } from '../utm-geometry.ts';
import { adjacentSegmentsById, loadCreekSegmentNetwork } from './creek-segment-network.ts';
import { MODELED_EXTENT, POLYGON_LADDER, stageDirectory } from './pipeline-configuration.ts';
import { writeReadableJson } from './readable-json.ts';
import {
  CROSS_SECTIONS_FILE,
  POLYGON_LADDERS_FILE,
  WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME,
  downstreamVertexDirectionByTncComid,
  groupByTncComid,
  listTimeSeriesFiles,
  tncComidOfSegmentId,
  type CrossSectionsFile,
  type DownstreamVertexDirection,
  type PolygonLaddersFile,
  type WaterSurfaceElevationTimeSeriesFile,
  type WaterSurfacePolygonSetsFile,
} from './stage-file-formats.ts';
import { formatBytes, runStage, runStageEntryPoint, type StageResult } from './stage-manifest.ts';
import { TERRAIN_TILE_INDEX_FILE, readTerrainTileIndex } from './terrain-tiles.ts';

/**
 * Stage 4 — water-surface polygons. For every Creek Segment, build a ladder of elevation
 * buckets from the bed up to the highest modeled WSE plus headroom, and trace one prepared
 * water-surface polygon per bucket on the Stage 0 USGS 3DEP terrain. Polygon tracing reuses
 * publish's corridor width, 8-connectivity, and Bank-overlap margin, with two changes so
 * neighbouring Creek Segments meet cleanly:
 *
 * - Each corridor end is cut at the angle bisector of the two segments meeting at that vertex,
 *   so the upstream segment's downstream boundary and the downstream segment's upstream boundary
 *   are the same line and no wedge of bed is left uncovered at a bend.
 * - A bucket's wet threshold slopes from the segment's downstream junction WSE to its upstream
 *   junction WSE (the Stage 3 junction values, averaged over the timestamps whose value falls in
 *   that bucket), so the water covers the bed from junction to junction. It is never below the
 *   bucket minimum, and a bucket no modeled value falls in keeps the flat threshold.
 *
 * The flood fill seeds from the centerline and from each Stage 1 thalweg point, because the
 * TNC flowline often sits several meters off the channel's lowest ground. Polygon sets are
 * written as one compact `water-surface-polygon-sets/<tncComid>.json` per TNC flowline.
 */

const acquireDirectory = stageDirectory('acquire');
const crossSectionsDirectory = stageDirectory('crossSections');
const timeSeriesDirectory = stageDirectory('timeSeries');
const outputDirectory = stageDirectory('waterSurfacePolygons');

/** Millimeters avoid floating-point drift when stepping by 0.05 m. */
function toMilli(meters: number): number {
  return Math.round(meters * 1000);
}

/** The fine bucket a modeled value falls in, as the bucket minimum in millimeters. */
function fineBucketFloorMilli(waterSurfaceElevationM: number): number {
  const fineStep = toMilli(POLYGON_LADDER.fineStepM);
  return Math.floor(toMilli(waterSurfaceElevationM) / fineStep) * fineStep;
}

/** Running sums of the junction WSEs of every modeled value that fell in one bucket. */
interface JunctionWseSums {
  count: number;
  upstreamSumM: number;
  downstreamSumM: number;
}

interface ModeledWseSummary {
  /** Highest non-null value across every Time Series. */
  maxM: number;
  junctionSumsByBucketFloorMilli: Map<number, JunctionWseSums>;
}

/**
 * Half-open buckets: fine steps from the floor through the bucket holding the highest
 * modeled WSE, then coarse steps until the ladder top reaches that WSE + headroom.
 */
function buildPolygonLadder(
  bedElevationM: number,
  maxModeledWaterSurfaceElevationM: number,
): { buckets: ElevationBucket[]; fineBuckets: number; coarseBuckets: number } {
  const fineStep = toMilli(POLYGON_LADDER.fineStepM);
  const coarseStep = toMilli(POLYGON_LADDER.coarseStepM);
  const floor = Math.floor(toMilli(bedElevationM) / fineStep) * fineStep;
  const lastFineStart = Math.floor(toMilli(Math.max(bedElevationM, maxModeledWaterSurfaceElevationM)) / fineStep) * fineStep;
  const ceilingTarget = toMilli(maxModeledWaterSurfaceElevationM + POLYGON_LADDER.headroomAboveMaxModeledWseM);
  const buckets: ElevationBucket[] = [];
  let edge = floor;
  for (; edge <= lastFineStart; edge += fineStep) {
    buckets.push({ minWaterSurfaceElevationM: edge / 1000, maxWaterSurfaceElevationM: (edge + fineStep) / 1000 });
  }
  const fineBuckets = buckets.length;
  for (; edge < ceilingTarget; edge += coarseStep) {
    buckets.push({ minWaterSurfaceElevationM: edge / 1000, maxWaterSurfaceElevationM: (edge + coarseStep) / 1000 });
  }
  return { buckets, fineBuckets, coarseBuckets: buckets.length - fineBuckets };
}

/**
 * Per Creek Segment across every Stage 3 Time Series file: the highest value, and per fine bucket
 * the summed junction WSEs of the values that fell in it. A Time Series without junction arrays
 * (an older file) counts the value itself as both junction WSEs.
 */
async function modeledWseSummaryBySegment(): Promise<Map<string, ModeledWseSummary>> {
  const summaryBySegmentId = new Map<string, ModeledWseSummary>();
  const files = [...(await listTimeSeriesFiles(timeSeriesDirectory)).values()].flat();
  for (const relativePath of files) {
    const file = (await readJson(path.join(timeSeriesDirectory, relativePath))) as WaterSurfaceElevationTimeSeriesFile;
    for (const segment of file.segments) {
      const summary = summaryBySegmentId.get(segment.segmentId) ?? { maxM: -Infinity, junctionSumsByBucketFloorMilli: new Map() };
      summaryBySegmentId.set(segment.segmentId, summary);
      segment.values.forEach((value, index) => {
        if (value === null) return;
        summary.maxM = Math.max(summary.maxM, value);
        const floorMilli = fineBucketFloorMilli(value);
        const sums = summary.junctionSumsByBucketFloorMilli.get(floorMilli) ?? { count: 0, upstreamSumM: 0, downstreamSumM: 0 };
        sums.count += 1;
        sums.upstreamSumM += segment.junctionWseUpstreamM?.[index] ?? value;
        sums.downstreamSumM += segment.junctionWseDownstreamM?.[index] ?? value;
        summary.junctionSumsByBucketFloorMilli.set(floorMilli, sums);
      });
    }
  }
  return summaryBySegmentId;
}

/**
 * Gives each bucket a sloped wet threshold from its mean junction WSEs, mapped to the segment's
 * start and end vertices by the flowline's vertex direction. A bucket no value fell in stays flat.
 */
function withJunctionThresholds(
  buckets: readonly ElevationBucket[],
  summary: ModeledWseSummary | undefined,
  direction: DownstreamVertexDirection,
): ElevationBucketToTrace[] {
  return buckets.map((bucket) => {
    const sums = summary?.junctionSumsByBucketFloorMilli.get(toMilli(bucket.minWaterSurfaceElevationM));
    if (!sums) return { ...bucket };
    const upstreamM = roundToDecimals(sums.upstreamSumM / sums.count, 3);
    const downstreamM = roundToDecimals(sums.downstreamSumM / sums.count, 3);
    // Vertex order running downstream puts the upstream junction at the start vertex.
    const fillThreshold = direction === 1 ? { atStartM: upstreamM, atEndM: downstreamM } : { atStartM: downstreamM, atEndM: upstreamM };
    return { ...bucket, fillThreshold };
  });
}

async function terrainTilePaths(): Promise<string[]> {
  const index = readTerrainTileIndex(await readJson(path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE)));
  return index.tiles.map((tile) => path.join(acquireDirectory, tile.file));
}

async function buildWaterSurfacePolygons(): Promise<StageResult> {
  const segments = await loadCreekSegmentNetwork();
  const crossSections = (await readJson(path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE))) as CrossSectionsFile;
  const bedBySegmentId = new Map(crossSections.segments.map((section) => [section.segmentId, section.bedElevationM]));
  const thalwegPointsBySegmentId = new Map(
    crossSections.segments.map((record) => [record.segmentId, record.sections.map((section) => section.thalwegUtm)]),
  );
  const summaryBySegmentId = await modeledWseSummaryBySegment();
  const directionByTncComid = downstreamVertexDirectionByTncComid(crossSections);
  const adjacentById = adjacentSegmentsById(segments);
  const tiles: ElevationGrid[] = [];
  for (const tilePath of await terrainTilePaths()) tiles.push(await readElevationGrid(tilePath));

  const warnings: string[] = [];
  const polygonSets: WaterSurfacePolygonSetsFile['waterSurfacePolygonSets'] = [];
  const ladders: PolygonLaddersFile['segments'] = [];
  let totalBuckets = 0;
  let emptyBuckets = 0;
  let slopedBuckets = 0;
  let ringVertices = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    const bedElevationM = bedBySegmentId.get(segment.segmentId);
    if (bedElevationM === undefined) throw new Error(`Creek Segment ${segment.segmentId} has no Stage 1 bed elevation.`);
    const summary = summaryBySegmentId.get(segment.segmentId);
    const maxModeledM = summary?.maxM;
    if (maxModeledM === undefined) warnings.push(`${segment.segmentId} has no modeled WSE values; ladder covers bed + headroom only.`);
    const ladder = buildPolygonLadder(bedElevationM, maxModeledM ?? bedElevationM);
    const direction = directionByTncComid.get(tncComidOfSegmentId(segment.segmentId)) ?? 1;
    const buckets = withJunctionThresholds(ladder.buckets, summary, direction);
    const adjacent = adjacentById.get(segment.segmentId) ?? {};
    const tile = tiles.find((candidate) => corridorInsideElevationGrid(candidate, segment, adjacent));
    if (!tile) throw new Error(`No USGS 3DEP tile covers the corridor of Creek Segment ${segment.segmentId}. Rerun Stage 0.`);

    const result = await generateWaterSurfacePolygons({
      elevationGrid: cropElevationGridToCorridor(tile, segment, adjacent),
      segment,
      buckets,
      logProgress: false,
      additionalSeedPointsUtm: thalwegPointsBySegmentId.get(segment.segmentId) ?? [],
      adjacentSegments: adjacent,
    });
    const elevationBuckets = result.elevationBuckets;
    const segmentSlopedBuckets = buckets.filter((bucket) => bucket.fillThreshold !== undefined).length;
    polygonSets.push({ segmentId: segment.segmentId, elevationBuckets });
    ladders.push({
      segmentId: segment.segmentId,
      bedElevationM,
      maxModeledWaterSurfaceElevationM: maxModeledM ?? bedElevationM,
      ceilingM: elevationBuckets[elevationBuckets.length - 1]?.maxWaterSurfaceElevationM ?? bedElevationM,
      fineBuckets: ladder.fineBuckets,
      coarseBuckets: ladder.coarseBuckets,
      slopedBuckets: segmentSlopedBuckets,
      emptyBuckets: result.emptyBuckets.length,
    });
    totalBuckets += elevationBuckets.length;
    slopedBuckets += segmentSlopedBuckets;
    emptyBuckets += result.emptyBuckets.length;
    ringVertices += elevationBuckets.reduce((sum, bucket) => sum + bucket.ringsWgs84.reduce((ringSum, ring) => ringSum + ring.length, 0), 0);
    if (result.emptyBuckets.length > 0) {
      warnings.push(
        `${segment.segmentId} ${result.emptyBuckets.length} empty bucket(s) from ${result.emptyBuckets[0]?.minWaterSurfaceElevationM} m (no wet ground connected to the centerline or a Stage 1 thalweg point).`,
      );
    }
    if ((segmentIndex + 1) % 10 === 0 || segmentIndex === segments.length - 1) {
      console.log(`  Creek Segment ${segmentIndex + 1} of ${segments.length}: ${totalBuckets} buckets so far`);
    }
  }

  const laddersFile: PolygonLaddersFile = {
    segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
    description:
      `Elevation-bucket ladder per Creek Segment: ${POLYGON_LADDER.fineStepM} m buckets from the bed through the highest modeled WSE, ` +
      `then ${POLYGON_LADDER.coarseStepM} m buckets through +${POLYGON_LADDER.headroomAboveMaxModeledWseM} m. Ceiling = top of the last bucket. ` +
      'A sloped bucket was traced with its wet threshold rising from the mean downstream junction WSE to the mean upstream junction WSE ' +
      'of the modeled values that fell in it; the other buckets were traced flat at the bucket minimum.',
    segments: ladders,
  };
  const polygonSetsDirectory = path.join(outputDirectory, WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME);
  // Remove earlier polygon set files, including the former single file, so no stale file is validated.
  await rm(polygonSetsDirectory, { recursive: true, force: true });
  await rm(path.join(outputDirectory, 'water-surface-polygon-sets.json'), { force: true });
  const polygonSetPaths: string[] = [];
  let polygonSetBytes = 0;
  let largestPolygonSetBytes = 0;
  for (const [tncComid, sets] of groupByTncComid(polygonSets)) {
    const polygonSetPath = path.join(polygonSetsDirectory, `${tncComid}.json`);
    const polygonSetsFile: WaterSurfacePolygonSetsFile = {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      waterSurfacePolygonSets: sets,
    };
    await writeCompactJson(polygonSetPath, polygonSetsFile);
    const { size } = await stat(polygonSetPath);
    polygonSetBytes += size;
    largestPolygonSetBytes = Math.max(largestPolygonSetBytes, size);
    polygonSetPaths.push(polygonSetPath);
  }
  const laddersPath = path.join(outputDirectory, POLYGON_LADDERS_FILE);
  await writeReadableJson(laddersPath, laddersFile);

  return {
    outputFiles: [...polygonSetPaths, laddersPath],
    counts: {
      creekSegments: polygonSets.length,
      polygonSetFiles: polygonSetPaths.length,
      elevationBuckets: totalBuckets,
      slopedBuckets,
      emptyBuckets,
      ringVertices,
    },
    warnings,
    measurements: { waterSurfacePolygonSetsBytes: polygonSetBytes, largestWaterSurfacePolygonSetFileBytes: largestPolygonSetBytes },
    summaryLines: [
      `${polygonSets.length} Creek Segments, ${totalBuckets} elevation buckets (${slopedBuckets} sloped between junction WSEs, ${emptyBuckets} empty), ${ringVertices} ring vertices.`,
      `${polygonSetPaths.length} polygon set file(s) in ${WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME}/: ${formatBytes(polygonSetBytes)} total, largest ${formatBytes(largestPolygonSetBytes)}.`,
    ],
  };
}

await runStageEntryPoint(async () => {
  const files = [...(await listTimeSeriesFiles(timeSeriesDirectory)).values()].flat();
  await runStage({
    stage: '04-water-surface-polygons',
    outputDirectory,
    inputFiles: [
      MODELED_EXTENT.flowlineSnapshotPath,
      path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE),
      path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE),
      ...(await terrainTilePaths()),
      ...files.map((relativePath) => path.join(timeSeriesDirectory, relativePath)),
    ],
    parameters: {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      ...POLYGON_LADDER,
      polygonGeneration: 'publish water-surface-polygon-generation.ts: corridor width, 8-connectivity, Bank-overlap margin',
      corridorEnds: 'cut at the angle bisector of the two Creek Segments sharing each vertex, so neighbouring corridors meet on one line',
      wetThreshold:
        'sloped from the mean downstream junction WSE to the mean upstream junction WSE of the Stage 3 values in the bucket, never below the bucket minimum; flat at the bucket minimum when no value fell in it',
      fileLayout: 'one compact JSON file per TNC flowline: water-surface-polygon-sets/<tncComid>.json',
      floodFillSeeds: 'centerline cells plus every Stage 1 thalweg point inside the Creek Segment corridor',
    },
    run: buildWaterSurfacePolygons,
  });
});
