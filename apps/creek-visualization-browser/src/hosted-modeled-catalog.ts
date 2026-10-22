/**
 * Hosted modeled catalog and WSE Polygon Generation Method list.
 *
 * Reads the two published versions tables (`modeled_wse_versions`,
 * `wse_polygon_versions`) and builds the JSON the dev middleware serves as
 * `05-catalog/catalog.json` (read by `readModeledCatalog`) and
 * `wse-polygon-methods.json` (read by `readWsePolygonMethodList`).
 *
 * Time Series `paths` use the same relative layout as the local pipeline
 * output, so the existing per-flowline / per-water-year keying keeps working;
 * in hosted mode a path names the flowline and water year to query, not a file.
 */

import {
  FALLBACK_MODELED_WSE_LAYER_IDS,
  FALLBACK_WSE_POLYGONS_LAYER_IDS,
  resolveLayerIdsFromArcgisTableNames,
  type ModeledWseLayerIds,
} from './creek-data-source-configuration.ts';
import type { HostedCreekSegmentNetwork } from './hosted-creek-segment-network.ts';
import {
  layerUrl,
  numberOrNull,
  parseJsonAttribute,
  stringOrEmpty,
  withHostedTransport,
  type HostedAdapterOptions,
} from './hosted-adapter-options.ts';
import { queryAllRows } from './hosted-feature-service-query.ts';

export const NATIONAL_WATER_MODEL_HOURLY_DATASET_ID = 'national-water-model-hourly';
export const CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID = 'california-natural-flows-monthly';
export type HostedModeledDatasetId =
  | typeof NATIONAL_WATER_MODEL_HOURLY_DATASET_ID
  | typeof CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID;

const WATER_SURFACE_ELEVATION_VARIABLE_ID = 'water-surface-elevation';
const TIME_SERIES_FOLDER = 'time-series';
const WATER_SURFACE_POLYGONS_STAGE_FOLDER = '04-water-surface-polygons';

/** Publisher display names; the versions table stores only publisher ids. */
const PUBLISHER_NAME_BY_ID: Readonly<Record<string, string>> = {
  'california-natural-flows': 'California Natural Flows',
  'noaa-national-water-model': 'NOAA National Water Model',
};

/**
 * Published time ranges (first and last timestamp, inclusive), used when the
 * versions table `water_years` text cannot be parsed.
 */
export const FALLBACK_TIME_RANGE_UTC: Readonly<Record<HostedModeledDatasetId, readonly [string, string]>> = {
  [NATIONAL_WATER_MODEL_HOURLY_DATASET_ID]: ['2020-10-01T00:00:00.000Z', '2023-02-01T00:00:00.000Z'],
  [CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID]: ['1950-01-01T00:00:00.000Z', '2024-12-01T00:00:00.000Z'],
};

// ---------------------------------------------------------------------------
// Modeled WSE version (one row of `modeled_wse_versions`)

export interface HostedModeledWseVersion {
  readonly modeledWseServiceUrl: string;
  readonly versionLabel: string;
  readonly methodId: string;
  readonly segmentNetworkVersion: string;
  readonly layerIds: ModeledWseLayerIds;
  /** Time range per published Dataset: [first, last] timestamp, inclusive, UTC ms. */
  readonly timeRangeUtcMsByDatasetId: ReadonlyMap<string, readonly [number, number]>;
  /** Parsed `derivation_json`: variable, datasets (with derivation), Drainage-Area Ratio Transfer note. */
  readonly derivation: ModeledWseDerivationJson;
}

interface ModeledWseDerivationJson {
  readonly datasets?: readonly {
    datasetId?: string;
    publisherId?: string;
    timeStep?: string;
    accuracyNote?: string | null;
    derivation?: unknown;
  }[];
}

export interface LoadHostedModeledWseVersionRequest {
  readonly modeledWseServiceUrl: string;
  /** Defaults to the published versions table id. */
  readonly versionsTableId?: number;
  /** Defaults to the newest `active` version. */
  readonly versionLabel?: string;
}

