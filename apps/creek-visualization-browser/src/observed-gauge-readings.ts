/**
 * Observed gauge readings: the browser's copy of the pipeline's Time Series rules.
 *
 * `pipelines/creek-visualization-data-production/observed-time-series-publication.ts`
 * turns the Jalama Near Lompoc gauge rows into the shipped observed Time Series.
 * That module (and `constants.ts`) pull Node APIs, so the browser cannot import
 * them. This file holds the same rules in plain TypeScript:
 *
 * - Gauge height (feet) → water-surface elevation (meters NAVD88):
 *   `(gauge height + Gauge datum) × 0.3048`, rounded to 3 decimals.
 * - Rows sorted by timestamp, then id.
 * - A repeated timestamp with the same gauge height keeps the first row;
 *   a repeated timestamp with a different gauge height is an error.
 * - A null gauge height stays null.
 *
 * `scripts/verify-hosted-observed-data-equivalence.ts` checks these constants
 * and this conversion against the pipeline's, so the two copies cannot drift.
 */

import type { ObservedApprovalStatus } from './creek-data-contract.ts';

/** Gauge datum for Jalama Near Lompoc, feet NAVD88. Treated as constant. */
export const GAUGE_DATUM_FT = 83.34;
export const FEET_TO_METERS = 0.3048;
/** `station_id` of the Jalama Near Lompoc gauge in the Creek Gauge Data table. */
export const OBSERVATION_STATION_ID = 1;


/** One Creek Gauge Data row, reduced to the fields the Time Series needs. */
export interface ObservedGaugeRow {
  readonly id: number;
  readonly stationId: number;
  readonly timestampUtcMs: number;
  readonly gaugeHeightFt: number | null;
  readonly gaugeHeightUnits: string | null;
  /** Null when the service gives no recognised approval status. */
  readonly approvalStatus: ObservedApprovalStatus | null;
}

export interface ObservedGaugeReadings {
  readonly timestampsUtcMs: number[];
  readonly waterSurfaceElevationM: (number | null)[];
  /** Parallel to `timestampsUtcMs`. */
  readonly approvalStatuses: (ObservedApprovalStatus | null)[];
  readonly droppedDuplicateCount: number;
}

export function waterSurfaceElevationMFromGaugeHeightFt(gaugeHeightFt: number): number {
  return Number(((gaugeHeightFt + GAUGE_DATUM_FT) * FEET_TO_METERS).toFixed(3));
}

/**
 * The gauge height (feet) that produced a published water-surface elevation:
 * the inverse of `waterSurfaceElevationMFromGaugeHeightFt`. Differs from the
 * original reading by at most the 3-decimal rounding of the meters (0.0016 ft).
 */
export function gaugeHeightFtFromWaterSurfaceElevationM(waterSurfaceElevationM: number): number {
  return waterSurfaceElevationM / FEET_TO_METERS - GAUGE_DATUM_FT;
}

export function readApprovalStatus(value: unknown): ObservedApprovalStatus | null {
  return value === 'Provisional' || value === 'Approved' ? value : null;
}

/** Validates, sorts, and de-duplicates gauge rows exactly as the pipeline does. */
export function buildObservedGaugeReadings(rows: readonly ObservedGaugeRow[]): ObservedGaugeReadings {
  const seenIds = new Set<number>();
  for (const row of rows) {
    if (row.stationId !== OBSERVATION_STATION_ID) {
      throw new Error(`Observation ${row.id} has station_id ${row.stationId}, expected ${OBSERVATION_STATION_ID}.`);
    }
    if (seenIds.has(row.id)) throw new Error(`Observation id ${row.id} appears more than once.`);
    seenIds.add(row.id);
    if (row.gaugeHeightFt !== null && row.gaugeHeightUnits !== 'ft') {
      throw new Error(`Observation ${row.id} gauge_height_units is ${row.gaugeHeightUnits ?? 'null'}, expected ft.`);
    }
  }

  const sortedRows = [...rows].sort((left, right) => left.timestampUtcMs - right.timestampUtcMs || left.id - right.id);

  const timestampsUtcMs: number[] = [];
  const waterSurfaceElevationM: (number | null)[] = [];
  const approvalStatuses: (ObservedApprovalStatus | null)[] = [];
  const keptGaugeHeightFt: (number | null)[] = [];
  let droppedDuplicateCount = 0;
  for (const row of sortedRows) {
    const lastIndex = timestampsUtcMs.length - 1;
    if (lastIndex >= 0 && timestampsUtcMs[lastIndex] === row.timestampUtcMs) {
      if (keptGaugeHeightFt[lastIndex] !== row.gaugeHeightFt) {
        throw new Error(
          `Duplicate timestamp ${row.timestampUtcMs} has gauge heights ${keptGaugeHeightFt[lastIndex]} ft and ${row.gaugeHeightFt} ft (id ${row.id}).`,
        );
      }
      droppedDuplicateCount += 1;
      continue;
    }
    timestampsUtcMs.push(row.timestampUtcMs);
    keptGaugeHeightFt.push(row.gaugeHeightFt);
    waterSurfaceElevationM.push(
      row.gaugeHeightFt === null ? null : waterSurfaceElevationMFromGaugeHeightFt(row.gaugeHeightFt),
    );
    approvalStatuses.push(row.approvalStatus);
  }
  return { timestampsUtcMs, waterSurfaceElevationM, approvalStatuses, droppedDuplicateCount };
}
