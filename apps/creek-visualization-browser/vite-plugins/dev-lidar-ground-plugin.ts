// Dev-server-only lookup of the 1 m lidar ground height under a longitude and latitude, for the
// Dev tools "Water click inspector". The browser has no lidar; this reads the pipeline's Stage 0
// tiles (data/pipeline-working-output/<extent>/00-acquire/usgs-3dep-1m-tile-*.tif, listed in
// terrain-tiles.json) on the developer's machine. `apply: 'serve'` keeps it out of `vite build`,
// and the pipeline data is git-ignored, so hosted data never has it.
//
//   GET /dev-lidar-ground?extent=<extent-id>&lon=<degrees>&lat=<degrees>
//     200 { nearestCellM, bilinearM, cellSpreadM: [min, max] }   heights in meters NAVD88
//     200 null                                                    point outside every tile, or on NoData
//     400 bad query · 404 extent or its tiles are not on disk
//
// Read-only. Heights are the cell containing the point (`nearestCellM`), the bilinear blend of the four
// cell centers around the point (`bilinearM`, null when one of them is NoData), and the lowest and
// highest of the 5 × 5 cells around the nearest cell (`cellSpreadM`).

import { fromArrayBuffer } from 'geotiff';
import { readdir, readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import proj4 from 'proj4';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export const DEV_LIDAR_GROUND_URL_PATH = '/dev-lidar-ground';

const TERRAIN_TILE_INDEX_PATH = '00-acquire/terrain-tiles.json';
/** Extent folder names are lowercase words joined by hyphens; anything else cannot be a folder here. */
const EXTENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Half-width of the neighborhood for `cellSpreadM`: 2 gives the 5 × 5 cells. */
const SPREAD_HALF_WIDTH_CELLS = 2;
/** A tile is 2000 × 2000 cells (16 MB); a few cover the area a developer inspects. */
const MAX_CACHED_TILES = 4;

const pluginDirectory = fileURLToPath(new URL('.', import.meta.url));
const DATA_ROOT = path.resolve(pluginDirectory, '../../../data/pipeline-working-output');

proj4.defs('EPSG:32610', '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs');

interface TileRecord {
  file: string;
  /** Tile extent in EPSG 32610 meters. */
  west: number;
  south: number;
  east: number;
  north: number;
  widthPixels: number;
  heightPixels: number;
}

/** One tile's cells, 1 m, row 0 at the north edge; NoData is NaN. */
interface LoadedTile {
  west: number;
  north: number;
  width: number;
  height: number;
  elevations: Float32Array;
}

export interface LidarGroundHeights {
  nearestCellM: number;
  bilinearM: number | null;
  cellSpreadM: [number, number];
}

/** Least recently used tiles, keyed by file path. Map order is use order. */
const tileCache = new Map<string, Promise<LoadedTile>>();

export function devLidarGroundPlugin(): Plugin {
  return {
    name: 'tnc-dev-lidar-ground',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = request.url ?? '';
        if (request.method !== 'GET' || !requestUrl.startsWith(DEV_LIDAR_GROUND_URL_PATH)) {
          next();
          return;
        }
        const url = new URL(requestUrl, 'http://localhost');
        if (url.pathname !== DEV_LIDAR_GROUND_URL_PATH) {
          next();
          return;
        }
        try {
          await answer(url.searchParams, response);
        } catch (error) {
          respondJson(response, 500, { error: error instanceof Error ? error.message : 'Server error.' });
        }
      });
    },
  };
}

async function answer(query: URLSearchParams, response: ServerResponse): Promise<void> {
  const extent = query.get('extent') ?? '';
  const longitude = parseFiniteNumber(query.get('lon'));
  const latitude = parseFiniteNumber(query.get('lat'));
  if (
    !EXTENT_ID_PATTERN.test(extent) ||
    longitude === null ||
    latitude === null ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  ) {
    respondJson(response, 400, { error: 'Expected extent=<extent-id>&lon=<degrees>&lat=<degrees>.' });
    return;
  }
  // The id must name a folder that exists; it is never joined into a path unchecked.
  const knownExtents = await readdir(DATA_ROOT, { withFileTypes: true }).catch(() => []);
  const knownExtent = knownExtents.find((entry) => entry.isDirectory() && entry.name === extent);
  if (!knownExtent) {
    respondJson(response, 404, { error: `No pipeline output for extent ${extent}.` });
    return;
  }
  const extentRoot = path.join(DATA_ROOT, knownExtent.name);
  const tiles = await readTileRecords(extentRoot);
  if (!tiles) {
    respondJson(response, 404, { error: `No 1 m lidar tiles on disk for extent ${extent}.` });
    return;
  }
  const [x, y] = proj4('EPSG:4326', 'EPSG:32610', [longitude, latitude]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    respondJson(response, 400, { error: 'Could not project the point to UTM zone 10N.' });
    return;
  }
  respondJson(response, 200, await lidarGroundAt(extentRoot, tiles, x as number, y as number));
}

