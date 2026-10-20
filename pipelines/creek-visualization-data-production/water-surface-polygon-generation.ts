import { contours } from 'd3-contour';
import { fromArrayBuffer } from 'geotiff';
import { readFile } from 'node:fs/promises';
import {
  BANK_OVERLAP_MARGIN_M,
  BUCKET_STEP_M,
  CENTERLINE_SAMPLE_SPACING_M,
  CORRIDOR_HALF_WIDTH_M,
} from './constants.ts';
import type { AdjacentCreekSegments } from './creek-segment-adjacency.ts';
import type { CreekSegment } from './tnc-flowline-segmentation.ts';
import { roundToDecimals, utm10nToWgs84, type UtmPoint } from './utm-geometry.ts';

export type { AdjacentCreekSegments };

export interface ElevationBucket {
  minWaterSurfaceElevationM: number;
  maxWaterSurfaceElevationM: number;
}

/**
 * A bucket to trace, optionally with a sloped wet threshold. Without `fillThreshold` the
 * threshold is flat at the bucket minimum. With it, the threshold runs linearly from
 * `atStartM` on the corridor's start boundary to `atEndM` on its end boundary (see
 * `fractionBetweenBoundaries`), so one polygon can meet each neighbour at the junction
 * water-surface elevation (WSE) they share, along the whole shared boundary line. The sloped
 * threshold is never taken below the bucket minimum, so the polygon always contains the flat one.
 */
export interface ElevationBucketToTrace extends ElevationBucket {
  fillThreshold?: { atStartM: number; atEndM: number };
}

export interface WaterSurfacePolygonBucket extends ElevationBucket {
  ringsWgs84: number[][][];
}

export interface CorridorBoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface WaterSurfacePolygonGenerationResult {
  elevationBuckets: WaterSurfacePolygonBucket[];
  emptyBuckets: ElevationBucket[];
  centerlineElevationM: { min: number; max: number };
  centerlineNoDataSamples: number;
  corridorBboxWgs84: CorridorBoundingBox;
}

export interface ElevationGrid {
  width: number;
  height: number;
  originX: number;
  originY: number;
  resolutionX: number;
  resolutionY: number;
  noData: number | null;
  elevations: Float64Array;
}

type PlanarPoint = [number, number];

/**
 * A straight boundary line through `point` with a unit normal. The corridor lies on the side
 * where the signed distance (point minus `point`, dotted with the normal) is at most 0.
 */
interface BoundaryLine {
  point: UtmPoint;
  normalX: number;
  normalY: number;
  /** True when a neighbouring Creek Segment's corridor meets this line from the other side. */
  shared: boolean;
}

interface SegmentFrame {
  start: UtmPoint;
  lengthM: number;
  unitX: number;
  unitY: number;
  normalX: number;
  normalY: number;
  /** The boundary at the start vertex, facing outward (upstream of the segment's own axis). */
  startBoundary: BoundaryLine;
  /** The boundary at the end vertex, facing outward. */
  endBoundary: BoundaryLine;
  /** Along-axis extent of the rectangle the boundaries cut: 0..lengthM, extended past a slanted boundary. */
  alongMinM: number;
  alongMaxM: number;
  /** Counter-clockwise convex ring of the corridor: ±CORRIDOR_HALF_WIDTH_M, cut by both boundaries. */
  corridor: PlanarPoint[];
}

/**
 * How far past a vertex, along the segment axis, a slanted boundary may reach. A bisector at a
 * sharp bend would otherwise run far down the outer bank; past this the corridor is cut square.
 */
const BOUNDARY_REACH_ALONG_M = CORRIDOR_HALF_WIDTH_M;

