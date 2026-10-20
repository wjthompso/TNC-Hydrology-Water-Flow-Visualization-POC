import {
  FEET_TO_METERS,
  GAUGE_DATUM_FT,
  OBSERVATION_STATION_ID,
  OBSERVED_SOURCE_ID,
  SEGMENT_NETWORK_VERSION,
} from './constants.ts';
import {
  expectNullableNumber,
  expectNullableString,
  expectNumber,
  expectRecord,
  expectString,
} from './json-files.ts';
import { roundToDecimals } from './utm-geometry.ts';

export interface ObservedTimeSeriesDocument {
  segmentNetworkVersion: string;
  sourceId: string;
  timestampsUtcMs: number[];
  segments: Array<{
    segmentId: string;
    waterSurfaceElevationM: Array<number | null>;
  }>;
}

export interface ObservedTimeSeriesPublication {
  document: ObservedTimeSeriesDocument;
  rowCount: number;
  nullCount: number;
  duplicateTimestampCount: number;
  droppedDuplicateIds: number[];
}

interface ObservationRow {
  id: number;
  stationId: number;
  timestampUtcMs: number;
  gaugeHeightFt: number | null;
  gaugeHeightUnits: string | null;
}

function readObservationRow(value: unknown, index: number): ObservationRow {
  const record = expectRecord(value, `Observation ${index}`);
  const id = expectNumber(record, 'id', `Observation ${index}`);
  return {
    id,
    stationId: expectNumber(record, 'station_id', `Observation ${id}`),
    timestampUtcMs: expectNumber(record, 'timestamp_utc', `Observation ${id}`),
    gaugeHeightFt: expectNullableNumber(record, 'gauge_height', `Observation ${id}`),
    gaugeHeightUnits: expectNullableString(record, 'gauge_height_units', `Observation ${id}`),
  };
}

function formatHeight(gaugeHeightFt: number | null): string {
  return gaugeHeightFt === null ? 'null' : String(gaugeHeightFt);
}

/**
 * Gauge datum is 83.34 ft NAVD88 and is treated as constant.
 * Null gauge-height readings stay null. Missing 15-minute slots are not invented.
 */
export function waterSurfaceElevationM(gaugeHeightFt: number): number {
  return roundToDecimals((gaugeHeightFt + GAUGE_DATUM_FT) * FEET_TO_METERS, 3);
}

export function buildObservedTimeSeries(
  snapshot: unknown,
  segmentId: string,
): ObservedTimeSeriesPublication {
  const record = expectRecord(snapshot, 'Observation snapshot');
  const requestParams = expectRecord(record.requestParams, 'Observation request params');
  const where = expectString(requestParams, 'where', 'Observation request params');
  if (where !== `station_id=${OBSERVATION_STATION_ID}`) {
    throw new Error(`Observation snapshot where clause is ${where}, expected station_id=${OBSERVATION_STATION_ID}.`);
  }
  if (!Array.isArray(record.attributes)) {
    throw new Error('Observation snapshot is missing attributes.');
  }
  const sourceRowCount = expectNumber(record, 'sourceRowCount', 'Observation snapshot');
  if (record.attributes.length !== sourceRowCount) {
    throw new Error(
      `Observation snapshot has ${record.attributes.length} rows but sourceRowCount is ${sourceRowCount}.`,
    );
  }

  const rows = record.attributes.map((row, index) => readObservationRow(row, index));
  const seenIds = new Set<number>();
  for (const row of rows) {
    if (row.stationId !== OBSERVATION_STATION_ID) {
      throw new Error(`Observation ${row.id} has station_id ${row.stationId}, expected ${OBSERVATION_STATION_ID}.`);
    }
    if (seenIds.has(row.id)) throw new Error(`Observation id ${row.id} appears more than once.`);
    seenIds.add(row.id);
    if (row.gaugeHeightFt !== null && row.gaugeHeightUnits !== 'ft') {
      throw new Error(
        `Observation ${row.id} gauge_height_units is ${row.gaugeHeightUnits ?? 'null'}, expected ft.`,
      );
    }
  }

  rows.sort((left, right) => left.timestampUtcMs - right.timestampUtcMs || left.id - right.id);

  const timestampsUtcMs: number[] = [];
  const waterSurfaceElevation: Array<number | null> = [];
  const keptGaugeHeightFt: Array<number | null> = [];
  const droppedDuplicateIds: number[] = [];
  let duplicateTimestampCount = 0;
  let lastDuplicateTimestamp: number | null = null;
  let nullCount = 0;

  for (const row of rows) {
    const previousTimestamp = timestampsUtcMs[timestampsUtcMs.length - 1];
    if (previousTimestamp === row.timestampUtcMs) {
      const previousHeight = keptGaugeHeightFt[keptGaugeHeightFt.length - 1];
      if (previousHeight !== row.gaugeHeightFt) {
        throw new Error(
          `Duplicate timestamp ${row.timestampUtcMs} has gauge heights ${formatHeight(previousHeight ?? null)} ft and ${formatHeight(row.gaugeHeightFt)} ft (id ${row.id}).`,
        );
      }
      if (lastDuplicateTimestamp !== row.timestampUtcMs) {
        duplicateTimestampCount += 1;
        lastDuplicateTimestamp = row.timestampUtcMs;
      }
      droppedDuplicateIds.push(row.id);
      continue;
    }
    timestampsUtcMs.push(row.timestampUtcMs);
    keptGaugeHeightFt.push(row.gaugeHeightFt);
    if (row.gaugeHeightFt === null) {
      waterSurfaceElevation.push(null);
      nullCount += 1;
    } else {
      waterSurfaceElevation.push(waterSurfaceElevationM(row.gaugeHeightFt));
    }
  }

  return {
    document: {
      segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
      sourceId: OBSERVED_SOURCE_ID,
      timestampsUtcMs,
      segments: [{ segmentId, waterSurfaceElevationM: waterSurfaceElevation }],
    },
    rowCount: timestampsUtcMs.length,
    nullCount,
    duplicateTimestampCount,
    droppedDuplicateIds,
  };
}