export async function loadHostedModeledWseVersion(
  request: LoadHostedModeledWseVersionRequest,
  options?: HostedAdapterOptions,
): Promise<HostedModeledWseVersion> {
  const versionsTableId = request.versionsTableId ?? FALLBACK_MODELED_WSE_LAYER_IDS.versions;
  const rows = await queryAllRows(
    withHostedTransport(options, {
      layerUrl: layerUrl(request.modeledWseServiceUrl, versionsTableId),
      where: '1=1',
      outFields: [
        'version_label',
        'method_id',
        'method_number',
        'version_number',
        'status',
        'segment_network_version',
        'water_years',
        'derivation_json',
        'arcgis_table_names',
      ],
      orderByFields: ['method_number', 'version_number'],
    }),
  );
  const attributes = pickVersionRow(
    rows.map((row) => row.attributes),
    request.versionLabel,
    'modeled_wse_versions',
  );

  const versionLabel = stringOrEmpty(attributes.version_label);
  const prefix = `modeled_wse_${versionLabel.replace(/-/g, '_')}`;
  return {
    modeledWseServiceUrl: request.modeledWseServiceUrl,
    versionLabel,
    methodId: stringOrEmpty(attributes.method_id),
    segmentNetworkVersion: requiredText(attributes.segment_network_version, 'segment_network_version'),
    layerIds: resolveLayerIdsFromArcgisTableNames(attributes.arcgis_table_names, FALLBACK_MODELED_WSE_LAYER_IDS, {
      creekSegments: `${prefix}_creek_segments`,
      californiaNaturalFlowsIntervals: `${prefix}_cnf_monthly_held_intervals`,
      californiaNaturalFlowsValues: `${prefix}_cnf_monthly_values`,
      nationalWaterModelIntervals: `${prefix}_nwm_hourly_held_intervals`,
      versions: 'modeled_wse_versions',
    }),
    timeRangeUtcMsByDatasetId: readTimeRanges(stringOrEmpty(attributes.water_years)),
    derivation: parseJsonAttribute<ModeledWseDerivationJson>(attributes.derivation_json, {}),
  };
}

/**
 * `water_years` text, e.g. `national-water-model-hourly: WY2021–WY2023 hourly
 * 2020-10-01T00:00:00Z to 2023-02-01T00:00:00Z; california-natural-flows-monthly:
 * monthly 1950-01 to 2024-12`. A Dataset the text does not name keeps its fallback.
 */
function readTimeRanges(waterYearsText: string): Map<string, readonly [number, number]> {
  const ranges = new Map<string, readonly [number, number]>();
  for (const [datasetId, [start, end]] of Object.entries(FALLBACK_TIME_RANGE_UTC)) {
    ranges.set(datasetId, [Date.parse(start), Date.parse(end)]);
  }
  for (const part of waterYearsText.split(';')) {
    const match = /^\s*([a-z0-9-]+)\s*:.*?(\d{4}-\d{2}(?:-\d{2}T[\d:.]+Z)?)\s+to\s+(\d{4}-\d{2}(?:-\d{2}T[\d:.]+Z)?)/.exec(
      part,
    );
    if (!match) continue;
    const start = Date.parse(monthToInstant(match[2]));
    const end = Date.parse(monthToInstant(match[3]));
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) ranges.set(match[1], [start, end]);
  }
  return ranges;
}

/** `1950-01` → `1950-01-01T00:00:00Z`; a full instant is returned unchanged. */
function monthToInstant(text: string): string {
  return /^\d{4}-\d{2}$/.test(text) ? `${text}-01T00:00:00Z` : text;
}

// ---------------------------------------------------------------------------
// Catalog (`05-catalog/catalog.json` shape)

export interface BuildHostedModeledCatalogOptions {
  /** False hides the California Natural Flows monthly Dataset. */
  readonly showCaliforniaNaturalFlowsMonthly: boolean;
}

