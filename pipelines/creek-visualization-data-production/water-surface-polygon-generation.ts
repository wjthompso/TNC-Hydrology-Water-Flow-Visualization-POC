import { contours } from 'd3-contour';
import { fromArrayBuffer } from 'geotiff';
import { readFile } from 'node:fs/promises';
import { BUCKET_STEP_M, CENTERLINE_SAMPLE_SPACING_M, CORRIDOR_HALF_WIDTH_M } from './constants.ts';
import type { CreekSegment } from './tnc-flowline-segmentation.ts';
import { roundToDecimals, utm10nToWgs84, type UtmPoint } from './utm-geometry.ts';

export interface ElevationBucket {
  minWaterSurfaceElevationM: number;
  maxWaterSurfaceElevationM: number;
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

interface ElevationGrid {
  width: number;
  height: number;
  originX: number;
  originY: number;
  resolutionX: number;
  resolutionY: number;
  noData: number | null;
  elevations: Float64Array;
}

interface SegmentFrame {
  start: UtmPoint;
  lengthM: number;
  unitX: number;
  unitY: number;
  normalX: number;
  normalY: number;
  corridor: Array<[number, number]>;
}

type PlanarPoint = [number, number];

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

function segmentFrame(segment: CreekSegment): SegmentFrame {
  const dx = segment.endUtm.x - segment.startUtm.x;
  const dy = segment.endUtm.y - segment.startUtm.y;
  const lengthM = Math.hypot(dx, dy);
  if (lengthM === 0) {
    throw new Error(`Creek Segment ${segment.segmentId} has zero length, so it has no corridor.`);
  }
  const unitX = dx / lengthM;
  const unitY = dy / lengthM;
  const normalX = -unitY;
  const normalY = unitX;
  const corner = (along: number, lateral: number): PlanarPoint => [
    segment.startUtm.x + unitX * along + normalX * lateral,
    segment.startUtm.y + unitY * along + normalY * lateral,
  ];
  return {
    start: segment.startUtm,
    lengthM,
    unitX,
    unitY,
    normalX,
    normalY,
    corridor: [
      corner(0, -CORRIDOR_HALF_WIDTH_M),
      corner(lengthM, -CORRIDOR_HALF_WIDTH_M),
      corner(lengthM, CORRIDOR_HALF_WIDTH_M),
      corner(0, CORRIDOR_HALF_WIDTH_M),
    ],
  };
}

function pointInCorridor(x: number, y: number, frame: SegmentFrame): boolean {
  const dx = x - frame.start.x;
  const dy = y - frame.start.y;
  const along = dx * frame.unitX + dy * frame.unitY;
  const lateral = dx * frame.normalX + dy * frame.normalY;
  const epsilon = 1e-6;
  return (
    along >= -epsilon &&
    along <= frame.lengthM + epsilon &&
    Math.abs(lateral) <= CORRIDOR_HALF_WIDTH_M + epsilon
  );
}

function lateralAndAlong(x: number, y: number, frame: SegmentFrame): { along: number; lateral: number } {
  const dx = x - frame.start.x;
  const dy = y - frame.start.y;
  return {
    along: dx * frame.unitX + dy * frame.unitY,
    lateral: dx * frame.normalX + dy * frame.normalY,
  };
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

async function readElevationGrid(rasterPath: string): Promise<ElevationGrid> {
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

/** Clip polygon must be counter-clockwise so the inside is to the left of each edge. */
function clipRingToConvex(subject: PlanarPoint[], clip: readonly PlanarPoint[]): PlanarPoint[] {
  let output = subject;
  for (let edge = 0; edge < clip.length; edge += 1) {
    const input = output;
    output = [];
    if (input.length === 0) break;
    const edgeStart = clip[edge];
    const edgeEnd = clip[(edge + 1) % clip.length];
    const previousStart = input[input.length - 1];
    if (!edgeStart || !edgeEnd || !previousStart) break;
    let previous = previousStart;
    for (const current of input) {
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
    const { along, lateral } = lateralAndAlong(x, y, frame);
    const alongExcess = along < 0 ? -along : Math.max(0, along - frame.lengthM);
    const lateralExcess = Math.max(0, Math.abs(lateral) - CORRIDOR_HALF_WIDTH_M);
    if (alongExcess > 0.05 || lateralExcess > 0.05) {
      throw new Error(
        `Prepared water-surface polygon at ${elevationM} m leaves the corridor by ${Math.max(alongExcess, lateralExcess).toFixed(3)} m.`,
      );
    }
  }
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

function corridorFits(grid: ElevationGrid, frame: SegmentFrame): void {
  for (const [x, y] of frame.corridor) {
    if (cellIndex(x, y, grid) === null) {
      throw new Error('The USGS 3DEP window does not cover the Creek Segment corridor. Re-run npm run pipeline:acquire.');
    }
  }
}

/**
 * Wet cells are 8-connected to wet seed cells under the segment centerline.
 * The polygon is built at the bucket minimum, so it never shows a higher water surface than observed.
 */
export async function generateWaterSurfacePolygons(input: {
  elevationRasterPath: string;
  segment: CreekSegment;
  buckets: ElevationBucket[];
}): Promise<WaterSurfacePolygonGenerationResult> {
  const grid = await readElevationGrid(input.elevationRasterPath);
  const frame = segmentFrame(input.segment);
  corridorFits(grid, frame);

  const inCorridor = new Uint8Array(grid.width * grid.height);
  for (let index = 0; index < inCorridor.length; index += 1) {
    const [x, y] = cellCenter(index, grid);
    if (pointInCorridor(x, y, frame)) inCorridor[index] = 1;
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

  const values = new Array<number>(grid.width * grid.height);
  const elevationBuckets: WaterSurfacePolygonBucket[] = [];
  const emptyBuckets: ElevationBucket[] = [];
  for (const [bucketIndex, bucket] of input.buckets.entries()) {
    if (bucketIndex % 10 === 0) {
      console.log(
        `Water-surface polygon ${bucketIndex + 1} of ${input.buckets.length} at ${bucket.minWaterSurfaceElevationM} m`,
      );
    }
    const wet = new Uint8Array(grid.width * grid.height);
    for (let index = 0; index < wet.length; index += 1) {
      if (inCorridor[index] !== 1) continue;
      const elevation = grid.elevations[index];
      if (elevation === undefined || isNoData(elevation, grid.noData)) continue;
      if (elevation < bucket.minWaterSurfaceElevationM) wet[index] = 1;
    }
    const mask = floodFill(wet, seedIndexes, grid.width, grid.height);
    const ringsWgs84 = vectorizeMask(mask, values, grid, frame, bucket.minWaterSurfaceElevationM);
    elevationBuckets.push({ ...bucket, ringsWgs84 });
    if (ringsWgs84.length === 0) emptyBuckets.push(bucket);
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
