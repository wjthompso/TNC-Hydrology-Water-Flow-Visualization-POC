// WSE Polygon Generation Methods the browser can draw (glossary: a named,
// versioned way to turn modeled water-surface elevations into the water
// polygons drawn for each Creek Segment). The dev middleware lists every
// saved method version per extent in `wse-polygon-methods.json`; the page
// picks one from `?wsePolygonMethod=<method-id>@v<version>` or the default.
// `&modeledWse=<method-id>@v<version>` draws those polygons with another
// Time Series solved on the same channel (a channel pairing, e.g. m4 on
// flowline-channel-ribbon v2, which was built from m3 v2). Without either
// parameter the page opens the default pairing: the default method's newest
// version drawn with the default Modeled WSE Derivation Method (m5) when that
// method was solved on the polygons' channel.

import { PublishedCreekDataError } from './creek-data-contract.ts';

/** `?wsePolygonMethod=flowline-channel-ribbon@v2`; `<method-id>` alone means its newest version. */
export const WSE_POLYGON_METHOD_QUERY_PARAM = 'wsePolygonMethod';
/** Dev-middleware file listing the saved method versions of one extent. */
export const WSE_POLYGON_METHODS_PATH = 'wse-polygon-methods.json';
/** `?modeledWse=m4-flowline-profile-variable-power-depth@v1`: the Time Series to draw, when not the one the polygons were built from. */
export const MODELED_WSE_QUERY_PARAM = 'modeledWse';

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
  | 'channel-ribbon-depth'
  // `channel-ribbon-pool-filled`: the same ribbon rungs, drawn on the water surface pool-filled along the run
  // (m3's pool-filled-water-surface.ts, the rule its Time Series values follow).
  | 'channel-ribbon-pool-filled';

/** True for the drawings whose buckets are water depths and whose ring vertices carry a bed elevation. */
export function drawsDepthBuckets(browserDrawing: WsePolygonBrowserDrawing): boolean {
  return browserDrawing === 'bed-parallel-depth' || drawsChannelRibbonRungs(browserDrawing);
}

/** True for the two channel ribbon drawings (vertex-aligned depth rungs with a `channelRibbon` summary). */
export function drawsChannelRibbonRungs(browserDrawing: WsePolygonBrowserDrawing): boolean {
  return browserDrawing === 'channel-ribbon-depth' || browserDrawing === 'channel-ribbon-pool-filled';
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
  /**
   * Set only on a channel pairing: the Time Series drawn with these polygons
   * (relative to `03-time-series/`), solved on the channel of the version they
   * were built from, e.g. m4 drawn on ribbon v2 built from m3 v2.
   */
  drawnWithModeledWsePath?: string;
}

/**
 * One saved modeled WSE version (Data-Product Version, e.g. `m2-v1`) of the
 * extent; hosted data lists the one version its service publishes.
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
  /**
   * The saved version whose channel this one was solved on (m4 and m5: m3 v2),
   * so polygons built from it can draw this Time Series too.
   */
  channelFromModeledWsePath?: string;
}

/** A registered method with no saved output for this extent: the answer to "do we have it yet?". */
export interface NotGeneratedDerivedData {
  modeledWse: readonly { label: string; versionLabel: string }[];
  wsePolygon: readonly { label: string }[];
}

export interface WsePolygonMethodList {
  defaultMethodId: string;
  /**
   * The Modeled WSE Derivation Method drawn on the default method's newest version when the URL names none, through a
   * channel pairing; '' when the file names none (older middleware output).
   */
  defaultModeledWseMethodId: string;
  /** Sorted by method id, then version. */
  versions: readonly WsePolygonMethodVersion[];
  /** Saved modeled WSE versions, sorted by method id, then version. Hosted data lists the published one. */
  modeledWseVersions: readonly SavedModeledWseVersion[];
  /** Each polygon version paired with every Time Series solved on the channel it was built from. */
  channelPairings: readonly WsePolygonMethodVersion[];
  notGenerated: NotGeneratedDerivedData;
}

/** `junction-sloped-terrain-fill@v1`: the URL and dev tools form of one method version. */
export function wsePolygonMethodKey(entry: Pick<WsePolygonMethodVersion, 'methodId' | 'version'>): string {
  return `${entry.methodId}@v${entry.version}`;
}

/** The Time Series a polygon version is drawn with: a channel pairing's, else the one it was built from. */
export function drawnModeledWsePathOf(
  method: Pick<WsePolygonMethodVersion, 'builtFromModeledWsePath' | 'drawnWithModeledWsePath'>,
): string | undefined {
  return method.drawnWithModeledWsePath ?? method.builtFromModeledWsePath;
}

/** `m4-flowline-profile-variable-power-depth/v1` → `m4-flowline-profile-variable-power-depth@v1`, the `modeledWse` URL form. */
export function modeledWseKeyOfPath(modeledWsePath: string): string {
  return modeledWsePath.replace(/\/v(\d+)$/, '@v$1');
}

/**
 * The dev tools and `setWsePolygonMethod` identity of a drawn pairing: the
 * polygon key, plus `+<modeledWse key>` for a channel pairing.
 */