/** Raw catalog JSON, readable by `readModeledCatalog`. */
export function buildHostedModeledCatalog(
  version: HostedModeledWseVersion,
  network: HostedCreekSegmentNetwork,
  catalogOptions: BuildHostedModeledCatalogOptions,
): {
  segmentNetworkVersion: string;
  publishers: { publisherId: string; name: string }[];
  datasets: {
    datasetId: string;
    publisherId: string;
    kind: string;
    timeStep: string;
    timeRangeUtc: [string, string];
    accuracyNote: string | null;
  }[];
  timeSeries: {
    datasetId: string;
    variableId: string;
    paths: string[];
    derivation: unknown;
    drainageAreaRatioTransferSegments: number;
  }[];
} {
  const publishedDatasets = (version.derivation.datasets ?? []).filter(
    (dataset) =>
      typeof dataset.datasetId === 'string' &&
      version.timeRangeUtcMsByDatasetId.has(dataset.datasetId) &&
      (catalogOptions.showCaliforniaNaturalFlowsMonthly ||
        dataset.datasetId !== CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID),
  );
  const tncComids = [...network.segmentsByTncComid.keys()];
  const transferSegmentCount = network.segments.filter((segment) => segment.drainageAreaRatioTransfer).length;

  const datasets = publishedDatasets.map((dataset) => {
    const datasetId = dataset.datasetId as string;
    const [startMs, endMs] = version.timeRangeUtcMsByDatasetId.get(datasetId) as readonly [number, number];
    return {
      datasetId,
      publisherId: dataset.publisherId ?? '',
      kind: 'modeled',
      timeStep: dataset.timeStep ?? (datasetId === NATIONAL_WATER_MODEL_HOURLY_DATASET_ID ? 'hourly' : 'monthly'),
      timeRangeUtc: [new Date(startMs).toISOString(), new Date(endMs).toISOString()] as [string, string],
      accuracyNote: dataset.accuracyNote ?? null,
    };
  });

  const publisherIds = [...new Set(datasets.map((dataset) => dataset.publisherId))].sort();
  return {
    segmentNetworkVersion: version.segmentNetworkVersion,
    publishers: publisherIds.map((publisherId) => ({
      publisherId,
      name: PUBLISHER_NAME_BY_ID[publisherId] ?? publisherId,
    })),
    datasets,
    timeSeries: datasets.map((dataset, index) => ({
      datasetId: dataset.datasetId,
      variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID,
      paths: timeSeriesPaths(dataset.datasetId, dataset.timeStep, tncComids, version),
      derivation: publishedDatasets[index].derivation ?? null,
      drainageAreaRatioTransferSegments: transferSegmentCount,
    })),
  };
}

/** Same relative layout as Stage 3: `<dataset>/<variable>/<comid>/WY<year>.json` (hourly) or `<comid>.json`. */
function timeSeriesPaths(
  datasetId: string,
  timeStep: string,
  tncComids: readonly string[],
  version: HostedModeledWseVersion,
): string[] {
  const folder = `${TIME_SERIES_FOLDER}/${datasetId}/${WATER_SURFACE_ELEVATION_VARIABLE_ID}`;
  if (timeStep !== 'hourly') {
    return tncComids.map((tncComid) => `${folder}/${tncComid}.json`);
  }
  const [startMs, endMs] = version.timeRangeUtcMsByDatasetId.get(datasetId) as readonly [number, number];
  const waterYears: number[] = [];
  for (let waterYear = waterYearOfUtcMs(startMs); waterYear <= waterYearOfUtcMs(endMs); waterYear += 1) {
    waterYears.push(waterYear);
  }
  return tncComids.flatMap((tncComid) =>
    waterYears.map((waterYear) => `${folder}/${tncComid}/WY${waterYear}.json`),
  );
}

