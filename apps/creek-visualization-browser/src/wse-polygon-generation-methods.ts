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

/**
 * How the method's polygons are drawn: lifted between the junction WSEs, flat
 * at the bucket minimum, or `bed-parallel-depth`: buckets are water depths and
 * each ring vertex carries its creek-bed elevation as z, so the water sits that
 * depth above the bed at every vertex.
 */
export type WsePolygonBrowserDrawing =
  | 'sloped-between-junctions'
  | 'flat-at-bucket-minimum'
  | 'bed-parallel-depth'
  // `channel-ribbon-depth`: depth buckets like `bed-parallel-depth`, but they are vertex-aligned morph targets
  // of one ribbon that the browser slides between at each station's own depth (channel-ribbon-surface.ts).
  | 'channel-ribbon-depth';

/** True for the drawings whose buckets are water depths and whose ring vertices carry a bed elevation. */
export function drawsDepthBuckets(browserDrawing: WsePolygonBrowserDrawing): boolean {
  return browserDrawing === 'bed-parallel-depth' || browserDrawing === 'channel-ribbon-depth';
}

export interface WsePolygonMethodVersion {
  methodId: string;
  version: number;
  label: string;
  description: string;
  browserDrawing: WsePolygonBrowserDrawing;
  /** Relative to the extent, e.g. `04-water-surface-polygons/junction-sloped-terrain-fill/v1`. */
  path: string;
  /**
   * Modeled WSE version folder the polygons were built from, relative to
   * `03-time-series/`, e.g. `m1-drainage-area-ratio-manning-rating-curve/v1`.
   * Local dev middleware only; absent for hosted data and older manifests.
   */
  builtFromModeledWsePath?: string;
}

/**
 * One saved modeled WSE version (Data-Product Version, e.g. `m2-v1`) of the
 * extent. Local dev middleware only; hosted data lists none.
 */
export interface SavedModeledWseVersion {
  methodId: string;
  version: number;
  /** Data-Product Version label, e.g. `m2-v1`. */
  versionLabel: string;
  label: string;
  description: string;
  /** Relative to `03-time-series/`, e.g. `m2-multi-section-manning-depth/v1`. */
  path: string;
}

/** A registered method with no saved output for this extent: the answer to "do we have it yet?". */
export interface NotGeneratedDerivedData {
  modeledWse: readonly { label: string; versionLabel: string }[];
  wsePolygon: readonly { label: string }[];
}

export interface WsePolygonMethodList {
  defaultMethodId: string;
  /** Sorted by method id, then version. */
  versions: readonly WsePolygonMethodVersion[];
  /** Saved modeled WSE versions, sorted by method id, then version. Empty for hosted data. */
  modeledWseVersions: readonly SavedModeledWseVersion[];
  notGenerated: NotGeneratedDerivedData;
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
    const builtFromModeledWsePath =
      typeof entry.builtFromModeledWsePath === 'string' && entry.builtFromModeledWsePath.length > 0
        ? entry.builtFromModeledWsePath
        : undefined;
    return {
      methodId,
      version,
      label: typeof entry.label === 'string' ? entry.label : methodId,
      description: typeof entry.description === 'string' ? entry.description : '',
      browserDrawing: readBrowserDrawing(entry.browserDrawing),
      path,
      ...(builtFromModeledWsePath ? { builtFromModeledWsePath } : {}),
    } satisfies WsePolygonMethodVersion;
  });
  return {
    defaultMethodId: typeof record.defaultMethodId === 'string' ? record.defaultMethodId : '',
    versions,
    modeledWseVersions: readSavedModeledWseVersions(record.modeledWseVersions),
    notGenerated: readNotGenerated(record.notGenerated),
  };
}

