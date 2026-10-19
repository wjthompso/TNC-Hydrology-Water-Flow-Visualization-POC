// WSE Polygon Generation Methods the browser can draw (glossary: a named,
// versioned way to turn modeled water-surface elevations into the water
// polygons drawn for each Creek Segment). The dev middleware lists every
// saved method version per extent in `wse-polygon-methods.json`; the page
// picks one from `?wsePolygonMethod=<method-id>@v<version>` or the default.

import { PublishedCreekDataError } from './creek-data-contract';

/** `?wsePolygonMethod=junction-sloped-terrain-fill@v1`; `<method-id>` alone means its newest version. */
export const WSE_POLYGON_METHOD_QUERY_PARAM = 'wsePolygonMethod';
/** Dev-middleware file listing the saved method versions of one extent. */
export const WSE_POLYGON_METHODS_PATH = 'wse-polygon-methods.json';

/** How the method's polygons are drawn: lifted between the junction WSEs, or flat at the bucket minimum. */
export type WsePolygonBrowserDrawing = 'sloped-between-junctions' | 'flat-at-bucket-minimum';

export interface WsePolygonMethodVersion {
  methodId: string;
  version: number;
  label: string;
  description: string;
  browserDrawing: WsePolygonBrowserDrawing;
  /** Relative to the extent, e.g. `04-water-surface-polygons/junction-sloped-terrain-fill/v1`. */
  path: string;
}

export interface WsePolygonMethodList {
  defaultMethodId: string;
  /** Sorted by method id, then version. */
  versions: readonly WsePolygonMethodVersion[];
}

/** `junction-sloped-terrain-fill@v1`: the URL and dev tools form of one method version. */
export function wsePolygonMethodKey(entry: Pick<WsePolygonMethodVersion, 'methodId' | 'version'>): string {
  return `${entry.methodId}@v${entry.version}`;
}

export function readWsePolygonMethodList(value: unknown): WsePolygonMethodList {
  if (typeof value !== 'object' || value === null) fail('wse-polygon-methods.json must be an object.');
  const record = value as Record<string, unknown>;
  const versions = (Array.isArray(record.versions) ? record.versions : []).map((item, index) => {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const methodId = entry.methodId;
    const version = entry.version;
    const path = entry.path;
    if (typeof methodId !== 'string' || typeof version !== 'number' || typeof path !== 'string') {
      fail(`wse-polygon-methods.json version ${index + 1} needs methodId, version, and path.`);
    }
    return {
      methodId,
      version,
      label: typeof entry.label === 'string' ? entry.label : methodId,
      description: typeof entry.description === 'string' ? entry.description : '',
      browserDrawing:
        entry.browserDrawing === 'flat-at-bucket-minimum' ? 'flat-at-bucket-minimum' : 'sloped-between-junctions',
      path,
    } satisfies WsePolygonMethodVersion;
  });
  return {
    defaultMethodId: typeof record.defaultMethodId === 'string' ? record.defaultMethodId : '',
    versions,
  };
}

/**
 * The version a request names: `<id>@v<n>` exactly, `<id>` as its newest
 * version. Without a request, or when the request matches nothing, the default
 * method's newest version (or the newest of any method when the default has
 * none). `unmatchedRequest` reports a request that fell back.
 */
export function resolveWsePolygonMethod(
  list: WsePolygonMethodList,
  request: string | null,
): { selected: WsePolygonMethodVersion; unmatchedRequest: string | null } {
  const newestOf = (methodId: string): WsePolygonMethodVersion | undefined =>
    list.versions.filter((entry) => entry.methodId === methodId).at(-1);
  const fallback = newestOf(list.defaultMethodId) ?? list.versions.at(-1);
  if (!fallback) {
    fail('No saved WSE Polygon Generation Method output for this extent. Run pipeline Stage 4 first.');
  }
  if (!request) return { selected: fallback, unmatchedRequest: null };
  const match = /^(.+)@v(\d+)$/.exec(request);
  const requested = match
    ? list.versions.find((entry) => entry.methodId === match[1] && entry.version === Number(match[2]))
    : newestOf(request);
  return requested ? { selected: requested, unmatchedRequest: null } : { selected: fallback, unmatchedRequest: request };
}

function fail(message: string): never {
  throw new PublishedCreekDataError(message);
}
