/**
 * Hosted modeled water-surface elevation (WSE) Time Series.
 *
 * Rebuilds one TNC flowline's Time Series file (Stage 3
 * `WaterSurfaceElevationTimeSeriesFile` shape, read by the data store's
 * `readTimeSeriesFile`) from the published Held WSE Interval tables:
 *
 * - segment rows (`location_kind = 'segment'`) give each Creek Segment's values;
 * - junction rows (`location_kind = 'junction'`) give the shared junction WSE
 *   at each flowline vertex. A segment's upstream / downstream junction series
 *   is its junction's series, set to null wherever the segment's own value is
 *   null (Stage 3 rule).
 *
 * A Held WSE Interval holds `wse_m` from `valid_from_utc` (inclusive) to
 * `valid_until_utc` (exclusive). A timestamp no interval covers is null.
 */

import {
  CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID,
  NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
  type HostedModeledDatasetId,
  type HostedModeledWseVersion,
} from './hosted-modeled-catalog.ts';
import type { HostedCreekSegmentNetwork } from './hosted-creek-segment-network.ts';
import {
  layerUrl,
  numberOrNull,
  sqlString,
  sqlTimestamp,
  stringOrEmpty,
  withHostedTransport,
  type HostedAdapterOptions,
} from './hosted-adapter-options.ts';
import { queryAllRows } from './hosted-feature-service-query.ts';

export const HOUR_MS = 3_600_000;
const WATER_SURFACE_ELEVATION_VARIABLE_ID = 'water-surface-elevation';

/** Stage 3 `WaterSurfaceElevationTimeSeriesFile` shape. */
export interface HostedTimeSeriesFile {
  segmentNetworkVersion: string;
  datasetId: string;
  variableId: typeof WATER_SURFACE_ELEVATION_VARIABLE_ID;
  timestampsUtcMs: number[];
  segments: HostedTimeSeriesSegment[];
}

export interface HostedTimeSeriesSegment {
  segmentId: string;
  values: (number | null)[];
  junctionWseUpstreamM: (number | null)[];
  junctionWseDownstreamM: (number | null)[];
  /** Present (true) only for a Drainage-Area Ratio Transfer segment; absent means false. */
  drainageAreaRatioTransfer?: true;
}

export interface LoadHostedTimeSeriesRequest {
  readonly version: HostedModeledWseVersion;
  readonly network: HostedCreekSegmentNetwork;
  readonly datasetId: HostedModeledDatasetId;
  readonly tncComid: string;
  /** Required for the hourly Dataset (one file per water year); ignored for monthly. */
  readonly waterYear?: number;
}

export async function loadHostedTimeSeriesForFlowline(
  request: LoadHostedTimeSeriesRequest,
  options?: HostedAdapterOptions,
): Promise<HostedTimeSeriesFile> {
  const { version, network, datasetId, tncComid } = request;
  const flowlineSegments = network.segmentsByTncComid.get(tncComid);
  if (!flowlineSegments) {
    throw new Error(`TNC flowline ${tncComid} is not in Creek Segment network ${network.segmentNetworkVersion}.`);
  }

  const timestampsUtcMs = datasetTimestamps(version, datasetId, request.waterYear);
  const intervalsLayerId =
    datasetId === NATIONAL_WATER_MODEL_HOURLY_DATASET_ID
      ? version.layerIds.nationalWaterModelIntervals
      : version.layerIds.californiaNaturalFlowsIntervals;

  const whereClauses = [`tnc_comid = ${sqlString(tncComid)}`];
  if (datasetId === NATIONAL_WATER_MODEL_HOURLY_DATASET_ID && timestampsUtcMs.length > 0) {
    // Time overlap with [first timestamp, last timestamp + 1 hour).
    const windowEndMs = timestampsUtcMs[timestampsUtcMs.length - 1] + HOUR_MS;
    whereClauses.push(`valid_from_utc < ${sqlTimestamp(windowEndMs)}`);
    whereClauses.push(`valid_until_utc > ${sqlTimestamp(timestampsUtcMs[0])}`);
  }

  const rows =
    timestampsUtcMs.length === 0
      ? []
      : await queryAllRows(
          withHostedTransport(options, {
            layerUrl: layerUrl(version.modeledWseServiceUrl, intervalsLayerId),
            where: whereClauses.join(' AND '),
            outFields: ['location_kind', 'location_id', 'valid_from_utc', 'valid_until_utc', 'wse_m'],
            orderByFields: ['location_kind', 'location_id', 'valid_from_utc'],
          }),
        );

  const seriesByLocationKey = new Map<string, (number | null)[]>();
  for (const { attributes } of rows) {
    const key = locationKey(stringOrEmpty(attributes.location_kind), stringOrEmpty(attributes.location_id));
    let series = seriesByLocationKey.get(key);
    if (!series) {
      series = new Array<number | null>(timestampsUtcMs.length).fill(null);
      seriesByLocationKey.set(key, series);
    }
    fillHeldInterval(
      series,
      timestampsUtcMs,
      numberOrNull(attributes.valid_from_utc),
      numberOrNull(attributes.valid_until_utc),
      numberOrNull(attributes.wse_m),
    );
  }

  const emptySeries = (): (number | null)[] => new Array<number | null>(timestampsUtcMs.length).fill(null);
  const segments = flowlineSegments.map((segment): HostedTimeSeriesSegment => {
    const values = seriesByLocationKey.get(locationKey('segment', segment.segmentId)) ?? emptySeries();
    const upstreamJunction = seriesByLocationKey.get(locationKey('junction', segment.upstreamJunctionId));
    const downstreamJunction = seriesByLocationKey.get(locationKey('junction', segment.downstreamJunctionId));
    const timeSeriesSegment: HostedTimeSeriesSegment = {
      segmentId: segment.segmentId,
      values,
      junctionWseUpstreamM: junctionWseForSegment(values, upstreamJunction),
      junctionWseDownstreamM: junctionWseForSegment(values, downstreamJunction),
    };
    if (segment.drainageAreaRatioTransfer) timeSeriesSegment.drainageAreaRatioTransfer = true;
    return timeSeriesSegment;
  });

  return {
    segmentNetworkVersion: network.segmentNetworkVersion,
    datasetId,
    variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID,
    timestampsUtcMs,
    segments,
  };
}

