import { roundToDecimals } from '../utm-geometry.ts';
import { bankTopIndices, wettedGeometryAt, type ProfileSample, type WettedGeometry } from './cross-section-geometry.ts';
import { CROSS_SECTION, RATING_CURVE } from './pipeline-configuration.ts';
import type { CrossSectionRecord, RatingCurveRecord } from './stage-file-formats.ts';

/**
 * Rating curve math: building one Creek Segment's curve (Stage 2) and inverting it (Stage 3).
 * This module does not run on import, so tests can call it on synthetic cross-sections.
 */

function manningDischarge(areaM2: number, wettedPerimeterM: number, slope: number, roughnessN: number): number {
  if (areaM2 <= 0 || wettedPerimeterM <= 0) return 0;
  const hydraulicRadiusM = areaM2 / wettedPerimeterM;
  return (1 / roughnessN) * areaM2 * hydraulicRadiusM ** (2 / 3) * Math.sqrt(slope);
}

/**
 * Manning's discharge on one cross-section dips where water first spills onto a flat bench:
 * the wetted perimeter jumps while the area barely grows, so R = A / P and Q fall.
 * A real channel never carries less water at a higher WSE, so the curve keeps the running
 * maximum (a flat step across the dip). The raw values stay in the file and the segment is flagged.
 */
function runningMaximum(values: readonly number[]): number[] {
  let highest = -Infinity;
  return values.map((value) => {
    highest = Math.max(highest, value);
    return highest;
  });
}

function isValidGeometry(geometry: WettedGeometry): boolean {
  return (
    Number.isFinite(geometry.areaM2) &&
    Number.isFinite(geometry.wettedPerimeterM) &&
    geometry.areaM2 >= 0 &&
    (geometry.areaM2 === 0 || geometry.wettedPerimeterM > 0)
  );
}

/**
 * Divided (compound) channel. The representative profile (already trimmed at its valley edges in
 * Stage 1) is split at its two bank tops into a left floodplain, a main channel, and a right
 * floodplain. A bank top is the highest ground on that side of the thalweg within the bank-top
 * search half-width of the TNC flowline (see `bankTopIndices`). The bank-top sample belongs to both
 * neighbouring subsections, so the split is a vertical line through it.
 */
interface DividedChannel {
  leftFloodplain: { profile: ProfileSample[]; seedIndex: number };
  mainChannel: { profile: ProfileSample[]; seedIndex: number };
  rightFloodplain: { profile: ProfileSample[]; seedIndex: number };
  leftBankTop: ProfileSample;
  rightBankTop: ProfileSample;
}

function divideChannel(profile: readonly ProfileSample[], thalwegIndex: number): DividedChannel {
  const banks = bankTopIndices(profile, thalwegIndex, CROSS_SECTION.bankTopSearchHalfWidthM);
  return {
    // Floodplain water enters over the bank top, so each floodplain's wetted run grows outward from it.
    leftFloodplain: { profile: profile.slice(0, banks.leftIndex + 1), seedIndex: banks.leftIndex },
    mainChannel: { profile: profile.slice(banks.leftIndex, banks.rightIndex + 1), seedIndex: thalwegIndex - banks.leftIndex },
    rightFloodplain: { profile: profile.slice(banks.rightIndex), seedIndex: 0 },
    leftBankTop: profile[banks.leftIndex] as ProfileSample,
    rightBankTop: profile[banks.rightIndex] as ProfileSample,
  };
}

/**
 * Wetted geometry of one subsection. Its own area and its own wetted ground only: the vertical
 * interface with the neighbouring subsection adds no wetted perimeter. A floodplain is dry until
 * the WSE rises above its bank top.
 */
function subsectionGeometry(subsection: { profile: ProfileSample[]; seedIndex: number }, wse: number): WettedGeometry {
  return wettedGeometryAt(subsection.profile, subsection.seedIndex, wse);
}

/**
 * The lower of the representative profile's valley-edge end elevations. A side that kept the untrimmed
 * half-section (Stage 1 valley-edge trim fallback) has no valley edge, so its end does not cap the
 * ladder; water there spills past the profile end instead. Null when neither end is a valley edge.
 */
function lowerValleyEdgeOf(section: CrossSectionRecord, profile: readonly ProfileSample[]): number | null {
  const representative = section.sections[section.representativeSectionIndex];
  const valleyEdgeEnds: number[] = [];
  if (!representative?.valleyEdgeTrimFallbackLeft) valleyEdgeEnds.push(profile[0]?.elevationM ?? Number.NaN);
  if (!representative?.valleyEdgeTrimFallbackRight) valleyEdgeEnds.push(profile[profile.length - 1]?.elevationM ?? Number.NaN);
  return valleyEdgeEnds.length === 0 ? null : Math.min(...valleyEdgeEnds);
}

