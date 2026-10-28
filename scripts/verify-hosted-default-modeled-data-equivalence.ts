/**
 * Verifies that the browser's hosted ArcGIS adapters rebuild the DEFAULT modeled pairing exactly as the local pipeline
 * working output (data/pipeline-working-output/dangermond-preserve/) gives it: WSE polygons m3-v2 (the channel ribbon,
 * read through its exact-rings service) drawn with modeled WSE m5-v1. Read-only: only `/query` and layer-metadata
 * requests are sent, against the services the production build opens with no environment variables.
 *
 *   npm run data-products:verify-hosted-default-modeled-data                 # signed in (token kept in memory)
 *   npm run data-products:verify-hosted-default-modeled-data -- --anonymous  # no token: the services must be public
 *   … -- --flowlines 27714697,27714637                                       # a subset (default: every flowline)
 *
 * Compared, each as a deep JSON equality (numbers with ===, key sets equal):
 * - every hourly National Water Model Time Series file the hosted version publishes (every flowline, every water year
 *   it covers), plus California Natural Flows monthly files of a few flowlines;
 * - every polygon set file of the default ribbon version (every bucket, every ring vertex with its bed z, the
 *   `channelRibbon` summary);
 * - the method list's default pairing (the version the page opens and the Time Series it draws) and the catalog fields
 *   `readModeledCatalog` reads;
 * - the reach crosswalk and Creek Segment paths (from the m5 Creek Segments layer).
 *
 * Expected differences are reported by name and never counted as mismatches; see EXPECTED_DIFFERENCES.
 * Exits nonzero on any mismatch.
 */

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildSegmentPaths,
  listWsePolygonMethods,
} from '../apps/creek-visualization-browser/vite-plugins/modeled-water-data-plugin.ts';
import {
  creekDataSourceConfiguration,
  WSE_POLYGON_RINGS_TABLE_ID,
} from '../apps/creek-visualization-browser/src/creek-data-source-configuration.ts';
import type { HostedAdapterOptions } from '../apps/creek-visualization-browser/src/hosted-adapter-options.ts';
import {
  buildCreekSegmentPathsFile,
  buildReachCrosswalkFile,
  loadHostedCreekSegmentNetwork,
} from '../apps/creek-visualization-browser/src/hosted-creek-segment-network.ts';
import type { FetchImplementation } from '../apps/creek-visualization-browser/src/hosted-feature-service-query.ts';
import {
  buildHostedModeledCatalog,
  buildHostedWsePolygonMethodList,
  loadHostedModeledWseVersion,
  loadHostedWsePolygonMethods,
  waterYearOfUtcMs,
} from '../apps/creek-visualization-browser/src/hosted-modeled-catalog.ts';
import { loadHostedTimeSeriesForFlowline } from '../apps/creek-visualization-browser/src/hosted-modeled-water-surface-elevation.ts';
import { loadHostedChannelRibbonPolygonsForFlowline } from '../apps/creek-visualization-browser/src/hosted-water-surface-polygons.ts';
import {
  readWsePolygonMethodList,
  resolveWsePolygonMethod,
  type WsePolygonMethodVersion,
} from '../apps/creek-visualization-browser/src/wse-polygon-generation-methods.ts';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENT_ROOT = path.join(REPOSITORY_ROOT, 'data/pipeline-working-output/dangermond-preserve');
const TIME_SERIES_ROOT = path.join(EXTENT_ROOT, '03-time-series');
const CATALOG_PATH = path.join(EXTENT_ROOT, '05-catalog/catalog.json');
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

const MONTHLY_FLOWLINES = ['27714637', '27714697', '27575419'];
/** Named instants the report looks up: the January 2023 peak and a WY2019 storm hour. */
const NAMED_INSTANTS_UTC = ['2023-01-10T01:00:00.000Z', '2019-01-17T13:00:00.000Z'];
const STEEP_SEGMENT_IDS = ['27714697-040', '27714697-041', '27714697-042', '27714697-043', '27714697-044', '27714697-045'];
const MAX_LISTED_MISMATCHES = 8;
const PARALLEL_FLOWLINES = 3;

