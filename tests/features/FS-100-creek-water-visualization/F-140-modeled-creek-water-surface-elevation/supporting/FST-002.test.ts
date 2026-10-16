import { describe, expect, it } from 'vitest';
import { buildRatingCurveRecord } from '../../../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/rating-curve-inversion.ts';
import type { CrossSectionRecord } from '../../../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/stage-file-formats.ts';

const TEST_NAME =
  "Every Creek Segment's rating curve gives a higher or equal discharge as water-surface elevation rises.";

const BED_M = 100;
const BENCH_M = 101;
const BANK_TOP_M = 103;

/**
 * Synthetic representative profile, 1 m sample spacing, offsets -45..45 m:
 * a 2 m wide, 1 m deep main channel, a flat 40 m bench on each side at BENCH_M,
 * and high outer banks so water never reaches the profile ends.
 */
function benchProfileElevation(offsetM: number): number {
  const distance = Math.abs(offsetM);
  if (distance <= 1) return BED_M;
  if (distance <= 42) return BENCH_M;
  return BANK_TOP_M + 1;
}

/** Synthetic V-shaped channel with no bench: raw Manning discharge rises smoothly. */
function plainProfileElevation(offsetM: number): number {
  return BED_M + Math.abs(offsetM) * 0.1;
}

function syntheticSection(segmentId: string, elevationAt: (offsetM: number) => number): CrossSectionRecord {
  const profileOffsetsM = Array.from({ length: 91 }, (_, index) => index - 45);
  return {
    segmentId,
    networkDistanceMidM: 0,
    bedElevationM: BED_M,
    rawSlope: 0.01,
    slope: 0.01,
    slopeFloored: false,
    representativeSectionIndex: 0,
    lowestBankTopM: BANK_TOP_M,
    sections: [],
    profileOffsetsM,
    profileElevationsM: profileOffsetsM.map(elevationAt),
    warnings: [],
  };
}

function rawDips(values: readonly number[]): number {
  return values.filter((value, index) => index > 0 && value < (values[index - 1] as number)).length;
}

describe('FST-002', () => {
  it(TEST_NAME, () => {
    const records = [
      buildRatingCurveRecord(syntheticSection('synthetic-bench-segment', benchProfileElevation)),
      buildRatingCurveRecord(syntheticSection('synthetic-plain-segment', plainProfileElevation)),
    ];

    for (const record of records) {
      expect(record.waterSurfaceElevationM.length, record.segmentId).toBeGreaterThan(50);
      expect(record.dischargeM3s, record.segmentId).toHaveLength(record.waterSurfaceElevationM.length);
      record.waterSurfaceElevationM.forEach((wse, index) => {
        if (index === 0) return;
        expect(wse, `${record.segmentId} ladder step ${index}`).toBeGreaterThan(
          record.waterSurfaceElevationM[index - 1] as number,
        );
        expect(record.dischargeM3s[index], `${record.segmentId} discharge at ${wse} m`).toBeGreaterThanOrEqual(
          record.dischargeM3s[index - 1] as number,
        );
      });
    }

    // Proves the fixture reaches the bench case: raw Manning discharge really fell once water spilled
    // onto the bench, the ladder climbed above it, and Stage 2 flagged the held steps.
    const [bench, plain] = records;
    expect(Math.max(...(bench?.waterSurfaceElevationM ?? []))).toBeGreaterThan(BENCH_M + 0.5);
    expect(rawDips(bench?.rawManningDischargeM3s ?? [])).toBeGreaterThan(0);
    expect(bench?.flags.some((flag) => flag.startsWith('non-monotonic-discharge'))).toBe(true);
    expect(rawDips(plain?.rawManningDischargeM3s ?? [])).toBe(0);
  });
});
