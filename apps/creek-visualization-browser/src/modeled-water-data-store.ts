// Lazy, cached loading of per-TNC-flowline modeled files: prepared water-surface
// polygon sets and water-surface elevation Time Series. Only flowlines the
// caller marks as needed are fetched; for hourly Datasets only the water year
// holding the selected time is fetched. Least-recently-needed flowlines are
// evicted once the cache passes its cap so the preserve never loads whole.

import {
  PublishedCreekDataError,
  type ElevationBucket,
  type LonLat,
  type LonLatRing,
} from './creek-data-contract';
import { modeledDataUrl, waterYearOf, type CatalogTimeSeries } from './modeled-water-catalog';
import type { JunctionWaterSurface, SegmentFlowlinePath } from './sloped-water-surface';

/** Flowlines kept in memory before least-recently-needed ones are dropped. */
const MAX_CACHED_FLOWLINES = 24;
/** Parallel fetches. The preserve's largest polygon file is ~13 MB. */
const MAX_PARALLEL_FETCHES = 4;
const POLYGON_SETS_PATH = '04-water-surface-polygons/water-surface-polygon-sets';
const TIME_SERIES_ROOT = '03-time-series';

export interface FlowlineIndexSegment {
  segmentId: string;
  centerWgs84: readonly [number, number] | null;
}

export interface FlowlineIndexEntry {
  tncComid: string;
  bboxWgs84: readonly [number, number, number, number];
  segments: readonly FlowlineIndexSegment[];
}

export interface FlowlineIndex {
  segmentNetworkVersion: string | null;
  flowlines: readonly FlowlineIndexEntry[];
}

export interface LoadedTimeSeries {
  timestampsUtcMs: readonly number[];
  valuesBySegmentId: ReadonlyMap<string, readonly (number | null)[]>;
  /**
   * Water-surface elevation at each segment's upstream and downstream junction,
   * parallel to `values` (optional fields `junctionWseUpstreamM` /
   * `junctionWseDownstreamM`). A segment is absent when its file lacks them.
   */
  junctionUpstreamBySegmentId: ReadonlyMap<string, readonly (number | null)[]>;
  junctionDownstreamBySegmentId: ReadonlyMap<string, readonly (number | null)[]>;
  /** Creek Segments flagged `drainageAreaRatioTransfer` by the pipeline (optional field). */
  transferSegmentIds: ReadonlySet<string>;
  /** Per-segment drainage-area ratio, when the pipeline writes it on the segment (optional field). */
  drainageAreaRatioBySegmentId: ReadonlyMap<string, number>;
}

export interface LoadedFlowline {
  tncComid: string;
  polygonBucketsBySegmentId: ReadonlyMap<string, readonly ElevationBucket[]>;
  /** Keyed by water year for hourly Datasets, or `all` for one-file Datasets. */
  seriesByKey: Map<string, LoadedTimeSeries>;
}

export interface ModeledWaterDataStoreOptions {
  extentId: string;
  timeSeries: CatalogTimeSeries;
  /** `hourly` Datasets split each flowline into WY<year>.json files. */
  timeStep: string;
  /** Called whenever a fetch lands so the caller can re-resolve the frame. */
  onChange: () => void;
}

export interface ModeledWaterDataStore {
  /** Marks the flowlines needed for the selected time; starts missing fetches. */
  setNeeded(tncComids: readonly string[], timeUtcMs: number): void;
  loadedFlowline(tncComid: string): LoadedFlowline | null;
  /** Time Series file covering the selected time for a flowline, when fetched. */
  seriesAt(tncComid: string, timeUtcMs: number): LoadedTimeSeries | null;
  readonly loadedFlowlineComids: readonly string[];
  readonly isLoading: boolean;
  /** Resolves once no fetch is in flight. */
  whenIdle(): Promise<void>;
  /** Last fetch failure message, or null. Shown in the status line. */
  readonly lastError: string | null;
}