/** Differences that are not errors: what the frozen versions chose to publish, or what the local pipeline writes. */
const EXPECTED_DIFFERENCES = {
  hourlyWaterYears:
    'Hosted m5-v1 publishes National Water Model hours WY2021–WY2023 only (2020-10-01T00Z to 2023-02-01T00Z), as every ' +
    'frozen modeled version does; the local Stage 3 output also has WY2018–WY2020, so the local catalog lists more files ' +
    'and its hourly time range starts 2017-10-01.',
  catalogDerivation:
    'The local catalog derivation is the text Stage 5 writes for every modeled version (m1’s rating-curve description); ' +
    'the hosted catalog carries none (m5-v1’s derivation_json has no per-Dataset derivation). readModeledCatalog treats ' +
    'both as optional.',
  methodListInventory:
    'The local method list names every saved version of the extent (7 polygon versions, 8 modeled versions) and the ' +
    'registered methods without output; the hosted list names the two published versions. Only the default pairing is compared.',
  datasetOrder:
    'The hosted catalog lists Datasets in derivation_json order (hourly first), the local one in pipeline order; the ' +
    'browser looks Datasets up by id.',
  flowlineIndex:
    'The hosted flowline index is built from flowline paths, the local one from prepared polygons (pre-existing; ' +
    'see verify-hosted-modeled-data-equivalence.ts).',
};

// ---------------------------------------------------------------------------
// Request accounting

const requestStats = { requests: 0, rows: 0, bytes: 0 };

const countingFetch: FetchImplementation = async (url, init) => {
  requestStats.requests += 1;
  const response = await fetch(url, init);
  const text = await response.text();
  requestStats.bytes += text.length;
  return {
    ok: response.ok,
    status: response.status,
    async json() {
      const body = JSON.parse(text) as { features?: unknown[] };
      if (Array.isArray(body.features)) requestStats.rows += body.features.length;
      return body;
    },
  };
};

// ---------------------------------------------------------------------------
// Results

interface ComparisonResult {
  name: string;
  checked: number;
  mismatches: string[];
  mismatchCount: number;
  seconds: number;
  requests: number;
  notes: string[];
}

const results: ComparisonResult[] = [];