const EIGHT_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Half-open 0.05 m buckets from the step at or below the lowest reading through the bucket that contains the highest. */
export function buildWaterSurfaceElevationBuckets(
  elevations: readonly (number | null)[],
): ElevationBucket[] {
  let minMilli = Infinity;
  let maxMilli = -Infinity;
  for (const elevation of elevations) {
    if (elevation === null) continue;
    const milli = Math.round(elevation * 1000);
    minMilli = Math.min(minMilli, milli);
    maxMilli = Math.max(maxMilli, milli);
  }
  if (!Number.isFinite(minMilli) || !Number.isFinite(maxMilli)) {
    throw new Error('Observed time series has no gauge-height readings to bucket.');
  }
  const stepMilli = Math.round(BUCKET_STEP_M * 1000);
  const start = Math.floor(minMilli / stepMilli) * stepMilli;
  const lastStart = Math.floor(maxMilli / stepMilli) * stepMilli;
  const buckets: ElevationBucket[] = [];
  for (let edge = start; edge <= lastStart; edge += stepMilli) {
    buckets.push({
      minWaterSurfaceElevationM: edge / 1000,
      maxWaterSurfaceElevationM: (edge + stepMilli) / 1000,
    });
  }
  return buckets;
}

/** Unit vector from the segment's start vertex to its end vertex, with the segment length. */
function unitDirection(segment: CreekSegment): { x: number; y: number; lengthM: number } {
  const dx = segment.endUtm.x - segment.startUtm.x;
  const dy = segment.endUtm.y - segment.startUtm.y;
  const lengthM = Math.hypot(dx, dy);
  if (lengthM === 0) {
    throw new Error(`Creek Segment ${segment.segmentId} has zero length, so it has no corridor.`);
  }
  return { x: dx / lengthM, y: dy / lengthM, lengthM };
}

/**
 * Direction the boundary at a shared vertex faces: the mean of the two segments' directions,
 * so the boundary is the angle bisector of their two perpendiculars. Without a neighbour it is
 * the segment's own direction (the perpendicular). Two nearly opposite directions (a hairpin)
 * have no usable mean and keep the perpendicular.
 */
function boundaryDirection(own: { x: number; y: number }, neighbour: CreekSegment | undefined): { x: number; y: number } {
  if (!neighbour) return own;
  const other = unitDirection(neighbour);
  const meanX = own.x + other.x;
  const meanY = own.y + other.y;
  const meanLength = Math.hypot(meanX, meanY);
  if (meanLength < 1e-6) return own;
  return { x: meanX / meanLength, y: meanY / meanLength };
}

/** Signed distance from the boundary line, positive outside the corridor. */
function distanceOutsideBoundary(x: number, y: number, boundary: BoundaryLine): number {
  return (x - boundary.point.x) * boundary.normalX + (y - boundary.point.y) * boundary.normalY;
}

function segmentFrame(segment: CreekSegment, adjacent: AdjacentCreekSegments = {}): SegmentFrame {
  const direction = unitDirection(segment);
  const { lengthM } = direction;
  const unitX = direction.x;
  const unitY = direction.y;
  const normalX = -unitY;
  const normalY = unitX;
  const corner = (along: number, lateral: number): PlanarPoint => [
    segment.startUtm.x + unitX * along + normalX * lateral,
    segment.startUtm.y + unitY * along + normalY * lateral,
  ];
  // The start boundary faces back along the flowline, the end boundary faces forward.
  const startDirection = boundaryDirection(direction, adjacent.atStart);
  const endDirection = boundaryDirection(direction, adjacent.atEnd);
  const startBoundary: BoundaryLine = {
    point: segment.startUtm,
    normalX: -startDirection.x,
    normalY: -startDirection.y,
    shared: adjacent.atStart !== undefined,
  };
  const endBoundary: BoundaryLine = {
    point: segment.endUtm,
    normalX: endDirection.x,
    normalY: endDirection.y,
    shared: adjacent.atEnd !== undefined,
  };

  // Without neighbours the ring is the plain rectangle, exactly as before. A slanted boundary
  // needs room past the vertex, so the rectangle is extended there and then cut by that boundary.
  const alongMinM = adjacent.atStart ? -BOUNDARY_REACH_ALONG_M : 0;
  const alongMaxM = adjacent.atEnd ? lengthM + BOUNDARY_REACH_ALONG_M : lengthM;
  let corridor: PlanarPoint[] = [
    corner(alongMinM, -CORRIDOR_HALF_WIDTH_M),
    corner(alongMaxM, -CORRIDOR_HALF_WIDTH_M),
    corner(alongMaxM, CORRIDOR_HALF_WIDTH_M),
    corner(alongMinM, CORRIDOR_HALF_WIDTH_M),
  ];
  if (adjacent.atStart) corridor = clipRingToBoundary(corridor, startBoundary);
  if (adjacent.atEnd) corridor = clipRingToBoundary(corridor, endBoundary);
  if (corridor.length < 3) {
    throw new Error(`Creek Segment ${segment.segmentId} corridor collapsed when cut at its junction bisectors.`);
  }
  return {
    start: segment.startUtm,
    lengthM,
    unitX,
    unitY,
    normalX,
    normalY,
    startBoundary,
    endBoundary,
    alongMinM,
    alongMaxM,
    corridor,
  };
}

