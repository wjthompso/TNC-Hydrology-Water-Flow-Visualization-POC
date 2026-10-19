import { usgs3DepResponseCacheDirectory } from './cache-location.ts';
import { testCacheRoot } from './disk-store.ts';
import type { ResponseCacheSource } from './response-cache-source.ts';

/**
 * USGS 3DEP (3D Elevation Program) source: terrain height tiles from the
 * `3DEPElevation/ImageServer/exportImage` endpoint on `elevation.nationalmap.gov`.
 *
 * The browser never calls that host directly. It has no CORS headers for localhost, so
 * `Usgs3DepElevationLayer` requests the same-origin dev-server path
 * `/api/usgs-elevation/exportImage`, and the Vite proxy in
 * `apps/creek-visualization-browser/vite.config.ts` forwards it upstream.
 *
 * Why cached: a scene test asks for 26–57 terrain tiles, and USGS has answered in
 * 3–11 s per tile under parallel load, which pushed scene tests past their 20 s timeout.
 *
 * Key rule: the upstream USGS URL, not the dev-server URL, so the page server's port
 * and host never change the key. The `/api/usgs-elevation` prefix is mapped onto the
 * upstream ImageServer path, the hash and `_ts` are dropped, and query parameters are
 * sorted. Bodies are float32 BIP (band interleaved by pixel) binary, stored byte for byte.
 */
export const USGS_3DEP_PROXY_PREFIX = '/api/usgs-elevation';
export const USGS_3DEP_UPSTREAM_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
const VOLATILE_PARAMS = new Set(['_ts']);

function upstreamUrl(url: URL): URL {
  const upstream = new URL(`${USGS_3DEP_UPSTREAM_URL}${url.pathname.slice(USGS_3DEP_PROXY_PREFIX.length)}`);
  for (const [name, value] of url.searchParams) {
    if (!VOLATILE_PARAMS.has(name.toLowerCase())) upstream.searchParams.append(name, value);
  }
  upstream.searchParams.sort();
  return upstream;
}

/** ArcGIS servers can answer HTTP 200 with a JSON error body; that is not terrain. */
function isJsonErrorBody(contentType: string | null, body: Buffer): boolean {
  if (!contentType || !/json|text/i.test(contentType)) return false;
  return /"error"\s*:/.test(body.toString('utf8', 0, Math.min(body.length, 512)));
}

export const usgs3DepResponseSource: ResponseCacheSource = {
  name: 'USGS 3DEP',
  directory: () => usgs3DepResponseCacheDirectory(testCacheRoot()),
  matches: (url, pageOrigin) =>
    pageOrigin !== undefined &&
    url.origin === pageOrigin &&
    url.pathname.startsWith(`${USGS_3DEP_PROXY_PREFIX}/`),
  keyUrl: (url) => upstreamUrl(url).href,
  isSavable: (status, contentType, body) =>
    status === 404 || (status === 200 && !isJsonErrorBody(contentType, body)),
};