/** Water year: Oct 1 through Sep 30, named for the year it ends in. */
export function waterYearOfUtcMs(timeUtcMs: number): number {
  const date = new Date(timeUtcMs);
  return date.getUTCMonth() >= 9 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

// ---------------------------------------------------------------------------
// WSE Polygon Generation Methods (`wse-polygon-methods.json` shape)

export interface HostedWsePolygonMethodVersion {
  readonly methodId: string;
  readonly version: number;
  readonly label: string;
  readonly description: string;
  readonly browserDrawing: string;
  /** Same relative path as local output; the store keys polygon sets by it. */
  readonly path: string;
}

export interface HostedWsePolygonMethods {
  /** Raw JSON, readable by `readWsePolygonMethodList`. */
  readonly methodList: { defaultMethodId: string; versions: HostedWsePolygonMethodVersion[] };
  /** Polygon layer id per method version, keyed by `wsePolygonMethodKey` (`<method-id>@v<version>`). */
  readonly polygonLayerIdByMethodKey: ReadonlyMap<string, number>;
  /** Parsed `parameters_json` per method version key. */
  readonly parametersByMethodKey: ReadonlyMap<string, unknown>;
}

export interface LoadHostedWsePolygonMethodsRequest {
  readonly wsePolygonsServiceUrl: string;
  /** Defaults to the published versions table id. */
  readonly versionsTableId?: number;
}

/** Every non-retired row of `wse_polygon_versions`; the default method is the newest active row's. */
export async function loadHostedWsePolygonMethods(
  request: LoadHostedWsePolygonMethodsRequest,
  options?: HostedAdapterOptions,
): Promise<HostedWsePolygonMethods> {
  const versionsTableId = request.versionsTableId ?? FALLBACK_WSE_POLYGONS_LAYER_IDS.versions;
  const rows = await queryAllRows(
    withHostedTransport(options, {
      layerUrl: layerUrl(request.wsePolygonsServiceUrl, versionsTableId),
      where: "status <> 'retired'",
      outFields: [
        'version_label',
        'status',
        'derivation_summary',
        'derivation_json',
        'pipeline_method_id',
        'pipeline_method_version',
        'browser_drawing',
        'parameters_json',
        'arcgis_table_names',
      ],
      orderByFields: ['pipeline_method_id', 'pipeline_method_version'],
    }),
  );

  const polygonLayerIdByMethodKey = new Map<string, number>();
  const parametersByMethodKey = new Map<string, unknown>();
  const versions = rows.map(({ attributes }) => {
    const methodId = requiredText(attributes.pipeline_method_id, 'pipeline_method_id');
    const version = numberOrNull(attributes.pipeline_method_version) ?? 1;
    const methodKey = `${methodId}@v${version}`;
    const polygonLayerName = `wse_polygons_${stringOrEmpty(attributes.version_label).replace(/-/g, '_')}`;
    const layerIds = resolveLayerIdsFromArcgisTableNames(attributes.arcgis_table_names, FALLBACK_WSE_POLYGONS_LAYER_IDS, {
      wsePolygons: polygonLayerName,
      versions: 'wse_polygon_versions',
    });
    polygonLayerIdByMethodKey.set(methodKey, layerIds.wsePolygons);
    parametersByMethodKey.set(methodKey, parseJsonAttribute<unknown>(attributes.parameters_json, null));

    const derivation = parseJsonAttribute<{ wse_polygon_generation_method?: { label?: string } }>(
      attributes.derivation_json,
      {},
    );
    return {
      methodId,
      version,
      label: derivation.wse_polygon_generation_method?.label ?? methodId,
      // `derivation_summary` is "<method description> Built from <modeled WSE version>."
      description: stringOrEmpty(attributes.derivation_summary).replace(/\s*Built from [^]*$/, ''),
      browserDrawing: stringOrEmpty(attributes.browser_drawing) || 'sloped-between-junctions',
      path: `${WATER_SURFACE_POLYGONS_STAGE_FOLDER}/${methodId}/v${version}`,
      status: stringOrEmpty(attributes.status),
    };
  });

  const defaultMethodId =
    versions.filter((entry) => entry.status === 'active').at(-1)?.methodId ?? versions.at(-1)?.methodId ?? '';
  return {
    methodList: {
      defaultMethodId,
      versions: versions.map((entry) => ({
        methodId: entry.methodId,
        version: entry.version,
        label: entry.label,
        description: entry.description,
        browserDrawing: entry.browserDrawing,
        path: entry.path,
      })),
    },
    polygonLayerIdByMethodKey,
    parametersByMethodKey,
  };
}

// ---------------------------------------------------------------------------
// Small readers

/** The requested version row, or the newest `active` row (rows arrive oldest first). */
function pickVersionRow(
  rows: readonly Record<string, unknown>[],
  versionLabel: string | undefined,
  tableName: string,
): Record<string, unknown> {
  const picked = versionLabel
    ? rows.find((row) => row.version_label === versionLabel)
    : (rows.filter((row) => row.status === 'active').at(-1) ?? rows.at(-1));
  if (!picked) {
    throw new Error(
      versionLabel ? `${tableName} has no version ${versionLabel}.` : `${tableName} has no version rows.`,
    );
  }
  return picked;
}

function requiredText(value: unknown, fieldName: string): string {
  const text = stringOrEmpty(value);
  if (!text) throw new Error(`The versions table row has no ${fieldName}.`);
  return text;
}