/**
 * Where a point sits between the corridor's two boundary lines: 0 on the start boundary, 1 on
 * the end boundary, linear in between, clamped outside. On a straight corridor with
 * perpendicular ends this is the along-axis fraction. At a shared vertex the boundary is the
 * junction bisector, so every point on that line gets the same fraction from both neighbours
 * and the two segments' sloped thresholds (and the browser's sloped surfaces, which use the
 * same rule) agree on the whole line instead of only at the vertex.
 */
export function fractionBetweenBoundaries(
  distanceInsideStartM: number,
  distanceInsideEndM: number,
): number {
  if (distanceInsideStartM <= 0) return 0;
  if (distanceInsideEndM <= 0) return 1;
  return distanceInsideStartM / (distanceInsideStartM + distanceInsideEndM);
}

function lateralAndAlong(x: number, y: number, frame: SegmentFrame): { along: number; lateral: number } {
  const dx = x - frame.start.x;
  const dy = y - frame.start.y;
  return {
    along: dx * frame.unitX + dy * frame.unitY,
    lateral: dx * frame.normalX + dy * frame.normalY,
  };
}

/**
 * How far a point lies outside the corridor, by part: past the start boundary, past the end
 * boundary, past the extended rectangle's ends, and beyond the half-width. All 0 inside.
 */
function corridorExcess(x: number, y: number, frame: SegmentFrame): { start: number; end: number; along: number; lateral: number } {
  const { along, lateral } = lateralAndAlong(x, y, frame);
  return {
    start: Math.max(0, distanceOutsideBoundary(x, y, frame.startBoundary)),
    end: Math.max(0, distanceOutsideBoundary(x, y, frame.endBoundary)),
    along: Math.max(0, frame.alongMinM - along, along - frame.alongMaxM),
    lateral: Math.max(0, Math.abs(lateral) - CORRIDOR_HALF_WIDTH_M),
  };
}

/**
 * Whether a raster cell centered here belongs to the corridor mask. A cell may sit up to
 * `sharedBoundaryReachM` past a shared boundary, so the two neighbours' masks both reach the
 * line and no half-cell strip along it is left out of both; the vector clip then cuts each
 * polygon exactly at the line. An unshared boundary (publish, a flowline end) is exact.
 */
function cellInCorridor(x: number, y: number, frame: SegmentFrame, sharedBoundaryReachM: number): boolean {
  const epsilon = 1e-6;
  const excess = corridorExcess(x, y, frame);
  const startReach = frame.startBoundary.shared ? sharedBoundaryReachM : 0;
  const endReach = frame.endBoundary.shared ? sharedBoundaryReachM : 0;
  return (
    excess.start <= startReach + epsilon &&
    excess.end <= endReach + epsilon &&
    excess.along <= epsilon &&
    excess.lateral <= epsilon
  );
}

function isNoData(value: number, noData: number | null): boolean {
  if (!Number.isFinite(value)) return true;
  if (noData !== null && value === noData) return true;
  return value <= -1000 || value >= 10000;
}

function cellIndex(x: number, y: number, grid: ElevationGrid): number | null {
  const column = Math.floor((x - grid.originX) / grid.resolutionX);
  const row = Math.floor((y - grid.originY) / grid.resolutionY);
  if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) return null;
  return row * grid.width + column;
}

function cellCenter(index: number, grid: ElevationGrid): PlanarPoint {
  const column = index % grid.width;
  const row = Math.floor(index / grid.width);
  return [
    grid.originX + (column + 0.5) * grid.resolutionX,
    grid.originY + (row + 0.5) * grid.resolutionY,
  ];
}

