// Dev-only middleware that serves the modeled water-surface elevation pipeline
// working output (git-ignored, under data/pipeline-working-output/) at
// /modeled-water-surface-elevation-data/<extent>/<path>. Nothing is copied into
// public/. It also computes one small
// per-extent `flowline-index.json` (bounding box and segment centers per TNC
// flowline) so the browser can decide which per-flowline files are near the
// camera before it downloads any of them, and exposes the extent's tracked
// NHDPlusV2 reach crosswalk as `reach-crosswalk.json` so the browser can read
// each Creek Segment's drainage-area ratio and Drainage-Area Ratio Transfer flag
// before the Time Series files carry them. A third computed file,
// `creek-segment-paths.json`, gives every Creek Segment's flowline vertices
// ordered upstream to downstream, plus the ids of the neighbours sharing its
// two vertices, so the browser can slope each water polygon between the
// junction water-surface elevations the Time Series carry and cut the slope at
// the same junction bisectors Stage 4 cut the polygons at.
//
// Anchor bed for m1 (UCS-301): Stage 3 of `m1-drainage-area-ratio-manning-rating-curve`
// writes no `anchorBedElevationM`, but its WSE Anchor Point bed already exists:
// the representative cross-section's thalweg, Stage 1's `segments[].bedElevationM`,
// where Stage 2's rating-curve ladder starts and zero discharge lands. An m1
// Time Series file is served with that bed added to each segment that lacks
// one, so the Water-Surface Elevation Chart can plot Anchor Water Depth. A
// segment Stage 1 has no record for keeps no bed.
//
// WSE Polygon Generation Methods: `wse-polygon-methods.json` lists every saved
// method version of the extent (read from each version's Stage 4 manifest),
// and each version folder gets its own computed flowline index at
// `04-water-surface-polygons/<method-id>/v<version>/flowline-index.json`. The
// extent-level `flowline-index.json` is the default method's newest version.
// Each listed version also names the modeled WSE version folder its polygons
// were built from (`builtFromModeledWsePath`), so the browser can read the
// matching Time Series. The same file lists every saved modeled WSE version
// (`modeledWseVersions`, from the Stage 3 manifests, each with the version
// whose channel it was solved on, `channelFromModeledWsePath`, so polygons
// built from that version can also draw it) and the registered
// methods with no saved output (`notGenerated`), for the dev tools' Derived
// data products section.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { adjacentSegmentsById } from '../../../pipelines/creek-visualization-data-production/creek-segment-adjacency.ts';
import { segmentTncFlowlines } from '../../../pipelines/creek-visualization-data-production/tnc-flowline-segmentation.ts';
import {
  listSavedWsePolygonMethodVersions,
  readSavedBuiltFromModeledWseVersion,
} from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/wse-polygon-generation-methods/wse-polygon-generation-method-outputs.ts';
import {
  DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID,
  WSE_POLYGON_GENERATION_METHODS,
} from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/wse-polygon-generation-methods/wse-polygon-generation-method-registry.ts';
import {
  listSavedModeledWseVersions,
  type SavedModeledWseVersion,
} from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods/modeled-wse-derivation-method-outputs.ts';
import { modeledWseVersionLabel } from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods/modeled-wse-derivation-method.ts';
import { MODELED_WSE_DERIVATION_METHODS } from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods/modeled-wse-derivation-method-registry.ts';
import { M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD } from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts';

export const MODELED_WATER_DATA_URL_PREFIX = '/modeled-water-surface-elevation-data/';
const FLOWLINE_INDEX_FILE = 'flowline-index.json';
const SEGMENT_PATHS_FILE = 'creek-segment-paths.json';
const WSE_POLYGON_METHODS_FILE = 'wse-polygon-methods.json';
/** Served from the tracked reviewed-assignments folder, not from the pipeline output. */
const REACH_CROSSWALK_FILE = 'reach-crosswalk.json';
const WATER_SURFACE_POLYGONS_STAGE_FOLDER = '04-water-surface-polygons';
const TIME_SERIES_STAGE_FOLDER = '03-time-series';
const POLYGON_SETS_FOLDER_NAME = 'water-surface-polygon-sets';
const CROSS_SECTIONS_FILE = '01-cross-sections/cross-sections.json';

