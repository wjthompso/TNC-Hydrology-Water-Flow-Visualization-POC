import { roundToDecimals, utm10nToWgs84 } from '../../../utm-geometry.ts';
import type { ElevationGrid } from '../../../water-surface-polygon-generation.ts';
import {
  assertInsideCorridor,
  clipRingToConvex,
  dropConsecutive,
  pixelToUtm,
  signedArea,
  type PlanarPoint,
  type SegmentFrame,
} from './corridor-geometry.ts';
import { HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD } from './method-config.ts';
import { quantileOfSorted, triangulatedDeviationsM, type HeightedPolygon, type HeightedVertex } from './ring-triangulation.ts';

/**
 * Slicing (height-above-nearest-drainage-fill version 3). ArcGIS draws a polygon by triangulating its
 * rim vertices only, so on a steep bed a long footprint is drawn as a few big triangles whose surface
 * can sit meters off the ideal surface (bed reference at the point + depth). Cutting the footprint into
 * short slices ACROSS the flow gives every slice a rim close to every point inside it.
 *
 * The footprint is the polygon version 2 drew: the marching-squares contour of the footprint cells
 * (what d3-contour computes), which is the union of one small piece per 2 × 2 block of neighbouring
 * cell centers (a "block"). Slicing sorts these blocks by their position along the bed line and gives
 * each slice a run of blocks. Pieces of neighbouring blocks meet on lines between cell centers, so two
 * slices meet along those lines and share the vertices on them exactly, and the slices add up to
 * exactly the version 2 polygon (no sliver is lost at a cut).
 *
 * Why blocks and not straight cut lines: the ideal surface is bed(nearest bed-line point), a function
 * of the position along the bed line, and it is jagged across a steep, zigzagging line. A slice that
 * holds the blocks of one position interval holds points of nearly one ideal height, and its rim runs
 * along the cell grid, with a vertex at every step, so no point is far from a vertex that carries the
 * exact ideal height. A straight perpendicular cut has two vertices and misses that structure.
 */

const SLICING = HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD.parameters.slicing;

/**
 * An open ring in EPSG 32610 m. Outer rings run clockwise and holes counter-clockwise, so `signedArea`
 * tells which a ring is.
 */
type Ring = PlanarPoint[];

/** The cells of one depth bucket's footprint. */
export interface FootprintCells {
  /** Every cell of the footprint: the wet cells grown by the Bank-overlap margin. */
  footprintCells: readonly number[];
  /** The wet cells alone (connected to the channel, before the margin). The tolerance is measured on these. */
  wetCells: readonly number[];
  /** The bucket's minimum water depth, m: the tolerance grows with it (see `toleranceForDepth`). */
  depthM: number;
}

/**
 * The deviation allowed at the tolerance percentile for water this deep: `toleranceM` for thin water,
 * and `toleranceDepthFraction` of the depth where that is more. A surface error only decides whether a
 * point shows when the water is about as deep as the ground there is above the bed, so deep water can
 * carry a larger absolute error than thin water.
 */
export function toleranceForDepth(depthM: number): number {
  return Math.max(SLICING.toleranceM, SLICING.toleranceDepthFraction * depthM);
}

export interface SlicingContext {
  grid: ElevationGrid;
  frame: SegmentFrame;
  /** Per grid cell: arc length (m) along the bed line of the nearest bed-line point, extended straight past the line's ends. */
  alongBedLineM: Float64Array;
  /** Per grid cell: reference bed (m) at the cell center, the ideal drawn height minus the depth. */
  referenceBedByCell: Float64Array;
  /** Reference bed (m) at any point, the same function the ring vertices use. */
  bedReferenceAt: (x: number, y: number) => number;
  label: string;
}

export interface SlicedFootprint {
  /** Rings of every slice: `[lon, lat, bedReferenceM]`, outer clockwise, holes counter-clockwise, closed. Empty when the footprint is empty. */
  ringsWgs84: number[][][];
  sliceCount: number;
  /** True when every slice's triangulated surface is within tolerance of the ideal surface at the tolerance percentile. */
  withinTolerance: boolean;
}

/**
 * One 2 × 2 block of neighbouring cell centers that touches the footprint: the pieces of the footprint
 * polygon inside it and where it lies along the bed line. Piece coordinates are twice the d3-contour
 * pixel coordinates (so they are whole numbers): a cell center is at (odd, odd), the middle of an edge
 * between two cell centers at (even, odd) or (odd, even).
 */