export async function readElevationGrid(rasterPath: string): Promise<ElevationGrid> {
  let bytes: Buffer;
  try {
    bytes = await readFile(rasterPath);
  } catch (error) {
    throw new Error(`Could not read the USGS 3DEP window at ${rasterPath}. Run npm run pipeline:acquire first.`, {
      cause: error,
    });
  }
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  if (!image.pixelIsArea()) {
    throw new Error('USGS 3DEP window pixels are points, not areas. The corridor mask expects area pixels.');
  }
  const width = image.getWidth();
  const height = image.getHeight();
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const originX = origin[0];
  const originY = origin[1];
  const resolutionX = resolution[0];
  const resolutionY = resolution[1];
  if (
    originX === undefined ||
    originY === undefined ||
    resolutionX === undefined ||
    resolutionY === undefined
  ) {
    throw new Error('USGS 3DEP window is missing a geotransform.');
  }
  if (Math.abs(Math.abs(resolutionX) - 1) > 0.05 || Math.abs(Math.abs(resolutionY) - 1) > 0.05) {
    throw new Error(`Expected a 1 m USGS 3DEP window, got resolution ${resolutionX}, ${resolutionY}.`);
  }
  const [west, south, east, north] = image.getBoundingBox();
  const tolerance = 0.05;
  const maxX = originX + resolutionX * width;
  const minY = originY + resolutionY * height;
  if (
    Math.abs(originX - west) > tolerance ||
    Math.abs(maxX - east) > tolerance ||
    Math.abs(minY - south) > tolerance ||
    Math.abs(originY - north) > tolerance
  ) {
    throw new Error(
      `USGS 3DEP geotransform does not match its bounding box (origin ${originX}, ${originY}; resolution ${resolutionX}, ${resolutionY}).`,
    );
  }
  const rawNoData = image.getGDALNoData();
  const rasters = await image.readRasters({ interleave: false });
  const band = rasters[0];
  if (!band || band.length !== width * height) {
    throw new Error(`USGS 3DEP window has ${band ? band.length : 0} samples, expected ${width * height}.`);
  }
  const elevations = new Float64Array(band.length);
  for (let index = 0; index < band.length; index += 1) {
    elevations[index] = band[index] ?? Number.NaN;
  }
  return {
    width,
    height,
    originX,
    originY,
    resolutionX,
    resolutionY,
    noData: rawNoData !== null && Number.isFinite(rawNoData) ? rawNoData : null,
    elevations,
  };
}

function floodFill(wet: Uint8Array, seeds: readonly number[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(wet.length);
  const queue: number[] = [];
  for (const seed of seeds) {
    if (wet[seed] === 1 && mask[seed] === 0) {
      mask[seed] = 1;
      queue.push(seed);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const index = queue[head];
    head += 1;
    if (index === undefined) continue;
    const column = index % width;
    const row = Math.floor(index / width);
    for (const [columnStep, rowStep] of EIGHT_NEIGHBORS) {
      const nextColumn = column + columnStep;
      const nextRow = row + rowStep;
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= width || nextRow >= height) continue;
      const next = nextRow * width + nextColumn;
      if (wet[next] !== 1 || mask[next] === 1) continue;
      mask[next] = 1;
      queue.push(next);
    }
  }
  return mask;
}

function cross(origin: PlanarPoint, end: PlanarPoint, point: PlanarPoint): number {
  return (end[0] - origin[0]) * (point[1] - origin[1]) - (end[1] - origin[1]) * (point[0] - origin[0]);
}

function segmentIntersection(start: PlanarPoint, end: PlanarPoint, edgeStart: PlanarPoint, edgeEnd: PlanarPoint): PlanarPoint {
  const denominator =
    (start[0] - end[0]) * (edgeStart[1] - edgeEnd[1]) - (start[1] - end[1]) * (edgeStart[0] - edgeEnd[0]);
  if (Math.abs(denominator) < 1e-12) return end;
  const t =
    ((start[0] - edgeStart[0]) * (edgeStart[1] - edgeEnd[1]) -
      (start[1] - edgeStart[1]) * (edgeStart[0] - edgeEnd[0])) /
    denominator;
  return [start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])];
}

