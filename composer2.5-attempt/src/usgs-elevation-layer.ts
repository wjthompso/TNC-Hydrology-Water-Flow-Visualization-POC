import BaseElevationLayer from '@arcgis/core/layers/BaseElevationLayer';
import TileInfo from '@arcgis/core/layers/support/TileInfo';
import SpatialReference from '@arcgis/core/geometry/SpatialReference';
import Point from '@arcgis/core/geometry/Point';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import { createAbortError } from '@arcgis/core/core/promiseUtils';
import { fromArrayBuffer } from 'geotiff';

export const USGS_3DEP_ELEVATION_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

/** Dev-server proxy path (see vite.config.ts) — avoids CORS from localhost. */
const EXPORT_IMAGE_PATH = '/api/usgs-elevation/exportImage';

/** Terrain tiles have 256 cells, requiring a 257 × 257 sample grid. */
const TILE_SIZE = 256;
const TILE_SAMPLE_SIZE = TILE_SIZE + 1;
/** USGS 3DEP expects -9999; ArcGIS may pass Float32 max — always use this. */
const NO_DATA = -9999;

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function resampleNearestNeighbor(
  values: Float32Array,
  srcWidth: number,
  srcHeight: number,
): Float32Array {
  if (srcWidth === TILE_SAMPLE_SIZE && srcHeight === TILE_SAMPLE_SIZE) {
    return values;
  }

  const out = new Float32Array(TILE_SAMPLE_SIZE * TILE_SAMPLE_SIZE);
  for (let y = 0; y < TILE_SAMPLE_SIZE; y++) {
    const srcY = Math.min(
      Math.floor((y / TILE_SAMPLE_SIZE) * srcHeight),
      srcHeight - 1,
    );
    for (let x = 0; x < TILE_SAMPLE_SIZE; x++) {
      const srcX = Math.min(
        Math.floor((x / TILE_SAMPLE_SIZE) * srcWidth),
        srcWidth - 1,
      );
      out[y * TILE_SAMPLE_SIZE + x] = values[srcY * srcWidth + srcX];
    }
  }
  return out;
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
    if (!Number.isFinite(elevationM) || elevationM === NO_DATA) {
      throw new Error('USGS elevation tile has no valid data at the creek');
    }
    return { elevationM, level, row, col };
  } catch (error) {
    console.warn('USGS elevation tile test failed', error);
    return null;
  }
}

/**
 * Custom elevation layer for USGS 3DEP ImageServer (dynamic, not LERC-tiled).
 * Fetches Float32 GeoTIFF tiles via exportImage and feeds SceneView terrain.
 *
 * Pass `fullExtent` (WGS84) around the creek reach so SceneView does not
 * request tiles globally.
 */
export default class Usgs3DepElevationLayer extends BaseElevationLayer {
  constructor(properties?: __esri.BaseElevationLayerProperties) {
    super({
      title: 'USGS 3DEP Elevation',
      ...properties,
    });

    this.tileInfo = TileInfo.create({
      size: TILE_SIZE,
      spatialReference: SpatialReference.WebMercator,
    });
  }

  async fetchTile(
    level: number,
    row: number,
    col: number,
    options?: __esri.BaseElevationLayerFetchTileOptions,
  ): Promise<__esri.ElevationTileData> {
    const [xmin, ymin, xmax, ymax] = this.getTileBounds(level, row, col);
    const renderingRule = encodeURIComponent(JSON.stringify({ rasterFunction: 'None' }));
    const url =
      `${EXPORT_IMAGE_PATH}?` +
      `bbox=${xmin},${ymin},${xmax},${ymax}` +
      `&bboxSR=3857&size=${TILE_SAMPLE_SIZE},${TILE_SAMPLE_SIZE}&imageSR=3857&format=tiff` +
      `&pixelType=F32&noData=${NO_DATA}&interpolation=RSP_BilinearLinear` +
      `&renderingRule=${renderingRule}&f=image`;

    const signal = options?.signal;
    throwIfAborted(signal);
    const response = await fetch(url, { signal: signal ?? undefined });
    throwIfAborted(signal);
    if (!response.ok) {
      throw new Error(`USGS 3DEP exportImage failed (${response.status})`);
    }

    const responseBuffer = await response.arrayBuffer();
    throwIfAborted(signal);
    const tiff = await fromArrayBuffer(responseBuffer);
    throwIfAborted(signal);
    const image = await tiff.getImage();
    throwIfAborted(signal);
    const srcWidth = image.getWidth();
    const srcHeight = image.getHeight();
    const rasters = await image.readRasters();
    throwIfAborted(signal);
    const band = rasters[0];
    if (typeof band === 'number') {
      throw new Error('USGS elevation GeoTIFF returned a scalar instead of raster samples');
    }
    const samples = band as ArrayLike<number>;
    if (!samples || samples.length !== srcWidth * srcHeight) {
      throw new Error('USGS elevation GeoTIFF has an invalid raster band');
    }

    // Copy sample-by-sample rather than reinterpreting the source ArrayBuffer.
    // This avoids DataView byte-offset/range errors when GeoTIFF returns a
    // typed-array view backed by a larger response buffer.
    const raw = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      raw[i] = samples[i];
    }
    throwIfAborted(signal);

    const values = resampleNearestNeighbor(raw, srcWidth, srcHeight);
    if (values.length !== TILE_SAMPLE_SIZE * TILE_SAMPLE_SIZE) {
      throw new Error(
        `USGS elevation tile size mismatch: expected ${TILE_SAMPLE_SIZE * TILE_SAMPLE_SIZE}, got ${values.length}`,
      );
    }
    if (!values.some((value) => Number.isFinite(value) && value !== NO_DATA)) {
      throw new Error('USGS elevation tile contains no usable elevation samples');
    }

    return {
      values,
      width: TILE_SAMPLE_SIZE,
      height: TILE_SAMPLE_SIZE,
      noDataValue: NO_DATA,
    };
  }
}
