import BaseElevationLayer from '@arcgis/core/layers/BaseElevationLayer';
import { ElevationTileData } from '@arcgis/core/layers/support/ElevationTileData';
import TileInfo from '@arcgis/core/layers/support/TileInfo';
import SpatialReference from '@arcgis/core/geometry/SpatialReference';
import Point from '@arcgis/core/geometry/Point';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import { createAbortError } from '@arcgis/core/core/promiseUtils';

export const USGS_3DEP_ELEVATION_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

/** Dev-server proxy path (see vite.config.ts) — avoids CORS from localhost. */
const EXPORT_IMAGE_PATH = '/api/usgs-elevation/exportImage';

/** Terrain tiles have 256 cells, requiring a 257 × 257 sample grid. */
const TILE_SIZE = 256;
const TILE_SAMPLE_SIZE = TILE_SIZE + 1;
const SAMPLE_COUNT = TILE_SAMPLE_SIZE * TILE_SAMPLE_SIZE;
/** USGS 3DEP exportImage nodata. SceneView often asks for ~3.4e37 instead. */
const USGS_NO_DATA = -9999;
/** Native 3DEP is ~1 m ≈ WM LOD 17. Camera queries may still ask 18–23. */
const MAX_MESH_LOD = 17;
const CACHE_LIMIT = 128;
/** Survives LRU eviction of the request cache so a failed LOD 17 cannot bury a good parent. */
const LAST_GOOD_LIMIT = 256;
const WEB_MERCATOR_ORIGIN = 20037508.342787;
const LOD0_RESOLUTION = 156543.03392800014;

function tileKey(level: number, row: number, col: number): string {
  return `${level}/${row}/${col}`;
}

function emptySamples(): Float32Array {
  return new Float32Array(SAMPLE_COUNT).fill(USGS_NO_DATA);
}

function isAllNoData(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    if (Number.isFinite(value) && value !== USGS_NO_DATA) return false;
  }
  return true;
}

function sampleBilinear(grid: Float32Array, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(TILE_SAMPLE_SIZE - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(TILE_SAMPLE_SIZE - 1, Math.floor(y)));
  const x1 = Math.min(x0 + 1, TILE_SAMPLE_SIZE - 1);
  const y1 = Math.min(y0 + 1, TILE_SAMPLE_SIZE - 1);
  const tx = x - Math.floor(x);
  const ty = y - Math.floor(y);
  const v00 = grid[y0 * TILE_SAMPLE_SIZE + x0];
  const v10 = grid[y0 * TILE_SAMPLE_SIZE + x1];
  const v01 = grid[y1 * TILE_SAMPLE_SIZE + x0];
  const v11 = grid[y1 * TILE_SAMPLE_SIZE + x1];
  const valid = [v00, v10, v01, v11].filter(
    (value) => Number.isFinite(value) && value !== USGS_NO_DATA,
  );
  if (valid.length === 0) return USGS_NO_DATA;
  if (valid.length < 4) return valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

/** Resample a coarser WM parent into the child tile's 257×257 grid. */
function upsampleFromParent(
  parent: Float32Array,
  parentLevel: number,
  parentRow: number,
  parentCol: number,
  level: number,
  row: number,
  col: number,
): Float32Array {
  const shift = level - parentLevel;
  const scale = 2 ** shift;
  const localCol = col - (parentCol << shift);
  const localRow = row - (parentRow << shift);
  const originX = (localCol * TILE_SIZE) / scale;
  const originY = (localRow * TILE_SIZE) / scale;
  const step = 1 / scale;
  const out = new Float32Array(SAMPLE_COUNT);
  for (let y = 0; y < TILE_SAMPLE_SIZE; y++) {
    const py = originY + y * step;
    for (let x = 0; x < TILE_SAMPLE_SIZE; x++) {
      out[y * TILE_SAMPLE_SIZE + x] = sampleBilinear(parent, originX + x * step, py);
    }
  }
  return out;
}

function requestedNoData(
  options?: __esri.BaseElevationLayerFetchTileOptions,
): number {
  const value = (options as { noDataValue?: number } | undefined)?.noDataValue;
  return typeof value === 'number' && Number.isFinite(value) ? value : USGS_NO_DATA;
}

/**
 * Copy-on-read and remap USGS -9999 to SceneView's nodata sentinel, then wrap the
 * samples in a real `ElevationTileData` instance. Returning the instance (not a
 * plain object) is the fix for UCS-275: ArcGIS reads `minValue`, `maxValue`,
 * `hasNoDataValues`, and `usedMemory` off this class. A plain object left those
 * undefined, so the terrain mesh bounds went NaN and drew lifted tile-shaped
 * slabs with vertical walls. Leaving -9999 in the array makes ocean look like
 * −9999 m pits, so it is remapped to the requested nodata sentinel.
 *
 * `@arcgis/core` 4.34 uses the positional constructor
 * `new ElevationTileData(values, width, height, noDataValue)`; an object
 * argument is only honored when it carries a `pixelData` key.
 */
function tileForViewer(
  source: Float32Array,
  noDataOut: number,
): ElevationTileData {
  const values = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const value = source[i];
    values[i] =
      !Number.isFinite(value) || value === USGS_NO_DATA ? noDataOut : value;
  }
  return new ElevationTileData(values, TILE_SAMPLE_SIZE, TILE_SAMPLE_SIZE, noDataOut);
}

