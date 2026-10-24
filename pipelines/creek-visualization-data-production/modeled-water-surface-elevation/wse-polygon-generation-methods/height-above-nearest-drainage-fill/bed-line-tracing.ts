import type { ElevationGrid } from '../../../water-surface-polygon-generation.ts';
import { EIGHT_NEIGHBORS, cellCenter, cellIndex, isNoData } from './corridor-geometry.ts';
import { HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD } from './method-config.ts';

/**
 * Bed line of one Creek Segment (height-above-nearest-drainage-fill version 2): the drainage line
 * traced on the 1 m lidar instead of straight lines between the Stage 1 thalweg points. Between each
 * pair of consecutive thalweg points the line follows the lowest ground (a least-cost path) inside a
 * narrow band around the straight chord, so it can follow the real channel floor between sections but
 * cannot jump to another gully. The bed along the line is the lidar elevation, lightly median-filtered.
 */

const BED_LINE = HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD.parameters.bedLine;

/** A point of the bed line (EPSG 32610 m) and its bed elevation (m NAVD88). */
export interface BedLinePoint {
  x: number;
  y: number;
  bedM: number;
}

/** Ground elevation of a cell, or null where the cell is NoData. */
function groundAt(grid: ElevationGrid, cell: number): number | null {
  const elevation = grid.elevations[cell];
  return elevation === undefined || isNoData(elevation, grid.noData) ? null : elevation;
}

/**
 * The cells of one chord band: every lidar cell whose center lies within `bandHalfWidthM` of the chord
 * from `from` to `to`, with its elevation above the straight line joining the two end cells' ground
 * elevations. Measuring height above that line, not above sea level, keeps a steep reach from
 * charging more for the uphill end of the band than for the downhill end.
 */
function chordBand(grid: ElevationGrid, from: BedLinePoint, to: BedLinePoint, startGround: number, endGround: number): Map<number, number> {
  const margin = BED_LINE.bandHalfWidthM + Math.max(Math.abs(grid.resolutionX), Math.abs(grid.resolutionY));
  const columns = [from.x, to.x].flatMap((x) => [(x - margin - grid.originX) / grid.resolutionX, (x + margin - grid.originX) / grid.resolutionX]);
  const rows = [from.y, to.y].flatMap((y) => [(y - margin - grid.originY) / grid.resolutionY, (y + margin - grid.originY) / grid.resolutionY]);
  const chordX = to.x - from.x;
  const chordY = to.y - from.y;
  const chordLengthSquared = chordX * chordX + chordY * chordY;
  const band = new Map<number, number>();
  for (let row = Math.max(0, Math.floor(Math.min(...rows))); row <= Math.min(grid.height - 1, Math.ceil(Math.max(...rows))); row += 1) {
    for (let column = Math.max(0, Math.floor(Math.min(...columns))); column <= Math.min(grid.width - 1, Math.ceil(Math.max(...columns))); column += 1) {
      const cell = row * grid.width + column;
      const ground = groundAt(grid, cell);
      if (ground === null) continue;
      const [x, y] = cellCenter(cell, grid);
      const along = Math.min(1, Math.max(0, ((x - from.x) * chordX + (y - from.y) * chordY) / chordLengthSquared));
      if (Math.hypot(x - (from.x + along * chordX), y - (from.y + along * chordY)) > BED_LINE.bandHalfWidthM) continue;
      band.set(cell, ground - (startGround + along * (endGround - startGround)));
    }
  }
  return band;
}

/**
 * The lowest-cost 8-connected path of lidar cells from the cell holding `from` to the cell holding
 * `to`, or null when either end is outside the grid or on NoData, or the band does not connect them.
 * Entering a cell costs its step length × (its height above the lowest cell of the band + `costFloorM`),
 * so the path hugs the lowest ground and the floor keeps it from wandering when the band is flat.
 */
