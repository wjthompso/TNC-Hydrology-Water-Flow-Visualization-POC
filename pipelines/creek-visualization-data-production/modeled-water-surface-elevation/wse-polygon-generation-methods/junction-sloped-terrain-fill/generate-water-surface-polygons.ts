import { readJson } from '../../../json-files.ts';
import {
  corridorInsideElevationGrid,
  cropElevationGridToCorridor,
  generateWaterSurfacePolygons,
  type ElevationBucket,
  type ElevationBucketToTrace,
} from '../../../water-surface-polygon-generation.ts';
import { roundToDecimals } from '../../../utm-geometry.ts';
import { adjacentSegmentsById } from '../../creek-segment-network.ts';
import {
  downstreamVertexDirectionByTncComid,
  tncComidOfSegmentId,
  type DownstreamVertexDirection,
  type PolygonLaddersFile,
  type WaterSurfaceElevationTimeSeriesFile,
} from '../../stage-file-formats.ts';
import type { WsePolygonMethodInputs, WsePolygonMethodResult } from '../wse-polygon-generation-method-generators.ts';
import { JUNCTION_SLOPED_TERRAIN_FILL_METHOD } from './method-config.ts';

/**
 * WSE Polygon Generation Method `junction-sloped-terrain-fill`. For every Creek Segment, build a
 * ladder of elevation buckets from the bed up to the highest modeled WSE plus headroom, and trace
 * one prepared water-surface polygon per bucket on the Stage 0 USGS 3DEP terrain. Polygon tracing
 * reuses publish's corridor width, 8-connectivity, and Bank-overlap margin, with two changes so
 * neighbouring Creek Segments meet cleanly:
 *
 * - Each corridor end is cut at the angle bisector of the two segments meeting at that vertex,
 *   so the upstream segment's downstream boundary and the downstream segment's upstream boundary
 *   are the same line and no wedge of bed is left uncovered at a bend.
 * - A bucket's wet threshold slopes from the segment's downstream junction WSE to its upstream
 *   junction WSE (the Stage 3 junction values, averaged over the timestamps whose value falls in
 *   that bucket), so the water covers the bed from junction to junction. It is never below the
 *   bucket minimum, and a bucket no modeled value falls in keeps the flat threshold. The slope is
 *   measured between the corridor's two boundary lines, not along the segment axis, so both
 *   neighbours hold the junction WSE on the whole shared bisector line.
 *
 * The flood fill seeds from the centerline and from each Stage 1 thalweg point, because the
 * TNC flowline often sits several meters off the channel's lowest ground.
 */

const POLYGON_LADDER = JUNCTION_SLOPED_TERRAIN_FILL_METHOD.parameters;

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
async function modeledWseSummaryBySegment(timeSeriesFilePaths: readonly string[]): Promise<Map<string, ModeledWseSummary>> {
  const summaryBySegmentId = new Map<string, ModeledWseSummary>();
  for (const filePath of timeSeriesFilePaths) {
    const file = (await readJson(filePath)) as WaterSurfaceElevationTimeSeriesFile;
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

export async function generateJunctionSlopedTerrainFillPolygons(inputs: WsePolygonMethodInputs): Promise<WsePolygonMethodResult> {
  const { segments, crossSections, terrainTiles: tiles } = inputs;
  const bedBySegmentId = new Map(crossSections.segments.map((section) => [section.segmentId, section.bedElevationM]));
  const thalwegPointsBySegmentId = new Map(
    crossSections.segments.map((record) => [record.segmentId, record.sections.map((section) => section.thalwegUtm)]),
  );
  const summaryBySegmentId = await modeledWseSummaryBySegment(inputs.timeSeriesFilePaths);
  const directionByTncComid = downstreamVertexDirectionByTncComid(crossSections);
  const adjacentById = adjacentSegmentsById(segments);

  const warnings: string[] = [];
  const polygonSets: WsePolygonMethodResult['polygonSets'] = [];
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

  return {
    polygonSets,
    ladders: {
      segmentNetworkVersion: inputs.segmentNetworkVersion,
      description:
        `Elevation-bucket ladder per Creek Segment: ${POLYGON_LADDER.fineStepM} m buckets from the bed through the highest modeled WSE, ` +
        `then ${POLYGON_LADDER.coarseStepM} m buckets through +${POLYGON_LADDER.headroomAboveMaxModeledWseM} m. Ceiling = top of the last bucket. ` +
        'A sloped bucket was traced with its wet threshold rising from the mean downstream junction WSE to the mean upstream junction WSE ' +
        'of the modeled values that fell in it; the other buckets were traced flat at the bucket minimum.',
      segments: ladders,
    },
    counts: { elevationBuckets: totalBuckets, slopedBuckets, emptyBuckets, ringVertices },
    warnings,
    summaryLines: [
      `${polygonSets.length} Creek Segments, ${totalBuckets} elevation buckets (${slopedBuckets} sloped between junction WSEs, ${emptyBuckets} empty), ${ringVertices} ring vertices.`,
    ],
  };
}
