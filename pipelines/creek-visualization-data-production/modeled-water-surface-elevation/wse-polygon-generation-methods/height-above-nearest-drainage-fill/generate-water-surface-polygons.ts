import { BANK_OVERLAP_MARGIN_M, CENTERLINE_SAMPLE_SPACING_M } from '../../../constants.ts';
import type { AdjacentCreekSegments } from '../../../creek-segment-adjacency.ts';
import { readJson } from '../../../json-files.ts';
import type { CreekSegment } from '../../../tnc-flowline-segmentation.ts';
import { roundToDecimals } from '../../../utm-geometry.ts';
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
import { cellCenter, cellInCorridor, cellIndex, floodFill, isNoData, segmentFrame } from './corridor-geometry.ts';
import { traceBedLine, type BedLinePoint } from './bed-line-tracing.ts';
import { HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD } from './method-config.ts';
import { sliceFootprint, type SlicingContext } from './sliced-footprints.ts';

/**
 * WSE Polygon Generation Method `height-above-nearest-drainage-fill`. For every Creek Segment:
 *
 * 1. A bed line is traced on the 1 m lidar through the Stage 1 thalweg points in vertex order: the
 *    start-vertex neighbour's 2 sections nearest the shared vertex, this segment's 5, and the
 *    end-vertex neighbour's 2 nearest. Between consecutive points a least-cost path follows the
 *    lowest ground inside a narrow band around the straight chord (`bed-line-tracing.ts`); the line
 *    is resampled every 1 m and its bed, the lidar elevation, lightly median-filtered.
 * 2. Every corridor cell's reference bed is the bed interpolated at the nearest point of that
 *    line; its height above nearest drainage (HAND) is its elevation minus that bed.
 * 3. A depth ladder (0.05 m buckets through the largest modeled depth, then 0.25 m to +2 m)
 *    is traced: a cell is wet when its HAND is below the bucket's minimum depth (at least the wet
 *    floor) and not more than `maximumDepthBelowReferenceBedM` below the bed (lower ground drains
 *    to another channel), and the polygon is the wet region connected to the channel, grown by the
 *    Bank-overlap margin, vectorized, and clipped to the corridor.
 * 4. Every ring vertex is `[lon, lat, bedReferenceM]`; the browser draws it at bedReferenceM + depth.
 * 5. (Version 3) Where the triangulated surface of that polygon would deviate from bed reference + depth,
 *    the footprint is cut into short slices across the flow (`sliced-footprints.ts`); a bucket then
 *    holds the rings of all its slices.
 *
 * Bucket `minWaterSurfaceElevationM` / `maxWaterSurfaceElevationM` hold DEPTHS for this method.
 */

const PARAMETERS = HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD.parameters;
/** Nearest sections of each neighbour added to the Stage 1 thalweg chain the bed line is traced through. */
const NEIGHBOUR_SECTIONS_IN_REFERENCE = 2;

/** One point of the bed line (traced, 1 m apart) or of the Stage 1 thalweg chain: position (EPSG 32610 m) and bed (m NAVD88). */
type ReferencePoint = BedLinePoint;

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

