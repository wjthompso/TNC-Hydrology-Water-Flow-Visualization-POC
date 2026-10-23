import { contours } from 'd3-contour';
import { BANK_OVERLAP_MARGIN_M, CENTERLINE_SAMPLE_SPACING_M } from '../../../constants.ts';
import type { AdjacentCreekSegments } from '../../../creek-segment-adjacency.ts';
import { readJson } from '../../../json-files.ts';
import type { CreekSegment } from '../../../tnc-flowline-segmentation.ts';
import { roundToDecimals, utm10nToWgs84 } from '../../../utm-geometry.ts';
import {
  corridorInsideElevationGrid,
  cropElevationGridToCorridor,
  dilateMask8Connected,
  type ElevationBucket,
  type ElevationGrid,
  type WaterSurfacePolygonBucket,
} from '../../../water-surface-polygon-generation.ts';
import { adjacentSegmentsById } from '../../creek-segment-network.ts';
import type { CrossSectionRecord, PolygonLaddersFile, WaterSurfaceElevationTimeSeriesFile } from '../../stage-file-formats.ts';
import { hasDepthFields } from '../../modeled-wse-derivation-methods/m2-multi-section-manning-depth/multi-section-time-series-file.ts';
import type { WsePolygonMethodInputs, WsePolygonMethodResult } from '../wse-polygon-generation-method-generators.ts';
import {
  assertInsideCorridor,
  cellCenter,
  cellInCorridor,
  cellIndex,
  clipRingToConvex,
  dropCollinear,
  dropConsecutive,
  floodFill,
  isNoData,
  pixelToUtm,
  segmentFrame,
  signedArea,
  type PlanarPoint,
  type SegmentFrame,
} from './corridor-geometry.ts';
import { HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD } from './method-config.ts';

/**
 * WSE Polygon Generation Method `height-above-nearest-drainage-fill`. For every Creek Segment:
 *
 * 1. A reference thalweg polyline runs through the Stage 1 thalweg points in vertex order: the
 *    start-vertex neighbour's 2 sections nearest the shared vertex, this segment's 5, and the
 *    end-vertex neighbour's 2 nearest. Each point carries its section's bed elevation.
 * 2. Every corridor cell's reference bed is the bed interpolated at the nearest point of that
 *    polyline; its height above nearest drainage (HAND) is its elevation minus that bed.
 * 3. A depth ladder (0.05 m buckets through the largest modeled depth, then 0.25 m to +2 m)
 *    is traced: a cell is wet when its HAND is below the bucket's minimum depth (at least the wet
 *    floor) and not more than `maximumDepthBelowReferenceBedM` below the bed (lower ground drains
 *    to another channel), and the polygon is the wet region connected to the channel, grown by the
 *    Bank-overlap margin, vectorized, and clipped to the corridor.
 * 4. Every ring vertex is `[lon, lat, bedReferenceM]`; the browser draws it at bedReferenceM + depth.
 *
 * Bucket `minWaterSurfaceElevationM` / `maxWaterSurfaceElevationM` hold DEPTHS for this method.
 */

const PARAMETERS = HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD.parameters;
/** Nearest sections of each neighbour added to the reference thalweg. */
const NEIGHBOUR_SECTIONS_IN_REFERENCE = 2;

/** One reference thalweg point: Stage 1 thalweg position (EPSG 32610 m) and bed (m NAVD88). */
interface ReferencePoint {
  x: number;
  y: number;
  bedM: number;
}

/** Millimeters avoid floating-point drift when stepping by 0.05 m. */
function toMilli(meters: number): number {
  return Math.round(meters * 1000);
}

/** Half-open depth buckets: fine steps from 0 through the bucket holding the largest depth, then coarse steps to that depth + headroom. */
function buildDepthLadder(maxDepthM: number): { buckets: ElevationBucket[]; fineBuckets: number; coarseBuckets: number } {
  const fineStep = toMilli(PARAMETERS.fineStepM);
  const coarseStep = toMilli(PARAMETERS.coarseStepM);
  const lastFineStart = Math.floor(toMilli(Math.max(0, maxDepthM)) / fineStep) * fineStep;
  const ceilingTarget = toMilli(Math.max(0, maxDepthM) + PARAMETERS.headroomAboveMaxModeledDepthM);
  const buckets: ElevationBucket[] = [];
  let edge = 0;
  for (; edge <= lastFineStart; edge += fineStep) {
    buckets.push({ minWaterSurfaceElevationM: edge / 1000, maxWaterSurfaceElevationM: (edge + fineStep) / 1000 });
  }
  const fineBuckets = buckets.length;
  for (; edge < ceilingTarget; edge += coarseStep) {
    buckets.push({ minWaterSurfaceElevationM: edge / 1000, maxWaterSurfaceElevationM: (edge + coarseStep) / 1000 });
  }
  return { buckets, fineBuckets, coarseBuckets: buckets.length - fineBuckets };
}

