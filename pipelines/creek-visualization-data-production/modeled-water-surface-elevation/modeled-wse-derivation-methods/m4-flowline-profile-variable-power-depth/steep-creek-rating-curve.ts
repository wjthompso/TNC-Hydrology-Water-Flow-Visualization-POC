import { roundToDecimals } from '../../../utm-geometry.ts';
import { bankTopIndices, wettedGeometryAt, type ProfileSample, type WettedGeometry } from '../../cross-section-geometry.ts';
import { CROSS_SECTION, RATING_CURVE } from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import type { CrossSectionRecord, RatingCurveRecord } from '../../stage-file-formats.ts';
import type { ChannelSubsection, SubsectionRoughnessN } from './flow-resistance.ts';

/**
 * A copy of `buildRatingCurveRecord` (rating-curve-inversion.ts) in which each subsection's Manning's n comes from a function of its
 * wetted geometry and the slope instead of a constant. The shared builder is left untouched because m1–m3 fingerprint it. Everything
 * else is the shared builder's: the divided channel split at the bank tops, the ladder from the bed to the lower valley edge (or bed +
 * maximum depth), the 2 cm step, the flags and the running maximum. With a roughness function that returns 0.04 and 0.07, the result
 * equals the shared builder's, value for value. m5 imports this file.
 */

/** Plus the top width of the wet subsections at each step, so velocity, Froude number and effective n can be reported at the anchor. */
export interface SteepCreekRatingCurveRecord extends RatingCurveRecord {
  topWidthM: number[];
}

function manningDischarge(areaM2: number, wettedPerimeterM: number, slope: number, roughnessN: number): number {
  if (areaM2 <= 0 || wettedPerimeterM <= 0) return 0;
  const hydraulicRadiusM = areaM2 / wettedPerimeterM;
  return (1 / roughnessN) * areaM2 * hydraulicRadiusM ** (2 / 3) * Math.sqrt(slope);
}

/** Discharge of one subsection; the roughness function is asked only for a wetted subsection. */
function subsectionDischarge(subsection: ChannelSubsection, geometry: WettedGeometry, slope: number, roughnessN: SubsectionRoughnessN): number {
  if (geometry.areaM2 <= 0 || geometry.wettedPerimeterM <= 0) return 0;
  return manningDischarge(geometry.areaM2, geometry.wettedPerimeterM, slope, roughnessN(subsection, geometry, slope));
}

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
    leftFloodplain: { profile: profile.slice(0, banks.leftIndex + 1), seedIndex: banks.leftIndex },
    mainChannel: { profile: profile.slice(banks.leftIndex, banks.rightIndex + 1), seedIndex: thalwegIndex - banks.leftIndex },
    rightFloodplain: { profile: profile.slice(banks.rightIndex), seedIndex: 0 },
    leftBankTop: profile[banks.leftIndex] as ProfileSample,
    rightBankTop: profile[banks.rightIndex] as ProfileSample,
  };
}

function lowerValleyEdgeOf(section: CrossSectionRecord, profile: readonly ProfileSample[]): number | null {
  const representative = section.sections[section.representativeSectionIndex];
  const valleyEdgeEnds: number[] = [];
  if (!representative?.valleyEdgeTrimFallbackLeft) valleyEdgeEnds.push(profile[0]?.elevationM ?? Number.NaN);
  if (!representative?.valleyEdgeTrimFallbackRight) valleyEdgeEnds.push(profile[profile.length - 1]?.elevationM ?? Number.NaN);
  return valleyEdgeEnds.length === 0 ? null : Math.min(...valleyEdgeEnds);
}

/** Q = Σ (1/nᵢ) · Aᵢ · Rᵢ^(2/3) · S^(1/2) over the main channel and the two floodplains, nᵢ = roughnessN(subsection, geometryᵢ, S). */
export function buildSteepCreekRatingCurveRecord(section: CrossSectionRecord, roughnessN: SubsectionRoughnessN): SteepCreekRatingCurveRecord {
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
  const topWidthM: number[] = [];
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
    const main = wettedGeometryAt(channel.mainChannel.profile, channel.mainChannel.seedIndex, wse);
    const left = wettedGeometryAt(channel.leftFloodplain.profile, channel.leftFloodplain.seedIndex, wse);
    const right = wettedGeometryAt(channel.rightFloodplain.profile, channel.rightFloodplain.seedIndex, wse);
    if (![main, left, right].every(isValidGeometry)) {
      invalidGeometrySteps += 1;
      continue;
    }
    if (wettedGeometryAt(profile, thalwegIndex, wse).spillsPastProfileEnd) spillSteps += 1;
    if (wse > lowerBankTopM) overbankSteps += 1;
    const mainDischarge = subsectionDischarge('mainChannel', main, section.slope, roughnessN);
    const leftDischarge = subsectionDischarge('floodplain', left, section.slope, roughnessN);
    const rightDischarge = subsectionDischarge('floodplain', right, section.slope, roughnessN);
    const discharge = mainDischarge + leftDischarge + rightDischarge;
    const totalAreaM2 = main.areaM2 + left.areaM2 + right.areaM2;
    const totalWettedPerimeterM = main.wettedPerimeterM + left.wettedPerimeterM + right.wettedPerimeterM;
    const previous = rawManningDischargeM3s[rawManningDischargeM3s.length - 1];
    if (previous !== undefined && discharge <= previous && wse > section.bedElevationM) nonMonotonicSteps += 1;
    waterSurfaceElevationM.push(roundToDecimals(wse, 3));
    areaM2.push(roundToDecimals(totalAreaM2, 4));
    wettedPerimeterM.push(roundToDecimals(totalWettedPerimeterM, 4));
    hydraulicRadiusM.push(roundToDecimals(totalWettedPerimeterM > 0 ? totalAreaM2 / totalWettedPerimeterM : 0, 4));
    topWidthM.push(roundToDecimals(main.topWidthM + left.topWidthM + right.topWidthM, 4));
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
    topWidthM,
    mainChannelDischargeM3s,
    leftFloodplainDischargeM3s,
    rightFloodplainDischargeM3s,
    rawManningDischargeM3s,
    dischargeM3s: runningMaximum(rawManningDischargeM3s),
    flags,
  };
}