const pluginDirectory = fileURLToPath(new URL('.', import.meta.url));
const DATA_ROOT = path.resolve(pluginDirectory, '../../../data/pipeline-working-output');
const SOURCE_INPUTS_ROOT = path.resolve(pluginDirectory, '../../../data/source-inputs');
const REACH_CROSSWALK_ROOT = path.join(SOURCE_INPUTS_ROOT, 'reviewed-assignments');

/**
 * The TNC flowline snapshot each extent was cut from; mirrors `flowlineSnapshotPath`
 * in the pipeline's pipeline-configuration.ts, which cannot be imported here
 * because it reads `--extent=` from the process arguments on import.
 */
function flowlineSnapshotPathFor(extent: string): string {
  if (extent === 'jalama-gauge-reach') return path.join(SOURCE_INPUTS_ROOT, 'tnc-flowline-27714637.json');
  return path.join(SOURCE_INPUTS_ROOT, `tnc-flowlines-${extent}.json`);
}

type LonLat = [number, number];
type Bbox = [number, number, number, number];

interface FlowlineIndexSegment {
  segmentId: string;
  /** Null when every prepared bucket of the segment is empty. */
  centerWgs84: LonLat | null;
}

interface FlowlineIndexEntry {
  tncComid: string;
  /** minLon, minLat, maxLon, maxLat over every prepared polygon of the flowline. */
  bboxWgs84: Bbox;
  segments: FlowlineIndexSegment[];
}

interface FlowlineIndex {
  segmentNetworkVersion: string | null;
  flowlines: FlowlineIndexEntry[];
}

interface SegmentPathEntry {
  segmentId: string;
  /** Flowline vertices of the segment, ordered upstream to downstream. */
  pathWgs84: LonLat[];
  /** Neighbour sharing the upstream vertex (the pipeline's adjacency rule); null at a flowline end. */
  upstreamSegmentId: string | null;
  /** Neighbour sharing the downstream vertex; null at a flowline end. */
  downstreamSegmentId: string | null;
}

interface SegmentPathsFile {
  segmentNetworkVersion: string | null;
  segments: SegmentPathEntry[];
}

interface CachedIndex {
  fingerprint: string;
  body: string;
}

interface CachedStageOneBeds {
  fingerprint: string;
  bedElevationMBySegmentId: Map<string, number>;
}

const indexCache = new Map<string, Promise<CachedIndex>>();
const segmentPathsCache = new Map<string, Promise<CachedIndex>>();
const stageOneBedsCache = new Map<string, Promise<CachedStageOneBeds>>();

export function modeledWaterDataPlugin(): Plugin {
  return {
    name: 'tnc-modeled-water-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(MODELED_WATER_DATA_URL_PREFIX)) {
          next();
          return;
        }
        try {
          const relative = decodeURIComponent(url.slice(MODELED_WATER_DATA_URL_PREFIX.length).split('?')[0]);
          const parts = relative.split('/').filter((part) => part.length > 0);
          const extent = parts[0];
          const rest = parts.slice(1);
          if (!extent || rest.length === 0 || parts.some((part) => part === '..' || part === '.')) {
            respondText(response, 404, 'Not found.');
            return;
          }
          const extentRoot = path.join(DATA_ROOT, extent);
          if (rest.length === 1 && rest[0] === WSE_POLYGON_METHODS_FILE) {
            respondJson(response, JSON.stringify(await listWsePolygonMethods(extentRoot)));
            return;
          }
          if (rest[rest.length - 1] === FLOWLINE_INDEX_FILE) {
            const methodFolder = await flowlineIndexMethodFolder(extentRoot, rest.slice(0, -1));
            if (!methodFolder) {
              respondText(response, 404, `No saved WSE Polygon Generation Method output at ${relative}.`);
              return;
            }
            const index = await loadFlowlineIndex(methodFolder);
            respondJson(response, index.body);
            return;
          }
          if (rest.length === 1 && rest[0] === SEGMENT_PATHS_FILE) {
            const paths = await loadSegmentPaths(extent, extentRoot);
            if (!paths) {
              respondText(response, 404, `No flowline snapshot or Stage 1 output for ${extent} yet.`);
              return;
            }
            respondJson(response, paths.body);
            return;
          }
          if (isM1TimeSeriesFile(rest)) {
            const body = await m1TimeSeriesWithAnchorBeds(extentRoot, rest);
            if (body !== null) {
              respondJson(response, body);
              return;
            }
          }
          const filePath =
            rest.length === 1 && rest[0] === REACH_CROSSWALK_FILE
              ? path.join(REACH_CROSSWALK_ROOT, `nhdplusv2-reach-crosswalk-${extent}.json`)
              : path.join(extentRoot, ...rest);
          const allowedRoot = filePath.startsWith(REACH_CROSSWALK_ROOT + path.sep)
            ? REACH_CROSSWALK_ROOT
            : extentRoot;
          if (!filePath.startsWith(allowedRoot + path.sep)) {
            respondText(response, 404, 'Not found.');
            return;
          }
          let fileStat;
          try {
            fileStat = await stat(filePath);
          } catch {
            respondText(response, 404, `No pipeline output at ${relative}.`);
            return;
          }
          if (!fileStat.isFile()) {
            respondText(response, 404, 'Not found.');
            return;
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', contentTypeFor(filePath));
          response.setHeader('Content-Length', String(fileStat.size));
          response.setHeader('Cache-Control', 'no-store');
          createReadStream(filePath).pipe(response);
        } catch (error) {
          respondText(response, 500, error instanceof Error ? error.message : 'Server error.');
        }
      });
    },
  };
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.tif' || extension === '.tiff') return 'image/tiff';
  return 'application/octet-stream';
}