interface Block {
  alongM: number;
  pieces: number[][];
}

/** The blocks of a footprint, ordered by position along the bed line, with where their pixel frame sits on the grid. */
interface FootprintBlocks {
  blocks: Block[];
  /** Grid column and row of the pixel frame's origin (one empty cell before the footprint's bounding box). */
  firstColumn: number;
  firstRow: number;
}

/** One slice: a run of blocks, its rings, and how far its triangulated surface is from the ideal. */
interface Slice {
  /** Blocks `[from, to)` of the ordered block list. */
  blockRange: readonly [number, number];
  /** Arc length interval along the bed line the slice's blocks cover. */
  fromM: number;
  toM: number;
  rings: Ring[];
  /** Deviation at the tolerance percentile over the wet cells the slice covers, m. */
  deviationM: number;
}

/**
 * Cuts one footprint into the fewest slices that keep the triangulated surface within tolerance.
 *
 * Start with the whole footprint as one slice (no cut: a flat footprint stays exactly the polygon
 * version 2 drew). While the slice with the largest deviation is over the tolerance (`toleranceForDepth`) at the tolerance
 * percentile, is at least twice `minimumSliceLengthM` long along the bed line, and fewer than
 * `maximumSlicesPerBucket` slices exist, cut it into the blocks before and after the middle of its
 * along-line interval. The deviation is measured the way ArcGIS draws: earcut on the slice's rim
 * vertices, compared with the ideal bed reference at every wet cell center the slice covers.
 */
export function sliceFootprint(footprint: FootprintCells, context: SlicingContext): SlicedFootprint {
  const { blocks, firstColumn, firstRow } = footprintBlocks(footprint.footprintCells, context);
  if (blocks.length === 0) return { ringsWgs84: [], sliceCount: 0, withinTolerance: true };
  const toleranceM = toleranceForDepth(footprint.depthM);

  const idealBedByWetCell = new Map(footprint.wetCells.map((cell) => [cell, context.referenceBedByCell[cell] as number]));
  const bedReferenceAtVertex = memoize(context.bedReferenceAt);
  const measure = (blockRange: readonly [number, number]): Slice => {
    const slicedBlocks = blocks.slice(...blockRange);
    const rings = ringsOfBlocks(slicedBlocks, firstColumn, firstRow, context);
    const polygons = polygonsOfRings(rings.map((ring) => dropCollinearVertices(ring, () => false))).map((polygon) => toHeightedPolygon(polygon, bedReferenceAtVertex));
    const deviations = triangulatedDeviationsM(polygons, idealBedByWetCell, context.grid);
    return {
      blockRange,
      fromM: (slicedBlocks[0] as Block).alongM,
      toM: (slicedBlocks[slicedBlocks.length - 1] as Block).alongM,
      rings,
      deviationM: quantileOfSorted(deviations, SLICING.tolerancePercentile),
    };
  };

  const slices = [measure([0, blocks.length])];
  while (slices.length < SLICING.maximumSlicesPerBucket) {
    const worst = slices
      .filter((slice) => slice.deviationM > toleranceM && slice.toM - slice.fromM >= 2 * SLICING.minimumSliceLengthM && slice.blockRange[1] - slice.blockRange[0] >= 2)
      .reduce<Slice | null>((current, slice) => (current === null || slice.deviationM > current.deviationM ? slice : current), null);
    if (worst === null) break;
    const [from, to] = worst.blockRange;
    const middleM = (worst.fromM + worst.toM) / 2;
    const split = firstBlockAtOrAbove(blocks, from, to, middleM);
    slices.splice(slices.indexOf(worst), 1, measure([from, split]), measure([split, to]));
  }

  return {
    ringsWgs84: encodeSlices(slices.map((slice) => slice.rings), context),
    sliceCount: slices.length,
    withinTolerance: slices.every((slice) => slice.deviationM <= toleranceM),
  };
}

function memoize(bedReferenceAt: (x: number, y: number) => number): (x: number, y: number) => number {
  const known = new Map<string, number>();
  return (x, y) => {
    const key = `${x},${y}`;
    let bedM = known.get(key);
    if (bedM === undefined) {
      bedM = bedReferenceAt(x, y);
      known.set(key, bedM);
    }
    return bedM;
  };
}

