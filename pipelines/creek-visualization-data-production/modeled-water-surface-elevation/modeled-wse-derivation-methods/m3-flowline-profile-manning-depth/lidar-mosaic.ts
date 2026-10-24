import { fromArrayBuffer } from 'geotiff';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TerrainTileIndex, TerrainTileRecord } from '../../terrain-tiles.ts';

/**
 * Windowed access to the Stage 0 USGS 3DEP 1 m lidar tiles (EPSG 32610, integer-meter aligned,
 * 2 km tiles that overlap). `LidarMosaic.window` copies the cells of a bounding box into one grid
 * so tracing and cross-section sampling can use O(1) bilinear lookups without scanning 60+ tiles.
 * Written for m3-flowline-profile-manning-depth; m3 keeps its own copy so it does not depend on
 * code other methods may change.
 */

interface LoadedTile {
  west: number;
  north: number;
  width: number;
  height: number;
  elevations: Float32Array;
}

/** A rectangular copy of the lidar: 1 m cells, row 0 at the north edge. NoData cells are NaN. */
export class LidarWindow {
  readonly west: number;
  readonly north: number;
  readonly width: number;
  readonly height: number;
  readonly elevations: Float32Array;

  constructor(west: number, north: number, width: number, height: number) {
    this.west = west;
    this.north = north;
    this.width = width;
    this.height = height;
    this.elevations = new Float32Array(width * height).fill(Number.NaN);
  }

  /** Cell value, or NaN outside the window or on NoData. */
  cell(column: number, row: number): number {
    if (column < 0 || row < 0 || column >= this.width || row >= this.height) return Number.NaN;
    return this.elevations[row * this.width + column] as number;
  }

  /** Cell holding a point: [column, row]. */
  cellOf(x: number, y: number): [number, number] {
    return [Math.floor(x - this.west), Math.floor(this.north - y)];
  }

  centerOf(column: number, row: number): [number, number] {
    return [this.west + column + 0.5, this.north - row - 0.5];
  }

  /** Bilinear elevation between cell centers; null when any of the four cells is NoData or outside. */
  bilinear(x: number, y: number): number | null {
    const fx = x - this.west - 0.5;
    const fy = this.north - y - 0.5;
    const column = Math.floor(fx);
    const row = Math.floor(fy);
    const tx = fx - column;
    const ty = fy - row;
    const a = this.cell(column, row);
    const b = this.cell(column + 1, row);
    const c = this.cell(column, row + 1);
    const d = this.cell(column + 1, row + 1);
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) return null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
}

function isNoData(value: number, noData: number | null): boolean {
  return !Number.isFinite(value) || (noData !== null && value === noData) || value <= -1000 || value >= 10000;
}

async function loadTile(filePath: string): Promise<LoadedTile> {
  const bytes = await readFile(filePath);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  const image = await (await fromArrayBuffer(arrayBuffer)).getImage();
  const [west, north] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();
  if (west === undefined || north === undefined || resolutionX !== 1 || resolutionY !== -1) {
    throw new Error(`${filePath} is not a 1 m north-up tile.`);
  }
  const band = (await image.readRasters({ interleave: false }))[0];
  const width = image.getWidth();
  const height = image.getHeight();
  if (!band || band.length !== width * height) throw new Error(`${filePath} has an unexpected sample count.`);
  const noData = image.getGDALNoData();
  const elevations = new Float32Array(band.length);
  for (let index = 0; index < band.length; index += 1) {
    const value = Number(band[index]);
    elevations[index] = isNoData(value, noData) ? Number.NaN : value;
  }
  return { west, north, width, height, elevations };
}

/** One source tile: its extent and a loader, so Stage 3 can read GeoTIFF files lazily and Stage 4 can reuse tiles it already holds. */
interface TileSource {
  west: number;
  north: number;
  width: number;
  height: number;
  load: () => Promise<LoadedTile>;
}

/** The lidar tiles of one extent; a window copies only the tiles it touches. */
export class LidarMosaic {
  private readonly sources: readonly TileSource[];
  private readonly cache = new Map<TileSource, Promise<LoadedTile>>();
  private static readonly MAX_CACHED_TILES = 6;

  private constructor(sources: readonly TileSource[]) {
    this.sources = sources;
  }

  /** Reads the Stage 0 tile files on first use and keeps a few in a least-recently-used cache. */
  static fromTerrainFiles(directory: string, index: TerrainTileIndex): LidarMosaic {
    return new LidarMosaic(
      index.tiles.map((record: TerrainTileRecord) => ({
        west: record.west,
        north: record.north,
        width: record.widthPixels,
        height: record.heightPixels,
        load: () => loadTile(path.join(directory, record.file)),
      })),
    );
  }

  /** Uses tiles Stage 4 already loaded (1 m, north-up). Values that are NoData become NaN in the copy. */
  static fromElevationGrids(
    grids: readonly { originX: number; originY: number; width: number; height: number; noData: number | null; elevations: ArrayLike<number> }[],
  ): LidarMosaic {
    return new LidarMosaic(
      grids.map((grid) => ({
        west: grid.originX,
        north: grid.originY,
        width: grid.width,
        height: grid.height,
        load: async () => {
          const elevations = new Float32Array(grid.width * grid.height);
          for (let index = 0; index < elevations.length; index += 1) {
            const value = grid.elevations[index] as number;
            elevations[index] = isNoData(value, grid.noData) ? Number.NaN : value;
          }
          return { west: grid.originX, north: grid.originY, width: grid.width, height: grid.height, elevations };
        },
      })),
    );
  }

  private tile(source: TileSource): Promise<LoadedTile> {
    const cached = this.cache.get(source);
    if (cached) {
      this.cache.delete(source);
      this.cache.set(source, cached);
      return cached;
    }
    const loading = source.load();
    this.cache.set(source, loading);
    while (this.cache.size > LidarMosaic.MAX_CACHED_TILES) this.cache.delete(this.cache.keys().next().value as TileSource);
    return loading;
  }

  /** The lidar inside the box (EPSG 32610 meters), grown to whole meters. */
  async window(minX: number, minY: number, maxX: number, maxY: number): Promise<LidarWindow> {
    const west = Math.floor(minX);
    const north = Math.ceil(maxY);
    const window = new LidarWindow(west, north, Math.ceil(maxX) - west, north - Math.floor(minY));
    for (const source of this.sources) {
      if (source.west + source.width <= west || source.west >= west + window.width) continue;
      if (source.north - source.height >= north || source.north <= north - window.height) continue;
      const tile = await this.tile(source);
      const firstColumn = Math.max(0, west - tile.west);
      const lastColumn = Math.min(tile.width, west + window.width - tile.west);
      const firstRow = Math.max(0, tile.north - north);
      const lastRow = Math.min(tile.height, tile.north - (north - window.height));
      for (let row = firstRow; row < lastRow; row += 1) {
        const targetRow = north - tile.north + row;
        for (let column = firstColumn; column < lastColumn; column += 1) {
          const value = tile.elevations[row * tile.width + column] as number;
          if (Number.isNaN(value)) continue;
          window.elevations[targetRow * window.width + (tile.west + column - west)] = value;
        }
      }
    }
    return window;
  }
}