/** Per Creek Segment: anchor bed and the largest modeled depth across every Time Series file. */
async function modeledDepthSummaryBySegment(
  timeSeriesFilePaths: readonly string[],
): Promise<Map<string, { anchorBedElevationM: number; maxDepthM: number }>> {
  const summaryById = new Map<string, { anchorBedElevationM: number; maxDepthM: number }>();
  for (const filePath of timeSeriesFilePaths) {
    const file = (await readJson(filePath)) as WaterSurfaceElevationTimeSeriesFile;
    for (const segment of file.segments) {
      if (!hasDepthFields(segment)) {
        throw new Error(
          `${filePath}: ${segment.segmentId} has no depth fields (anchorBedElevationM, junctionDepthUpstreamM, junctionDepthDownstreamM). ` +
            `${HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD.id} needs the m2-multi-section-manning-depth Time Series: add --modeled-wse-method=m2-multi-section-manning-depth.`,
        );
      }
      const summary = summaryById.get(segment.segmentId) ?? { anchorBedElevationM: segment.anchorBedElevationM, maxDepthM: -Infinity };
      summaryById.set(segment.segmentId, summary);
      segment.values.forEach((value, index) => {
        if (value === null) return;
        summary.maxDepthM = Math.max(
          summary.maxDepthM,
          value - segment.anchorBedElevationM,
          segment.junctionDepthUpstreamM[index] ?? 0,
          segment.junctionDepthDownstreamM[index] ?? 0,
        );
      });
    }
  }
  return summaryById;
}

/** This segment's thalweg points with each neighbour's nearest sections, in vertex order. */
function referenceThalweg(
  record: CrossSectionRecord,
  recordById: ReadonlyMap<string, CrossSectionRecord>,
  adjacent: AdjacentCreekSegments,
): ReferencePoint[] {
  const toPoint = (section: CrossSectionRecord['sections'][number]): ReferencePoint => ({
    x: section.thalwegUtm.x,
    y: section.thalwegUtm.y,
    bedM: section.bedElevationM,
  });
  const previous = adjacent.atStart ? recordById.get(adjacent.atStart.segmentId)?.sections ?? [] : [];
  const next = adjacent.atEnd ? recordById.get(adjacent.atEnd.segmentId)?.sections ?? [] : [];
  const points = [
    // The start-vertex neighbour's sections nearest the shared vertex are its last ones.
    ...previous.slice(-NEIGHBOUR_SECTIONS_IN_REFERENCE),
    ...record.sections,
    ...next.slice(0, NEIGHBOUR_SECTIONS_IN_REFERENCE),
  ].map(toPoint);
  // Two Stage 1 sections can find the same thalweg cell; a zero-length piece adds nothing.
  return points.filter((point, index) => index === 0 || point.x !== points[index - 1]?.x || point.y !== points[index - 1]?.y);
}

/**
 * Bed grade (m of bed per m along the polyline) to continue past one end of the reference thalweg:
 * from the end point to the point `endExtrapolationPieces` pieces inward, so one short, noisy
 * piece does not set the grade alone.
 */