/** This segment's Stage 1 thalweg points with each neighbour's nearest sections, in vertex order. */
function stageOneThalweg(
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
 * Bed grade (m of bed per m along the line) to continue past one end of the bed line: from the end
 * point to the point `endGradeLengthM` inward (counted in resampled pieces), so one short, noisy
 * piece does not set the grade alone.
 */
function endGrade(polyline: readonly ReferencePoint[], atStart: boolean): number {
  const ordered = atStart ? polyline : [...polyline].reverse();
  const inner = Math.min(Math.round(PARAMETERS.endGradeLengthM / PARAMETERS.bedLine.spacingM), ordered.length - 1);
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

/** Bed and arc length (m from the start of the bed line) at the nearest point of the bed line. */
export interface ReferencePosition {
  bedM: number;
  alongM: number;
}

/**
 * Bed at the nearest point of the bed line, linearly interpolated along that piece, and that point's
 * arc length along the line. Past either end of the line the bed continues at the end grade instead of
 * staying at the end bed: at a flowline end with no neighbour the creek keeps falling, and holding the
 * last bed would make every down-valley cell look deep below the creek. The arc length continues
 * straight past the ends too (negative before the start).
 */
export function referenceAt(x: number, y: number, line: ReferenceBedLine): ReferencePosition {
  const { points: polyline, grades, cumulativeLengthM } = line;
  if (polyline.length === 1) return { bedM: (polyline[0] as ReferencePoint).bedM, alongM: 0 };
  let bestDistanceSquared = Infinity;
  let bestBedM = Number.NaN;
  let bestAlongM = Number.NaN;
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
    bestAlongM = (cumulativeLengthM[index] as number) + t * lengthM;
    if (t < 0) bestBedM = start.bedM + -t * lengthM * grades.atStart;
    else if (t > 1) bestBedM = end.bedM + (t - 1) * lengthM * grades.atEnd;
    else bestBedM = start.bedM + t * (end.bedM - start.bedM);
  }
  return { bedM: bestBedM, alongM: bestAlongM };
}

/** The traced bed line with its two end grades, so every bed lookup uses the same line, and the Stage 1 thalweg points it passes through (flood-fill seeds). */
export interface ReferenceBedLine {
  points: ReferencePoint[];
  grades: { atStart: number; atEnd: number };
  /** Arc length (m) from the first point to each point. */
  cumulativeLengthM: number[];
  stageOneThalwegPoints: ReferencePoint[];
}

function withEndGrades(points: ReferencePoint[], stageOneThalwegPoints: ReferencePoint[]): ReferenceBedLine {
  let lengthM = 0;
  const cumulativeLengthM = points.map((point, index) => {
    const previous = points[index - 1];
    if (previous) lengthM += Math.hypot(point.x - previous.x, point.y - previous.y);
    return lengthM;
  });
  return { points, grades: { atStart: endGrade(points, true), atEnd: endGrade(points, false) }, cumulativeLengthM, stageOneThalwegPoints };
}

/** The traced bed line of one Creek Segment with its end grades; also the reference bed every HAND value and ring vertex is measured against. */
export function referenceBedLineOfCreekSegment(input: {
  record: CrossSectionRecord;
  recordById: ReadonlyMap<string, CrossSectionRecord>;
  adjacent: AdjacentCreekSegments;
  /** The whole terrain tile holding the corridor, not the corridor crop: a short segment's corridor is narrow and its Stage 1 thalweg points can lie outside it. */
  tile: ElevationGrid;
}): { reference: ReferenceBedLine; chordFallbackPieces: number } {
  const stageOnePoints = stageOneThalweg(input.record, input.recordById, input.adjacent);
  const bedLine = traceBedLine(input.tile, stageOnePoints);
  return { reference: withEndGrades(bedLine.points, stageOnePoints), chordFallbackPieces: bedLine.chordFallbackPieces };
}

/** Every grid cell the bed line crosses (sampled every `bedLineRasterStepM`). */
function cellsOnReferenceBedLine(polyline: readonly ReferencePoint[], grid: ElevationGrid): Set<number> {
  const cells = new Set<number>();
  for (let index = 0; index < polyline.length; index += 1) {
    const start = polyline[index] as ReferencePoint;
    const end = polyline[index + 1] ?? start;
    const lengthM = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(lengthM / PARAMETERS.bedLineRasterStepM));
    for (let step = 0; step <= steps; step += 1) {
      const fraction = step / steps;
      const cell = cellIndex(start.x + (end.x - start.x) * fraction, start.y + (end.y - start.y) * fraction, grid);
      if (cell !== null) cells.add(cell);
    }
  }
  return cells;
}

