// Dataset selection (URL query) and the modeled pipeline catalog shape.
// Terms follow docs/architecture/glossary.md: Publisher, Dataset, Variable,
// Time Series, Derivation, Hold rule, Creek Segment, Prepared water-surface polygon.

import { creekDataSourceConfiguration } from './creek-data-source-configuration';
import { PublishedCreekDataError } from './creek-data-contract';

export const DATASET_QUERY_PARAM = 'dataset';
export const MODELED_EXTENT_QUERY_PARAM = 'modeledExtent';
/** ISO 8601 UTC instant that chooses the opening timeline slot in a modeled Dataset. */
export const TIME_QUERY_PARAM = 'time';

export const OBSERVED_DATASET_OPTION_ID = 'observed-gauge';
/** Whole-watershed extent opens by default; `?modeledExtent=` overrides it. */
export const DEFAULT_MODELED_EXTENT_ID = 'dangermond-preserve';
export const MODELED_EXTENT_IDS = ['jalama-gauge-reach', 'dangermond-preserve'] as const;

/** Picker entries. The observed gauge keeps the existing experience and is the default. */
export const DATASET_PICKER_OPTIONS = [
  { id: OBSERVED_DATASET_OPTION_ID, label: 'Observed gauge', kind: 'observed' },
  {
    id: 'california-natural-flows-monthly',
    label: 'Modeled Creek Water Levels — monthly (from California Natural Flows)',
    kind: 'modeled',
  },
  {
    id: 'national-water-model-hourly',
    label: 'Modeled Creek Water Levels — hourly (from NOAA National Water Model v3.0 flows)',
    kind: 'modeled',
  },
] as const;

/**
 * Picker entries this build offers: the California Natural Flows monthly
 * Dataset only when `VITE_SHOW_CALIFORNIA_NATURAL_FLOWS_MONTHLY` is true.
 */
export function availableDatasetPickerOptions(): readonly (typeof DATASET_PICKER_OPTIONS)[number][] {
  return DATASET_PICKER_OPTIONS.filter(
    (option) =>
      option.id !== 'california-natural-flows-monthly' || creekDataSourceConfiguration.showCaliforniaNaturalFlowsMonthly,
  );
}

export type ModeledDatasetId = Extract<
  (typeof DATASET_PICKER_OPTIONS)[number],
  { kind: 'modeled' }
>['id'];

/** Base URL where the Vite dev middleware exposes the pipeline output. */
export const MODELED_WATER_DATA_ROOT = '/modeled-water-surface-elevation-data';

export type DatasetSelection =
  | { kind: 'observed' }
  | {
      kind: 'modeled';
      datasetId: ModeledDatasetId;
      extentId: string;
      /** Opening time from the URL, or null for the first slot. */
      openingTimeUtcMs: number | null;
    };

export function readDatasetSelection(locationSearch: string): DatasetSelection {
  const params = new URLSearchParams(locationSearch);
  const datasetId = params.get(DATASET_QUERY_PARAM);
  const option = availableDatasetPickerOptions().find((item) => item.id === datasetId);
  if (!option || option.kind !== 'modeled') return { kind: 'observed' };
  const extentParam = params.get(MODELED_EXTENT_QUERY_PARAM);
  const extentId = extentParam && extentParam.trim().length > 0 ? extentParam.trim() : DEFAULT_MODELED_EXTENT_ID;
  const timeParam = params.get(TIME_QUERY_PARAM);
  const parsed = timeParam ? Date.parse(timeParam) : Number.NaN;
  return {
    kind: 'modeled',
    datasetId: option.id,
    extentId,
    openingTimeUtcMs: Number.isFinite(parsed) ? parsed : null,
  };
}

/** Camera pose carried across a Dataset switch: longitude, latitude, height (m), heading, tilt. */
export const CAMERA_QUERY_PARAM = 'camera';
/** Selected Creek Segment carried across a Dataset switch. */
export const SEGMENT_QUERY_PARAM = 'segment';

export interface CameraQueryPose {
  readonly positionWgs84: readonly [number, number, number];
  readonly headingDegrees: number;
  readonly tiltDegrees: number;
}

export function writeCameraQuery(pose: CameraQueryPose): string {
  const [longitude, latitude, z] = pose.positionWgs84;
  return [longitude.toFixed(7), latitude.toFixed(7), z.toFixed(1), pose.headingDegrees.toFixed(1), pose.tiltDegrees.toFixed(1)].join(',');
}

