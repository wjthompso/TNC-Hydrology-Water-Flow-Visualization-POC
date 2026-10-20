import { describe, expect, it } from 'vitest';

/**
 * EXAMPLE ONLY; excluded from test discovery; does not protect the application.
 *
 * Methodology: This example does not run. If promoted, it would call the real
 * production water-depth calculation through an imported production seam and
 * compare exact known surveyed values: 103.75 m water minus 101.25 m bed equals
 * 2.5 m, and 99.5 m water minus 100 m bed equals -0.5 m. Inputs are fixed test
 * values; no calculation or response is mocked. It does not read a map or
 * network response.
 */

// Promotion must replace this declaration with a real production import.
declare const calculateWaterDepth: (
  surveyedWaterElevationMeters: number,
  surveyedBedElevationMeters: number,
) => number;

describe.skip('CCT-E001 example', () => {
  it(
    'Water depth in meters equals the surveyed water elevation minus the surveyed bed elevation.',
    () => {
      expect(calculateWaterDepth(103.75, 101.25)).toBe(2.5);
      expect(calculateWaterDepth(99.5, 100)).toBe(-0.5);
    },
  );
});