/** Sutherland–Hodgman step: keeps the part of the ring to the left of the directed line edgeStart→edgeEnd. */
function clipRingToLeftOfLine(subject: PlanarPoint[], edgeStart: PlanarPoint, edgeEnd: PlanarPoint): PlanarPoint[] {
  const output: PlanarPoint[] = [];
  const previousStart = subject[subject.length - 1];
  if (!previousStart) return output;
  let previous = previousStart;
  for (const current of subject) {
    const currentInside = cross(edgeStart, edgeEnd, current) >= -1e-7;
    const previousInside = cross(edgeStart, edgeEnd, previous) >= -1e-7;
    if (currentInside) {
      if (!previousInside) output.push(segmentIntersection(previous, current, edgeStart, edgeEnd));
      output.push(current);
    } else if (previousInside) {
      output.push(segmentIntersection(previous, current, edgeStart, edgeEnd));
    }
    previous = current;
  }
  return output;
}

/** Keeps the part of the ring on the corridor side of the boundary (signed distance at most 0). */
function clipRingToBoundary(subject: PlanarPoint[], boundary: BoundaryLine): PlanarPoint[] {
  // The inside is to the left of a line running along the boundary with the normal on its right.
  const lineStart: PlanarPoint = [boundary.point.x, boundary.point.y];
  const lineEnd: PlanarPoint = [boundary.point.x - boundary.normalY, boundary.point.y + boundary.normalX];
  return clipRingToLeftOfLine(subject, lineStart, lineEnd);
}

/** Clip polygon must be counter-clockwise so the inside is to the left of each edge. */
function clipRingToConvex(subject: PlanarPoint[], clip: readonly PlanarPoint[]): PlanarPoint[] {
  let output = subject;
  for (let edge = 0; edge < clip.length; edge += 1) {
    if (output.length === 0) break;
    const edgeStart = clip[edge];
    const edgeEnd = clip[(edge + 1) % clip.length];
    if (!edgeStart || !edgeEnd) break;
    output = clipRingToLeftOfLine(output, edgeStart, edgeEnd);
  }
  return output;
}

function dropConsecutive(points: PlanarPoint[]): PlanarPoint[] {
  const kept: PlanarPoint[] = [];
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    kept.push(point);
  }
  if (kept.length >= 2) {
    const first = kept[0];
    const last = kept[kept.length - 1];
    if (first && last && first[0] === last[0] && first[1] === last[1]) kept.pop();
  }
  return kept;
}

function dropCollinear(points: PlanarPoint[]): PlanarPoint[] {
  if (points.length < 3) return points;
  const kept: PlanarPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!previous || !current || !next) continue;
    const area =
      (current[0] - previous[0]) * (next[1] - current[1]) -
      (current[1] - previous[1]) * (next[0] - current[0]);
    if (Math.abs(area) > 1e-4) kept.push(current);
  }
  return kept;
}