/** First block in `[from, to)` whose position is at least `alongM`. Both sides keep a block: a cut at the first or last block moves one block across. */
function firstBlockAtOrAbove(blocks: readonly Block[], from: number, to: number, alongM: number): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((blocks[middle] as Block).alongM < alongM) low = middle + 1;
    else high = middle;
  }
  return Math.min(Math.max(low, from + 1), to - 1);
}

// ---------------------------------------------------------------- blocks: the footprint polygon in pieces

/**
 * Splits the marching-squares polygon of the footprint cells into blocks. Each block's pieces follow
 * d3-contour's rules for a 2 × 2 block of cell centers: wet centers are inside, the contour crosses the
 * line between a wet and a dry center at its middle, and two wet centers on a diagonal stay separate.
 */
function footprintBlocks(cells: readonly number[], context: SlicingContext): FootprintBlocks {
  const { grid } = context;
  if (cells.length === 0) return { blocks: [], firstColumn: 0, firstRow: 0 };
  const columnOf = (cell: number): number => cell % grid.width;
  const rowOf = (cell: number): number => Math.floor(cell / grid.width);
  // A loop, not Math.min(...cells): a big footprint has tens of thousands of cells.
  let [minColumn, maxColumn, minRow, maxRow] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const cell of cells) {
    minColumn = Math.min(minColumn, columnOf(cell));
    maxColumn = Math.max(maxColumn, columnOf(cell));
    minRow = Math.min(minRow, rowOf(cell));
    maxRow = Math.max(maxRow, rowOf(cell));
  }
  // One empty cell all around, so every wet center has a full set of blocks.
  const firstColumn = minColumn - 1;
  const firstRow = minRow - 1;
  const width = maxColumn + 2 - firstColumn;
  const height = maxRow + 2 - firstRow;
  const alongAt = new Map<number, number>();
  for (const cell of cells) alongAt.set((rowOf(cell) - firstRow) * width + (columnOf(cell) - firstColumn), context.alongBedLineM[cell] as number);

  const blocks: Block[] = [];
  for (let row = 0; row < height - 1; row += 1) {
    for (let column = 0; column < width - 1; column += 1) {
      // Clockwise from the top-left center: a, b, c, d; null where the center is dry.
      const centers = [
        alongAt.get(row * width + column),
        alongAt.get(row * width + column + 1),
        alongAt.get((row + 1) * width + column + 1),
        alongAt.get((row + 1) * width + column),
      ];
      const wetAlong = centers.filter((alongM): alongM is number => alongM !== undefined);
      if (wetAlong.length === 0) continue;
      blocks.push({ alongM: wetAlong.reduce((sum, alongM) => sum + alongM, 0) / wetAlong.length, pieces: piecesOfBlock(column, row, centers.map((alongM) => alongM !== undefined)) });
    }
  }
  blocks.sort((first, second) => first.alongM - second.alongM);
  return { blocks, firstColumn, firstRow };
}

/** The inside of one block, as pieces with whole-number (doubled) corner coordinates, all running the same way around. */
function piecesOfBlock(column: number, row: number, wet: readonly boolean[]): number[][] {
  // Doubled pixel coordinates of the four centers, and of the middle of the edge from each center to the next.
  const centers: PlanarPoint[] = [
    [2 * column + 1, 2 * row + 1],
    [2 * column + 3, 2 * row + 1],
    [2 * column + 3, 2 * row + 3],
    [2 * column + 1, 2 * row + 3],
  ];
  const middles: PlanarPoint[] = [
    [2 * column + 2, 2 * row + 1],
    [2 * column + 3, 2 * row + 2],
    [2 * column + 2, 2 * row + 3],
    [2 * column + 1, 2 * row + 2],
  ];
  const isDiagonalPair = wet.filter(Boolean).length === 2 && wet[0] === wet[2];
  if (isDiagonalPair) {
    // Each wet center is cut off on its own: the middle before it, the center, the middle after it.
    return [0, 1, 2, 3].filter((corner) => wet[corner]).map((corner) => flatten([middles[(corner + 3) % 4], centers[corner], middles[corner]] as PlanarPoint[]));
  }
  const outline: PlanarPoint[] = [];
  for (let corner = 0; corner < 4; corner += 1) {
    if (wet[corner]) outline.push(centers[corner] as PlanarPoint);
    if (wet[corner] !== wet[(corner + 1) % 4]) outline.push(middles[corner] as PlanarPoint);
  }
  return [flatten(outline)];
}