export function derivedDataSelectionKey(
  entry: Pick<WsePolygonMethodVersion, 'methodId' | 'version' | 'drawnWithModeledWsePath'>,
): string {
  const polygonKey = wsePolygonMethodKey(entry);
  return entry.drawnWithModeledWsePath ? `${polygonKey}+${modeledWseKeyOfPath(entry.drawnWithModeledWsePath)}` : polygonKey;
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
  const modeledWseVersions = readSavedModeledWseVersions(record.modeledWseVersions);
  return {
    defaultMethodId: typeof record.defaultMethodId === 'string' ? record.defaultMethodId : '',
    defaultModeledWseMethodId: typeof record.defaultModeledWseMethodId === 'string' ? record.defaultModeledWseMethodId : '',
    versions,
    modeledWseVersions,
    channelPairings: channelPairingsOf(versions, modeledWseVersions),
    notGenerated: readNotGenerated(record.notGenerated),
  };
}

/**
 * A polygon version's geometry depends only on the channel it was built on,
 * so it can draw any Time Series solved on that channel. The middleware lists
 * the channel only while its source version keeps the fingerprint recorded.
 */
function channelPairingsOf(
  versions: readonly WsePolygonMethodVersion[],
  modeledWseVersions: readonly SavedModeledWseVersion[],
): WsePolygonMethodVersion[] {
  return modeledWseVersions.flatMap((wseVersion) =>
    versions
      .filter((entry) => wseVersion.channelFromModeledWsePath && entry.builtFromModeledWsePath === wseVersion.channelFromModeledWsePath)
      .map((entry) => ({ ...entry, drawnWithModeledWsePath: wseVersion.path })),
  );
}

/** Optional in the file: older middleware output carries none. */
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
    const channelFromModeledWsePath =
      typeof entry.channelFromModeledWsePath === 'string' && entry.channelFromModeledWsePath.length > 0
        ? entry.channelFromModeledWsePath
        : undefined;
    return [
      {
        methodId,
        version,
        versionLabel,
        label: typeof entry.label === 'string' ? entry.label : methodId,
        description: typeof entry.description === 'string' ? entry.description : '',
        path,
        ...(channelFromModeledWsePath ? { channelFromModeledWsePath } : {}),
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
  /**
   * Sorted by method id, then version; the polygon versions built from this
   * Time Series, then the channel pairings that draw it. Empty when only the
   * Time Series exists.
   */
  polygonVersions: readonly WsePolygonMethodVersion[];
}

/** Saved modeled WSE versions first (oldest first), then polygon pairings no saved version covers. */
export function groupDerivedData(list: WsePolygonMethodList): DerivedDataGroup[] {
  const groups: DerivedDataGroup[] = list.modeledWseVersions.map((wseVersion) => ({
    key: wseVersion.path,
    label: `${wseVersion.versionLabel} · ${wseVersion.label}`,
    wseVersion,
    polygonVersions: [
      ...list.versions.filter((entry) => entry.builtFromModeledWsePath === wseVersion.path),
      ...list.channelPairings.filter((entry) => entry.drawnWithModeledWsePath === wseVersion.path),
    ],
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
  method: Pick<WsePolygonMethodVersion, 'builtFromModeledWsePath' | 'drawnWithModeledWsePath'>,
): DerivedDataGroup | null {
  return groups.find((group) => group.key === (drawnModeledWsePathOf(method) ?? '')) ?? null;
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
 * none). `modeledWseRequest` (`<id>@v<n>`) then picks that version's channel
 * pairing, or keeps its own Time Series when it names that one.
 * With neither request, the default pairing: that version drawn with the
 * newest saved version of the default Modeled WSE Derivation Method solved on
 * its channel, or with its own Time Series when there is none.
 * `unmatchedRequest` reports a request that fell back.
 */
export function resolveWsePolygonMethod(
  list: WsePolygonMethodList,
  request: string | null,
  modeledWseRequest: string | null = null,
): { selected: WsePolygonMethodVersion; unmatchedRequest: string | null } {
  const polygon = resolvePolygonVersion(list, request);
  if (!request && !modeledWseRequest) {
    const defaultPairing = list.channelPairings
      .filter(
        (entry) =>
          wsePolygonMethodKey(entry) === wsePolygonMethodKey(polygon.selected) &&
          list.modeledWseVersions.some(
            (wseVersion) => wseVersion.path === entry.drawnWithModeledWsePath && wseVersion.methodId === list.defaultModeledWseMethodId,
          ),
      )
      .at(-1);
    return defaultPairing ? { selected: defaultPairing, unmatchedRequest: null } : polygon;
  }
  if (!modeledWseRequest || polygon.unmatchedRequest) return polygon;
  const own = polygon.selected.builtFromModeledWsePath;
  if (own && modeledWseKeyOfPath(own) === modeledWseRequest) return polygon;
  const pairing = list.channelPairings.find(
    (entry) =>
      wsePolygonMethodKey(entry) === wsePolygonMethodKey(polygon.selected) &&
      modeledWseKeyOfPath(entry.drawnWithModeledWsePath ?? '') === modeledWseRequest,
  );
  return pairing
    ? { selected: pairing, unmatchedRequest: null }
    : { selected: polygon.selected, unmatchedRequest: `${request ?? wsePolygonMethodKey(polygon.selected)} with ${modeledWseRequest}` };
}

function resolvePolygonVersion(
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
  if (
    value === 'flat-at-bucket-minimum' ||
    value === 'bed-parallel-depth' ||
    value === 'channel-ribbon-depth' ||
    value === 'channel-ribbon-pool-filled'
  ) {
    return value;
  }
  return 'sloped-between-junctions';
}

function fail(message: string): never {
  throw new PublishedCreekDataError(message);
}