function signedArea(openRing: readonly PlanarPoint[]): number {
  let sum = 0;
  for (let index = 0; index < openRing.length; index += 1) {
    const current = openRing[index];
    const next = openRing[(index + 1) % openRing.length];
    if (!current || !next) continue;
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

function closeRing(points: PlanarPoint[]): PlanarPoint[] | null {
  const open = dropConsecutive(points);
  if (open.length < 3 || signedArea(open) === 0) return null;
  const first = open[0];
  if (!first) return null;
  return [...open, [first[0], first[1]]];
}

/** Esri outer rings are clockwise and holes are counter-clockwise in longitude/latitude. */
function orientRing(closed: PlanarPoint[], isHole: boolean): PlanarPoint[] {
  const open = closed.slice(0, -1);
  const counterClockwise = signedArea(open) > 0;
  if (counterClockwise === isHole) return closed;
  open.reverse();
  const first = open[0];
  if (!first) return closed;
  return [...open, [first[0], first[1]]];
}

function pixelToUtm(position: number[], grid: ElevationGrid): PlanarPoint {
  const pixelX = position[0];
  const pixelY = position[1];
  if (pixelX === undefined || pixelY === undefined) {
    throw new Error('Contour coordinate is incomplete.');
  }
  // d3-contour places sample (column, row) at (column + 0.5, row + 0.5).
  // The GeoTIFF origin is the corner of cell (0, 0), so that sample is the cell center.
  return [grid.originX + pixelX * grid.resolutionX, grid.originY + pixelY * grid.resolutionY];
}

function assertInsideCorridor(ring: readonly PlanarPoint[], frame: SegmentFrame, elevationM: number): void {
  for (const [x, y] of ring) {
    const excess = corridorExcess(x, y, frame);
    const worst = Math.max(excess.start, excess.end, excess.along, excess.lateral);
    if (worst > 0.05) {
      throw new Error(`Prepared water-surface polygon at ${elevationM} m leaves the corridor by ${worst.toFixed(3)} m.`);
    }
  }
}

/**
 * Grows a wet mask outward by `cells` 8-connected steps, intersected with the
 * in-corridor mask so the dilation stays inside the Creek Segment corridor.
 * The input mask is not mutated. Returns a new Uint8Array.
 */
export function dilateMask8Connected(
  mask: Uint8Array,
  inCorridor: Uint8Array,
  width: number,
  height: number,
  cells: number,
): Uint8Array {
  if (cells <= 0) return new Uint8Array(mask);
  let current = new Uint8Array(mask);
  for (let pass = 0; pass < cells; pass += 1) {
    const next = new Uint8Array(current.length);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const index = row * width + column;
        if (inCorridor[index] !== 1) continue;
        if (current[index] === 1) {
          next[index] = 1;
          continue;
        }
        for (const [columnStep, rowStep] of EIGHT_NEIGHBORS) {
          const neighborColumn = column + columnStep;
          const neighborRow = row + rowStep;
          if (
            neighborColumn < 0 ||
            neighborRow < 0 ||
            neighborColumn >= width ||
            neighborRow >= height
          ) {
            continue;
          }
          if (current[neighborRow * width + neighborColumn] === 1) {
            next[index] = 1;
            break;
          }
        }
      }
    }
    current = next;
  }
  return current;
}

function vectorizeMask(
  mask: Uint8Array,
  values: number[],
  grid: ElevationGrid,
  frame: SegmentFrame,
  elevationM: number,
): number[][][] {
  for (let index = 0; index < mask.length; index += 1) values[index] = mask[index] === 1 ? 1 : 0;
  const [contour] = contours().size([grid.width, grid.height]).smooth(false).thresholds([0.5])(values);
  if (!contour) return [];
  const rings: number[][][] = [];
  for (const polygon of contour.coordinates) {
    polygon.forEach((pixelRing, ringIndex) => {
      const utmRing = dropConsecutive(pixelRing.map((position) => pixelToUtm(position, grid)));
      const clipped = dropCollinear(dropConsecutive(clipRingToConvex(utmRing, frame.corridor)));
      if (clipped.length < 3) return;
      assertInsideCorridor(clipped, frame, elevationM);
      const lonLat = clipped.map(([x, y]) => {
        const [longitude, latitude] = utm10nToWgs84(x, y);
        return [roundToDecimals(longitude, 7), roundToDecimals(latitude, 7)] as PlanarPoint;
      });
      const closed = closeRing(lonLat);
      if (!closed) return;
      rings.push(orientRing(closed, ringIndex > 0));
    });
  }
  return rings;
}

function corridorBboxWgs84(frame: SegmentFrame): CorridorBoundingBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [x, y] of frame.corridor) {
    const [longitude, latitude] = utm10nToWgs84(x, y);
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  return { west, south, east, north };
}

/**
 * The window of a larger elevation grid that holds one Creek Segment corridor plus a few
 * cells of padding. Cells keep their exact elevations and positions; a smaller grid only
 * makes each elevation bucket faster when one terrain tile covers many Creek Segments.
 */