/** Traces every depth bucket of one Creek Segment. */
function traceDepthBuckets(input: {
  grid: ElevationGrid;
  segment: CreekSegment;
  adjacent: AdjacentCreekSegments;
  reference: ReferenceBedLine;
  buckets: readonly ElevationBucket[];
}): { elevationBuckets: WaterSurfacePolygonBucket[]; emptyBuckets: ElevationBucket[]; slicing: SlicingCounts } {
  const { grid, segment, reference } = input;
  const polyline = reference.points;
  const frame = segmentFrame(segment, input.adjacent);
  const cellCount = grid.width * grid.height;
  const halfCellDiagonalM = Math.hypot(grid.resolutionX, grid.resolutionY) / 2;

  // Per corridor cell: reference bed, position along the bed line, and height above the reference bed.
  // The cells the bed line crosses are the drainage itself (HAND 0).
  const inCorridor = new Uint8Array(cellCount);
  const heightAboveDrainageM = new Float64Array(cellCount).fill(Number.NaN);
  const referenceBedByCell = new Float64Array(cellCount).fill(Number.NaN);
  const alongBedLineM = new Float64Array(cellCount).fill(Number.NaN);
  const bedLineCells = cellsOnReferenceBedLine(polyline, grid);
  for (let index = 0; index < cellCount; index += 1) {
    const [x, y] = cellCenter(index, grid);
    if (!cellInCorridor(x, y, frame, halfCellDiagonalM)) continue;
    inCorridor[index] = 1;
    const { bedM, alongM } = referenceAt(x, y, reference);
    referenceBedByCell[index] = bedM;
    alongBedLineM[index] = alongM;
    const elevation = grid.elevations[index];
    if (elevation === undefined || isNoData(elevation, grid.noData)) continue;
    heightAboveDrainageM[index] = bedLineCells.has(index) ? 0 : elevation - bedM;
  }
  const slicingContext: Omit<SlicingContext, 'label'> = {
    grid,
    frame,
    alongBedLineM,
    referenceBedByCell,
    bedReferenceAt: (x, y) => referenceAt(x, y, reference).bedM,
  };

  // Seeds: the bed line cells inside the corridor, the Stage 1 thalweg points, and the centerline cells.
  const seeds = new Set<number>();
  for (const cell of bedLineCells) if (inCorridor[cell] === 1) seeds.add(cell);
  for (const point of reference.stageOneThalwegPoints) {
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
  const elevationBuckets: WaterSurfacePolygonBucket[] = [];
  const emptyBuckets: ElevationBucket[] = [];
  const slicing: SlicingCounts = { slices: 0, slicedBuckets: 0, bucketsOverTolerance: 0 };
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
    const sliced = sliceFootprint(
      { footprintCells: cellsOfMask(dilated), wetCells: cellsOfMask(mask), depthM: bucket.minWaterSurfaceElevationM },
      { ...slicingContext, label: `${segment.segmentId} at depth ${bucket.minWaterSurfaceElevationM} m` },
    );
    const { ringsWgs84 } = sliced;
    const traced: ElevationBucket = { minWaterSurfaceElevationM: bucket.minWaterSurfaceElevationM, maxWaterSurfaceElevationM: bucket.maxWaterSurfaceElevationM };
    elevationBuckets.push({ ...traced, ringsWgs84 });
    if (ringsWgs84.length === 0) emptyBuckets.push(traced);
    slicing.slices += sliced.sliceCount;
    if (sliced.sliceCount > 1) slicing.slicedBuckets += 1;
    if (!sliced.withinTolerance) slicing.bucketsOverTolerance += 1;
  }
  return { elevationBuckets, emptyBuckets, slicing };
}

/** The grid cell indexes a 0/1 mask marks. */
function cellsOfMask(mask: Uint8Array): number[] {
  const cells: number[] = [];
  mask.forEach((value, index) => {
    if (value === 1) cells.push(index);
  });
  return cells;
}

/** What slicing did over a set of depth buckets. */
interface SlicingCounts {
  /** Slices written (an unsliced bucket counts 1; an empty bucket 0). */
  slices: number;
  /** Buckets cut into more than one slice. */
  slicedBuckets: number;
  /** Buckets whose worst slice still deviates more than the tolerance (the cap or the minimum slice length stopped the cutting). */
  bucketsOverTolerance: number;
}

/** Everything one Creek Segment contributes to the Stage 4 output. */
export interface CreekSegmentPolygons {
  polygonSet: WsePolygonMethodResult['polygonSets'][number];
  ladder: PolygonLaddersFile['segments'][number];
  warnings: string[];
  emptyBuckets: number;
  ringVertices: number;
  bedLinePoints: number;
  chordFallbackPieces: number;
  slicing: SlicingCounts;
}