/**
 * BIP responses can include extra trailing bytes; only the first 257×257
 * floats are samples. A new buffer is required so ArcGIS can detach it.
 */
function decodeBipElevation(buffer: ArrayBuffer): Float32Array | null {
  if (buffer.byteLength < SAMPLE_COUNT * 4) return null;
  const src = new Float32Array(buffer, 0, SAMPLE_COUNT);
  const packed = new Float32Array(SAMPLE_COUNT);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const value = src[i];
    packed[i] =
      Number.isFinite(value) && value !== USGS_NO_DATA ? value : USGS_NO_DATA;
  }
  return packed;
}

/** SceneView still asks for LOD 9 (and sometimes 23) even if tileInfo is sliced. */
function webMercatorTileBounds(
  level: number,
  row: number,
  col: number,
): [number, number, number, number] {
  const size = TILE_SIZE * (LOD0_RESOLUTION / 2 ** level);
  const xmin = -WEB_MERCATOR_ORIGIN + col * size;
  const ymax = WEB_MERCATOR_ORIGIN - row * size;
  return [xmin, ymax - size, xmin + size, ymax];
}

export function tileCoordsForPoint(
  point: Point,
  level: number,
): { row: number; col: number } {
  const wm = webMercatorUtils.geographicToWebMercator(point) as Point;
  const tileInfo = TileInfo.create({
    size: TILE_SIZE,
    spatialReference: SpatialReference.WebMercator,
  });
  const lod = tileInfo.lods[level];
  const resolution = lod.resolution;
  const origin = tileInfo.origin;
  const col = Math.floor((wm.x - origin.x) / (TILE_SIZE * resolution));
  const row = Math.floor((origin.y - wm.y) / (TILE_SIZE * resolution));
  return { row, col };
}

export interface ElevationPreflightResult {
  elevationM: number;
  level: number;
  row: number;
  col: number;
}

/**
 * Preflight: fetch and validate one 3DEP tile at the creek before attaching
 * the layer to SceneView. The sampled value aligns mock absolute heights with
 * the real terrain's local vertical reference.
 */
export async function preflightElevationAtPoint(
  point: Point,
  layer: Usgs3DepElevationLayer,
): Promise<ElevationPreflightResult | null> {
  const level = 14;
  const { row, col } = tileCoordsForPoint(point, level);
  try {
    const tile = await layer.fetchTile(level, row, col);
    const [xmin, ymin, xmax, ymax] = layer.getTileBounds(level, row, col);
    const wm = webMercatorUtils.geographicToWebMercator(point) as Point;
    const x = Math.max(
      0,
      Math.min(
        TILE_SAMPLE_SIZE - 1,
        Math.floor(((wm.x - xmin) / (xmax - xmin)) * TILE_SAMPLE_SIZE),
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        TILE_SAMPLE_SIZE - 1,
        Math.floor(((ymax - wm.y) / (ymax - ymin)) * TILE_SAMPLE_SIZE),
      ),
    );
    const elevationM = tile.values[y * TILE_SAMPLE_SIZE + x];
    if (!Number.isFinite(elevationM) || elevationM === USGS_NO_DATA) {
      return null;
    }
    return { elevationM, level, row, col };
  } catch (error) {
    console.warn('USGS elevation tile test failed', error);
    return null;
  }
}

