import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { USGS_3DEP_EXPORT } from '../constants.ts';
import { writePrettyJson } from '../json-files.ts';
import type { CreekSegment } from '../tnc-flowline-segmentation.ts';
import { fetchBytes, urlWithParams } from './http-download.ts';
import { TERRAIN_TILE_MAX_PIXELS, TERRAIN_TILE_STEP_M } from './pipeline-configuration.ts';
import { TERRAIN_TILE_INDEX_FILE, type TerrainTileIndex, type TerrainTileRecord } from './terrain-tiles.ts';

/**
 * Data in: Creek Segments for one extent. Data out: USGS 3DEP 1 m bare-earth GeoTIFF tiles
 * that cover every Creek Segment corridor, plus `terrain-tiles.json` listing them.
 *
 * Tiles are TERRAIN_TILE_MAX_PIXELS meters square and start every TERRAIN_TILE_STEP_M meters,
 * so neighbouring tiles overlap. The overlap is larger than any one Creek Segment corridor,
 * so every corridor lies wholly inside at least one tile (Stage 4 needs that). Only tiles
 * that touch a corridor are downloaded. A tile already on disk is reused, so an interrupted
 * run resumes where it stopped.
 */

interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

function isTiff(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
  return littleEndian || bigEndian;
}

async function existingTiff(filePath: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(filePath);
    return isTiff(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** One box per Creek Segment: its two endpoints plus the buffer, in EPSG 32610 meters. */
function corridorBoxes(segments: readonly CreekSegment[], bufferM: number): Box[] {
  return segments.map((segment) => ({
    west: Math.min(segment.startUtm.x, segment.endUtm.x) - bufferM,
    south: Math.min(segment.startUtm.y, segment.endUtm.y) - bufferM,
    east: Math.max(segment.startUtm.x, segment.endUtm.x) + bufferM,
    north: Math.max(segment.startUtm.y, segment.endUtm.y) + bufferM,
  }));
}

function boxesTouch(a: Box, b: Box): boolean {
  return a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
}

function boxInside(inner: Box, outer: Box): boolean {
  return inner.west >= outer.west && inner.east <= outer.east && inner.south >= outer.south && inner.north <= outer.north;
}

/** Overlapping grid tiles (whole meters, so pixels are exactly 1 m) that touch at least one corridor. */
export function plannedTerrainTiles(segments: readonly CreekSegment[], bufferM: number): { tiles: Box[]; corridorsOutsideAnyTile: number } {
  const corridors = corridorBoxes(segments, bufferM);
  const west = Math.floor(Math.min(...corridors.map((box) => box.west)));
  const south = Math.floor(Math.min(...corridors.map((box) => box.south)));
  const east = Math.max(...corridors.map((box) => box.east));
  const north = Math.max(...corridors.map((box) => box.north));
  const tiles: Box[] = [];
  for (let tileSouth = south; tileSouth < north; tileSouth += TERRAIN_TILE_STEP_M) {
    for (let tileWest = west; tileWest < east; tileWest += TERRAIN_TILE_STEP_M) {
      const tile = {
        west: tileWest,
        south: tileSouth,
        east: tileWest + TERRAIN_TILE_MAX_PIXELS,
        north: tileSouth + TERRAIN_TILE_MAX_PIXELS,
      };
      if (corridors.some((corridor) => boxesTouch(corridor, tile))) tiles.push(tile);
    }
  }
  const corridorsOutsideAnyTile = corridors.filter((corridor) => !tiles.some((tile) => boxInside(corridor, tile))).length;
  return { tiles, corridorsOutsideAnyTile };
}

export async function acquireTerrainTiles(input: {
  segments: readonly CreekSegment[];
  bufferM: number;
  outputDirectory: string;
}): Promise<{ index: TerrainTileIndex; files: string[]; bytes: number; downloadedTiles: number; reusedTiles: number }> {
  await mkdir(input.outputDirectory, { recursive: true });
  const plan = plannedTerrainTiles(input.segments, input.bufferM);
  if (plan.corridorsOutsideAnyTile > 0) {
    throw new Error(
      `${plan.corridorsOutsideAnyTile} Creek Segment corridors do not fit inside one terrain tile. ` +
        'Increase the overlap (TERRAIN_TILE_MAX_PIXELS minus TERRAIN_TILE_STEP_M).',
    );
  }
  console.log(`  ${plan.tiles.length} terrain tiles of ${TERRAIN_TILE_MAX_PIXELS} m touch a Creek Segment corridor.`);

  const tiles: TerrainTileRecord[] = [];
  const files: string[] = [];
  let totalBytes = 0;
  let downloadedTiles = 0;
  let reusedTiles = 0;
  for (const [tileNumber, tile] of plan.tiles.entries()) {
    const widthPixels = tile.east - tile.west;
    const heightPixels = tile.north - tile.south;
    const url = urlWithParams(USGS_3DEP_EXPORT, {
      bbox: [tile.west, tile.south, tile.east, tile.north].join(','),
      bboxSR: '32610',
      imageSR: '32610',
      size: `${widthPixels},${heightPixels}`,
      format: 'tiff',
      pixelType: 'F32',
      interpolation: 'RSP_NearestNeighbor',
      f: 'image',
    });
    const file = `usgs-3dep-1m-tile-${tile.west}-${tile.south}.tif`;
    const filePath = path.join(input.outputDirectory, file);
    let bytes = await existingTiff(filePath);
    if (bytes) {
      reusedTiles += 1;
    } else {
      bytes = await fetchBytes(url);
      if (!isTiff(bytes)) {
        throw new Error(`USGS 3DEP export was not a TIFF. Body starts: ${bytes.subarray(0, 180).toString('utf8')}`);
      }
      await writeFile(filePath, bytes);
      downloadedTiles += 1;
    }
    files.push(filePath);
    totalBytes += bytes.length;
    tiles.push({ file, ...tile, widthPixels, heightPixels, url });
    if ((tileNumber + 1) % 10 === 0 || tileNumber + 1 === plan.tiles.length) {
      console.log(`  Terrain tiles ${tileNumber + 1}/${plan.tiles.length} (downloaded ${downloadedTiles}, reused ${reusedTiles}).`);
    }
  }
  const index: TerrainTileIndex = {
    description: 'USGS 3DEP 1 m bare-earth terrain tiles covering every Creek Segment corridor. Tiles overlap.',
    spatialReference: 'EPSG:32610',
    tiles,
  };
  const indexPath = path.join(input.outputDirectory, TERRAIN_TILE_INDEX_FILE);
  await writePrettyJson(indexPath, index);
  files.push(indexPath);
  return { index, files, bytes: totalBytes, downloadedTiles, reusedTiles };
}
