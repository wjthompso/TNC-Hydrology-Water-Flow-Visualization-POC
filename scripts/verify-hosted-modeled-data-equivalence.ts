/**
 * Verifies that the browser's hosted ArcGIS adapters rebuild the same modeled data as the local
 * pipeline working output (data/pipeline-working-output/dangermond-preserve/), against the LIVE
 * published feature services. Read-only: only `/query` and layer-metadata requests are sent.
 *
 *   npm run data-products:verify-hosted-modeled-data
 *
 * A short-lived portal token comes from print_portal_token_for_child_process.py (credentials via
 * dotenv, `ARCGIS_DOTENV_PATH`, default ../../Data-Pipeline/.env). The token stays in this
 * process's memory: it is never printed, logged, or written to disk.
 *
 * Exits nonzero when a Time Series or polygon-set comparison has a mismatch. Network-derived
 * files (reach crosswalk, segment paths) are reported; flowline-index differences are expected
 * (hosted bounding boxes come from flowline paths, local ones from prepared polygons).
 */

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildFlowlineIndex,
  buildSegmentPaths,
} from '../apps/creek-visualization-browser/vite-plugins/modeled-water-data-plugin.ts';
import {
  creekDataSourceConfiguration,
} from '../apps/creek-visualization-browser/src/creek-data-source-configuration.ts';
import type { HostedAdapterOptions } from '../apps/creek-visualization-browser/src/hosted-adapter-options.ts';
import {
  buildCreekSegmentPathsFile,
  buildFlowlineIndexFile,
  buildReachCrosswalkFile,
  loadHostedCreekSegmentNetwork,
} from '../apps/creek-visualization-browser/src/hosted-creek-segment-network.ts';
import type { FetchImplementation } from '../apps/creek-visualization-browser/src/hosted-feature-service-query.ts';
import {
  buildHostedModeledCatalog,
  loadHostedModeledWseVersion,
  loadHostedWsePolygonMethods,
  type HostedModeledDatasetId,
} from '../apps/creek-visualization-browser/src/hosted-modeled-catalog.ts';
import { loadHostedTimeSeriesForFlowline } from '../apps/creek-visualization-browser/src/hosted-modeled-water-surface-elevation.ts';
import { loadHostedWaterSurfacePolygonsForFlowline } from '../apps/creek-visualization-browser/src/hosted-water-surface-polygons.ts';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENT_ROOT = path.join(REPOSITORY_ROOT, 'data/pipeline-working-output/dangermond-preserve');
// The local Time Series come from the modeled WSE version the hosted service was published from (m1-v1).
const TIME_SERIES_ROOT = path.join(
  EXTENT_ROOT,
  '03-time-series/m1-drainage-area-ratio-manning-rating-curve/v1/time-series',
);
const POLYGON_METHOD_FOLDER = path.join(EXTENT_ROOT, '04-water-surface-polygons/junction-sloped-terrain-fill/v1');
const POLYGON_METHOD_KEY = 'junction-sloped-terrain-fill@v1';
const REACH_CROSSWALK_PATH = path.join(
  REPOSITORY_ROOT,
  'data/source-inputs/reviewed-assignments/nhdplusv2-reach-crosswalk-dangermond-preserve.json',
);
const FLOWLINE_SNAPSHOT_PATH = path.join(REPOSITORY_ROOT, 'data/source-inputs/tnc-flowlines-dangermond-preserve.json');
const CROSS_SECTIONS_PATH = path.join(EXTENT_ROOT, '01-cross-sections/cross-sections.json');
const TOKEN_HELPER_PATH = path.join(
  REPOSITORY_ROOT,
  'pipelines/creek-visualization-data-production/arcgis-publishing/print_portal_token_for_child_process.py',
);
const CONDA_ENVIRONMENT = process.env.ARCGIS_PYTHON_ENV ?? path.resolve(REPOSITORY_ROOT, '../../Data-Pipeline/conda-env');

