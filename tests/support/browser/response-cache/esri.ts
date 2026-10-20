import { esriResponseCacheDirectory } from './cache-location.ts';
import { testCacheRoot } from './disk-store.ts';
import type { ResponseCacheSource } from './response-cache-source.ts';

/**
 * Esri source: basemap imagery, terrain, and service metadata from `*.arcgis.com` and
 * `*.arcgisonline.com`, requested directly by the browser.
 *
 * Why cached: every scene test loads hundreds of Esri tiles. Saving them removes Esri
 * round trips and HTTP 429 rate limits from warm runs.
 *
 * Key rule: the full request URL with the hash, credentials, and `_ts` cache-buster
 * removed and the remaining query parameters sorted. Do not change this rule: it would
 * orphan every saved entry in `esri-responses/v1`.
 */
const ESRI_HOST = /(^|\.)(arcgis\.com|arcgisonline\.com)$/i;
/** Credentials and cache-busters. They never reach the cache key or the disk. */
const SECRET_OR_VOLATILE_PARAMS = new Set(['token', 'apikey', 'api_key', 'key', 'access_token', 'secret', '_ts']);

function withoutSecrets(url: URL): URL {
  const cleaned = new URL(url.href);
  cleaned.hash = '';
  for (const name of [...cleaned.searchParams.keys()]) {
    if (SECRET_OR_VOLATILE_PARAMS.has(name.toLowerCase())) cleaned.searchParams.delete(name);
  }
  cleaned.searchParams.sort();
  return cleaned;
}

export const esriResponseSource: ResponseCacheSource = {
  name: 'Esri',
  directory: () => esriResponseCacheDirectory(testCacheRoot()),
  matches: (url) => (url.protocol === 'https:' || url.protocol === 'http:') && ESRI_HOST.test(url.hostname),
  keyUrl: (url) => withoutSecrets(url).href,
  // 404 is a real Esri answer for a tile that does not exist.
  isSavable: (status) => status === 200 || status === 404,
};