function endGrade(polyline: readonly ReferencePoint[], atStart: boolean): number {
  const ordered = atStart ? polyline : [...polyline].reverse();
  const inner = Math.min(PARAMETERS.endExtrapolationPieces, ordered.length - 1);
  let alongM = 0;
  for (let index = 0; index < inner; index += 1) {
    const a = ordered[index] as ReferencePoint;
    const b = ordered[index + 1] as ReferencePoint;
    alongM += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (alongM === 0) return 0;
  // Bed change per meter moving outward past the end.
  return ((ordered[0] as ReferencePoint).bedM - (ordered[inner] as ReferencePoint).bedM) / alongM;
}

/**
 * Bed at the nearest point of the reference thalweg polyline, linearly interpolated along that
 * piece. Past either end of the polyline the bed continues at the end grade instead of staying at
 * the end bed: at a flowline end with no neighbour the creek keeps falling, and holding the last
 * bed would make every down-valley cell look deep below the creek.
 */
function referenceBedAt(x: number, y: number, polyline: readonly ReferencePoint[], grades: { atStart: number; atEnd: number }): number {
  if (polyline.length === 1) return (polyline[0] as ReferencePoint).bedM;
  let bestDistanceSquared = Infinity;
  let bestBedM = Number.NaN;
  const lastPiece = polyline.length - 2;
  for (let index = 0; index <= lastPiece; index += 1) {
    const start = polyline[index] as ReferencePoint;
    const end = polyline[index + 1] as ReferencePoint;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const rawT = lengthSquared === 0 ? 0 : ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared;
    // The first piece extends backward past the start and the last piece forward past the end.
    const t = Math.min(index === lastPiece ? Infinity : 1, Math.max(index === 0 ? -Infinity : 0, rawT));
    const distanceSquared = (x - (start.x + t * dx)) ** 2 + (y - (start.y + t * dy)) ** 2;
    if (distanceSquared >= bestDistanceSquared) continue;
    bestDistanceSquared = distanceSquared;
    const lengthM = Math.sqrt(lengthSquared);
    if (t < 0) bestBedM = start.bedM + -t * lengthM * grades.atStart;
    else if (t > 1) bestBedM = end.bedM + (t - 1) * lengthM * grades.atEnd;
    else bestBedM = start.bedM + t * (end.bedM - start.bedM);
  }
  return bestBedM;
}

/** The reference thalweg with its two end grades, so every bed lookup uses the same polyline. */
interface ReferenceThalweg {
  points: ReferencePoint[];
  grades: { atStart: number; atEnd: number };
}

function withEndGrades(points: ReferencePoint[]): ReferenceThalweg {
  return { points, grades: { atStart: endGrade(points, true), atEnd: endGrade(points, false) } };
}

/** Every grid cell the reference thalweg polyline crosses (sampled every `referenceThalwegRasterStepM`). */
function cellsOnReferenceThalweg(polyline: readonly ReferencePoint[], grid: ElevationGrid): Set<number> {
  const cells = new Set<number>();
  for (let index = 0; index < polyline.length; index += 1) {
    const start = polyline[index] as ReferencePoint;
    const end = polyline[index + 1] ?? start;
    const lengthM = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(lengthM / PARAMETERS.referenceThalwegRasterStepM));
    for (let step = 0; step <= steps; step += 1) {
      const fraction = step / steps;
      const cell = cellIndex(start.x + (end.x - start.x) * fraction, start.y + (end.y - start.y) * fraction, grid);
      if (cell !== null) cells.add(cell);
    }
  }
  return cells;
}

