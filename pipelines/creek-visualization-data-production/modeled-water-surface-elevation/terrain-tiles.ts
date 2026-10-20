import { fromArrayBuffer } from 'geotiff';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../json-files.ts';
import type { UtmPoint } from '../utm-geometry.ts';

/**
 * USGS 3DEP (3D Elevation Program) 1 m bare-earth terrain in EPSG 32610 (UTM zone 10N, meters),
 * stored as one or more GeoTIFF tiles listed in `terrain-tiles.json`.
 */

export interface TerrainTileRecord {
  file: string;
  /** Tile extent in EPSG 32610 meters. */
  west: number;
  south: number;
  east: number;
  north: number;
  widthPixels: number;
  heightPixels: number;
  url: string;
}

export interface TerrainTileIndex {
  description: string;
  spatialReference: 'EPSG:32610';
  tiles: TerrainTileRecord[];
}

interface LoadedTile {
  west: number;
  north: number;
  width: number;
  height: number;
  resolutionX: number;
  /** Negative: rows go south. */
  resolutionY: number;
  noData: number | null;
  elevations: Float32Array;
}

export const TERRAIN_TILE_INDEX_FILE = 'terrain-tiles.json';

export function readTerrainTileIndex(value: unknown): TerrainTileIndex {
  if (!isRecord(value) || !Array.isArray(value.tiles)) throw new Error('terrain-tiles.json has no tiles list.');
  return value as unknown as TerrainTileIndex;
}

async function loadTile(filePath: string): Promise<LoadedTile> {
  const bytes = await readFile(filePath);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  const image = await (await fromArrayBuffer(arrayBuffer)).getImage();
  if (!image.pixelIsArea()) throw new Error(`${filePath} pixels are points, expected area pixels.`);
  const [originX, originY] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();
  if (originX === undefined || originY === undefined || resolutionX === undefined || resolutionY === undefined) {
    throw new Error(`${filePath} is missing a geotransform.`);
  }
  const rasters = await image.readRasters({ interleave: false });
  const band = rasters[0];
  const width = image.getWidth();
  const height = image.getHeight();
  if (!band || band.length !== width * height) throw new Error(`${filePath} has an unexpected sample count.`);
  const elevations = new Float32Array(band.length);
  for (let index = 0; index < band.length; index += 1) elevations[index] = Number(band[index]);
  const rawNoData = image.getGDALNoData();
  return {
    west: originX,
    north: originY,
    width,
    height,
    resolutionX,
    resolutionY,
    noData: rawNoData !== null && Number.isFinite(rawNoData) ? rawNoData : null,
    elevations,
  };
}

function isNoData(value: number | undefined, noData: number | null): boolean {
  if (value === undefined || !Number.isFinite(value)) return true;
  if (noData !== null && value === noData) return true;
  return value <= -1000 || value >= 10000;
}

/** Bilinear sampler across terrain tiles. Returns null for NoData or outside every tile. */
export class TerrainSampler {
  private readonly tiles: LoadedTile[];

  private constructor(tiles: LoadedTile[]) {
    this.tiles = tiles;
  }

  static async load(tileDirectory: string, index: TerrainTileIndex): Promise<TerrainSampler> {
    const tiles: LoadedTile[] = [];
    for (const tile of index.tiles) tiles.push(await loadTile(path.join(tileDirectory, tile.file)));
    return new TerrainSampler(tiles);
  }

  elevationAt(point: UtmPoint): number | null {
    for (const tile of this.tiles) {
      // Continuous pixel coordinates measured from pixel centers.
      const column = (point.x - tile.west) / tile.resolutionX - 0.5;
      const row = (point.y - tile.north) / tile.resolutionY - 0.5;
      if (column < 0 || row < 0 || column > tile.width - 1 || row > tile.height - 1) continue;
      const column0 = Math.floor(column);
      const row0 = Math.floor(row);
      const column1 = Math.min(column0 + 1, tile.width - 1);
      const row1 = Math.min(row0 + 1, tile.height - 1);
      const fx = column - column0;
      const fy = row - row0;
      const corners = [
        tile.elevations[row0 * tile.width + column0],
        tile.elevations[row0 * tile.width + column1],
        tile.elevations[row1 * tile.width + column0],
        tile.elevations[row1 * tile.width + column1],
      ];
      if (corners.some((value) => isNoData(value, tile.noData))) return null;
      const [topLeft, topRight, bottomLeft, bottomRight] = corners as [number, number, number, number];
      const top = topLeft + (topRight - topLeft) * fx;
      const bottom = bottomLeft + (bottomRight - bottomLeft) * fx;
      return top + (bottom - top) * fy;
    }
    return null;
  }
}