/**
 * Custom elevation layer for USGS 3DEP ImageServer (dynamic, not LERC-tiled).
 * Fetches packed Float32 BIP tiles via exportImage and feeds SceneView terrain.
 *
 * Pass `fullExtent` covering the creek network plus buffer so SceneView does
 * not request tiles globally.
 */
export default class Usgs3DepElevationLayer extends BaseElevationLayer {
  private readonly cache = new Map<string, Float32Array>();
  /** Good 3DEP only; never evicted by all-nodata and not used for LOD 18–23 copies. */
  private readonly lastGood = new Map<string, Float32Array>();
  private readonly inflight = new Map<string, Promise<Float32Array>>();
  private fallbackWarned = false;

  constructor(properties?: __esri.BaseElevationLayerProperties) {
    super({
      title: 'USGS 3DEP Elevation',
      ...properties,
    });

    this.tileInfo = TileInfo.create({
      size: TILE_SIZE,
      spatialReference: SpatialReference.WebMercator,
    });
    // Keep native 0–23 so getTileBounds / lodAt work when SceneView asks
    // past 1 m. fetchTile still only hits USGS at MAX_MESH_LOD and finer.
  }

  /**
   * Native TileInfo.getTileBounds is null once lods stop at 17. SceneView still
   * asks for 18–23 on creek zoom; a [0,0,0,0] extent makes that tile a hole.
   */
  override getTileBounds(
    level: number,
    row: number,
    column: number,
    out?: number[],
  ): number[] {
    const bounds = out ?? [0, 0, 0, 0];
    const [xmin, ymin, xmax, ymax] = webMercatorTileBounds(level, row, column);
    bounds[0] = xmin;
    bounds[1] = ymin;
    bounds[2] = xmax;
    bounds[3] = ymax;
    return bounds;
  }

  async fetchTile(
    level: number,
    row: number,
    col: number,
    options?: __esri.BaseElevationLayerFetchTileOptions,
  ): Promise<ElevationTileData> {
    const noDataOut = requestedNoData(options);
    const samples = await this.ensureSamples(level, row, col);
    const usable = this.samplesOrAncestor(level, row, col, samples);
    if (!isAllNoData(usable)) {
      if (usable !== samples) this.warnFallback(level, row, col);
      return tileForViewer(usable, noDataOut);
    }
    // Only abort when there is no 3DEP parent to return. TerrainSurface
    // swallows AbortError (no log, no dataMissing) and meshes nodata as z=0.
    if (options?.signal?.aborted) throw createAbortError();
    return tileForViewer(usable, noDataOut);
  }