/**
 * Manning's equation normal-depth rating curve for one Creek Segment's representative cross-section,
 * as a divided channel: Q = Σ (1/nᵢ) · Aᵢ · Rᵢ^(2/3) · S^(1/2), with Rᵢ = Aᵢ / Pᵢ for the main channel
 * (n = manningRoughnessN) and each floodplain (n = floodplainManningRoughnessN), on a WSE ladder from
 * the bed upward. Below the lower bank top only the main channel is wet, so Q equals the single-channel
 * result. The ladder top is the lower of the trimmed section's valley-edge end elevations (the lower
 * valley edge), with bed + maximumDepthAboveBedM as a safety cap.
 */
export function buildRatingCurveRecord(section: CrossSectionRecord): RatingCurveRecord {
  const flags: string[] = [];
  const profile: ProfileSample[] = section.profileOffsetsM.map((offsetM, index) => ({
    offsetM,
    elevationM: section.profileElevationsM[index] ?? Number.NaN,
  }));
  const thalwegIndex = profile.reduce(
    (best, sample, index) =>
      Math.abs(sample.elevationM - section.bedElevationM) < Math.abs((profile[best]?.elevationM ?? Infinity) - section.bedElevationM)
        ? index
        : best,
    0,
  );
  const channel = divideChannel(profile, thalwegIndex);
  const lowerValleyEdgeM = lowerValleyEdgeOf(section, profile);
  const maximumDepthCap = section.bedElevationM + RATING_CURVE.maximumDepthAboveBedM;
  const capReason = lowerValleyEdgeM !== null && lowerValleyEdgeM <= maximumDepthCap ? 'lower-valley-edge' : 'maximum-depth';
  const capElevationM = capReason === 'lower-valley-edge' ? (lowerValleyEdgeM as number) : maximumDepthCap;
  if (capElevationM - section.bedElevationM < CROSS_SECTION.valleyEdgeMinimumBankHeightM) {
    flags.push(`shallow-section: cap is less than ${CROSS_SECTION.valleyEdgeMinimumBankHeightM} m above the bed`);
  }
  const lowerBankTopM = Math.min(channel.leftBankTop.elevationM, channel.rightBankTop.elevationM);

  const stepMilli = Math.round(RATING_CURVE.wseStepM * 1000);
  const bedMilli = Math.round(section.bedElevationM * 1000);
  const capMilli = Math.round(capElevationM * 1000);
  const waterSurfaceElevationM: number[] = [];
  const areaM2: number[] = [];
  const wettedPerimeterM: number[] = [];
  const hydraulicRadiusM: number[] = [];
  const mainChannelDischargeM3s: number[] = [];
  const leftFloodplainDischargeM3s: number[] = [];
  const rightFloodplainDischargeM3s: number[] = [];
  const rawManningDischargeM3s: number[] = [];
  let invalidGeometrySteps = 0;
  let spillSteps = 0;
  let nonMonotonicSteps = 0;
  let overbankSteps = 0;
  for (let milli = bedMilli; milli <= capMilli; milli += stepMilli) {
    const wse = milli / 1000;
    const main = subsectionGeometry(channel.mainChannel, wse);
    const left = subsectionGeometry(channel.leftFloodplain, wse);
    const right = subsectionGeometry(channel.rightFloodplain, wse);
    if (![main, left, right].every(isValidGeometry)) {
      invalidGeometrySteps += 1;
      continue;
    }
    // Spilling means water reaches a valley edge (an end of the trimmed profile), not a bank top.
    if (wettedGeometryAt(profile, thalwegIndex, wse).spillsPastProfileEnd) spillSteps += 1;
    if (wse > lowerBankTopM) overbankSteps += 1;
    const mainDischarge = manningDischarge(main.areaM2, main.wettedPerimeterM, section.slope, RATING_CURVE.manningRoughnessN);
    const leftDischarge = manningDischarge(left.areaM2, left.wettedPerimeterM, section.slope, RATING_CURVE.floodplainManningRoughnessN);
    const rightDischarge = manningDischarge(right.areaM2, right.wettedPerimeterM, section.slope, RATING_CURVE.floodplainManningRoughnessN);
    const discharge = mainDischarge + leftDischarge + rightDischarge;
    const totalAreaM2 = main.areaM2 + left.areaM2 + right.areaM2;
    const totalWettedPerimeterM = main.wettedPerimeterM + left.wettedPerimeterM + right.wettedPerimeterM;
    const previous = rawManningDischargeM3s[rawManningDischargeM3s.length - 1];
    if (previous !== undefined && discharge <= previous && wse > section.bedElevationM) nonMonotonicSteps += 1;
    waterSurfaceElevationM.push(roundToDecimals(wse, 3));
    areaM2.push(roundToDecimals(totalAreaM2, 4));
    wettedPerimeterM.push(roundToDecimals(totalWettedPerimeterM, 4));
    hydraulicRadiusM.push(roundToDecimals(totalWettedPerimeterM > 0 ? totalAreaM2 / totalWettedPerimeterM : 0, 4));
    mainChannelDischargeM3s.push(roundToDecimals(mainDischarge, 5));
    leftFloodplainDischargeM3s.push(roundToDecimals(leftDischarge, 5));
    rightFloodplainDischargeM3s.push(roundToDecimals(rightDischarge, 5));
    rawManningDischargeM3s.push(roundToDecimals(discharge, 5));
  }
  if (invalidGeometrySteps > 0) flags.push(`invalid-geometry: ${invalidGeometrySteps} ladder steps dropped`);
  if (spillSteps > 0) flags.push(`spills-past-profile: ${spillSteps} ladder steps reach a valley edge`);
  if (nonMonotonicSteps > 0) {
    flags.push(`non-monotonic-discharge: ${nonMonotonicSteps} ladder steps held at the running maximum`);
  }
  if (section.slopeFloored) flags.push('min-slope: slope floored in Stage 1');
  return {
    segmentId: section.segmentId,
    bedElevationM: section.bedElevationM,
    slope: section.slope,
    capElevationM: roundToDecimals(capElevationM, 3),
    capReason,
    lowerValleyEdgeM: lowerValleyEdgeM === null ? null : roundToDecimals(lowerValleyEdgeM, 3),
    leftBankTop: { offsetM: channel.leftBankTop.offsetM, elevationM: roundToDecimals(channel.leftBankTop.elevationM, 3) },
    rightBankTop: { offsetM: channel.rightBankTop.offsetM, elevationM: roundToDecimals(channel.rightBankTop.elevationM, 3) },
    overbankLadderSteps: overbankSteps,
    waterSurfaceElevationM,
    areaM2,
    wettedPerimeterM,
    hydraulicRadiusM,
    mainChannelDischargeM3s,
    leftFloodplainDischargeM3s,
    rightFloodplainDischargeM3s,
    rawManningDischargeM3s,
    dischargeM3s: runningMaximum(rawManningDischargeM3s),
    flags,
  };
}