export function createModeledWaterDataStore(
  options: ModeledWaterDataStoreOptions,
): ModeledWaterDataStore {
  const pathByKey = timeSeriesPathsByKey(options.timeSeries, options.timeStep);
  const cache = new Map<string, LoadedFlowline>();
  const lastNeededAt = new Map<string, number>();
  const inFlight = new Set<string>();
  const idleResolvers: (() => void)[] = [];
  let lastError: string | null = null;
  let neededComids: readonly string[] = [];
  const queue: (() => Promise<void>)[] = [];
  let running = 0;

  const seriesKeyFor = (timeUtcMs: number): string =>
    options.timeStep === 'hourly' ? `WY${waterYearOf(timeUtcMs)}` : 'all';

  const settle = (): void => {
    if (inFlight.size > 0 || queue.length > 0 || running > 0) return;
    for (const resolve of idleResolvers.splice(0)) resolve();
  };

  const pump = (): void => {
    while (running < MAX_PARALLEL_FETCHES && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      running += 1;
      void job().finally(() => {
        running -= 1;
        pump();
        settle();
      });
    }
  };

  const enqueue = (key: string, job: () => Promise<void>): void => {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    queue.push(async () => {
      try {
        await job();
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(error);
      } finally {
        inFlight.delete(key);
        options.onChange();
      }
    });
    pump();
  };

  const ensureSeries = (flowline: LoadedFlowline, seriesKey: string): void => {
    if (flowline.seriesByKey.has(seriesKey)) return;
    const relative = pathByKey.get(`${flowline.tncComid}/${seriesKey}`);
    if (!relative) return; // No Time Series for this flowline and time; nothing to show.
    enqueue(`series:${flowline.tncComid}/${seriesKey}`, async () => {
      const file = await fetchJson(modeledDataUrl(options.extentId, `${TIME_SERIES_ROOT}/${relative}`));
      flowline.seriesByKey.set(seriesKey, readTimeSeriesFile(file));
      // Keep only the current water year plus one neighbour per flowline.
      for (const key of [...flowline.seriesByKey.keys()]) {
        if (flowline.seriesByKey.size <= 2) break;
        if (key !== seriesKey) flowline.seriesByKey.delete(key);
      }
    });
  };

  const evict = (): void => {
    if (cache.size <= MAX_CACHED_FLOWLINES) return;
    const needed = new Set(neededComids);
    const candidates = [...cache.keys()]
      .filter((comid) => !needed.has(comid))
      .sort((a, b) => (lastNeededAt.get(a) ?? 0) - (lastNeededAt.get(b) ?? 0));
    for (const comid of candidates) {
      if (cache.size <= MAX_CACHED_FLOWLINES) break;
      cache.delete(comid);
      lastNeededAt.delete(comid);
    }
  };

  return {
    setNeeded(tncComids, timeUtcMs) {
      neededComids = [...tncComids];
      const seriesKey = seriesKeyFor(timeUtcMs);
      const now = performance.now();
      for (const comid of tncComids) {
        lastNeededAt.set(comid, now);
        const loaded = cache.get(comid);
        if (loaded) {
          ensureSeries(loaded, seriesKey);
          continue;
        }
        enqueue(`polygons:${comid}`, async () => {
          const file = await fetchJson(
            modeledDataUrl(options.extentId, `${POLYGON_SETS_PATH}/${comid}.json`),
          );
          const flowline: LoadedFlowline = {
            tncComid: comid,
            polygonBucketsBySegmentId: readPolygonSetFile(file),
            seriesByKey: new Map(),
          };
          cache.set(comid, flowline);
          ensureSeries(flowline, seriesKeyFor(timeUtcMs));
        });
      }
      evict();
    },
    loadedFlowline(tncComid) {
      return cache.get(tncComid) ?? null;
    },
    seriesAt(tncComid, timeUtcMs) {
      return cache.get(tncComid)?.seriesByKey.get(seriesKeyFor(timeUtcMs)) ?? null;
    },
    get loadedFlowlineComids() {
      return [...cache.keys()];
    },
    get isLoading() {
      return inFlight.size > 0;
    },
    whenIdle() {
      if (inFlight.size === 0 && queue.length === 0 && running === 0) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
    get lastError() {
      return lastError;
    },
  };
}

/**
 * Maps `<tncComid>/<seriesKey>` to a catalog path. Hourly paths end in
 * `<comid>/WY<year>.json`; one-file Datasets end in `<comid>.json`.
 */
function timeSeriesPathsByKey(timeSeries: CatalogTimeSeries, timeStep: string): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const path of timeSeries.paths) {
    const hourly = /\/(\d+)\/WY(\d{4})\.json$/.exec(path);
    if (hourly && timeStep === 'hourly') {
      byKey.set(`${hourly[1]}/WY${hourly[2]}`, path);
      continue;
    }
    const single = /\/(\d+)\.json$/.exec(path);
    if (single) byKey.set(`${single[1]}/all`, path);
  }
  return byKey;
}