/** Closes a ring of [lon, lat, z] and orients it (Esri: outer clockwise, holes counter-clockwise in lon/lat). */
function closeAndOrientRing(open3d: number[][], isHole: boolean): number[][] | null {
  const deduplicated: number[][] = [];
  for (const point of open3d) {
    const previous = deduplicated[deduplicated.length - 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    deduplicated.push(point);
  }
  const first = deduplicated[0];
  const last = deduplicated[deduplicated.length - 1];
  if (deduplicated.length >= 2 && first && last && first[0] === last[0] && first[1] === last[1]) deduplicated.pop();
  if (deduplicated.length < 3) return null;
  const area = signedArea(deduplicated);
  if (area === 0) return null;
  const counterClockwise = area > 0;
  const oriented = counterClockwise === isHole ? deduplicated : [...deduplicated].reverse();
  return [...oriented, [...(oriented[0] as number[])]];
}

/** Vectorizes one wet mask, clips it to the corridor, and gives every vertex its reference bed. */
function vectorizeMask(input: {
  mask: Uint8Array;
  values: number[];
  grid: ElevationGrid;
  frame: SegmentFrame;
  reference: ReferenceThalweg;
  label: string;
}): number[][][] {
  const { mask, values, grid, frame } = input;
  for (let index = 0; index < mask.length; index += 1) values[index] = mask[index] === 1 ? 1 : 0;
  const [contour] = contours().size([grid.width, grid.height]).smooth(false).thresholds([0.5])(values);
  if (!contour) return [];
  const rings: number[][][] = [];
  for (const polygon of contour.coordinates) {
    polygon.forEach((pixelRing, ringIndex) => {
      const utmRing = dropConsecutive(pixelRing.map((position) => pixelToUtm(position, grid)));
      const clipped: PlanarPoint[] = dropCollinear(dropConsecutive(clipRingToConvex(utmRing, frame.corridor)));
      if (clipped.length < 3) return;
      assertInsideCorridor(clipped, frame, input.label);
      const withBed = clipped.map(([x, y]) => {
        const [longitude, latitude] = utm10nToWgs84(x, y);
        return [roundToDecimals(longitude, 7), roundToDecimals(latitude, 7), roundToDecimals(referenceBedAt(x, y, input.reference.points, input.reference.grades), 3)];
      });
      const ring = closeAndOrientRing(withBed, ringIndex > 0);
      if (ring) rings.push(ring);
    });
  }
  return rings;
}

/** Traces every depth bucket of one Creek Segment. */
function traceDepthBuckets(input: {
  grid: ElevationGrid;
  segment: CreekSegment;
  adjacent: AdjacentCreekSegments;
  reference: ReferenceThalweg;
  buckets: readonly ElevationBucket[];
}): { elevationBuckets: WaterSurfacePolygonBucket[]; emptyBuckets: ElevationBucket[] } {
  const { grid, segment, reference } = input;
  const polyline = reference.points;
  const frame = segmentFrame(segment, input.adjacent);
  const cellCount = grid.width * grid.height;
  const halfCellDiagonalM = Math.hypot(grid.resolutionX, grid.resolutionY) / 2;

  // Per corridor cell: height above the reference bed. The cells the reference thalweg crosses are the drainage itself (HAND 0).
  const inCorridor = new Uint8Array(cellCount);
  const heightAboveDrainageM = new Float64Array(cellCount).fill(Number.NaN);
  const thalwegCells = cellsOnReferenceThalweg(polyline, grid);
  for (let index = 0; index < cellCount; index += 1) {
    const [x, y] = cellCenter(index, grid);
    if (!cellInCorridor(x, y, frame, halfCellDiagonalM)) continue;
    inCorridor[index] = 1;
    const elevation = grid.elevations[index];
    if (elevation === undefined || isNoData(elevation, grid.noData)) continue;
    heightAboveDrainageM[index] = thalwegCells.has(index) ? 0 : elevation - referenceBedAt(x, y, polyline, reference.grades);
  }

  // Seeds: the reference thalweg cells inside the corridor, the Stage 1 thalweg points, and the centerline cells.
  const seeds = new Set<number>();
  for (const cell of thalwegCells) if (inCorridor[cell] === 1) seeds.add(cell);
  for (const point of polyline) {
    const cell = cellIndex(point.x, point.y, grid);
    if (cell !== null && inCorridor[cell] === 1) seeds.add(cell);
  }
  const steps = Math.ceil(frame.lengthM / CENTERLINE_SAMPLE_SPACING_M);
  for (let step = 0; step <= steps; step += 1) {
    const along = Math.min(frame.lengthM, step * CENTERLINE_SAMPLE_SPACING_M);
    const cell = cellIndex(frame.start.x + frame.unitX * along, frame.start.y + frame.unitY * along, grid);
    if (cell === null) throw new Error(`Creek Segment ${segment.segmentId} leaves the USGS 3DEP window.`);
    seeds.add(cell);
  }
  const seedList = [...seeds];

  const marginCells = Math.max(0, Math.round(BANK_OVERLAP_MARGIN_M / grid.resolutionX));
  const values = new Array<number>(cellCount);
  const elevationBuckets: WaterSurfacePolygonBucket[] = [];
  const emptyBuckets: ElevationBucket[] = [];
  for (const bucket of input.buckets) {
    const thresholdM = Math.max(bucket.minWaterSurfaceElevationM, PARAMETERS.wetDepthFloorM);
    const wet = new Uint8Array(cellCount);
    for (let index = 0; index < cellCount; index += 1) {
      const heightM = heightAboveDrainageM[index] as number;
      // NaN (NoData) compares false, so it stays dry.
      if (inCorridor[index] === 1 && heightM < thresholdM && heightM >= -PARAMETERS.maximumDepthBelowReferenceBedM) wet[index] = 1;
    }
    const mask = floodFill(wet, seedList, grid.width, grid.height);
    const dilated = dilateMask8Connected(mask, inCorridor, grid.width, grid.height, marginCells);
    const ringsWgs84 = vectorizeMask({ mask: dilated, values, grid, frame, reference, label: `${segment.segmentId} at depth ${bucket.minWaterSurfaceElevationM} m` });
    const traced: ElevationBucket = { minWaterSurfaceElevationM: bucket.minWaterSurfaceElevationM, maxWaterSurfaceElevationM: bucket.maxWaterSurfaceElevationM };
    elevationBuckets.push({ ...traced, ringsWgs84 });
    if (ringsWgs84.length === 0) emptyBuckets.push(traced);
  }
  return { elevationBuckets, emptyBuckets };
}

export async function generateHeightAboveNearestDrainageFillPolygons(inputs: WsePolygonMethodInputs): Promise<WsePolygonMethodResult> {
  const { segments, crossSections, terrainTiles: tiles } = inputs;
  const recordById = new Map(crossSections.segments.map((record) => [record.segmentId, record]));
  const depthSummaryById = await modeledDepthSummaryBySegment(inputs.timeSeriesFilePaths);
  const adjacentById = adjacentSegmentsById(segments);

  const warnings: string[] = [];
  const polygonSets: WsePolygonMethodResult['polygonSets'] = [];
  const ladders: PolygonLaddersFile['segments'] = [];
  let totalBuckets = 0;
  let emptyBuckets = 0;
  let ringVertices = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    const record = recordById.get(segment.segmentId);
    if (!record) throw new Error(`Creek Segment ${segment.segmentId} has no Stage 1 cross-sections.`);
    const summary = depthSummaryById.get(segment.segmentId);
    const anchorBedElevationM = summary?.anchorBedElevationM ?? record.bedElevationM;
    const hasDepths = summary !== undefined && Number.isFinite(summary.maxDepthM);
    if (!hasDepths) warnings.push(`${segment.segmentId} has no modeled depths; ladder covers 0 m + headroom only.`);
    const maxDepthM = hasDepths ? Math.max(0, summary.maxDepthM) : 0;
    const ladder = buildDepthLadder(maxDepthM);
    const adjacent = adjacentById.get(segment.segmentId) ?? {};
    const tile = tiles.find((candidate) => corridorInsideElevationGrid(candidate, segment, adjacent));
    if (!tile) throw new Error(`No USGS 3DEP tile covers the corridor of Creek Segment ${segment.segmentId}. Rerun Stage 0.`);
    const reference = withEndGrades(referenceThalweg(record, recordById, adjacent));

    const result = traceDepthBuckets({
      grid: cropElevationGridToCorridor(tile, segment, adjacent),
      segment,
      adjacent,
      reference,
      buckets: ladder.buckets,
    });
    polygonSets.push({ segmentId: segment.segmentId, elevationBuckets: result.elevationBuckets });
    const topDepthM = result.elevationBuckets[result.elevationBuckets.length - 1]?.maxWaterSurfaceElevationM ?? 0;
    ladders.push({
      segmentId: segment.segmentId,
      bedElevationM: anchorBedElevationM,
      maxModeledWaterSurfaceElevationM: roundToDecimals(anchorBedElevationM + maxDepthM, 3),
      ceilingM: roundToDecimals(anchorBedElevationM + topDepthM, 3),
      fineBuckets: ladder.fineBuckets,
      coarseBuckets: ladder.coarseBuckets,
      emptyBuckets: result.emptyBuckets.length,
    });
    totalBuckets += result.elevationBuckets.length;
    emptyBuckets += result.emptyBuckets.length;
    ringVertices += result.elevationBuckets.reduce((sum, bucket) => sum + bucket.ringsWgs84.reduce((ringSum, ring) => ringSum + ring.length, 0), 0);
    if (result.emptyBuckets.length > 0) {
      warnings.push(
        `${segment.segmentId} ${result.emptyBuckets.length} empty depth bucket(s) from ${result.emptyBuckets[0]?.minWaterSurfaceElevationM} m (no wet ground connected to the reference thalweg).`,
      );
    }
    if ((segmentIndex + 1) % 250 === 0 || segmentIndex === segments.length - 1) {
      console.log(`  Creek Segment ${segmentIndex + 1} of ${segments.length}: ${totalBuckets} depth buckets so far`);
    }
  }

  return {
    polygonSets,
    ladders: {
      segmentNetworkVersion: inputs.segmentNetworkVersion,
      description:
        `DEPTH-bucket ladder per Creek Segment (bucket min/max in the polygon sets are depths in m above the local bed, not elevations): ` +
        `${PARAMETERS.fineStepM} m buckets from 0 through the largest modeled depth, then ${PARAMETERS.coarseStepM} m buckets through +${PARAMETERS.headroomAboveMaxModeledDepthM} m. ` +
        'Here bedElevationM is the anchor (mid-segment) section bed, maxModeledWaterSurfaceElevationM = anchor bed + largest modeled depth, ' +
        'and ceilingM = anchor bed + ladder top depth.',
      segments: ladders,
    },
    counts: { depthBuckets: totalBuckets, emptyBuckets, ringVertices },
    warnings,
    summaryLines: [`${polygonSets.length} Creek Segments, ${totalBuckets} depth buckets (${emptyBuckets} empty), ${ringVertices} ring vertices.`],
  };
}