export function cropElevationGridToCorridor(
  grid: ElevationGrid,
  segment: CreekSegment,
  adjacent: AdjacentCreekSegments = {},
): ElevationGrid {
  const paddingCells = 3;
  const frame = segmentFrame(segment, adjacent);
  const columns = frame.corridor.map(([x]) => (x - grid.originX) / grid.resolutionX);
  const rows = frame.corridor.map(([, y]) => (y - grid.originY) / grid.resolutionY);
  const firstColumn = Math.max(0, Math.floor(Math.min(...columns)) - paddingCells);
  const lastColumn = Math.min(grid.width - 1, Math.ceil(Math.max(...columns)) + paddingCells);
  const firstRow = Math.max(0, Math.floor(Math.min(...rows)) - paddingCells);
  const lastRow = Math.min(grid.height - 1, Math.ceil(Math.max(...rows)) + paddingCells);
  const width = lastColumn - firstColumn + 1;
  const height = lastRow - firstRow + 1;
  const elevations = new Float64Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = (firstRow + row) * grid.width + firstColumn;
    elevations.set(grid.elevations.subarray(sourceStart, sourceStart + width), row * width);
  }
  return {
    width,
    height,
    originX: grid.originX + firstColumn * grid.resolutionX,
    originY: grid.originY + firstRow * grid.resolutionY,
    resolutionX: grid.resolutionX,
    resolutionY: grid.resolutionY,
    noData: grid.noData,
    elevations,
  };
}

/** True when every corner of the Creek Segment corridor lies inside the grid. */
export function corridorInsideElevationGrid(
  grid: ElevationGrid,
  segment: CreekSegment,
  adjacent: AdjacentCreekSegments = {},
): boolean {
  return segmentFrame(segment, adjacent).corridor.every(([x, y]) => cellIndex(x, y, grid) !== null);
}

function corridorFits(grid: ElevationGrid, frame: SegmentFrame): void {
  for (const [x, y] of frame.corridor) {
    if (cellIndex(x, y, grid) === null) {
      throw new Error('The USGS 3DEP window does not cover the Creek Segment corridor. Re-run npm run pipeline:acquire.');
    }
  }
}

/**
 * Wet cells are 8-connected to wet seed cells under the segment centerline, plus any
 * additional seed points the caller supplies (for example, thalweg points found off the centerline).
 * A cell is wet when its ground is below the bucket's threshold: flat at the bucket minimum, so the
 * polygon never shows a higher water surface than observed, or sloped between the two junction
 * thresholds a bucket carries, measured between the corridor's boundary lines (see
 * `ElevationBucketToTrace` and `fractionBetweenBoundaries`).
 */