function tracePiece(grid: ElevationGrid, from: BedLinePoint, to: BedLinePoint): number[] | null {
  const startCell = cellIndex(from.x, from.y, grid);
  const endCell = cellIndex(to.x, to.y, grid);
  if (startCell === null || endCell === null) return null;
  const startGround = groundAt(grid, startCell);
  const endGround = groundAt(grid, endCell);
  if (startGround === null || endGround === null) return null;
  if (startCell === endCell) return [startCell];

  const band = chordBand(grid, from, to, startGround, endGround);
  const lowestExcess = Math.min(...band.values());
  const costOfCell = new Map<number, number>([[startCell, 0]]);
  const previousCell = new Map<number, number>();
  const settled = new Set<number>();
  const open = new Set<number>([startCell]);
  while (open.size > 0) {
    // The open set is one band's frontier, a few dozen cells, so a scan for the cheapest is clear enough.
    const current = [...open].reduce((cheapest, cell) => ((costOfCell.get(cell) as number) < (costOfCell.get(cheapest) as number) ? cell : cheapest));
    open.delete(current);
    if (current === endCell) break;
    settled.add(current);
    const column = current % grid.width;
    const row = Math.floor(current / grid.width);
    for (const [columnStep, rowStep] of EIGHT_NEIGHBORS) {
      const nextColumn = column + columnStep;
      const nextRow = row + rowStep;
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= grid.width || nextRow >= grid.height) continue;
      const next = nextRow * grid.width + nextColumn;
      const excess = band.get(next);
      if (excess === undefined || settled.has(next)) continue;
      const stepLengthM = Math.hypot(columnStep * grid.resolutionX, rowStep * grid.resolutionY);
      const cost = (costOfCell.get(current) as number) + stepLengthM * (excess - lowestExcess + BED_LINE.costFloorM);
      if (cost >= (costOfCell.get(next) ?? Infinity)) continue;
      costOfCell.set(next, cost);
      previousCell.set(next, current);
      open.add(next);
    }
  }
  if (!previousCell.has(endCell)) return null;
  const path = [endCell];
  while (path[0] !== startCell) path.unshift(previousCell.get(path[0] as number) as number);
  return path;
}

/** Resamples a polyline to points `spacingM` apart along it (first and last point kept), interpolating the bed linearly. */
function densify(points: readonly BedLinePoint[], spacingM: number): BedLinePoint[] {
  const first = points[0];
  if (!first) return [];
  const densified: BedLinePoint[] = [first];
  let nextAtM = spacingM;
  let pieceStartM = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index] as BedLinePoint;
    const end = points[index + 1] as BedLinePoint;
    const pieceLengthM = Math.hypot(end.x - start.x, end.y - start.y);
    for (; nextAtM < pieceStartM + pieceLengthM - 1e-9; nextAtM += spacingM) {
      const fraction = (nextAtM - pieceStartM) / pieceLengthM;
      densified.push({ x: start.x + fraction * (end.x - start.x), y: start.y + fraction * (end.y - start.y), bedM: start.bedM + fraction * (end.bedM - start.bedM) });
    }
    pieceStartM += pieceLengthM;
  }
  const last = points[points.length - 1] as BedLinePoint;
  const previous = densified[densified.length - 1] as BedLinePoint;
  if (previous.x !== last.x || previous.y !== last.y) densified.push(last);
  return densified;
}

/**
 * Median of the bed over `bedSmoothingWindowM` along the line. A median removes single-cell lidar spikes
 * but keeps a step in the channel floor, where a moving average would round it off (on 28 test segments
 * the worst 95th-percentile error against the lidar was 0.30 m for a 5 m median and 1.68 m for a 5 m
 * moving average). The window shrinks toward each end of the line, so the two end beds stay the lidar values.
 */
function smoothBed(points: readonly BedLinePoint[]): BedLinePoint[] {
  const halfWindowPoints = Math.floor(BED_LINE.bedSmoothingWindowM / BED_LINE.spacingM / 2);
  return points.map((point, index) => {
    const half = Math.min(halfWindowPoints, index, points.length - 1 - index);
    const sortedBeds = points
      .slice(index - half, index + half + 1)
      .map((candidate) => candidate.bedM)
      .sort((a, b) => a - b);
    return { ...point, bedM: sortedBeds[Math.floor(sortedBeds.length / 2)] as number };
  });
}

/**
 * Traces the bed line through the Stage 1 thalweg points `thalwegPoints` (in vertex order, each with its
 * section bed) on `grid`. A piece with no lidar path (an end off the grid or on NoData, or a band the
 * lidar does not connect) falls back to the straight chord with the Stage 1 section beds; `chordFallbackPieces` counts them.
 */
export function traceBedLine(grid: ElevationGrid, thalwegPoints: readonly BedLinePoint[]): { points: BedLinePoint[]; chordFallbackPieces: number } {
  const traced: BedLinePoint[] = [];
  let chordFallbackPieces = 0;
  for (let index = 0; index + 1 < thalwegPoints.length; index += 1) {
    const from = thalwegPoints[index] as BedLinePoint;
    const to = thalwegPoints[index + 1] as BedLinePoint;
    const cells = tracePiece(grid, from, to);
    if (!cells) chordFallbackPieces += 1;
    const piece: BedLinePoint[] = cells
      ? cells.map((cell) => {
          const [x, y] = cellCenter(cell, grid);
          return { x, y, bedM: groundAt(grid, cell) as number };
        })
      : [from, to];
    // Consecutive pieces share the cell holding their common thalweg point.
    const last = traced[traced.length - 1];
    traced.push(...(last && last.x === (piece[0] as BedLinePoint).x && last.y === (piece[0] as BedLinePoint).y ? piece.slice(1) : piece));
  }
  if (traced.length === 0) return { points: [...thalwegPoints], chordFallbackPieces };
  return { points: smoothBed(densify(traced, BED_LINE.spacingM)), chordFallbackPieces };
}