/** Optional in the file: older middleware output and hosted data carry none. */
function readSavedModeledWseVersions(value: unknown): SavedModeledWseVersion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SavedModeledWseVersion[] => {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const { methodId, version, versionLabel, path } = entry;
    if (
      typeof methodId !== 'string' ||
      typeof version !== 'number' ||
      typeof versionLabel !== 'string' ||
      typeof path !== 'string'
    ) {
      return [];
    }
    return [
      {
        methodId,
        version,
        versionLabel,
        label: typeof entry.label === 'string' ? entry.label : methodId,
        description: typeof entry.description === 'string' ? entry.description : '',
        path,
      },
    ];
  });
}

function readNotGenerated(value: unknown): NotGeneratedDerivedData {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const labelled = (items: unknown): Record<string, unknown>[] =>
    Array.isArray(items)
      ? items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : [];
  return {
    modeledWse: labelled(record.modeledWse).flatMap((item) =>
      typeof item.label === 'string' && typeof item.versionLabel === 'string'
        ? [{ label: item.label, versionLabel: item.versionLabel }]
        : [],
    ),
    wsePolygon: labelled(record.wsePolygon).flatMap((item) =>
      typeof item.label === 'string' ? [{ label: item.label }] : [],
    ),
  };
}

/**
 * Every polygon version of one modeled WSE version, which is the pairing the
 * dev tools offer: a polygon version is only drawn with the Time Series it was
 * built from. `wseVersion` is null for a pairing the extent has no saved
 * version for (hosted data, or a manifest that predates the pairing record).
 */
export interface DerivedDataGroup {
  /** `builtFromModeledWsePath`, or '' when polygons name no modeled WSE version. */
  key: string;
  /** Short select label, e.g. `m2-v1 · Multi-section Manning depth`. */
  label: string;
  wseVersion: SavedModeledWseVersion | null;
  /** Sorted by method id, then version. Empty when only the Time Series exists. */
  polygonVersions: readonly WsePolygonMethodVersion[];
}

/** Saved modeled WSE versions first (oldest first), then polygon pairings no saved version covers. */
export function groupDerivedData(list: WsePolygonMethodList): DerivedDataGroup[] {
  const groups: DerivedDataGroup[] = list.modeledWseVersions.map((wseVersion) => ({
    key: wseVersion.path,
    label: `${wseVersion.versionLabel} · ${wseVersion.label}`,
    wseVersion,
    polygonVersions: list.versions.filter((entry) => entry.builtFromModeledWsePath === wseVersion.path),
  }));
  const covered = new Set(groups.map((group) => group.key));
  for (const entry of list.versions) {
    const key = entry.builtFromModeledWsePath ?? '';
    if (covered.has(key)) continue;
    covered.add(key);
    groups.push({
      key,
      label: key === '' ? 'Catalog default' : key,
      wseVersion: null,
      polygonVersions: list.versions.filter((candidate) => (candidate.builtFromModeledWsePath ?? '') === key),
    });
  }
  return groups;
}

/** The group whose polygons a method version belongs to. */
export function derivedDataGroupOf(
  groups: readonly DerivedDataGroup[],
  method: Pick<WsePolygonMethodVersion, 'builtFromModeledWsePath'>,
): DerivedDataGroup | null {
  return groups.find((group) => group.key === (method.builtFromModeledWsePath ?? '')) ?? null;
}

/**
 * The polygon version to draw when a group is chosen: the default method's
 * newest version in it, else the group's newest. Null when it has no polygons yet.
 */
export function preferredPolygonVersionOf(
  group: DerivedDataGroup,
  defaultMethodId: string,
): WsePolygonMethodVersion | null {
  return group.polygonVersions.filter((entry) => entry.methodId === defaultMethodId).at(-1) ?? group.polygonVersions.at(-1) ?? null;
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

/** Unknown or missing values keep the original default, `sloped-between-junctions`. */
function readBrowserDrawing(value: unknown): WsePolygonBrowserDrawing {
  if (value === 'flat-at-bucket-minimum' || value === 'bed-parallel-depth' || value === 'channel-ribbon-depth') return value;
  return 'sloped-between-junctions';
}

function fail(message: string): never {
  throw new PublishedCreekDataError(message);
}