export async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new PublishedCreekDataError(`Could not reach ${url}.`);
  }
  if (!response.ok) {
    throw new PublishedCreekDataError(`Could not load ${url} (${response.status}).`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new PublishedCreekDataError(`${url} is not valid JSON.`);
  }
}

export function readFlowlineIndex(value: unknown): FlowlineIndex {
  const record = asRecord(value, 'flowline index');
  const flowlines = asArray(record.flowlines, 'flowline index').map((item, index) => {
    const entry = asRecord(item, `flowline ${index + 1}`);
    const bbox = asArray(entry.bboxWgs84, `flowline ${index + 1} bbox`);
    if (bbox.length < 4 || bbox.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      fail(`flowline ${index + 1} bbox must hold four numbers.`);
    }
    const segments = asArray(entry.segments, `flowline ${index + 1} segments`).map((seg) => {
      const segment = asRecord(seg, 'flowline segment');
      const center = Array.isArray(segment.centerWgs84) ? segment.centerWgs84 : null;
      return {
        segmentId: String(segment.segmentId),
        centerWgs84:
          center && typeof center[0] === 'number' && typeof center[1] === 'number'
            ? ([center[0], center[1]] as const)
            : null,
      };
    });
    return {
      tncComid: String(entry.tncComid),
      bboxWgs84: [bbox[0], bbox[1], bbox[2], bbox[3]] as [number, number, number, number],
      segments,
    };
  });
  return {
    segmentNetworkVersion:
      typeof record.segmentNetworkVersion === 'string' ? record.segmentNetworkVersion : null,
    flowlines,
  };
}

/** Same bucket shape as the published file; light validation keeps big files fast. */
function readPolygonSetFile(value: unknown): Map<string, readonly ElevationBucket[]> {
  const record = asRecord(value, 'water-surface polygon set file');
  const sets = asArray(record.waterSurfacePolygonSets, 'waterSurfacePolygonSets');
  const bySegment = new Map<string, readonly ElevationBucket[]>();
  for (const item of sets) {
    const set = asRecord(item, 'polygon set');
    const segmentId = String(set.segmentId);
    const buckets = asArray(set.elevationBuckets, `${segmentId} buckets`).map((entry) => {
      const bucket = asRecord(entry, `${segmentId} bucket`);
      const min = bucket.minWaterSurfaceElevationM;
      const max = bucket.maxWaterSurfaceElevationM;
      if (typeof min !== 'number' || typeof max !== 'number') {
        fail(`${segmentId} has a bucket without numeric bounds.`);
      }
      return {
        minWaterSurfaceElevationM: min,
        maxWaterSurfaceElevationM: max,
        ringsWgs84: (Array.isArray(bucket.ringsWgs84) ? bucket.ringsWgs84 : []) as LonLatRing[],
      };
    });
    bySegment.set(segmentId, buckets);
  }
  return bySegment;
}