function flatten(points: PlanarPoint[]): number[] {
  return points.flat();
}

/**
 * The rings of a set of blocks, in EPSG 32610 m, clipped to the corridor and oriented (outer clockwise,
 * holes counter-clockwise). The pieces' edges are chained after dropping every edge two pieces share
 * (walked once in each direction): what is left is the outline of the union. Where an outline touches
 * itself, the chain takes the sharpest left turn, which keeps touching rings apart.
 */
function ringsOfBlocks(blocks: readonly Block[], firstColumn: number, firstRow: number, context: SlicingContext): Ring[] {
  const vertexId = (x: number, y: number): number => y * 65536 + x;
  const coordinatesOf = (id: number): PlanarPoint => [id % 65536, Math.floor(id / 65536)];
  // Edges as vertexId pairs; an edge present in both directions is inside the union and cancels.
  const edges = new Map<number, [number, number]>();
  const edgeKey = (from: number, to: number): number => from * 2 ** 26 + to;
  for (const block of blocks) {
    for (const piece of block.pieces) {
      for (let index = 0; index < piece.length; index += 2) {
        const next = (index + 2) % piece.length;
        const from = vertexId(piece[index] as number, piece[index + 1] as number);
        const to = vertexId(piece[next] as number, piece[next + 1] as number);
        if (edges.delete(edgeKey(to, from))) continue;
        edges.set(edgeKey(from, to), [from, to]);
      }
    }
  }
  const outgoing = new Map<number, number[]>();
  for (const [from, to] of edges.values()) outgoing.set(from, [...(outgoing.get(from) ?? []), to]);

  const rings: Ring[] = [];
  for (const [start, firstTargets] of outgoing) {
    while (firstTargets.length > 0) {
      const ringIds = [start];
      let previous = start;
      let current = firstTargets.pop() as number;
      while (current !== start) {
        ringIds.push(current);
        const targets = outgoing.get(current) as number[];
        const [fromX, fromY] = coordinatesOf(previous);
        const [atX, atY] = coordinatesOf(current);
        // Sharpest left turn from the direction we arrived in.
        const turn = (target: number): number => {
          const [toX, toY] = coordinatesOf(target);
          return Math.atan2((atX - fromX) * (toY - atY) - (atY - fromY) * (toX - atX), (atX - fromX) * (toX - atX) + (atY - fromY) * (toY - atY));
        };
        const next = targets.reduce((best, target) => (turn(target) > turn(best) ? target : best));
        targets.splice(targets.indexOf(next), 1);
        previous = current;
        current = next;
      }
      const pixelRing = ringIds.map(coordinatesOf);
      // Outer rings run the same way as a single block's piece, so the sign of the area in pixel space tells outer from hole.
      const isHole = signedArea(pixelRing) < 0;
      const utmRing = dropConsecutive(pixelRing.map(([x, y]) => pixelToUtm([x / 2 + firstColumn, y / 2 + firstRow], context.grid)));
      const clipped = dropConsecutive(clipRingToConvex(utmRing, context.frame.corridor));
      if (clipped.length < 3) continue;
      assertInsideCorridor(clipped, context.frame, context.label);
      const area = signedArea(clipped);
      if (area === 0) continue;
      rings.push((area > 0) === isHole ? clipped : [...clipped].reverse());
    }
  }
  return rings;
}

/** Drops vertices that lie on a straight line between their neighbours, except those `isProtected` keeps. */
function dropCollinearVertices(ring: Ring, isProtected: (vertex: PlanarPoint) => boolean): Ring {
  const kept = ring.filter((current, index) => {
    const previous = ring[(index - 1 + ring.length) % ring.length] as PlanarPoint;
    const next = ring[(index + 1) % ring.length] as PlanarPoint;
    const doubledArea = (current[0] - previous[0]) * (next[1] - current[1]) - (current[1] - previous[1]) * (next[0] - current[0]);
    return Math.abs(doubledArea) > 1e-4 || isProtected(current);
  });
  return kept.length >= 3 ? kept : [];
}