  private async ensureSamples(
    level: number,
    row: number,
    col: number,
  ): Promise<Float32Array> {
    const key = tileKey(level, row, col);
    const cached = this.readCache(key) ?? this.lastGood.get(key);
    if (cached) return cached;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.loadTile(level, row, col, key).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private readCache(key: string): Float32Array | undefined {
    const samples = this.cache.get(key);
    if (!samples) return undefined;
    this.cache.delete(key);
    this.cache.set(key, samples);
    return samples;
  }

  private storeCache(key: string, samples: Float32Array): Float32Array {
    if (isAllNoData(samples)) return samples;
    this.rememberGood(key, samples);
    this.cache.delete(key);
    this.cache.set(key, samples);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return samples;
  }

  private rememberGood(key: string, samples: Float32Array): void {
    if (isAllNoData(samples)) return;
    this.lastGood.delete(key);
    this.lastGood.set(key, samples);
    if (this.lastGood.size > LAST_GOOD_LIMIT) {
      const oldest = this.lastGood.keys().next().value;
      if (oldest !== undefined) this.lastGood.delete(oldest);
    }
  }

  private readLastGood(key: string): Float32Array | undefined {
    return this.lastGood.get(key) ?? this.readCache(key);
  }

  private lastGoodAncestor(
    level: number,
    row: number,
    col: number,
  ): {
    level: number;
    row: number;
    col: number;
    samples: Float32Array;
  } | null {
    const start = Math.min(level, MAX_MESH_LOD);
    for (let ancestorLevel = start; ancestorLevel >= 0; ancestorLevel--) {
      const shift = level - ancestorLevel;
      const ancestorRow = row >> shift;
      const ancestorCol = col >> shift;
      const samples = this.readLastGood(tileKey(ancestorLevel, ancestorRow, ancestorCol));
      if (samples && !isAllNoData(samples)) {
        return {
          level: ancestorLevel,
          row: ancestorRow,
          col: ancestorCol,
          samples,
        };
      }
    }
    return null;
  }

  private samplesOrAncestor(
    level: number,
    row: number,
    col: number,
    samples: Float32Array,
  ): Float32Array {
    if (!isAllNoData(samples)) return samples;
    const ancestor = this.lastGoodAncestor(level, row, col);
    if (!ancestor) return samples;
    return upsampleFromParent(
      ancestor.samples,
      ancestor.level,
      ancestor.row,
      ancestor.col,
      level,
      row,
      col,
    );
  }

  private warnFallback(level: number, row: number, col: number): void {
    if (this.fallbackWarned) return;
    this.fallbackWarned = true;
    console.warn(
      `USGS 3DEP: using a coarser parent instead of empty/aborted tile ${level}/${row}/${col}`,
    );
  }

  /**
   * Shared USGS load: never abort this fetch when one caller cancels.
   * LOD 18–23 are upsampled from a pinned parent and are not cached, so they
   * cannot evict the 1 m 3DEP tile SceneView needs on the next creek zoom.
   */
  private async loadTile(
    level: number,
    row: number,
    col: number,
    key: string,
  ): Promise<Float32Array> {
    if (level > MAX_MESH_LOD) {
      const shift = level - MAX_MESH_LOD;
      const srcRow = row >> shift;
      const srcCol = col >> shift;
      const src = await this.ensureSamples(MAX_MESH_LOD, srcRow, srcCol);
      const source = !isAllNoData(src)
        ? { samples: src, level: MAX_MESH_LOD, row: srcRow, col: srcCol }
        : this.lastGoodAncestor(level, row, col);
      if (source) {
        return upsampleFromParent(
          source.samples,
          source.level,
          source.row,
          source.col,
          level,
          row,
          col,
        );
      }
      return this.upsampleFromAncestor(level, row, col);
    }

    const fetched = await this.fetchBipWithRetry(level, row, col);
    if (fetched && !isAllNoData(fetched)) return this.storeCache(key, fetched);
    const inherited = await this.upsampleFromAncestor(level, row, col);
    if (!isAllNoData(inherited)) return this.storeCache(key, inherited);
    return inherited;
  }

  private async upsampleFromAncestor(
    level: number,
    row: number,
    col: number,
  ): Promise<Float32Array> {
    if (level <= 0) return emptySamples();
    const parent = await this.ensureSamples(level - 1, row >> 1, col >> 1);
    if (!isAllNoData(parent)) {
      return upsampleFromParent(parent, level - 1, row >> 1, col >> 1, level, row, col);
    }
    const pinned = this.lastGoodAncestor(level, row, col);
    if (!pinned) return emptySamples();
    return upsampleFromParent(
      pinned.samples,
      pinned.level,
      pinned.row,
      pinned.col,
      level,
      row,
      col,
    );
  }

  private async fetchBipWithRetry(
    level: number,
    row: number,
    col: number,
  ): Promise<Float32Array | null> {
    const first = await this.fetchBip(level, row, col);
    if (first && !isAllNoData(first)) return first;
    return this.fetchBip(level, row, col);
  }

  private async fetchBip(
    level: number,
    row: number,
    col: number,
  ): Promise<Float32Array | null> {
    try {
      const [xmin, ymin, xmax, ymax] = webMercatorTileBounds(level, row, col);
      const renderingRule = encodeURIComponent(JSON.stringify({ rasterFunction: 'None' }));
      const url =
        `${EXPORT_IMAGE_PATH}?` +
        `bbox=${xmin},${ymin},${xmax},${ymax}` +
        `&bboxSR=3857&size=${TILE_SAMPLE_SIZE},${TILE_SAMPLE_SIZE}&imageSR=3857&format=bip` +
        `&pixelType=F32&noData=${USGS_NO_DATA}&interpolation=RSP_NearestNeighbor` +
        `&renderingRule=${renderingRule}&f=image`;

      const response = await fetch(url);
      if (!response.ok) return null;
      return decodeBipElevation(await response.arrayBuffer());
    } catch {
      return null;
    }
  }
}