function respondJson(response: import('node:http').ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function respondText(
  response: import('node:http').ServerResponse,
  status: number,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(message);
}

interface WsePolygonMethodListEntry {
  methodId: string;
  version: number;
  label: string;
  description: string;
  browserDrawing: string;
  /** Relative to the extent folder. */
  path: string;
  /**
   * Modeled WSE version folder the polygons were built from, relative to
   * `03-time-series/`, e.g. `m1-drainage-area-ratio-manning-rating-curve/v1`.
   * Null when the Stage 4 manifest has no `builtFromModeledWseVersion` record.
   */
  builtFromModeledWsePath: string | null;
}

interface SavedModeledWseVersionListEntry {
  methodId: string;
  version: number;
  /** Data-Product Version label, e.g. `m2-v1`. */
  versionLabel: string;
  label: string;
  description: string;
  /** Relative to `03-time-series/`. */
  path: string;
  /**
   * The saved version (relative to `03-time-series/`) whose channel this version was solved on, e.g.
   * `m3-flowline-profile-manning-depth/v2` for m4 and m5: polygons built from it can draw this Time Series.
   * Null when the version names none, or that version is no longer saved with the fingerprint it recorded.
   */
  channelFromModeledWsePath: string | null;
}

interface WsePolygonMethodListFile {
  defaultMethodId: string;
  versions: WsePolygonMethodListEntry[];
  /** Saved Stage 3 versions, so the dev tools can pick the Time Series on its own. */
  modeledWseVersions: SavedModeledWseVersionListEntry[];
  /** Registered methods with no saved output in this extent. */
  notGenerated: {
    modeledWse: { label: string; versionLabel: string }[];
    wsePolygon: { label: string }[];
  };
}

/** Every saved WSE Polygon Generation Method version of the extent, read from the Stage 4 manifests. */
async function listSavedWsePolygonMethodEntries(extentRoot: string): Promise<WsePolygonMethodListEntry[]> {
  const stageDirectory = path.join(extentRoot, WATER_SURFACE_POLYGONS_STAGE_FOLDER);
  const saved = await listSavedWsePolygonMethodVersions(stageDirectory);
  return Promise.all(
    saved.map(async (entry) => ({
      methodId: entry.methodId,
      version: entry.version,
      label: entry.method.label,
      description: entry.method.description,
      browserDrawing: entry.method.browserDrawing,
      path: `${WATER_SURFACE_POLYGONS_STAGE_FOLDER}/${entry.relativePath}`,
      builtFromModeledWsePath: modeledWseVersionPath(
        await readSavedBuiltFromModeledWseVersion(stageDirectory, entry.methodId, entry.version),
      ),
    })),
  );
}

/**
 * `wse-polygon-methods.json`: the saved polygon versions (Stage 4 manifests), the saved modeled WSE
 * versions (Stage 3 manifests), and the registered methods with no saved output yet. Read on each request.
 */
async function listWsePolygonMethods(extentRoot: string): Promise<WsePolygonMethodListFile> {
  const versions = await listSavedWsePolygonMethodEntries(extentRoot);
  const savedModeledWse = await listSavedModeledWseVersions(path.join(extentRoot, TIME_SERIES_STAGE_FOLDER));
  const savedModeledWseMethodIds = new Set(savedModeledWse.map((entry) => entry.methodId));
  const savedPolygonMethodIds = new Set(versions.map((entry) => entry.methodId));
  return {
    defaultMethodId: DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID,
    versions,
    modeledWseVersions: savedModeledWse.map((entry) => ({
      methodId: entry.methodId,
      version: entry.version,
      versionLabel: modeledWseVersionLabel(entry.method),
      label: entry.method.label,
      description: entry.method.description,
      path: entry.relativePath,
      channelFromModeledWsePath: channelSourcePath(entry, savedModeledWse),
    })),
    notGenerated: {
      modeledWse: MODELED_WSE_DERIVATION_METHODS.filter((method) => !savedModeledWseMethodIds.has(method.id)).map(
        (method) => ({ label: method.label, versionLabel: modeledWseVersionLabel(method) }),
      ),
      wsePolygon: WSE_POLYGON_GENERATION_METHODS.filter((method) => !savedPolygonMethodIds.has(method.id)).map(
        (method) => ({ label: method.label }),
      ),
    },
  };
}

/** The saved version whose channel `entry` was solved on, while that version still has the fingerprint `entry` recorded. */
function channelSourcePath(entry: SavedModeledWseVersion, saved: readonly SavedModeledWseVersion[]): string | null {
  const source = entry.channelFromModeledWseVersion;
  if (!source) return null;
  const sourceVersion = saved.find((candidate) => candidate.methodId === source.methodId && candidate.version === source.version);
  return sourceVersion?.method.methodSha256 === source.methodSha256 ? sourceVersion.relativePath : null;
}

/** `{ methodId, version }` from a Stage 4 manifest → `<methodId>/v<version>`, the Stage 3 version folder. */
function modeledWseVersionPath(record: { methodId?: unknown; version?: unknown } | null): string | null {
  if (!record || typeof record.methodId !== 'string' || typeof record.version !== 'number') return null;
  return `${record.methodId}/v${record.version}`;
}

/**
 * The method version folder a flowline-index request names: the extent root
 * means the default method's newest version; otherwise the request must be
 * `04-water-surface-polygons/<method-id>/v<version>/flowline-index.json` for a saved version.
 */
async function flowlineIndexMethodFolder(extentRoot: string, folderParts: string[]): Promise<string | null> {
  const versions = await listSavedWsePolygonMethodEntries(extentRoot);
  const requested =
    folderParts.length === 0
      ? versions.filter((entry) => entry.methodId === DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID).at(-1)
      : versions.find((entry) => entry.path === folderParts.join('/'));
  return requested ? path.join(extentRoot, requested.path) : null;
}

/**
 * The index is rebuilt whenever the polygon folder's file list or mtimes change,
 * so a pipeline rerun by another process is picked up on the next request.
 * Cached per method version folder.
 */
async function loadFlowlineIndex(methodFolder: string): Promise<CachedIndex> {
  const folder = path.join(methodFolder, POLYGON_SETS_FOLDER_NAME);
  const names = (await readdir(folder)).filter((name) => name.endsWith('.json')).sort();
  const stats = await Promise.all(names.map((name) => stat(path.join(folder, name))));
  const fingerprint = names.map((name, i) => `${name}:${stats[i].size}:${stats[i].mtimeMs}`).join('|');
  const cached = indexCache.get(folder);
  if (cached) {
    const resolved = await cached.catch(() => null);
    if (resolved && resolved.fingerprint === fingerprint) return resolved;
  }
  const building = buildFlowlineIndex(folder, names).then((index) => ({
    fingerprint,
    body: JSON.stringify(index),
  }));
  indexCache.set(folder, building);
  return building;
}

export async function buildFlowlineIndex(folder: string, names: string[]): Promise<FlowlineIndex> {
  let segmentNetworkVersion: string | null = null;
  const flowlines: FlowlineIndexEntry[] = [];
  // Sequential on purpose: the preserve's polygon files total ~190 MB.
  for (const name of names) {
    const parsed = JSON.parse(await readFile(path.join(folder, name), 'utf8')) as {
      segmentNetworkVersion?: unknown;
      waterSurfacePolygonSets?: unknown;
    };
    if (typeof parsed.segmentNetworkVersion === 'string') {
      segmentNetworkVersion = parsed.segmentNetworkVersion;
    }
    const sets = Array.isArray(parsed.waterSurfacePolygonSets) ? parsed.waterSurfacePolygonSets : [];
    const flowlineBbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const segments: FlowlineIndexSegment[] = [];
    for (const set of sets as { segmentId?: unknown; elevationBuckets?: unknown }[]) {
      if (typeof set.segmentId !== 'string') continue;
      const segmentBbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
      const buckets = Array.isArray(set.elevationBuckets) ? set.elevationBuckets : [];
      for (const bucket of buckets as { ringsWgs84?: unknown }[]) {
        const rings = Array.isArray(bucket.ringsWgs84) ? bucket.ringsWgs84 : [];
        for (const ring of rings as unknown[][]) {
          for (const point of ring as unknown[]) {
            if (!Array.isArray(point) || point.length < 2) continue;
            const [lon, lat] = point as [number, number];
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
            growBbox(segmentBbox, lon, lat);
          }
        }
      }
      const hasExtent = Number.isFinite(segmentBbox[0]);
      if (hasExtent) {
        growBbox(flowlineBbox, segmentBbox[0], segmentBbox[1]);
        growBbox(flowlineBbox, segmentBbox[2], segmentBbox[3]);
      }
      segments.push({
        segmentId: set.segmentId,
        centerWgs84: hasExtent
          ? [(segmentBbox[0] + segmentBbox[2]) / 2, (segmentBbox[1] + segmentBbox[3]) / 2]
          : null,
      });
    }
    if (!Number.isFinite(flowlineBbox[0])) continue;
    flowlines.push({
      tncComid: name.replace(/\.json$/, ''),
      bboxWgs84: flowlineBbox,
      segments,
    });
  }
  return { segmentNetworkVersion, flowlines };
}

function growBbox(bbox: Bbox, lon: number, lat: number): void {
  if (lon < bbox[0]) bbox[0] = lon;
  if (lat < bbox[1]) bbox[1] = lat;
  if (lon > bbox[2]) bbox[2] = lon;
  if (lat > bbox[3]) bbox[3] = lat;
}

/**
 * Creek Segment flowline paths, ordered upstream to downstream, cut from the
 * extent's TNC flowline snapshot with the pipeline's own segmentation and
 * oriented by Stage 1's rule. Rebuilt when either input file changes. Null
 * when the snapshot or the Stage 1 file is not there yet (the browser then
 * draws flat water).
 */
async function loadSegmentPaths(extent: string, extentRoot: string): Promise<CachedIndex | null> {
  const snapshotPath = flowlineSnapshotPathFor(extent);
  const crossSectionsPath = path.join(extentRoot, CROSS_SECTIONS_FILE);
  let fingerprint: string;
  try {
    const stats = await Promise.all([stat(snapshotPath), stat(crossSectionsPath)]);
    fingerprint = stats.map((item) => `${item.size}:${item.mtimeMs}`).join('|');
  } catch {
    return null;
  }
  const cached = segmentPathsCache.get(extent);
  if (cached) {
    const resolved = await cached.catch(() => null);
    if (resolved && resolved.fingerprint === fingerprint) return resolved;
  }
  const building = buildSegmentPaths(snapshotPath, crossSectionsPath).then((file) => ({
    fingerprint,
    body: JSON.stringify(file),
  }));
  segmentPathsCache.set(extent, building);
  return building;
}

export async function buildSegmentPaths(snapshotPath: string, crossSectionsPath: string): Promise<SegmentPathsFile> {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
  const crossSections = JSON.parse(await readFile(crossSectionsPath, 'utf8')) as {
    segmentNetworkVersion?: unknown;
    segments?: unknown;
  };
  const directionByTncComid = downstreamVertexDirectionByTncComid(crossSections.segments);
  const creekSegments = segmentTncFlowlines(snapshot);
  const adjacentById = adjacentSegmentsById(creekSegments);
  const segments = creekSegments.map((segment) => {
    const runsDownstream = (directionByTncComid.get(String(segment.comid)) ?? 1) === 1;
    const pathWgs84 = segment.pathWgs84.map(([lon, lat]) => [lon, lat] as LonLat);
    const adjacent = adjacentById.get(segment.segmentId) ?? {};
    const atStart = adjacent.atStart?.segmentId ?? null;
    const atEnd = adjacent.atEnd?.segmentId ?? null;
    return {
      segmentId: segment.segmentId,
      pathWgs84: runsDownstream ? pathWgs84 : pathWgs84.reverse(),
      upstreamSegmentId: runsDownstream ? atStart : atEnd,
      downstreamSegmentId: runsDownstream ? atEnd : atStart,
    };
  });
  return {
    segmentNetworkVersion:
      typeof crossSections.segmentNetworkVersion === 'string' ? crossSections.segmentNetworkVersion : null,
    segments,
  };
}

/** `03-time-series/m1-drainage-area-ratio-manning-rating-curve/v<version>/time-series/…/<file>.json`. */
function isM1TimeSeriesFile(rest: readonly string[]): boolean {
  return (
    rest[0] === TIME_SERIES_STAGE_FOLDER &&
    rest[1] === M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD.id &&
    rest[3] === 'time-series' &&
    rest[rest.length - 1]?.endsWith('.json') === true
  );
}

/**
 * The m1 Time Series file with each segment's WSE Anchor Point bed added as
 * `anchorBedElevationM` (see the header). A bed the file already carries is
 * kept. Null when the file or Stage 1 output is missing, so the caller answers 404.
 */
async function m1TimeSeriesWithAnchorBeds(extentRoot: string, rest: readonly string[]): Promise<string | null> {
  const beds = await loadStageOneBeds(extentRoot);
  if (!beds) return null;
  let file: { segments?: unknown };
  try {
    file = JSON.parse(await readFile(path.join(extentRoot, ...rest), 'utf8')) as { segments?: unknown };
  } catch {
    return null;
  }
  for (const segment of (Array.isArray(file.segments) ? file.segments : []) as Record<string, unknown>[]) {
    const existing = segment.anchorBedElevationM;
    if (typeof existing === 'number' && Number.isFinite(existing)) continue;
    const bedM = beds.get(String(segment.segmentId));
    if (bedM !== undefined) segment.anchorBedElevationM = bedM;
  }
  return JSON.stringify(file);
}

/** Stage 1's representative bed per Creek Segment, rebuilt when `cross-sections.json` changes. */
async function loadStageOneBeds(extentRoot: string): Promise<Map<string, number> | null> {
  const crossSectionsPath = path.join(extentRoot, CROSS_SECTIONS_FILE);
  let fingerprint: string;
  try {
    const fileStat = await stat(crossSectionsPath);
    fingerprint = `${fileStat.size}:${fileStat.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = await stageOneBedsCache.get(extentRoot)?.catch(() => null);
  if (cached && cached.fingerprint === fingerprint) return cached.bedElevationMBySegmentId;
  const building = readFile(crossSectionsPath, 'utf8').then((text) => {
    const crossSections = JSON.parse(text) as { segments?: unknown };
    const bedElevationMBySegmentId = new Map<string, number>();
    for (const record of (Array.isArray(crossSections.segments) ? crossSections.segments : []) as {
      segmentId?: unknown;
      bedElevationM?: unknown;
    }[]) {
      const bedM = record.bedElevationM;
      if (typeof record.segmentId === 'string' && typeof bedM === 'number' && Number.isFinite(bedM)) {
        bedElevationMBySegmentId.set(record.segmentId, bedM);
      }
    }
    return { fingerprint, bedElevationMBySegmentId };
  });
  stageOneBedsCache.set(extentRoot, building);
  return (await building).bedElevationMBySegmentId;
}

/**
 * Stage 1's orientation rule, same as `downstreamVertexDirection` in the
 * pipeline's stage-file-formats.ts: a TNC flowline's vertex order runs
 * downstream (+1) when its first sampled bed is at or above its last, else −1.
 * Stage 1 records are in vertex order; a flowline with no sampled beds gets +1.
 */
function downstreamVertexDirectionByTncComid(records: unknown): Map<string, 1 | -1> {
  const bedsByTncComid = new Map<string, number[]>();
  for (const record of (Array.isArray(records) ? records : []) as { segmentId?: unknown; sections?: unknown }[]) {
    if (typeof record.segmentId !== 'string') continue;
    const tncComid = record.segmentId.split('-')[0];
    const beds = bedsByTncComid.get(tncComid) ?? [];
    for (const section of (Array.isArray(record.sections) ? record.sections : []) as { bedElevationM?: unknown }[]) {
      if (typeof section.bedElevationM === 'number') beds.push(section.bedElevationM);
    }
    bedsByTncComid.set(tncComid, beds);
  }
  const directions = new Map<string, 1 | -1>();
  for (const [tncComid, beds] of bedsByTncComid) {
    const first = beds[0] ?? 0;
    const last = beds[beds.length - 1] ?? 0;
    directions.set(tncComid, first - last >= 0 ? 1 : -1);
  }
  return directions;
}