export function readCameraQuery(locationSearch: string): CameraQueryPose | null {
  const raw = new URLSearchParams(locationSearch).get(CAMERA_QUERY_PARAM);
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 5 || parts.some((part) => !Number.isFinite(part))) return null;
  const [longitude, latitude, z, headingDegrees, tiltDegrees] = parts as [number, number, number, number, number];
  return { positionWgs84: [longitude, latitude, z], headingDegrees, tiltDegrees };
}

/** Opening time from `?time=`, for either experience; null when absent or unreadable. */
export function readOpeningTimeQuery(locationSearch: string): number | null {
  const raw = new URLSearchParams(locationSearch).get(TIME_QUERY_PARAM);
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Builds the page URL for a picker choice, keeping the extent and devtools
 * flags. The selected time and camera ride along, so the new Dataset opens at
 * the same moment and view; each experience snaps the time to its own grid.
 */
export function datasetPageUrl(
  datasetOptionId: string,
  current: Location,
  carry: {
    selectedTimeUtcMs: number | null;
    cameraPose: CameraQueryPose | null;
    selectedCreekSegmentId?: string | null;
  } = {
    selectedTimeUtcMs: null,
    cameraPose: null,
  },
): string {
  const params = new URLSearchParams(current.search);
  params.delete(TIME_QUERY_PARAM);
  params.delete(CAMERA_QUERY_PARAM);
  params.delete(SEGMENT_QUERY_PARAM);
  if (carry.selectedCreekSegmentId) params.set(SEGMENT_QUERY_PARAM, carry.selectedCreekSegmentId);
  if (carry.selectedTimeUtcMs !== null) params.set(TIME_QUERY_PARAM, new Date(carry.selectedTimeUtcMs).toISOString());
  if (carry.cameraPose) params.set(CAMERA_QUERY_PARAM, writeCameraQuery(carry.cameraPose));
  if (datasetOptionId === OBSERVED_DATASET_OPTION_ID) {
    params.delete(DATASET_QUERY_PARAM);
  } else {
    params.set(DATASET_QUERY_PARAM, datasetOptionId);
  }
  const query = params.toString();
  return `${current.pathname}${query ? `?${query}` : ''}`;
}

export function modeledDataUrl(extentId: string, relativePath: string): string {
  return `${MODELED_WATER_DATA_ROOT}/${encodeURIComponent(extentId)}/${relativePath}`;
}

// ---------------------------------------------------------------------------
// Catalog (05-catalog/catalog.json)

export interface CatalogPublisher {
  publisherId: string;
  name: string;
}

export interface CatalogDataset {
  datasetId: string;
  publisherId: string;
  kind: string;
  timeStep: string;
  /** Start and end instants, inclusive. */
  timeRangeUtcMs: readonly [number, number];
  accuracyNote: string | null;
}

export interface DerivationInput {
  role: string;
  source: string;
}

export interface DerivationParameter {
  name: string;
  value: number | string | null;
  unit: string;
  basis: string | null;
  publishedRange: readonly [number, number] | null;
  citations: readonly string[];
}

export interface Derivation {
  derivedFrom: string | null;
  method: string | null;
  derivedBy: string | null;
  inputs: readonly DerivationInput[];
  steps: readonly string[];
  parameters: readonly DerivationParameter[];
  assumptions: readonly string[];
  sensitivity: string | null;
}

export interface CatalogTimeSeries {
  datasetId: string;
  variableId: string;
  /** Relative to 03-time-series/. */
  paths: readonly string[];
  derivation: Derivation | null;
  /** Any extra numeric counts the pipeline adds later (optional, shown as-is). */
  counts: Readonly<Record<string, number>>;
}

export interface ModeledCatalog {
  segmentNetworkVersion: string;
  publishers: readonly CatalogPublisher[];
  datasets: readonly CatalogDataset[];
  timeSeries: readonly CatalogTimeSeries[];
}

export const WATER_SURFACE_ELEVATION_VARIABLE_ID = 'water-surface-elevation';

export function readModeledCatalog(value: unknown): ModeledCatalog {
  const record = asRecord(value, 'catalog');
  const segmentNetworkVersion = asText(record.segmentNetworkVersion, 'catalog segmentNetworkVersion');
  const publishers = asArray(record.publishers, 'catalog publishers').map((item, index) => {
    const publisher = asRecord(item, `publisher ${index + 1}`);
    return {
      publisherId: asText(publisher.publisherId, `publisher ${index + 1} id`),
      name: asText(publisher.name, `publisher ${index + 1} name`),
    };
  });
  const datasets = asArray(record.datasets, 'catalog datasets').map((item, index) => {
    const dataset = asRecord(item, `dataset ${index + 1}`);
    const range = asArray(dataset.timeRangeUtc, `dataset ${index + 1} timeRangeUtc`);
    const start = Date.parse(asText(range[0], `dataset ${index + 1} range start`));
    const end = Date.parse(asText(range[1], `dataset ${index + 1} range end`));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      fail(`dataset ${index + 1} has an invalid timeRangeUtc.`);
    }
    return {
      datasetId: asText(dataset.datasetId, `dataset ${index + 1} id`),
      publisherId: asText(dataset.publisherId, `dataset ${index + 1} publisher`),
      kind: typeof dataset.kind === 'string' ? dataset.kind : 'modeled',
      timeStep: asText(dataset.timeStep, `dataset ${index + 1} timeStep`),
      timeRangeUtcMs: [start, end] as const,
      accuracyNote: optionalText(dataset.accuracyNote),
    };
  });
  const timeSeries = asArray(record.timeSeries, 'catalog timeSeries').map((item, index) => {
    const series = asRecord(item, `time series ${index + 1}`);
    const counts: Record<string, number> = {};
    for (const [key, entry] of Object.entries(series)) {
      if (typeof entry === 'number' && Number.isFinite(entry)) counts[key] = entry;
    }
    return {
      datasetId: asText(series.datasetId, `time series ${index + 1} dataset`),
      variableId: asText(series.variableId, `time series ${index + 1} variable`),
      paths: asArray(series.paths, `time series ${index + 1} paths`).filter(
        (path): path is string => typeof path === 'string',
      ),
      derivation: readDerivation(series.derivation),
      counts,
    };
  });
  return { segmentNetworkVersion, publishers, datasets, timeSeries };
}

