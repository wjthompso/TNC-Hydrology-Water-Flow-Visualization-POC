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
// WSE Polygon Generation Methods: `wse-polygon-methods.json` lists every saved
// method version of the extent (read from each version's Stage 4 manifest),
// and each version folder gets its own computed flowline index at
// `04-water-surface-polygons/<method-id>/v<version>/flowline-index.json`. The
// extent-level `flowline-index.json` is the default method's newest version.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { adjacentSegmentsById } from '../../../pipelines/creek-visualization-data-production/creek-segment-adjacency.ts';
import { segmentTncFlowlines } from '../../../pipelines/creek-visualization-data-production/tnc-flowline-segmentation.ts';
import { listSavedWsePolygonMethodVersions } from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/wse-polygon-generation-methods/wse-polygon-generation-method-outputs.ts';
import { DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID } from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/wse-polygon-generation-methods/wse-polygon-generation-method-registry.ts';

export const MODELED_WATER_DATA_URL_PREFIX = '/modeled-water-surface-elevation-data/';
const FLOWLINE_INDEX_FILE = 'flowline-index.json';
const SEGMENT_PATHS_FILE = 'creek-segment-paths.json';
const WSE_POLYGON_METHODS_FILE = 'wse-polygon-methods.json';
/** Served from the tracked reviewed-assignments folder, not from the pipeline output. */
const REACH_CROSSWALK_FILE = 'reach-crosswalk.json';
const WATER_SURFACE_POLYGONS_STAGE_FOLDER = '04-water-surface-polygons';
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

const indexCache = new Map<string, Promise<CachedIndex>>();
const segmentPathsCache = new Map<string, Promise<CachedIndex>>();

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
}

/** Every saved WSE Polygon Generation Method version of the extent, read from the Stage 4 manifests on each request. */
async function listWsePolygonMethods(
  extentRoot: string,
): Promise<{ defaultMethodId: string; versions: WsePolygonMethodListEntry[] }> {
  const saved = await listSavedWsePolygonMethodVersions(path.join(extentRoot, WATER_SURFACE_POLYGONS_STAGE_FOLDER));
  return {
    defaultMethodId: DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID,
    versions: saved.map((entry) => ({
      methodId: entry.methodId,
      version: entry.version,
      label: entry.method.label,
      description: entry.method.description,
      browserDrawing: entry.method.browserDrawing,
      path: `${WATER_SURFACE_POLYGONS_STAGE_FOLDER}/${entry.relativePath}`,
    })),
  };
}

/**
 * The method version folder a flowline-index request names: the extent root
 * means the default method's newest version; otherwise the request must be
 * `04-water-surface-polygons/<method-id>/v<version>/flowline-index.json` for a saved version.
 */
async function flowlineIndexMethodFolder(extentRoot: string, folderParts: string[]): Promise<string | null> {
  const { defaultMethodId, versions } = await listWsePolygonMethods(extentRoot);
  const requested =
    folderParts.length === 0
      ? versions.filter((entry) => entry.methodId === defaultMethodId).at(-1)
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