/** Traces one Creek Segment: its bed line, depth ladder, and every depth bucket's (sliced) polygon. */
export function polygonsForCreekSegment(input: {
  segment: CreekSegment;
  adjacent: AdjacentCreekSegments;
  record: CrossSectionRecord;
  recordById: ReadonlyMap<string, CrossSectionRecord>;
  /** Anchor bed and largest modeled depth over every Time Series file; undefined when the segment has none. */
  depthSummary: { anchorBedElevationM: number; maxDepthM: number } | undefined;
  tiles: readonly ElevationGrid[];
}): CreekSegmentPolygons {
  const { segment, adjacent, record, depthSummary: summary } = input;
  const warnings: string[] = [];
  const anchorBedElevationM = summary?.anchorBedElevationM ?? record.bedElevationM;
  const hasDepths = summary !== undefined && Number.isFinite(summary.maxDepthM);
  if (!hasDepths) warnings.push(`${segment.segmentId} has no modeled depths; ladder covers 0 m + headroom only.`);
  const maxDepthM = hasDepths ? Math.max(0, summary.maxDepthM) : 0;
  const ladder = buildDepthLadder(maxDepthM);
  const tile = input.tiles.find((candidate) => corridorInsideElevationGrid(candidate, segment, adjacent));
  if (!tile) throw new Error(`No USGS 3DEP tile covers the corridor of Creek Segment ${segment.segmentId}. Rerun Stage 0.`);
  const grid = cropElevationGridToCorridor(tile, segment, adjacent);
  const { reference, chordFallbackPieces } = referenceBedLineOfCreekSegment({ record, recordById: input.recordById, adjacent, tile });
  if (chordFallbackPieces > 0) {
    warnings.push(`${segment.segmentId} ${chordFallbackPieces} bed line piece(s) had no lidar path and use the straight chord with Stage 1 section beds.`);
  }

  const result = traceDepthBuckets({ grid, segment, adjacent, reference, buckets: ladder.buckets });
  const topDepthM = result.elevationBuckets[result.elevationBuckets.length - 1]?.maxWaterSurfaceElevationM ?? 0;
  if (result.emptyBuckets.length > 0) {
    warnings.push(
      `${segment.segmentId} ${result.emptyBuckets.length} empty depth bucket(s) from ${result.emptyBuckets[0]?.minWaterSurfaceElevationM} m (no wet ground connected to the bed line).`,
    );
  }
  return {
    polygonSet: { segmentId: segment.segmentId, elevationBuckets: result.elevationBuckets },
    ladder: {
      segmentId: segment.segmentId,
      bedElevationM: anchorBedElevationM,
      maxModeledWaterSurfaceElevationM: roundToDecimals(anchorBedElevationM + maxDepthM, 3),
      ceilingM: roundToDecimals(anchorBedElevationM + topDepthM, 3),
      fineBuckets: ladder.fineBuckets,
      coarseBuckets: ladder.coarseBuckets,
      emptyBuckets: result.emptyBuckets.length,
    },
    warnings,
    emptyBuckets: result.emptyBuckets.length,
    ringVertices: result.elevationBuckets.reduce((sum, bucket) => sum + bucket.ringsWgs84.reduce((ringSum, ring) => ringSum + ring.length, 0), 0),
    bedLinePoints: reference.points.length,
    chordFallbackPieces,
    slicing: result.slicing,
  };
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
  let chordFallbackPieces = 0;
  let bedLineVertices = 0;
  const slicing: SlicingCounts = { slices: 0, slicedBuckets: 0, bucketsOverTolerance: 0 };
  for (const [segmentIndex, segment] of segments.entries()) {
    const record = recordById.get(segment.segmentId);
    if (!record) throw new Error(`Creek Segment ${segment.segmentId} has no Stage 1 cross-sections.`);
    const result = polygonsForCreekSegment({
      segment,
      adjacent: adjacentById.get(segment.segmentId) ?? {},
      record,
      recordById,
      depthSummary: depthSummaryById.get(segment.segmentId),
      tiles,
    });
    warnings.push(...result.warnings);
    polygonSets.push(result.polygonSet);
    ladders.push(result.ladder);
    totalBuckets += result.polygonSet.elevationBuckets.length;
    emptyBuckets += result.emptyBuckets;
    ringVertices += result.ringVertices;
    bedLineVertices += result.bedLinePoints;
    chordFallbackPieces += result.chordFallbackPieces;
    slicing.slices += result.slicing.slices;
    slicing.slicedBuckets += result.slicing.slicedBuckets;
    slicing.bucketsOverTolerance += result.slicing.bucketsOverTolerance;
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
    counts: {
      depthBuckets: totalBuckets,
      emptyBuckets,
      ringVertices,
      bedLineVertices,
      chordFallbackPieces,
      slices: slicing.slices,
      slicedBuckets: slicing.slicedBuckets,
      bucketsOverTolerance: slicing.bucketsOverTolerance,
    },
    warnings,
    summaryLines: [
      `${polygonSets.length} Creek Segments, ${totalBuckets} depth buckets (${emptyBuckets} empty), ${ringVertices} ring vertices.`,
      `Bed lines: ${bedLineVertices} points at ${PARAMETERS.bedLine.spacingM} m, ${chordFallbackPieces} thalweg-to-thalweg piece(s) without a lidar path.`,
      `Slicing: ${slicing.slicedBuckets} of ${totalBuckets} depth buckets cut into more than one slice (${slicing.slices} slices in all); ` +
        `${slicing.bucketsOverTolerance} bucket(s) still deviate more than ${PARAMETERS.slicing.toleranceM} m at the ${PARAMETERS.slicing.tolerancePercentile} quantile.`,
    ],
  };
}