function readDerivation(value: unknown): Derivation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    derivedFrom: optionalText(record.derivedFrom),
    method: optionalText(record.method),
    derivedBy: optionalText(record.derivedBy),
    inputs: textRecords(record.inputs).map((input) => ({
      role: optionalText(input.role) ?? '',
      source: optionalText(input.source) ?? '',
    })),
    steps: textList(record.steps),
    parameters: textRecords(record.parameters).map((parameter) => ({
      name: optionalText(parameter.name) ?? '',
      value:
        typeof parameter.value === 'number' || typeof parameter.value === 'string'
          ? parameter.value
          : null,
      unit: optionalText(parameter.unit) ?? '',
      basis: optionalText(parameter.basis),
      publishedRange: numberPair(parameter.publishedRange),
      citations: textList(parameter.citations),
    })),
    assumptions: textList(record.assumptions),
    sensitivity: optionalText(record.sensitivity),
  };
}

export interface SelectedModeledDataset {
  publisher: CatalogPublisher;
  dataset: CatalogDataset;
  timeSeries: CatalogTimeSeries;
}

export function selectModeledDataset(catalog: ModeledCatalog, datasetId: string): SelectedModeledDataset {
  const dataset = catalog.datasets.find((item) => item.datasetId === datasetId);
  if (!dataset) fail(`The catalog has no Dataset ${datasetId}.`);
  const publisher = catalog.publishers.find((item) => item.publisherId === dataset.publisherId);
  if (!publisher) fail(`The catalog has no Publisher for ${datasetId}.`);
  const timeSeries = catalog.timeSeries.find(
    (item) => item.datasetId === datasetId && item.variableId === WATER_SURFACE_ELEVATION_VARIABLE_ID,
  );
  if (!timeSeries) fail(`The catalog has no water-surface elevation Time Series for ${datasetId}.`);
  return { publisher, dataset, timeSeries };
}

/**
 * Hold rule: a value stands for at most one time step of its Dataset.
 * A month is held for 31 days so a 31-day month is fully covered; the next
 * month's own value takes over on its first day regardless.
 */
export function datasetHoldMs(timeStep: string): number {
  switch (timeStep) {
    case 'hourly':
      return 60 * 60 * 1000;
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'monthly':
      return 31 * 24 * 60 * 60 * 1000;
    default:
      fail(`Unsupported Dataset time step "${timeStep}".`);
  }
}

/** Slider grid: one slot per hour for hourly data, one slot per day otherwise. */
export function timelineGridStepMs(timeStep: string): number {
  return timeStep === 'hourly' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

/** Water year: Oct 1 through Sep 30, named for the year it ends in. */
export function waterYearOf(timeUtcMs: number): number {
  const date = new Date(timeUtcMs);
  return date.getUTCMonth() >= 9 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

// ---------------------------------------------------------------------------
// Small readers

function textRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberPair(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return [a, b];
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
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

function asText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be text.`);
  return value;
}

function fail(message: string): never {
  throw new PublishedCreekDataError(message);
}
