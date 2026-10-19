import path from 'node:path';

/**
 * Disk folders, under the test cache root (`.test-cache` or `TNC_TEST_CACHE_DIR`), that
 * hold saved live-service responses. Each source keeps its own folder so one source can
 * be cleared or re-versioned without touching the other.
 */
export const ESRI_RESPONSE_CACHE_FOLDER = 'esri-responses';
export const USGS_3DEP_RESPONSE_CACHE_FOLDER = 'usgs-3dep-responses';
/** Every response-cache folder. `npm run test:refresh-map-cache` should clear all of them. */
export const RESPONSE_CACHE_FOLDERS = [ESRI_RESPONSE_CACHE_FOLDER, USGS_3DEP_RESPONSE_CACHE_FOLDER] as const;

/** Versioned directory of saved Esri responses for one cache root. */
export function esriResponseCacheDirectory(cacheRoot: string): string {
  return path.join(cacheRoot, ESRI_RESPONSE_CACHE_FOLDER, 'v1');
}

/** Versioned directory of saved USGS 3DEP terrain responses for one cache root. */
export function usgs3DepResponseCacheDirectory(cacheRoot: string): string {
  return path.join(cacheRoot, USGS_3DEP_RESPONSE_CACHE_FOLDER, 'v1');
}
