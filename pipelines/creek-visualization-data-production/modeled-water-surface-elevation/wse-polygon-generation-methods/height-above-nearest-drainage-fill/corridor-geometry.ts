import { CORRIDOR_HALF_WIDTH_M } from '../../../constants.ts';
import type { AdjacentCreekSegments } from '../../../creek-segment-adjacency.ts';
import type { CreekSegment } from '../../../tnc-flowline-segmentation.ts';
import type { ElevationGrid } from '../../../water-surface-polygon-generation.ts';

/**
 * Corridor, raster, flood-fill, and ring helpers copied from the private functions of
 * `water-surface-polygon-generation.ts` (publish and `junction-sloped-terrain-fill`), so this method
 * keeps the same ±100 m corridor, bisector-cut ends, 8-connectivity, and clipping without editing
 * that shared, fingerprinted file. Behaviour is unchanged from the originals; only exports were added.
 */

export type PlanarPoint = [number, number];

/** A straight boundary line through `point`; the corridor lies where the signed distance is at most 0. */
export interface BoundaryLine {
  point: { x: number; y: number };
  normalX: number;
  normalY: number;
  /** True when a neighbouring Creek Segment's corridor meets this line from the other side. */
  shared: boolean;
}

export interface SegmentFrame {
  start: { x: number; y: number };
  lengthM: number;
  unitX: number;
  unitY: number;
  normalX: number;
  normalY: number;
  startBoundary: BoundaryLine;
  endBoundary: BoundaryLine;
  alongMinM: number;
  alongMaxM: number;
  /** Counter-clockwise convex ring of the corridor: ±CORRIDOR_HALF_WIDTH_M, cut by both boundaries. */
  corridor: PlanarPoint[];
}

/** How far past a vertex, along the segment axis, a slanted boundary may reach. */
const BOUNDARY_REACH_ALONG_M = CORRIDOR_HALF_WIDTH_M;

export const EIGHT_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function unitDirection(segment: CreekSegment): { x: number; y: number; lengthM: number } {
  const dx = segment.endUtm.x - segment.startUtm.x;
  const dy = segment.endUtm.y - segment.startUtm.y;
  const lengthM = Math.hypot(dx, dy);
  if (lengthM === 0) throw new Error(`Creek Segment ${segment.segmentId} has zero length, so it has no corridor.`);
  return { x: dx / lengthM, y: dy / lengthM, lengthM };
}

/** Mean of the two segments' directions (the angle bisector of their perpendiculars); a hairpin keeps its own. */
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
export function distanceOutsideBoundary(x: number, y: number, boundary: BoundaryLine): number {
  return (x - boundary.point.x) * boundary.normalX + (y - boundary.point.y) * boundary.normalY;
}

export function segmentFrame(segment: CreekSegment, adjacent: AdjacentCreekSegments = {}): SegmentFrame {
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
  if (corridor.length < 3) throw new Error(`Creek Segment ${segment.segmentId} corridor collapsed when cut at its junction bisectors.`);
  return { start: segment.startUtm, lengthM, unitX, unitY, normalX, normalY, startBoundary, endBoundary, alongMinM, alongMaxM, corridor };
}

function lateralAndAlong(x: number, y: number, frame: SegmentFrame): { along: number; lateral: number } {
  const dx = x - frame.start.x;
  const dy = y - frame.start.y;
  return { along: dx * frame.unitX + dy * frame.unitY, lateral: dx * frame.normalX + dy * frame.normalY };
}

/** How far a point lies outside the corridor, by part. All 0 inside. */
function corridorExcess(x: number, y: number, frame: SegmentFrame): { start: number; end: number; along: number; lateral: number } {
  const { along, lateral } = lateralAndAlong(x, y, frame);
  return {
    start: Math.max(0, distanceOutsideBoundary(x, y, frame.startBoundary)),
    end: Math.max(0, distanceOutsideBoundary(x, y, frame.endBoundary)),
    along: Math.max(0, frame.alongMinM - along, along - frame.alongMaxM),
    lateral: Math.max(0, Math.abs(lateral) - CORRIDOR_HALF_WIDTH_M),
  };
}