export async function generateWaterSurfacePolygons(input: {
  /** USGS 3DEP GeoTIFF to read; ignored when `elevationGrid` is already loaded. */
  elevationRasterPath?: string;
  elevationGrid?: ElevationGrid;
  segment: CreekSegment;
  buckets: ElevationBucketToTrace[];
  /** Print a line every 10 buckets. Defaults to true. */
  logProgress?: boolean;
  /**
   * Extra flood-fill seed points in UTM zone 10N meters. A point outside the grid or the
   * Creek Segment corridor is ignored. Omitted means centerline seeds only.
   */
  additionalSeedPointsUtm?: readonly UtmPoint[];
  /** Neighbours sharing the segment's vertices; omitted means perpendicular corridor ends. */
  adjacentSegments?: AdjacentCreekSegments;
}): Promise<WaterSurfacePolygonGenerationResult> {
  let grid = input.elevationGrid;
  if (!grid) {
    if (!input.elevationRasterPath) throw new Error('Water-surface polygons need an elevation raster path or grid.');
    grid = await readElevationGrid(input.elevationRasterPath);
  }
  const frame = segmentFrame(input.segment, input.adjacentSegments ?? {});
  corridorFits(grid, frame);

  // Per cell: 1 inside the corridor, and where the cell sits between the corridor's start and
  // end boundaries, 0 on the start boundary to 1 on the end boundary, for the sloped threshold.
  const halfCellDiagonalM = Math.hypot(grid.resolutionX, grid.resolutionY) / 2;
  const inCorridor = new Uint8Array(grid.width * grid.height);
  const alongFraction = new Float64Array(grid.width * grid.height);
  for (let index = 0; index < inCorridor.length; index += 1) {
    const [x, y] = cellCenter(index, grid);
    if (!cellInCorridor(x, y, frame, halfCellDiagonalM)) continue;
    inCorridor[index] = 1;
    alongFraction[index] = fractionBetweenBoundaries(
      -distanceOutsideBoundary(x, y, frame.startBoundary),
      -distanceOutsideBoundary(x, y, frame.endBoundary),
    );
  }

  const seedIndexes: number[] = [];
  const seedSeen = new Uint8Array(grid.width * grid.height);
  const centerlineElevations: number[] = [];
  let centerlineNoDataSamples = 0;
  const steps = Math.ceil(frame.lengthM / CENTERLINE_SAMPLE_SPACING_M);
  for (let step = 0; step <= steps; step += 1) {
    const distanceAlong = Math.min(frame.lengthM, step * CENTERLINE_SAMPLE_SPACING_M);
    const x = frame.start.x + frame.unitX * distanceAlong;
    const y = frame.start.y + frame.unitY * distanceAlong;
    const index = cellIndex(x, y, grid);
    if (index === null) {
      throw new Error(`Creek Segment ${input.segment.segmentId} leaves the USGS 3DEP window.`);
    }
    const elevation = grid.elevations[index];
    if (elevation === undefined || isNoData(elevation, grid.noData)) {
      centerlineNoDataSamples += 1;
    } else {
      centerlineElevations.push(elevation);
    }
    if (seedSeen[index] === 0) {
      seedSeen[index] = 1;
      seedIndexes.push(index);
    }
  }
  if (centerlineElevations.length === 0) {
    throw new Error(`Creek Segment ${input.segment.segmentId} has no USGS 3DEP elevation under the centerline.`);
  }
  for (const point of input.additionalSeedPointsUtm ?? []) {
    const index = cellIndex(point.x, point.y, grid);
    if (index === null || inCorridor[index] !== 1 || seedSeen[index] === 1) continue;
    seedSeen[index] = 1;
    seedIndexes.push(index);
  }

  const values = new Array<number>(grid.width * grid.height);
  const elevationBuckets: WaterSurfacePolygonBucket[] = [];
  const emptyBuckets: ElevationBucket[] = [];
  for (const [bucketIndex, bucket] of input.buckets.entries()) {
    if (input.logProgress !== false && bucketIndex % 10 === 0) {
      console.log(
        `Water-surface polygon ${bucketIndex + 1} of ${input.buckets.length} at ${bucket.minWaterSurfaceElevationM} m`,
      );
    }
    const { fillThreshold } = bucket;
    const wet = new Uint8Array(grid.width * grid.height);
    for (let index = 0; index < wet.length; index += 1) {
      if (inCorridor[index] !== 1) continue;
      const elevation = grid.elevations[index];
      if (elevation === undefined || isNoData(elevation, grid.noData)) continue;
      const flatThreshold = bucket.minWaterSurfaceElevationM;
      const slopedThreshold = fillThreshold
        ? fillThreshold.atStartM + (fillThreshold.atEndM - fillThreshold.atStartM) * (alongFraction[index] ?? 0)
        : flatThreshold;
      if (elevation < Math.max(flatThreshold, slopedThreshold)) wet[index] = 1;
    }
    const mask = floodFill(wet, seedIndexes, grid.width, grid.height);
    const marginCells = Math.max(0, Math.round(BANK_OVERLAP_MARGIN_M / grid.resolutionX));
    const dilatedMask = dilateMask8Connected(mask, inCorridor, grid.width, grid.height, marginCells);
    const ringsWgs84 = vectorizeMask(dilatedMask, values, grid, frame, bucket.minWaterSurfaceElevationM);
    const traced: ElevationBucket = {
      minWaterSurfaceElevationM: bucket.minWaterSurfaceElevationM,
      maxWaterSurfaceElevationM: bucket.maxWaterSurfaceElevationM,
    };
    elevationBuckets.push({ ...traced, ringsWgs84 });
    if (ringsWgs84.length === 0) emptyBuckets.push(traced);
  }

  return {
    elevationBuckets,
    emptyBuckets,
    centerlineElevationM: {
      min: Math.min(...centerlineElevations),
      max: Math.max(...centerlineElevations),
    },
    centerlineNoDataSamples,
    corridorBboxWgs84: corridorBboxWgs84(frame),
  };
}