async function runComparison(name: string, compare: (result: ComparisonResult) => Promise<void>): Promise<void> {
  const result: ComparisonResult = { name, checked: 0, mismatches: [], mismatchCount: 0, seconds: 0, requests: 0, notes: [] };
  const startRequests = requestStats.requests;
  const startedAt = performance.now();
  try {
    await compare(result);
  } catch (error) {
    recordMismatch(result, `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  result.seconds = (performance.now() - startedAt) / 1000;
  result.requests = requestStats.requests - startRequests;
  results.push(result);
  process.stdout.write(
    `${result.mismatchCount === 0 ? 'OK  ' : 'FAIL'} ${name}: ${result.checked} checked, ${result.mismatchCount} mismatches; ` +
      `${result.requests} requests, ${result.seconds.toFixed(1)} s\n`,
  );
  for (const note of result.notes) process.stdout.write(`       note: ${note}\n`);
  for (const mismatch of result.mismatches) process.stdout.write(`       - ${mismatch}\n`);
}

function recordMismatch(result: ComparisonResult, message: string): void {
  result.mismatchCount += 1;
  if (result.mismatches.length < MAX_LISTED_MISMATCHES) result.mismatches.push(message);
}

/** Deep equality of two JSON values; records each differing leaf (numbers compared with ===, objects by key set). */
function compareJson(result: ComparisonResult, label: string, local: unknown, hosted: unknown): void {
  if (Array.isArray(local) && Array.isArray(hosted)) {
    if (local.length !== hosted.length) {
      recordMismatch(result, `${label}: length ${hosted.length} ≠ ${local.length}`);
      return;
    }
    local.forEach((item, index) => compareJson(result, `${label}[${index}]`, item, hosted[index]));
    return;
  }
  if (isRecord(local) && isRecord(hosted)) {
    const keys = new Set([...Object.keys(local), ...Object.keys(hosted)]);
    for (const key of keys) {
      if (!(key in local) || !(key in hosted)) {
        recordMismatch(result, `${label}.${key}: ${key in local ? 'missing from hosted' : 'only in hosted'}`);
        continue;
      }
      compareJson(result, `${label}.${key}`, local[key], hosted[key]);
    }
    return;
  }
  if (local !== hosted) recordMismatch(result, `${label}: hosted ${JSON.stringify(hosted)} ≠ local ${JSON.stringify(local)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The hosted object as the browser receives it after a JSON round trip (drops undefined fields). */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

async function readJsonFile<Value>(filePath: string): Promise<Value> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Value;
}

async function mapWithConcurrency<Item>(items: readonly Item[], limit: number, task: (item: Item) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await task(item);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Token (kept in memory only)

async function obtainPortalToken(): Promise<string> {
  const child = spawn('conda', ['run', '--no-capture-output', '-p', CONDA_ENVIRONMENT, 'python', TOKEN_HELPER_PATH], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const token = Buffer.concat(chunks).toString('utf8').trim();
  if (exitCode !== 0 || !/^[A-Za-z0-9._\-~+/=]+$/.test(token)) {
    throw new Error(`The token helper failed (exit code ${exitCode}); see its message above.`);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Main

const argumentsList = process.argv.slice(2);
const anonymous = argumentsList.includes('--anonymous');
const flowlinesArgument = argumentsList[argumentsList.indexOf('--flowlines') + 1];
const totalStartedAt = performance.now();
const configuration = creekDataSourceConfiguration;
process.stdout.write(
  `Hosted DEFAULT modeled data equivalence check (${anonymous ? 'anonymous' : 'signed in'})\n` +
    `  modeled WSE: ${configuration.modeledWseServiceUrl}\n  WSE polygons: ${configuration.wsePolygonsServiceUrl}\n` +
    `  exact rings: ${configuration.wsePolygonRingsServiceUrl}\n  local: ${path.relative(REPOSITORY_ROOT, EXTENT_ROOT)}\n`,
);
const adapterOptions: HostedAdapterOptions = anonymous
  ? { fetchImplementation: countingFetch }
  : { token: await obtainPortalToken(), fetchImplementation: countingFetch };

const setupStartedAt = performance.now();
const version = await loadHostedModeledWseVersion({ modeledWseServiceUrl: configuration.modeledWseServiceUrl }, adapterOptions);
const polygonMethods = await loadHostedWsePolygonMethods({ wsePolygonsServiceUrl: configuration.wsePolygonsServiceUrl }, adapterOptions);
const network = await loadHostedCreekSegmentNetwork(
  {
    modeledWseServiceUrl: configuration.modeledWseServiceUrl,
    creekSegmentsLayerId: version.layerIds.creekSegments,
    segmentNetworkVersion: version.segmentNetworkVersion,
    withBeds: version.timeSeriesLayout === 'junction-depth',
  },
  adapterOptions,
);
const hostedMethodList = readWsePolygonMethodList(asJson(buildHostedWsePolygonMethodList(polygonMethods, version)));
const hostedDefault = resolveWsePolygonMethod(hostedMethodList, null).selected;
const hostedCatalog = asJson(buildHostedModeledCatalog(version, network, { showCaliforniaNaturalFlowsMonthly: true })) as {
  timeSeries: { datasetId: string; paths: string[] }[];
} & Record<string, unknown>;
process.stdout.write(
  `Loaded modeled ${version.versionLabel} (${version.timeSeriesLayout}), ${network.segments.length} Creek Segments on ` +
    `${network.segmentsByTncComid.size} flowlines; default pairing ${hostedDefault.path} + ${hostedDefault.drawnWithModeledWsePath ?? '(own)'} ` +
    `in ${((performance.now() - setupStartedAt) / 1000).toFixed(1)} s, ${requestStats.requests} requests\n\n`,
);

const tncComids = flowlinesArgument && !flowlinesArgument.startsWith('--') ? flowlinesArgument.split(',') : [...network.segmentsByTncComid.keys()];

await runComparison('Method list: default pairing', async (result) => {
  const localList = readWsePolygonMethodList(await listWsePolygonMethods(EXTENT_ROOT));
  const localDefault = resolveWsePolygonMethod(localList, null).selected;
  const fields: (keyof WsePolygonMethodVersion)[] = [
    'methodId',
    'version',
    'label',
    'description',
    'browserDrawing',
    'path',
    'builtFromModeledWsePath',
    'drawnWithModeledWsePath',
  ];
  for (const field of fields) compareJson(result, `default.${field}`, localDefault[field] ?? null, hostedDefault[field] ?? null);
  compareJson(result, 'defaultMethodId', localList.defaultMethodId, hostedMethodList.defaultMethodId);
  compareJson(result, 'defaultModeledWseMethodId', localList.defaultModeledWseMethodId, hostedMethodList.defaultModeledWseMethodId);
  const localDrawn = localList.modeledWseVersions.find((entry) => entry.path === localDefault.drawnWithModeledWsePath);
  const hostedDrawn = hostedMethodList.modeledWseVersions.find((entry) => entry.path === hostedDefault.drawnWithModeledWsePath);
  compareJson(result, 'drawn modeled WSE version', localDrawn ?? null, hostedDrawn ?? null);
  result.checked = fields.length + 3;
  result.notes.push(`opens ${localDefault.path} drawn with ${localDefault.drawnWithModeledWsePath}`);
  result.notes.push(`expected: ${EXPECTED_DIFFERENCES.methodListInventory}`);
});

await runComparison('Catalog (fields readModeledCatalog reads)', async (result) => {
  const local = await readJsonFile<Record<string, unknown> & { timeSeries: { datasetId: string; paths: string[] }[] }>(CATALOG_PATH);
  for (const field of ['segmentNetworkVersion', 'publishers'] as const) compareJson(result, field, local[field], hostedCatalog[field]);
  const localVersion = local.modeledWseVersion as Record<string, unknown>;
  for (const field of ['methodId', 'version', 'versionLabel', 'path']) {
    compareJson(result, `modeledWseVersion.${field}`, localVersion[field], (hostedCatalog.modeledWseVersion as Record<string, unknown>)[field]);
  }
  const localDatasets = local.datasets as Record<string, unknown>[];
  const hostedDatasets = hostedCatalog.datasets as Record<string, unknown>[];
  const datasetIds = (datasets: Record<string, unknown>[]): string[] => datasets.map((entry) => String(entry.datasetId));
  compareJson(result, 'dataset ids', [...datasetIds(localDatasets)].sort(), [...datasetIds(hostedDatasets)].sort());
  if (datasetIds(localDatasets).join() !== datasetIds(hostedDatasets).join()) {
    result.notes.push(`dataset order ${datasetIds(hostedDatasets).join(', ')} hosted, ${datasetIds(localDatasets).join(', ')} local (expected: datasetOrder)`);
  }
  localDatasets.forEach((localDataset) => {
    const hostedDataset = hostedDatasets.find((entry) => entry.datasetId === localDataset.datasetId) ?? {};
    for (const field of ['publisherId', 'kind', 'timeStep', 'accuracyNote']) {
      compareJson(result, `datasets[${String(localDataset.datasetId)}].${field}`, localDataset[field], hostedDataset[field]);
    }
    const [localStart, localEnd] = localDataset.timeRangeUtc as string[];
    const [hostedStart, hostedEnd] = hostedDataset.timeRangeUtc as string[];
    if (localEnd !== hostedEnd) recordMismatch(result, `${String(localDataset.datasetId)} range end ${hostedEnd} ≠ ${localEnd}`);
    if (localStart !== hostedStart) result.notes.push(`${String(localDataset.datasetId)} starts ${hostedStart} hosted, ${localStart} local (expected)`);
  });
  for (const localSeries of local.timeSeries) {
    const hostedSeries = hostedCatalog.timeSeries.find((entry) => entry.datasetId === localSeries.datasetId);
    if (!hostedSeries) {
      recordMismatch(result, `${localSeries.datasetId}: no hosted Time Series`);
      continue;
    }
    const localPaths = new Set(localSeries.paths);
    const hostedOnly = hostedSeries.paths.filter((entry) => !localPaths.has(entry));
    if (hostedOnly.length > 0) recordMismatch(result, `${localSeries.datasetId}: ${hostedOnly.length} hosted paths not local, e.g. ${hostedOnly[0]}`);
    const hostedPaths = new Set(hostedSeries.paths);
    const localOnly = localSeries.paths.filter((entry) => !hostedPaths.has(entry));
    const unexpectedLocalOnly = localOnly.filter((entry) => !/\/WY20(18|19|20)\.json$/.test(entry));
    if (unexpectedLocalOnly.length > 0) recordMismatch(result, `${localSeries.datasetId}: ${unexpectedLocalOnly.length} local paths not hosted, e.g. ${unexpectedLocalOnly[0]}`);
    result.notes.push(`${localSeries.datasetId}: ${hostedSeries.paths.length} paths hosted, ${localSeries.paths.length} local (${localOnly.length} WY2018–WY2020 local only, expected)`);
    const localCount = (localSeries as unknown as Record<string, unknown>).drainageAreaRatioTransferSegments;
    const hostedCount = (hostedSeries as unknown as Record<string, unknown>).drainageAreaRatioTransferSegments;
    compareJson(result, `${localSeries.datasetId}.drainageAreaRatioTransferSegments`, localCount, hostedCount);
  }
  result.checked = local.timeSeries.length + localDatasets.length + 6;
  result.notes.push(`expected: ${EXPECTED_DIFFERENCES.hourlyWaterYears}`);
  result.notes.push(`expected: ${EXPECTED_DIFFERENCES.catalogDerivation}`);
});

const hourlyPaths = (hostedCatalog.timeSeries.find((entry) => entry.datasetId === 'national-water-model-hourly')?.paths ?? []).filter((entry) =>
  tncComids.some((tncComid) => entry.includes(`/${tncComid}/`)),
);
const namedInstantFindings: string[] = [];

await runComparison(`NWM hourly Time Series: ${hourlyPaths.length} files (every flowline × WY2021–WY2023)`, async (result) => {
  const namedInstantsMs = NAMED_INSTANTS_UTC.map((instant) => Date.parse(instant));
  let values = 0;
  await mapWithConcurrency(hourlyPaths, PARALLEL_FLOWLINES, async (catalogPath) => {
    const match = /\/(\d+)\/WY(\d{4})\.json$/.exec(catalogPath) as RegExpExecArray;
    const [tncComid, waterYear] = [match[1], Number(match[2])];
    const local = await readJsonFile<{ timestampsUtcMs: number[]; segments: { segmentId: string; values: (number | null)[] }[] }>(
      path.join(TIME_SERIES_ROOT, catalogPath),
    );
    const hosted = asJson(
      await loadHostedTimeSeriesForFlowline({ version, network, datasetId: 'national-water-model-hourly', tncComid, waterYear }, adapterOptions),
    );
    compareJson(result, `${tncComid} WY${waterYear}`, local, hosted);
    values += local.segments.length * local.timestampsUtcMs.length;
    for (const instantMs of namedInstantsMs) {
      const index = local.timestampsUtcMs.indexOf(instantMs);
      if (index < 0) continue;
      for (const segment of local.segments.filter((entry) => STEEP_SEGMENT_IDS.includes(entry.segmentId))) {
        namedInstantFindings.push(`${new Date(instantMs).toISOString()} ${segment.segmentId}: ${segment.values[index]} m (hosted equal)`);
      }
    }
    result.checked += 1;
  });
  result.notes.push(`${values.toLocaleString('en-US')} segment-hours compared, each with values and both junction depths`);
  for (const instant of NAMED_INSTANTS_UTC) {
    if (waterYearOfUtcMs(Date.parse(instant)) < 2021) result.notes.push(`${instant}: not published hosted (WY${waterYearOfUtcMs(Date.parse(instant))}); expected`);
  }
});
for (const finding of namedInstantFindings.sort()) process.stdout.write(`       ${finding}\n`);

await runComparison(`CNF monthly Time Series: ${MONTHLY_FLOWLINES.length} flowlines`, async (result) => {
  for (const tncComid of MONTHLY_FLOWLINES) {
    const local = await readJsonFile<unknown>(
      path.join(TIME_SERIES_ROOT, version.modeledWsePath, `time-series/california-natural-flows-monthly/water-surface-elevation/${tncComid}.json`),
    );
    const hosted = asJson(
      await loadHostedTimeSeriesForFlowline({ version, network, datasetId: 'california-natural-flows-monthly', tncComid }, adapterOptions),
    );
    compareJson(result, `${tncComid} monthly`, local, hosted);
    result.checked += 1;
  }
});

await runComparison(`Polygon sets: ${tncComids.length} flowlines of ${hostedDefault.path} (exact rings)`, async (result) => {
  const methodKey = `${hostedDefault.methodId}@v${hostedDefault.version}`;
  const channelRibbonsTableId = polygonMethods.channelRibbonsTableIdByMethodKey.get(methodKey);
  if (channelRibbonsTableId === undefined) throw new Error(`No channel ribbons table for ${methodKey}.`);
  let buckets = 0;
  let vertices = 0;
  await mapWithConcurrency(tncComids, PARALLEL_FLOWLINES, async (tncComid) => {
    const local = await readJsonFile<{ waterSurfacePolygonSets: { elevationBuckets: { ringsWgs84: unknown[][] }[] }[] }>(
      path.join(EXTENT_ROOT, hostedDefault.path, `water-surface-polygon-sets/${tncComid}.json`),
    );
    const hosted = asJson(
      await loadHostedChannelRibbonPolygonsForFlowline(
        {
          wsePolygonsServiceUrl: configuration.wsePolygonsServiceUrl,
          channelRibbonsTableId,
          wsePolygonRingsServiceUrl: configuration.wsePolygonRingsServiceUrl,
          ringsTableId: WSE_POLYGON_RINGS_TABLE_ID,
          network,
          tncComid,
        },
        adapterOptions,
      ),
    );
    compareJson(result, tncComid, local, hosted);
    for (const set of local.waterSurfacePolygonSets) {
      buckets += set.elevationBuckets.length;
      for (const bucket of set.elevationBuckets) for (const ring of bucket.ringsWgs84) vertices += ring.length;
    }
    result.checked += 1;
  });
  result.notes.push(`${buckets.toLocaleString('en-US')} buckets, ${vertices.toLocaleString('en-US')} ring vertices compared with z`);
});

await runComparison('Reach crosswalk (all Creek Segments)', async (result) => {
  const local = await readJsonFile<{ segments: Record<string, unknown>[] }>(REACH_CROSSWALK_PATH);
  const hostedById = new Map(buildReachCrosswalkFile(network).segments.map((segment) => [segment.segmentId, segment]));
  for (const entry of local.segments) {
    const hosted = hostedById.get(String(entry.segmentId));
    if (!hosted) {
      recordMismatch(result, `${String(entry.segmentId)} missing from hosted`);
      continue;
    }
    const localComid = entry.nhdplusV2Comid === null || entry.nhdplusV2Comid === undefined ? null : String(entry.nhdplusV2Comid);
    compareJson(result, `${String(entry.segmentId)}.nhdplusV2Comid`, localComid, hosted.nhdplusV2Comid);
    compareJson(result, `${String(entry.segmentId)}.drainageAreaRatio`, entry.drainageAreaRatio ?? null, hosted.drainageAreaRatio);
    compareJson(result, `${String(entry.segmentId)}.drainageAreaRatioTransfer`, entry.drainageAreaRatioTransfer === true, hosted.drainageAreaRatioTransfer);
    compareJson(result, `${String(entry.segmentId)}.transferDistanceM`, entry.transferDistanceM ?? null, hosted.transferDistanceM);
    result.checked += 1;
  }
});

await runComparison('Creek Segment paths (all Creek Segments, dev middleware builder)', async (result) => {
  const local = await buildSegmentPaths(FLOWLINE_SNAPSHOT_PATH, CROSS_SECTIONS_PATH);
  const hostedById = new Map(buildCreekSegmentPathsFile(network).segments.map((segment) => [segment.segmentId, segment]));
  let largestOffsetDeg = 0;
  for (const localSegment of local.segments) {
    const hosted = hostedById.get(localSegment.segmentId);
    if (!hosted) {
      recordMismatch(result, `${localSegment.segmentId} missing from hosted`);
      continue;
    }
    compareJson(result, `${localSegment.segmentId} neighbours`, [localSegment.upstreamSegmentId, localSegment.downstreamSegmentId], [hosted.upstreamSegmentId, hosted.downstreamSegmentId]);
    if (hosted.pathWgs84.length !== localSegment.pathWgs84.length) {
      recordMismatch(result, `${localSegment.segmentId}: ${hosted.pathWgs84.length} vertices ≠ ${localSegment.pathWgs84.length}`);
    } else {
      localSegment.pathWgs84.forEach((point, index) => {
        largestOffsetDeg = Math.max(largestOffsetDeg, Math.abs(point[0] - hosted.pathWgs84[index][0]), Math.abs(point[1] - hosted.pathWgs84[index][1]));
      });
    }
    result.checked += 1;
  }
  // Same tolerance as verify-hosted-modeled-data-equivalence.ts: the layer stores the flowline vertices as geometry.
  if (largestOffsetDeg > 1e-7) recordMismatch(result, `largest vertex offset ${largestOffsetDeg}° > 1e-7°`);
  result.notes.push(`largest vertex offset ${largestOffsetDeg.toExponential(2)}° (geometry storage; tolerance 1e-7°)`);
});

const localPolygonFiles = (await readdir(path.join(EXTENT_ROOT, hostedDefault.path, 'water-surface-polygon-sets'))).length;
const failed = results.filter((result) => result.mismatchCount > 0);
process.stdout.write(
  `\nExpected differences (not mismatches):\n${Object.entries(EXPECTED_DIFFERENCES)
    .map(([name, text]) => `  - ${name}: ${text}`)
    .join('\n')}\n` +
    `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} comparisons without mismatches ` +
    `(${results.reduce((sum, result) => sum + result.mismatchCount, 0)} mismatches); local polygon files ${localPolygonFiles}; ` +
    `${requestStats.requests} requests, ${requestStats.rows.toLocaleString('en-US')} rows, ` +
    `${(requestStats.bytes / 1e6).toFixed(1)} MB, ${((performance.now() - totalStartedAt) / 1000).toFixed(1)} s total\n`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