const HOURLY_FLOWLINES = ['27714637', '27715677'];
const HOURLY_WATER_YEARS = [2023, 2021];
const MONTHLY_FLOWLINE = '27714637';
const POLYGON_FLOWLINE = '27714637';
const COORDINATE_TOLERANCE_DEG = 1e-7;
const MAX_LISTED_MISMATCHES = 8;

type LonLat = [number, number];

// ---------------------------------------------------------------------------
// Request accounting

const requestStats = { requests: 0, rows: 0 };

/** Plain fetch that counts requests and returned rows (features). Never logs request bodies. */
const countingFetch: FetchImplementation = async (url, init) => {
  requestStats.requests += 1;
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    async json() {
      const body = (await response.json()) as { features?: unknown[] };
      if (Array.isArray(body.features)) requestStats.rows += body.features.length;
      return body;
    },
  };
};

// ---------------------------------------------------------------------------
// Comparison results

interface ComparisonResult {
  name: string;
  checked: number;
  mismatches: string[];
  mismatchCount: number;
  seconds: number;
  requests: number;
  rows: number;
  notes: string[];
  /** False for informational comparisons that never fail the run. */
  required: boolean;
}

const results: ComparisonResult[] = [];

async function runComparison(
  name: string,
  required: boolean,
  compare: (result: ComparisonResult) => Promise<void>,
): Promise<void> {
  const result: ComparisonResult = {
    name,
    checked: 0,
    mismatches: [],
    mismatchCount: 0,
    seconds: 0,
    requests: 0,
    rows: 0,
    notes: [],
    required,
  };
  const startRequests = requestStats.requests;
  const startRows = requestStats.rows;
  const startedAt = performance.now();
  try {
    await compare(result);
  } catch (error) {
    recordMismatch(result, `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  result.seconds = (performance.now() - startedAt) / 1000;
  result.requests = requestStats.requests - startRequests;
  result.rows = requestStats.rows - startRows;
  results.push(result);
  printResult(result);
}

function recordMismatch(result: ComparisonResult, message: string): void {
  result.mismatchCount += 1;
  if (result.mismatches.length < MAX_LISTED_MISMATCHES) result.mismatches.push(message);
}

function printResult(result: ComparisonResult): void {
  const status = result.mismatchCount === 0 ? 'OK  ' : result.required ? 'FAIL' : 'DIFF';
  process.stdout.write(
    `${status} ${result.name}: ${result.checked} checked, ${result.mismatchCount} mismatches; ` +
      `${result.requests} requests, ${result.rows} rows, ${result.seconds.toFixed(1)} s\n`,
  );
  for (const note of result.notes) process.stdout.write(`       note: ${note}\n`);
  for (const mismatch of result.mismatches) process.stdout.write(`       - ${mismatch}\n`);
}

// ---------------------------------------------------------------------------
// Token (kept in memory only)

async function obtainPortalToken(): Promise<string> {
  const child = spawn(
    'conda',
    ['run', '--no-capture-output', '-p', CONDA_ENVIRONMENT, 'python', TOKEN_HELPER_PATH],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const token = Buffer.concat(chunks).toString('utf8').trim();
  if (exitCode !== 0 || !/^[A-Za-z0-9._\-~+/=]+$/.test(token)) {
    // Never echo the captured output: it may hold a token.
    throw new Error(`The token helper failed (exit code ${exitCode}); see its message above.`);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Local files

async function readJsonFile<Value>(filePath: string): Promise<Value> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Value;
}

interface TimeSeriesFileLike {
  segmentNetworkVersion: string;
  datasetId: string;
  variableId: string;
  timestampsUtcMs: number[];
  segments: {
    segmentId: string;
    values: (number | null)[];
    junctionWseUpstreamM?: (number | null)[];
    junctionWseDownstreamM?: (number | null)[];
    drainageAreaRatioTransfer?: boolean;
  }[];
}

interface PolygonSetsFileLike {
  segmentNetworkVersion: string;
  waterSurfacePolygonSets: {
    segmentId: string;
    elevationBuckets: { minWaterSurfaceElevationM: number; maxWaterSurfaceElevationM: number; ringsWgs84: LonLat[][] }[];
  }[];
}

// ---------------------------------------------------------------------------
// Comparators

function compareTimeSeries(result: ComparisonResult, label: string, local: TimeSeriesFileLike, hosted: TimeSeriesFileLike): void {
  for (const field of ['segmentNetworkVersion', 'datasetId', 'variableId'] as const) {
    if (local[field] !== hosted[field]) recordMismatch(result, `${label} ${field}: ${hosted[field]} ≠ ${local[field]}`);
  }
  compareArrays(result, `${label} timestamps`, local.timestampsUtcMs, hosted.timestampsUtcMs);
  const localOrder = local.segments.map((segment) => segment.segmentId).join(',');
  const hostedOrder = hosted.segments.map((segment) => segment.segmentId).join(',');
  if (localOrder !== hostedOrder) recordMismatch(result, `${label} segment order or set differs`);
  const hostedById = new Map(hosted.segments.map((segment) => [segment.segmentId, segment]));
  for (const localSegment of local.segments) {
    const hostedSegment = hostedById.get(localSegment.segmentId);
    if (!hostedSegment) {
      recordMismatch(result, `${label} ${localSegment.segmentId} missing from hosted`);
      continue;
    }
    compareArrays(result, `${label} ${localSegment.segmentId} values`, localSegment.values, hostedSegment.values);
    compareArrays(
      result,
      `${label} ${localSegment.segmentId} junctionWseUpstreamM`,
      localSegment.junctionWseUpstreamM ?? [],
      hostedSegment.junctionWseUpstreamM ?? [],
    );
    compareArrays(
      result,
      `${label} ${localSegment.segmentId} junctionWseDownstreamM`,
      localSegment.junctionWseDownstreamM ?? [],
      hostedSegment.junctionWseDownstreamM ?? [],
    );
    if ((localSegment.drainageAreaRatioTransfer === true) !== (hostedSegment.drainageAreaRatioTransfer === true)) {
      recordMismatch(result, `${label} ${localSegment.segmentId} drainageAreaRatioTransfer differs`);
    }
    result.checked += 1;
  }
}

/** Exact comparison (null included); reports the first differing index. */
function compareArrays(
  result: ComparisonResult,
  label: string,
  local: readonly (number | null)[],
  hosted: readonly (number | null)[],
): void {
  if (local.length !== hosted.length) {
    recordMismatch(result, `${label}: length ${hosted.length} ≠ ${local.length}`);
    return;
  }
  let differing = 0;
  let firstIndex = -1;
  for (let index = 0; index < local.length; index += 1) {
    if (local[index] !== hosted[index]) {
      differing += 1;
      if (firstIndex < 0) firstIndex = index;
    }
  }
  if (differing > 0) {
    recordMismatch(
      result,
      `${label}: ${differing} differ, first at ${firstIndex} (hosted ${hosted[firstIndex]}, local ${local[firstIndex]})`,
    );
  }
}

interface RingMatchCounts {
  rings: number;
  rotated: number;
  reversed: number;
}

function comparePolygonSets(
  result: ComparisonResult,
  local: PolygonSetsFileLike,
  hosted: PolygonSetsFileLike,
  ringCounts: RingMatchCounts,
): void {
  if (local.segmentNetworkVersion !== hosted.segmentNetworkVersion) {
    recordMismatch(result, `segmentNetworkVersion ${hosted.segmentNetworkVersion} ≠ ${local.segmentNetworkVersion}`);
  }
  const localIds = local.waterSurfacePolygonSets.map((set) => set.segmentId).join(',');
  const hostedIds = hosted.waterSurfacePolygonSets.map((set) => set.segmentId).join(',');
  if (localIds !== hostedIds) recordMismatch(result, 'segment order or set differs');
  const hostedById = new Map(hosted.waterSurfacePolygonSets.map((set) => [set.segmentId, set]));
  for (const localSet of local.waterSurfacePolygonSets) {
    const hostedBuckets = hostedById.get(localSet.segmentId)?.elevationBuckets ?? [];
    const localBuckets = localSet.elevationBuckets.filter((bucket) => bucket.ringsWgs84.length > 0);
    if (localBuckets.length !== hostedBuckets.length) {
      recordMismatch(result, `${localSet.segmentId}: ${hostedBuckets.length} buckets ≠ ${localBuckets.length} non-empty`);
      continue;
    }
    localBuckets.forEach((localBucket, index) => {
      const hostedBucket = hostedBuckets[index];
      const label = `${localSet.segmentId} bucket ${index}`;
      if (
        localBucket.minWaterSurfaceElevationM !== hostedBucket.minWaterSurfaceElevationM ||
        localBucket.maxWaterSurfaceElevationM !== hostedBucket.maxWaterSurfaceElevationM
      ) {
        recordMismatch(
          result,
          `${label} bounds [${hostedBucket.minWaterSurfaceElevationM}, ${hostedBucket.maxWaterSurfaceElevationM}) ≠ ` +
            `[${localBucket.minWaterSurfaceElevationM}, ${localBucket.maxWaterSurfaceElevationM})`,
        );
      }
      compareRingSets(result, label, localBucket.ringsWgs84, hostedBucket.ringsWgs84, ringCounts);
      result.checked += 1;
    });
  }
}

/** Rings as sets: each local ring must match one unused hosted ring (rotation allowed, counted). */
function compareRingSets(
  result: ComparisonResult,
  label: string,
  localRings: readonly LonLat[][],
  hostedRings: readonly LonLat[][],
  ringCounts: RingMatchCounts,
): void {
  if (localRings.length !== hostedRings.length) {
    recordMismatch(result, `${label}: ${hostedRings.length} rings ≠ ${localRings.length}`);
    return;
  }
  const unused = new Set(hostedRings.map((_, index) => index));
  for (const localRing of localRings) {
    ringCounts.rings += 1;
    let matched: 'same' | 'rotated' | 'reversed' | null = null;
    for (const index of unused) {
      matched = ringMatch(localRing, hostedRings[index]);
      if (matched) {
        unused.delete(index);
        break;
      }
    }
    if (matched === 'rotated') ringCounts.rotated += 1;
    if (matched === 'reversed') ringCounts.reversed += 1;
    if (!matched || matched === 'reversed') {
      recordMismatch(result, `${label}: a ${localRing.length}-vertex ring has no ${matched ? 'same-direction' : ''} hosted match`);
    }
  }
}

function ringMatch(localRing: readonly LonLat[], hostedRing: readonly LonLat[]): 'same' | 'rotated' | 'reversed' | null {
  if (localRing.length !== hostedRing.length) return null;
  if (localRing.every((point, index) => pointsClose(point, hostedRing[index]))) return 'same';
  const localOpen = openRing(localRing);
  const hostedOpen = openRing(hostedRing);
  if (localOpen.length !== hostedOpen.length) return null;
  if (cyclicMatch(localOpen, hostedOpen)) return 'rotated';
  if (cyclicMatch(localOpen, [...hostedOpen].reverse())) return 'reversed';
  return null;
}

function openRing(ring: readonly LonLat[]): LonLat[] {
  const closed = ring.length > 1 && pointsClose(ring[0], ring[ring.length - 1]);
  return closed ? ring.slice(0, -1) : [...ring];
}

function cyclicMatch(a: readonly LonLat[], b: readonly LonLat[]): boolean {
  const count = a.length;
  for (let offset = 0; offset < count; offset += 1) {
    if (!pointsClose(a[0], b[offset])) continue;
    let all = true;
    for (let index = 0; index < count && all; index += 1) all = pointsClose(a[index], b[(index + offset) % count]);
    if (all) return true;
  }
  return false;
}

function pointsClose(a: readonly number[], b: readonly number[]): boolean {
  return Math.abs(a[0] - b[0]) <= COORDINATE_TOLERANCE_DEG && Math.abs(a[1] - b[1]) <= COORDINATE_TOLERANCE_DEG;
}

// ---------------------------------------------------------------------------
// Main

const totalStartedAt = performance.now();
const configuration = creekDataSourceConfiguration;
process.stdout.write(
  `Hosted modeled data equivalence check\n  modeled WSE: ${configuration.modeledWseServiceUrl}\n` +
    `  WSE polygons: ${configuration.wsePolygonsServiceUrl}\n  local: ${path.relative(REPOSITORY_ROOT, EXTENT_ROOT)}\n`,
);

const token = await obtainPortalToken();
process.stdout.write('Portal token obtained (kept in memory).\n');
const adapterOptions: HostedAdapterOptions = { token, fetchImplementation: countingFetch };

const setupStartedAt = performance.now();
const version = await loadHostedModeledWseVersion({ modeledWseServiceUrl: configuration.modeledWseServiceUrl }, adapterOptions);
const polygonMethods = await loadHostedWsePolygonMethods({ wsePolygonsServiceUrl: configuration.wsePolygonsServiceUrl }, adapterOptions);
const network = await loadHostedCreekSegmentNetwork(
  {
    modeledWseServiceUrl: configuration.modeledWseServiceUrl,
    creekSegmentsLayerId: version.layerIds.creekSegments,
    segmentNetworkVersion: version.segmentNetworkVersion,
  },
  adapterOptions,
);
const catalog = buildHostedModeledCatalog(version, network, { showCaliforniaNaturalFlowsMonthly: true });
process.stdout.write(
  `Loaded ${version.versionLabel} (${version.segmentNetworkVersion}), layer ids ${JSON.stringify(version.layerIds)}; ` +
    `${network.segments.length} Creek Segments on ${network.segmentsByTncComid.size} flowlines; ` +
    `catalog datasets ${catalog.datasets.map((dataset) => dataset.datasetId).join(', ')}; ` +
    `polygon methods ${polygonMethods.methodList.versions.map((entry) => `${entry.methodId}@v${entry.version}`).join(', ')} ` +
    `in ${((performance.now() - setupStartedAt) / 1000).toFixed(1)} s, ${requestStats.requests} requests\n\n`,
);

for (const tncComid of HOURLY_FLOWLINES) {
  for (const waterYear of HOURLY_WATER_YEARS) {
    await runComparison(`NWM hourly ${tncComid} WY${waterYear}`, true, async (result) => {
      const local = await readJsonFile<TimeSeriesFileLike>(
        path.join(TIME_SERIES_ROOT, `national-water-model-hourly/water-surface-elevation/${tncComid}/WY${waterYear}.json`),
      );
      const hosted = await loadHostedTimeSeriesForFlowline(
        { version, network, datasetId: 'national-water-model-hourly', tncComid, waterYear },
        adapterOptions,
      );
      result.notes.push(`${hosted.segments.length} segments × ${hosted.timestampsUtcMs.length} timestamps`);
      compareTimeSeries(result, `WY${waterYear}`, local, hosted);
    });
  }
}

await runComparison(`CNF monthly ${MONTHLY_FLOWLINE}`, true, async (result) => {
  const datasetId: HostedModeledDatasetId = 'california-natural-flows-monthly';
  const local = await readJsonFile<TimeSeriesFileLike>(
    path.join(TIME_SERIES_ROOT, `${datasetId}/water-surface-elevation/${MONTHLY_FLOWLINE}.json`),
  );
  const hosted = await loadHostedTimeSeriesForFlowline({ version, network, datasetId, tncComid: MONTHLY_FLOWLINE }, adapterOptions);
  result.notes.push(`${hosted.segments.length} segments × ${hosted.timestampsUtcMs.length} months`);
  compareTimeSeries(result, 'monthly', local, hosted);
});

await runComparison(`Polygon sets ${POLYGON_FLOWLINE} (${POLYGON_METHOD_KEY})`, true, async (result) => {
  const polygonLayerId = polygonMethods.polygonLayerIdByMethodKey.get(POLYGON_METHOD_KEY);
  if (polygonLayerId === undefined) throw new Error(`No hosted polygon layer for ${POLYGON_METHOD_KEY}.`);
  const local = await readJsonFile<PolygonSetsFileLike>(
    path.join(POLYGON_METHOD_FOLDER, `water-surface-polygon-sets/${POLYGON_FLOWLINE}.json`),
  );
  const hosted = await loadHostedWaterSurfacePolygonsForFlowline(
    { wsePolygonsServiceUrl: configuration.wsePolygonsServiceUrl, polygonLayerId, network, tncComid: POLYGON_FLOWLINE },
    adapterOptions,
  );
  const ringCounts: RingMatchCounts = { rings: 0, rotated: 0, reversed: 0 };
  comparePolygonSets(result, local, hosted, ringCounts);
  result.notes.push(
    `${ringCounts.rings} rings: ${ringCounts.rotated} matched only after rotation, ${ringCounts.reversed} reversed`,
  );
});

await runComparison('Reach crosswalk (all Creek Segments)', true, async (result) => {
  const local = await readJsonFile<{ segments: Record<string, unknown>[] }>(REACH_CROSSWALK_PATH);
  const hostedById = new Map(buildReachCrosswalkFile(network).segments.map((segment) => [segment.segmentId, segment]));
  if (hostedById.size !== local.segments.length) {
    recordMismatch(result, `${hostedById.size} hosted segments ≠ ${local.segments.length} local`);
  }
  for (const entry of local.segments) {
    const segmentId = String(entry.segmentId);
    const hosted = hostedById.get(segmentId);
    if (!hosted) {
      recordMismatch(result, `${segmentId} missing from hosted`);
      continue;
    }
    const localComid = entry.nhdplusV2Comid === null || entry.nhdplusV2Comid === undefined ? null : String(entry.nhdplusV2Comid);
    const comparisons: [string, unknown, unknown][] = [
      ['nhdplusV2Comid', localComid, hosted.nhdplusV2Comid],
      ['drainageAreaRatio', entry.drainageAreaRatio ?? null, hosted.drainageAreaRatio],
      ['drainageAreaRatioTransfer', entry.drainageAreaRatioTransfer === true, hosted.drainageAreaRatioTransfer],
      ['transferDistanceM', entry.transferDistanceM ?? null, hosted.transferDistanceM],
    ];
    for (const [field, localValue, hostedValue] of comparisons) {
      if (localValue !== hostedValue) recordMismatch(result, `${segmentId} ${field}: ${String(hostedValue)} ≠ ${String(localValue)}`);
    }
    result.checked += 1;
  }
});

await runComparison('Creek segment paths (all Creek Segments, dev middleware builder)', true, async (result) => {
  const local = await buildSegmentPaths(FLOWLINE_SNAPSHOT_PATH, CROSS_SECTIONS_PATH);
  const hostedById = new Map(buildCreekSegmentPathsFile(network).segments.map((segment) => [segment.segmentId, segment]));
  if (hostedById.size !== local.segments.length) {
    recordMismatch(result, `${hostedById.size} hosted segments ≠ ${local.segments.length} local`);
  }
  let maxOffsetDeg = 0;
  for (const localSegment of local.segments) {
    const hosted = hostedById.get(localSegment.segmentId);
    if (!hosted) {
      recordMismatch(result, `${localSegment.segmentId} missing from hosted`);
      continue;
    }
    if (hosted.upstreamSegmentId !== localSegment.upstreamSegmentId || hosted.downstreamSegmentId !== localSegment.downstreamSegmentId) {
      recordMismatch(
        result,
        `${localSegment.segmentId} neighbours ${hosted.upstreamSegmentId}/${hosted.downstreamSegmentId} ≠ ` +
          `${localSegment.upstreamSegmentId}/${localSegment.downstreamSegmentId}`,
      );
    }
    if (hosted.pathWgs84.length !== localSegment.pathWgs84.length) {
      recordMismatch(result, `${localSegment.segmentId} path has ${hosted.pathWgs84.length} vertices ≠ ${localSegment.pathWgs84.length}`);
    } else {
      localSegment.pathWgs84.forEach((point, index) => {
        const hostedPoint = hosted.pathWgs84[index];
        maxOffsetDeg = Math.max(maxOffsetDeg, Math.abs(point[0] - hostedPoint[0]), Math.abs(point[1] - hostedPoint[1]));
      });
      if (!localSegment.pathWgs84.every((point, index) => pointsClose(point, hosted.pathWgs84[index]))) {
        recordMismatch(result, `${localSegment.segmentId} path vertices differ by more than ${COORDINATE_TOLERANCE_DEG}°`);
      }
    }
    result.checked += 1;
  }
  result.notes.push(`largest vertex offset ${maxOffsetDeg.toExponential(2)}°`);
});

await runComparison('Flowline index (informational: hosted uses flowline paths)', false, async (result) => {
  const polygonSetsFolder = path.join(POLYGON_METHOD_FOLDER, 'water-surface-polygon-sets');
  const names = (await readdir(polygonSetsFolder)).filter((name) => name.endsWith('.json')).sort();
  const local = await buildFlowlineIndex(polygonSetsFolder, names);
  const hostedByComid = new Map(buildFlowlineIndexFile(network).flowlines.map((flowline) => [flowline.tncComid, flowline]));
  let bboxInsideLocal = 0;
  let localNullCenters = 0;
  let largestCenterOffsetDeg = 0;
  let segmentSetDiffers = 0;
  for (const localFlowline of local.flowlines) {
    const hosted = hostedByComid.get(localFlowline.tncComid);
    if (!hosted) {
      recordMismatch(result, `${localFlowline.tncComid} missing from hosted index`);
      continue;
    }
    const [minLon, minLat, maxLon, maxLat] = localFlowline.bboxWgs84;
    const [hostedMinLon, hostedMinLat, hostedMaxLon, hostedMaxLat] = hosted.bboxWgs84;
    if (hostedMinLon >= minLon && hostedMinLat >= minLat && hostedMaxLon <= maxLon && hostedMaxLat <= maxLat) bboxInsideLocal += 1;
    const hostedCenters = new Map(hosted.segments.map((segment) => [segment.segmentId, segment.centerWgs84]));
    if (hostedCenters.size !== localFlowline.segments.length) segmentSetDiffers += 1;
    for (const segment of localFlowline.segments) {
      const hostedCenter = hostedCenters.get(segment.segmentId);
      if (!segment.centerWgs84) {
        localNullCenters += 1;
        continue;
      }
      if (hostedCenter) {
        largestCenterOffsetDeg = Math.max(
          largestCenterOffsetDeg,
          Math.abs(segment.centerWgs84[0] - hostedCenter[0]),
          Math.abs(segment.centerWgs84[1] - hostedCenter[1]),
        );
      }
    }
    result.checked += 1;
  }
  result.notes.push(
    `${local.flowlines.length} local / ${hostedByComid.size} hosted flowlines; ` +
      `${bboxInsideLocal} hosted bboxes inside the local polygon bbox; ${segmentSetDiffers} flowlines with a different segment set`,
  );
  result.notes.push(
    `${localNullCenters} local segments have no center (all buckets empty), hosted gives them one; ` +
      `largest center offset ${largestCenterOffsetDeg.toFixed(5)}° (~${Math.round(largestCenterOffsetDeg * 111_000)} m)`,
  );
});

const failed = results.filter((result) => result.required && result.mismatchCount > 0);
process.stdout.write(
  `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} comparisons without required mismatches; ` +
    `${requestStats.requests} requests, ${requestStats.rows} rows, ${((performance.now() - totalStartedAt) / 1000).toFixed(1)} s total\n`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
