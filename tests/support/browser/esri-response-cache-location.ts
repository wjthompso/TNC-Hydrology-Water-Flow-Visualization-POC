import path from 'node:path';

/** Disk folder, under the test cache root, that holds saved Esri responses. */
export const ESRI_RESPONSE_CACHE_FOLDER = 'esri-responses';

/** Versioned directory of saved Esri responses for one cache root. */
export function esriResponseCacheDirectory(cacheRoot: string): string {
  return path.join(cacheRoot, ESRI_RESPONSE_CACHE_FOLDER, 'v1');
}