function locationKey(locationKind: string, locationId: string): string {
  return `${locationKind}:${locationId}`;
}

/** Stage 3 rule: null where the segment's own value is null, else the shared junction value. */
function junctionWseForSegment(
  segmentValues: readonly (number | null)[],
  junctionSeries: readonly (number | null)[] | undefined,
): (number | null)[] {
  return segmentValues.map((value, index) => (value === null ? null : (junctionSeries?.[index] ?? null)));
}

/** Writes `wseM` at every timestamp in [validFromMs, validUntilMs). */
function fillHeldInterval(
  series: (number | null)[],
  timestampsUtcMs: readonly number[],
  validFromMs: number | null,
  validUntilMs: number | null,
  wseM: number | null,
): void {
  if (validFromMs === null || validUntilMs === null) return;
  for (let index = firstIndexAtOrAfter(timestampsUtcMs, validFromMs); index < timestampsUtcMs.length; index += 1) {
    if (timestampsUtcMs[index] >= validUntilMs) break;
    series[index] = wseM;
  }
}

/** Binary search: first index whose timestamp is >= `timeUtcMs`. */
function firstIndexAtOrAfter(timestampsUtcMs: readonly number[], timeUtcMs: number): number {
  let low = 0;
  let high = timestampsUtcMs.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (timestampsUtcMs[middle] < timeUtcMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

// ---------------------------------------------------------------------------
// Timestamps

/**
 * Hourly: every hour of the water year (Oct 1 00Z → next Oct 1 00Z, exclusive)
 * clipped to the published range (inclusive). Monthly: every month start of
 * the published range.
 */
export function datasetTimestamps(
  version: HostedModeledWseVersion,
  datasetId: HostedModeledDatasetId,
  waterYear: number | undefined,
): number[] {
  const range = version.timeRangeUtcMsByDatasetId.get(datasetId);
  if (!range) throw new Error(`Modeled WSE ${version.versionLabel} does not publish ${datasetId}.`);
  const [firstMs, lastMs] = range;

  if (datasetId === CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID) {
    return monthStartsUtcMs(firstMs, lastMs);
  }
  if (waterYear === undefined) {
    throw new Error(`${datasetId} Time Series are per water year; pass waterYear.`);
  }
  const waterYearStartMs = Date.UTC(waterYear - 1, 9, 1);
  const nextWaterYearStartMs = Date.UTC(waterYear, 9, 1);
  const startMs = Math.max(waterYearStartMs, firstMs);
  const endMs = Math.min(nextWaterYearStartMs - HOUR_MS, lastMs);
  const timestamps: number[] = [];
  for (let timeMs = startMs; timeMs <= endMs; timeMs += HOUR_MS) timestamps.push(timeMs);
  return timestamps;
}

function monthStartsUtcMs(firstMs: number, lastMs: number): number[] {
  const first = new Date(firstMs);
  const timestamps: number[] = [];
  for (let monthOffset = 0; ; monthOffset += 1) {
    const timeMs = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + monthOffset, 1);
    if (timeMs > lastMs) break;
    if (timeMs >= firstMs) timestamps.push(timeMs);
  }
  return timestamps;
}