export type InversionOutcome = 'bed' | 'interpolated' | 'clamped' | 'missing';

/**
 * Discharge → water-surface elevation (WSE) on one rating curve.
 * - null or non-finite discharge → null (missing)
 * - discharge ≤ 0 → bed elevation
 * - otherwise the lowest WSE whose discharge reaches the target, linearly interpolated
 *   between ladder steps. Stage 2 stores discharge as a running maximum, so the curve never
 *   falls; on a flat step (bench spill) the first crossing picks the lower WSE.
 * - above the curve's largest discharge → the curve's top WSE (clamped)
 */
export function invertRatingCurve(
  curve: RatingCurveRecord,
  dischargeM3s: number | null,
): { wseM: number | null; outcome: InversionOutcome } {
  if (dischargeM3s === null || !Number.isFinite(dischargeM3s)) return { wseM: null, outcome: 'missing' };
  if (dischargeM3s <= 0) return { wseM: curve.bedElevationM, outcome: 'bed' };
  const discharges = curve.dischargeM3s;
  const elevations = curve.waterSurfaceElevationM;
  for (let index = 1; index < discharges.length; index += 1) {
    const upper = discharges[index] as number;
    if (upper < dischargeM3s) continue;
    const lower = discharges[index - 1] as number;
    const lowerWse = elevations[index - 1] as number;
    const upperWse = elevations[index] as number;
    const fraction = upper === lower ? 0 : (dischargeM3s - lower) / (upper - lower);
    return { wseM: lowerWse + Math.max(0, Math.min(1, fraction)) * (upperWse - lowerWse), outcome: 'interpolated' };
  }
  const topIndex = discharges.reduce((best, value, index) => (value > (discharges[best] ?? -Infinity) ? index : best), 0);
  return { wseM: elevations[topIndex] ?? curve.bedElevationM, outcome: 'clamped' };
}