function parseFiniteNumber(text: string | null): number | null {
  if (text === null || text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

async function readTileRecords(extentRoot: string): Promise<TileRecord[] | null> {
  try {
    const index = JSON.parse(await readFile(path.join(extentRoot, TERRAIN_TILE_INDEX_PATH), 'utf8')) as {
      tiles?: unknown;
    };
    if (!Array.isArray(index.tiles)) return null;
    const records = (index.tiles as TileRecord[]).filter(
      (tile) => typeof tile.file === 'string' && path.basename(tile.file) === tile.file,
    );
    return records.length > 0 ? records : null;
  } catch {
    return null;
  }
}

/** The tile the neighborhood fits in, else any tile holding the point; tiles overlap, so edges rarely need the fallback. */
function tileForPoint(tiles: readonly TileRecord[], x: number, y: number): TileRecord | null {
  const margin = SPREAD_HALF_WIDTH_CELLS + 1;
  const holdsPoint = (tile: TileRecord, inset: number): boolean =>
    x >= tile.west + inset && x < tile.east - inset && y > tile.south + inset && y <= tile.north - inset;
  return tiles.find((tile) => holdsPoint(tile, margin)) ?? tiles.find((tile) => holdsPoint(tile, 0)) ?? null;
}

/** Null when no tile holds the point or its nearest cell is NoData. */
async function lidarGroundAt(
  extentRoot: string,
  tiles: readonly TileRecord[],
  x: number,
  y: number,
): Promise<LidarGroundHeights | null> {
  const record = tileForPoint(tiles, x, y);
  if (!record) return null;
  const tile = await loadTileCached(path.join(extentRoot, '00-acquire', record.file));

  const cellAt = (column: number, row: number): number =>
    column < 0 || row < 0 || column >= tile.width || row >= tile.height
      ? Number.NaN
      : (tile.elevations[row * tile.width + column] as number);

  const column = Math.floor(x - tile.west);
  const row = Math.floor(tile.north - y);
  const nearestCellM = cellAt(column, row);
  if (Number.isNaN(nearestCellM)) return null;

  // Bilinear between cell centers, as the pipeline's lidar window does.
  const fx = x - tile.west - 0.5;
  const fy = tile.north - y - 0.5;
  const column0 = Math.floor(fx);
  const row0 = Math.floor(fy);
  const tx = fx - column0;
  const ty = fy - row0;
  const corners = [cellAt(column0, row0), cellAt(column0 + 1, row0), cellAt(column0, row0 + 1), cellAt(column0 + 1, row0 + 1)];
  const bilinearM = corners.some(Number.isNaN)
    ? null
    : (corners[0]! * (1 - tx) + corners[1]! * tx) * (1 - ty) + (corners[2]! * (1 - tx) + corners[3]! * tx) * ty;

  let lowest = nearestCellM;
  let highest = nearestCellM;
  for (let dRow = -SPREAD_HALF_WIDTH_CELLS; dRow <= SPREAD_HALF_WIDTH_CELLS; dRow += 1) {
    for (let dColumn = -SPREAD_HALF_WIDTH_CELLS; dColumn <= SPREAD_HALF_WIDTH_CELLS; dColumn += 1) {
      const value = cellAt(column + dColumn, row + dRow);
      if (Number.isNaN(value)) continue;
      lowest = Math.min(lowest, value);
      highest = Math.max(highest, value);
    }
  }
  return { nearestCellM, bilinearM, cellSpreadM: [lowest, highest] };
}

function loadTileCached(filePath: string): Promise<LoadedTile> {
  const cached = tileCache.get(filePath);
  if (cached) {
    tileCache.delete(filePath);
    tileCache.set(filePath, cached);
    return cached;
  }
  const loading = loadTile(filePath);
  // A failed load must not stay cached.
  loading.catch(() => tileCache.delete(filePath));
  tileCache.set(filePath, loading);
  while (tileCache.size > MAX_CACHED_TILES) tileCache.delete(tileCache.keys().next().value as string);
  return loading;
}

async function loadTile(filePath: string): Promise<LoadedTile> {
  const bytes = await readFile(filePath);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  const image = await (await fromArrayBuffer(arrayBuffer)).getImage();
  const [west, north] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();
  if (west === undefined || north === undefined || resolutionX !== 1 || resolutionY !== -1) {
    throw new Error(`${path.basename(filePath)} is not a 1 m north-up tile.`);
  }
  const band = (await image.readRasters({ interleave: false }))[0];
  const width = image.getWidth();
  const height = image.getHeight();
  if (!band || band.length !== width * height) throw new Error(`${path.basename(filePath)} has an unexpected sample count.`);
  const noData = image.getGDALNoData();
  const elevations = new Float32Array(band.length);
  for (let index = 0; index < band.length; index += 1) {
    const value = Number(band[index]);
    const isNoData = !Number.isFinite(value) || (noData !== null && value === noData) || value <= -1000 || value >= 10000;
    elevations[index] = isNoData ? Number.NaN : value;
  }
  return { west, north, width, height, elevations };
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}