// ---------------------------------------------------------------- measuring a slice

/** Groups rings into polygons: every clockwise ring is an outer ring, every counter-clockwise ring a hole of the smallest outer ring that contains it. */
function polygonsOfRings(rings: readonly Ring[]): { outer: Ring; holes: Ring[] }[] {
  const outers = rings.filter((ring) => ring.length >= 3 && signedArea(ring) < 0).map((outer) => ({ outer, holes: [] as Ring[], areaM2: Math.abs(signedArea(outer)) }));
  for (const hole of rings.filter((ring) => ring.length >= 3 && signedArea(ring) > 0)) {
    // A hole can touch its outer ring, so the owner is the outer ring holding most of the hole's vertices.
    const owner = outers
      .filter((candidate) => hole.filter((vertex) => isInsideRing(vertex, candidate.outer)).length * 2 > hole.length)
      .reduce<(typeof outers)[number] | null>((smallest, candidate) => (smallest === null || candidate.areaM2 < smallest.areaM2 ? candidate : smallest), null);
    owner?.holes.push(hole);
  }
  return outers;
}

function isInsideRing(point: PlanarPoint, ring: Ring): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x, y] = ring[index] as PlanarPoint;
    const [previousX, previousY] = ring[previous] as PlanarPoint;
    if (y > point[1] !== previousY > point[1] && point[0] < ((previousX - x) * (point[1] - y)) / (previousY - y) + x) inside = !inside;
  }
  return inside;
}

function toHeightedPolygon(polygon: { outer: Ring; holes: Ring[] }, bedReferenceAt: (x: number, y: number) => number): HeightedPolygon {
  const heighted = (ring: Ring): HeightedVertex[] => ring.map(([x, y]) => [x, y, bedReferenceAt(x, y)]);
  return { outer: heighted(polygon.outer), holes: polygon.holes.map(heighted) };
}

// ---------------------------------------------------------------- file encoding

/** A vertex's identity in the file: longitude and latitude rounded to the stored 7 decimals. */
function storedPosition(vertex: PlanarPoint): { key: string; longitude: number; latitude: number } {
  const [rawLongitude, rawLatitude] = utm10nToWgs84(vertex[0], vertex[1]);
  const longitude = roundToDecimals(rawLongitude, 7);
  const latitude = roundToDecimals(rawLatitude, 7);
  return { key: `${longitude},${latitude}`, longitude, latitude };
}

/**
 * Turns every slice's rings into closed `[lon, lat, bedReferenceM]` rings. Two guarantees make
 * neighbouring slices crack-free:
 * - A vertex that appears in more than one slice is never dropped as collinear, so both slices keep
 *   the same vertices along their shared cut edge.
 * - A stored position gets one bed reference, computed once, so shared vertices have identical z.
 */
function encodeSlices(sliceRings: readonly Ring[][], context: SlicingContext): number[][][] {
  const firstSliceOfPosition = new Map<string, number>();
  const sharedBetweenSlices = new Set<string>();
  sliceRings.forEach((rings, sliceIndex) => {
    for (const vertex of rings.flat()) {
      const { key } = storedPosition(vertex);
      const first = firstSliceOfPosition.get(key);
      if (first === undefined) firstSliceOfPosition.set(key, sliceIndex);
      else if (first !== sliceIndex) sharedBetweenSlices.add(key);
    }
  });

  const bedReferenceByPosition = new Map<string, number>();
  const encoded: number[][][] = [];
  for (const rings of sliceRings) {
    for (const ring of rings) {
      const simplified = dropCollinearVertices(ring, (vertex) => sharedBetweenSlices.has(storedPosition(vertex).key));
      const withBed = simplified.map((vertex) => {
        const { key, longitude, latitude } = storedPosition(vertex);
        let bedReferenceM = bedReferenceByPosition.get(key);
        if (bedReferenceM === undefined) {
          bedReferenceM = roundToDecimals(context.bedReferenceAt(vertex[0], vertex[1]), 3);
          bedReferenceByPosition.set(key, bedReferenceM);
        }
        return [longitude, latitude, bedReferenceM];
      });
      const closed = closeAndOrientRing(withBed, signedArea(ring) > 0);
      if (closed) encoded.push(closed);
    }
  }
  return encoded;
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
