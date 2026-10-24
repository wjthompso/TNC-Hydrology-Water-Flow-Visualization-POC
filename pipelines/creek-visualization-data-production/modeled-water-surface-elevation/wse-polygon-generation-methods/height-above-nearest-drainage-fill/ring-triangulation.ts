import type { ElevationGrid } from '../../../water-surface-polygon-generation.ts';
import { cellCenter } from './corridor-geometry.ts';

/**
 * How ArcGIS draws a polygon, as far as this method needs it: the 3D view triangulates the RIM
 * vertices of every ring (earcut) and interpolates the surface inside each triangle between the
 * three vertex heights. Nothing inside the polygon is looked up from the terrain or the bed, so a
 * big polygon on a slope is only as accurate as its rim. `triangulatedDeviationsM` measures that.
 *
 * The earcut is the copy bundled in `@arcgis/core` (the library the browser draws with), imported by
 * its chunk path because the package does not export it. A different ArcGIS version may move it; the
 * import then fails loudly instead of silently measuring another triangulation. The version is not
 * part of the method fingerprint, so a method version bump has to accompany an ArcGIS upgrade that
 * changes the triangulation.
 */

type Earcut = (flatCoordinates: number[], holeVertexIndexes?: number[], dimensions?: number) => number[];

const ARCGIS_EARCUT_MODULE = '@arcgis/core/chunks/earcut.js';
const earcut: Earcut = ((await import(ARCGIS_EARCUT_MODULE)) as { e: Earcut }).e;

/** A polygon vertex: x and y in EPSG 32610 m, and the drawn height z in m (the bed reference, depth excluded). */
export type HeightedVertex = readonly [x: number, y: number, z: number];

/** One outer ring and its holes, all open (the closing vertex is not repeated). */
export interface HeightedPolygon {
  outer: readonly HeightedVertex[];
  holes: readonly (readonly HeightedVertex[])[];
}

/**
 * |triangulated surface − ideal surface| in m at every wet cell center the triangulation covers,
 * sorted ascending. `idealBedByCell` maps each wet cell to its ideal drawn height (the bed reference
 * at the cell center; the depth is the same on both sides, so it cancels). A cell no triangle covers
 * (outside the polygon after the corridor clip) is skipped.
 */
export function triangulatedDeviationsM(
  polygons: readonly HeightedPolygon[],
  idealBedByCell: ReadonlyMap<number, number>,
  grid: ElevationGrid,
): number[] {
  const deviations: number[] = [];
  const measured = new Set<number>();
  for (const polygon of polygons) {
    const vertices = [...polygon.outer, ...polygon.holes.flat()];
    const [originX, originY] = polygon.outer[0] ?? [0, 0];
    const holeVertexIndexes: number[] = [];
    let vertexCount = polygon.outer.length;
    for (const hole of polygon.holes) {
      holeVertexIndexes.push(vertexCount);
      vertexCount += hole.length;
    }
    // Local coordinates keep earcut's arithmetic away from UTM's 7-digit northings.
    const triangleCorners = earcut(vertices.flatMap(([x, y]) => [x - originX, y - originY]), holeVertexIndexes, 2);
    for (let corner = 0; corner < triangleCorners.length; corner += 3) {
      const a = vertices[triangleCorners[corner] as number] as HeightedVertex;
      const b = vertices[triangleCorners[corner + 1] as number] as HeightedVertex;
      const c = vertices[triangleCorners[corner + 2] as number] as HeightedVertex;
      measureTriangle(a, b, c, idealBedByCell, grid, measured, deviations);
    }
  }
  return deviations.sort((first, second) => first - second);
}

/** Adds the deviation of every not yet measured wet cell whose center lies in the triangle (edges included). */
function measureTriangle(
  a: HeightedVertex,
  b: HeightedVertex,
  c: HeightedVertex,
  idealBedByCell: ReadonlyMap<number, number>,
  grid: ElevationGrid,
  measured: Set<number>,
  deviations: number[],
): void {
  const determinant = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(determinant) < 1e-12) return;
  const columns = [a, b, c].map(([x]) => Math.floor((x - grid.originX) / grid.resolutionX));
  const rows = [a, b, c].map(([, y]) => Math.floor((y - grid.originY) / grid.resolutionY));
  const edgeTolerance = -1e-9;
  for (let row = Math.max(0, Math.min(...rows)); row <= Math.min(grid.height - 1, Math.max(...rows)); row += 1) {
    for (let column = Math.max(0, Math.min(...columns)); column <= Math.min(grid.width - 1, Math.max(...columns)); column += 1) {
      const cell = row * grid.width + column;
      const idealM = idealBedByCell.get(cell);
      if (idealM === undefined || measured.has(cell)) continue;
      const [x, y] = cellCenter(cell, grid);
      const weightA = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / determinant;
      const weightB = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / determinant;
      const weightC = 1 - weightA - weightB;
      if (weightA < edgeTolerance || weightB < edgeTolerance || weightC < edgeTolerance) continue;
      measured.add(cell);
      deviations.push(Math.abs(weightA * a[2] + weightB * b[2] + weightC * c[2] - idealM));
    }
  }
}

/** Linear-interpolated quantile of an ascending list; 0 for an empty list (nothing to deviate). */
export function quantileOfSorted(sortedAscending: readonly number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0;
  const position = fraction * (sortedAscending.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (sortedAscending[lower] as number) + ((sortedAscending[upper] as number) - (sortedAscending[lower] as number)) * (position - lower);
}