/** A cell may sit up to `sharedBoundaryReachM` past a shared boundary so both neighbours' masks reach the line. */
export function cellInCorridor(x: number, y: number, frame: SegmentFrame, sharedBoundaryReachM: number): boolean {
  const epsilon = 1e-6;
  const excess = corridorExcess(x, y, frame);
  const startReach = frame.startBoundary.shared ? sharedBoundaryReachM : 0;
  const endReach = frame.endBoundary.shared ? sharedBoundaryReachM : 0;
  return excess.start <= startReach + epsilon && excess.end <= endReach + epsilon && excess.along <= epsilon && excess.lateral <= epsilon;
}

export function isNoData(value: number, noData: number | null): boolean {
  if (!Number.isFinite(value)) return true;
  if (noData !== null && value === noData) return true;
  return value <= -1000 || value >= 10000;
}

export function cellIndex(x: number, y: number, grid: ElevationGrid): number | null {
  const column = Math.floor((x - grid.originX) / grid.resolutionX);
  const row = Math.floor((y - grid.originY) / grid.resolutionY);
  if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) return null;
  return row * grid.width + column;
}

export function cellCenter(index: number, grid: ElevationGrid): PlanarPoint {
  const column = index % grid.width;
  const row = Math.floor(index / grid.width);
  return [grid.originX + (column + 0.5) * grid.resolutionX, grid.originY + (row + 0.5) * grid.resolutionY];
}

export function floodFill(wet: Uint8Array, seeds: readonly number[], width: number, height: number): Uint8Array {
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
  const denominator = (start[0] - end[0]) * (edgeStart[1] - edgeEnd[1]) - (start[1] - end[1]) * (edgeStart[0] - edgeEnd[0]);
  if (Math.abs(denominator) < 1e-12) return end;
  const t =
    ((start[0] - edgeStart[0]) * (edgeStart[1] - edgeEnd[1]) - (start[1] - edgeStart[1]) * (edgeStart[0] - edgeEnd[0])) / denominator;
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

function clipRingToBoundary(subject: PlanarPoint[], boundary: BoundaryLine): PlanarPoint[] {
  const lineStart: PlanarPoint = [boundary.point.x, boundary.point.y];
  const lineEnd: PlanarPoint = [boundary.point.x - boundary.normalY, boundary.point.y + boundary.normalX];
  return clipRingToLeftOfLine(subject, lineStart, lineEnd);
}

/** Clip polygon must be counter-clockwise so the inside is to the left of each edge. */
export function clipRingToConvex(subject: PlanarPoint[], clip: readonly PlanarPoint[]): PlanarPoint[] {
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

export function dropConsecutive(points: PlanarPoint[]): PlanarPoint[] {
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

export function dropCollinear(points: PlanarPoint[]): PlanarPoint[] {
  if (points.length < 3) return points;
  const kept: PlanarPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!previous || !current || !next) continue;
    const area = (current[0] - previous[0]) * (next[1] - current[1]) - (current[1] - previous[1]) * (next[0] - current[0]);
    if (Math.abs(area) > 1e-4) kept.push(current);
  }
  return kept;
}

/** Shoelace area of an open ring of [x, y, …] points; positive when counter-clockwise. */
export function signedArea(openRing: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let index = 0; index < openRing.length; index += 1) {
    const current = openRing[index];
    const next = openRing[(index + 1) % openRing.length];
    if (!current || !next) continue;
    sum += (current[0] as number) * (next[1] as number) - (next[0] as number) * (current[1] as number);
  }
  return sum / 2;
}

export function pixelToUtm(position: number[], grid: ElevationGrid): PlanarPoint {
  const pixelX = position[0];
  const pixelY = position[1];
  if (pixelX === undefined || pixelY === undefined) throw new Error('Contour coordinate is incomplete.');
  // d3-contour places sample (column, row) at (column + 0.5, row + 0.5): the cell center.
  return [grid.originX + pixelX * grid.resolutionX, grid.originY + pixelY * grid.resolutionY];
}

export function assertInsideCorridor(ring: readonly PlanarPoint[], frame: SegmentFrame, label: string): void {
  for (const [x, y] of ring) {
    const excess = corridorExcess(x, y, frame);
    const worst = Math.max(excess.start, excess.end, excess.along, excess.lateral);
    if (worst > 0.05) throw new Error(`Prepared water-surface polygon ${label} leaves the corridor by ${worst.toFixed(3)} m.`);
  }
}
