import process from 'node:process';
import { NATIONAL_WATER_MODEL } from './pipeline-configuration.ts';

/** A US water year N runs from Oct 1 of year N-1 00:00 UTC up to Oct 1 of year N 00:00 UTC. */
export function waterYearStartMs(waterYear: number): number {
  return Date.UTC(waterYear - 1, 9, 1);
}

export function waterYearOf(timestampMs: number): number {
  const date = new Date(timestampMs);
  return date.getUTCMonth() >= 9 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

/** `--water-years=2020-2022` or `--water-years=2021` overrides the National Water Model window. */
export function requestedWaterYears(): { first: number; last: number } {
  const flag = process.argv.find((argument) => argument.startsWith('--water-years='));
  if (!flag) {
    return { first: NATIONAL_WATER_MODEL.defaultFirstWaterYear, last: NATIONAL_WATER_MODEL.defaultLastWaterYear };
  }
  const match = /^--water-years=(\d{4})(?:-(\d{4}))?$/.exec(flag);
  if (!match) throw new Error(`Could not read ${flag}. Use --water-years=2020-2022.`);
  const first = Number(match[1]);
  const last = Number(match[2] ?? match[1]);
  if (last < first) throw new Error(`${flag} ends before it starts.`);
  return { first, last };
}
