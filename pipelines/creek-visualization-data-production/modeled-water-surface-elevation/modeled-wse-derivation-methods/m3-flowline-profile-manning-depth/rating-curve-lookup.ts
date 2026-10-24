import type { InversionOutcome } from '../../rating-curve-inversion.ts';
import type { RatingCurveRecord } from '../../stage-file-formats.ts';

/**
 * Discharge → water-surface elevation on one rating curve, with the same rules and results as
 * `invertRatingCurve` in rating-curve-inversion.ts, found by binary search instead of a linear scan.
 * m2 inverts three curves per value (about 460 million inversions in the preserve), so the scan
 * would dominate Stage 3. The search is valid because Stage 2's `dischargeM3s` (and
 * `buildRatingCurveRecord`) store the running maximum, so discharge never falls up the ladder.
 *
 * - null or non-finite discharge → null (missing)
 * - discharge ≤ 0 → bed elevation
 * - otherwise the lowest ladder step (index ≥ 1) whose discharge reaches the target, linearly
 *   interpolated from the step below it
 * - above the curve's largest discharge → the WSE of the first step holding that largest discharge (clamped)
 */
export function lookUpRatingCurve(curve: RatingCurveRecord, dischargeM3s: number | null): { wseM: number | null; outcome: InversionOutcome } {
  if (dischargeM3s === null || !Number.isFinite(dischargeM3s)) return { wseM: null, outcome: 'missing' };
  if (dischargeM3s <= 0) return { wseM: curve.bedElevationM, outcome: 'bed' };
  const discharges = curve.dischargeM3s;
  const elevations = curve.waterSurfaceElevationM;
  const lastIndex = discharges.length - 1;
  if (lastIndex >= 1 && (discharges[lastIndex] as number) >= dischargeM3s) {
    // Lowest index in [1, lastIndex] whose discharge reaches the target.
    let low = 1;
    let high = lastIndex;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((discharges[middle] as number) >= dischargeM3s) high = middle;
      else low = middle + 1;
    }
    const upper = discharges[low] as number;
    const lower = discharges[low - 1] as number;
    const lowerWse = elevations[low - 1] as number;
    const upperWse = elevations[low] as number;
    const fraction = upper === lower ? 0 : (dischargeM3s - lower) / (upper - lower);
    return { wseM: lowerWse + Math.max(0, Math.min(1, fraction)) * (upperWse - lowerWse), outcome: 'interpolated' };
  }
  return { wseM: elevations[firstIndexOfLargestDischarge(discharges)] ?? curve.bedElevationM, outcome: 'clamped' };
}

/** Same as `invertRatingCurve`'s top index: the first step holding the largest discharge. */
function firstIndexOfLargestDischarge(discharges: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < discharges.length; index += 1) {
    if ((discharges[index] as number) > (discharges[best] as number)) best = index;
  }
  return best;
}