function readTimeSeriesFile(value: unknown): LoadedTimeSeries {
  const record = asRecord(value, 'time series file');
  const timestampsUtcMs = asArray(record.timestampsUtcMs, 'timestampsUtcMs') as number[];
  const valuesBySegmentId = new Map<string, readonly (number | null)[]>();
  const junctionUpstreamBySegmentId = new Map<string, readonly (number | null)[]>();
  const junctionDownstreamBySegmentId = new Map<string, readonly (number | null)[]>();
  const transferSegmentIds = new Set<string>();
  const drainageAreaRatioBySegmentId = new Map<string, number>();
  for (const item of asArray(record.segments, 'time series segments')) {
    const segment = asRecord(item, 'time series segment');
    const segmentId = String(segment.segmentId);
    const values = Array.isArray(segment.values) ? (segment.values as (number | null)[]) : null;
    if (!values || values.length !== timestampsUtcMs.length) {
      fail(`Modeled values for ${segmentId} do not line up with the timestamps.`);
    }
    valuesBySegmentId.set(segmentId, values);
    // Junction fields are optional; an older file or a mismatched length means flat water.
    const upstream = segment.junctionWseUpstreamM;
    const downstream = segment.junctionWseDownstreamM;
    if (
      Array.isArray(upstream) &&
      Array.isArray(downstream) &&
      upstream.length === values.length &&
      downstream.length === values.length
    ) {
      junctionUpstreamBySegmentId.set(segmentId, upstream as (number | null)[]);
      junctionDownstreamBySegmentId.set(segmentId, downstream as (number | null)[]);
    }
    if (segment.drainageAreaRatioTransfer === true) transferSegmentIds.add(segmentId);
    if (typeof segment.drainageAreaRatio === 'number' && Number.isFinite(segment.drainageAreaRatio)) {
      drainageAreaRatioBySegmentId.set(segmentId, segment.drainageAreaRatio);
    }
  }
  return {
    timestampsUtcMs,
    valuesBySegmentId,
    junctionUpstreamBySegmentId,
    junctionDownstreamBySegmentId,
    transferSegmentIds,
    drainageAreaRatioBySegmentId,
  };
}

/**
 * Creek Segment flowline paths computed by the dev middleware
 * (`creek-segment-paths.json`): each segment's vertices ordered upstream to
 * downstream. Segments without a usable path are left out.
 */
export function readCreekSegmentPaths(value: unknown): Map<string, SegmentFlowlinePath> {
  const record = asRecord(value, 'creek segment paths');
  const byId = new Map<string, SegmentFlowlinePath>();
  for (const item of asArray(record.segments, 'creek segment paths')) {
    const segment = asRecord(item, 'creek segment path');
    const raw = Array.isArray(segment.pathWgs84) ? segment.pathWgs84 : [];
    const path: LonLat[] = [];
    for (const point of raw) {
      if (Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number') {
        path.push([point[0], point[1]]);
      }
    }
    if (path.length >= 2) byId.set(String(segment.segmentId), path);
  }
  return byId;
}

/**
 * Hold rule: the latest value at or before the selected time, held for at most
 * `holdMs`. Returns null beyond the hold, before the first value, or for a null value.
 */
export function heldValueAt(
  series: LoadedTimeSeries,
  segmentId: string,
  timeUtcMs: number,
  holdMs: number,
): number | null {
  const index = heldIndexAt(series, timeUtcMs, holdMs);
  if (index < 0) return null;
  return finiteOrNull(series.valuesBySegmentId.get(segmentId)?.[index]);
}

/**
 * The junction water-surface elevations held at the selected time, under the
 * same hold rule as `heldValueAt`. Null when the file has no junction fields
 * for the segment or either end is null, so the caller draws flat water.
 */
export function heldJunctionWaterSurfaceAt(
  series: LoadedTimeSeries,
  segmentId: string,
  timeUtcMs: number,
  holdMs: number,
): JunctionWaterSurface | null {
  const index = heldIndexAt(series, timeUtcMs, holdMs);
  if (index < 0) return null;
  const upstreamM = finiteOrNull(series.junctionUpstreamBySegmentId.get(segmentId)?.[index]);
  const downstreamM = finiteOrNull(series.junctionDownstreamBySegmentId.get(segmentId)?.[index]);
  if (upstreamM === null || downstreamM === null) return null;
  return { upstreamM, downstreamM };
}

/** Index of the value held at the selected time, or -1 beyond the hold or before the first value. */
function heldIndexAt(series: LoadedTimeSeries, timeUtcMs: number, holdMs: number): number {
  const index = latestIndexAtOrBefore(series.timestampsUtcMs, timeUtcMs);
  if (index < 0) return -1;
  return timeUtcMs - series.timestampsUtcMs[index] > holdMs ? -1 : index;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function latestIndexAtOrBefore(timestamps: readonly number[], timeUtcMs: number): number {
  let low = 0;
  let high = timestamps.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timestamps[mid] <= timeUtcMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be a list.`);
  return value;
}

function fail(message: string): never {
  throw new PublishedCreekDataError(message);
}
