/**
 * Steep-creek flow resistance as an effective Manning's n of one wetted subsection (main channel or one floodplain) at one ladder
 * step: the Ferguson & Recking (2025) calibrated variable-power law, and the blend from Manning's fixed n to a steep-creek law by
 * slope that m4 and m5 share. Pure functions of the subsection's geometry, the slope and constants passed in, so any cross-section
 * can use them and m5 can import the blend without m4's settings.
 */

const GRAVITY_M_PER_S2 = 9.81;

export type ChannelSubsection = 'mainChannel' | 'floodplain';

/** What a resistance law needs of one wetted subsection; the shape of `wettedGeometryAt`'s result. */
export interface SubsectionGeometry {
  areaM2: number;
  wettedPerimeterM: number;
  topWidthM: number;
}

/** Effective Manning's n of one wetted subsection (area and wetted perimeter both above 0) at slope S. */
export type SubsectionRoughnessN = (subsection: ChannelSubsection, geometry: SubsectionGeometry, slope: number) => number;

/** A steep-creek law's effective Manning's n of one wetted subsection, before the blend. */
export type SteepLawRoughnessN = (geometry: SubsectionGeometry, slope: number) => number;

export interface SteepCreekRoughnessBlend {
  /** At or below this slope (m/m) the steep law has no weight: Manning's fixed n exactly. */
  manningOnlyAtOrBelowSlope: number;
  /** At or above this slope the steep law has full weight. */
  steepLawOnlyAtOrAboveSlope: number;
}

/** Weight of the steep law: 0 at or below the lower slope, 1 at or above the upper slope, linear in log(slope) between. */
export function steepLawWeight(slope: number, blend: SteepCreekRoughnessBlend): number {
  if (slope <= blend.manningOnlyAtOrBelowSlope) return 0;
  if (slope >= blend.steepLawOnlyAtOrAboveSlope) return 1;
  return Math.log(slope / blend.manningOnlyAtOrBelowSlope) / Math.log(blend.steepLawOnlyAtOrAboveSlope / blend.manningOnlyAtOrBelowSlope);
}

/**
 * ln n = (1 − w) ln n_Manning + w ln max(n_Manning, n_steep), w = `steepLawWeight`. The steep n is floored at Manning's, so the blend
 * never makes water faster than Manning would. Weight 0 returns `manningN` itself, so flat creeks get m3's arithmetic exactly.
 */
export function blendedRoughnessN(manningN: number, steepLawN: number, slope: number, blend: SteepCreekRoughnessBlend): number {
  const weight = steepLawWeight(slope, blend);
  if (weight === 0) return manningN;
  const flooredSteepN = Math.max(manningN, steepLawN);
  return Math.exp((1 - weight) * Math.log(manningN) + weight * Math.log(flooredSteepN));
}

/** Per-subsection roughness: Manning's fixed n of the subsection (main channel or floodplain) blended toward the steep law by slope. */
export function steepCreekSubsectionRoughness(input: {
  manningN: Readonly<Record<ChannelSubsection, number>>;
  steepLawN: SteepLawRoughnessN;
  blend: SteepCreekRoughnessBlend;
}): SubsectionRoughnessN {
  return (subsection, geometry, slope) => {
    const manningN = input.manningN[subsection];
    // The steep law is not evaluated where it has no weight.
    if (steepLawWeight(slope, input.blend) === 0) return manningN;
    return blendedRoughnessN(manningN, input.steepLawN(geometry, slope), slope, input.blend);
  };
}

/** n_eff = R^(2/3) S^(1/2) / U: the Manning's n that gives velocity U on hydraulic radius R at slope S. */
export function effectiveRoughnessN(hydraulicRadiusM: number, slope: number, velocityMs: number): number {
  return (hydraulicRadiusM ** (2 / 3) * Math.sqrt(slope)) / velocityMs;
}

/**
 * Ferguson & Recking (2025) calibrated variable-power equation (VPEc), in the dimensionless hydraulic-geometry form:
 * U** = coefficient · q**^exponent · (1 + deepFlowCoefficient · q**^exponent)^deepFlowExponent, with U** = U / √(g S D84) and
 * q** = q / √(g S D84³), q = U · h the discharge per meter of width.
 */
export interface VariablePowerLaw {
  coefficient: number;
  exponent: number;
  deepFlowCoefficient: number;
  deepFlowExponent: number;
  /** D84 = referenceM × (S / referenceSlope)^slopeExponent, meters: assumed from slope (no grain-size data). */
  d84: { referenceM: number; referenceSlope: number; slopeExponent: number };
}

export function d84ForSlopeM(slope: number, law: VariablePowerLaw): number {
  return law.d84.referenceM * (slope / law.d84.referenceSlope) ** law.d84.slopeExponent;
}

/**
 * Mean velocity (m/s) at mean depth h (m) on slope S with grain size D84 (m). Since q** = U** · h / D84, the law is solved for U**
 * by bisection in log space: below the root the law's U** exceeds the guess, above it falls short (the law grows slower than U**).
 */
export function variablePowerVelocityMs(meanDepthM: number, slope: number, d84M: number, law: VariablePowerLaw): number {
  const relativeDepth = meanDepthM / d84M;
  const lawVelocity = (dimensionlessVelocity: number): number => {
    const flow = (dimensionlessVelocity * relativeDepth) ** law.exponent;
    return law.coefficient * flow * (1 + law.deepFlowCoefficient * flow) ** law.deepFlowExponent;
  };
  let low = 1e-12;
  let high = 1e3;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = Math.sqrt(low * high);
    if (lawVelocity(middle) > middle) low = middle;
    else high = middle;
  }
  return Math.sqrt(low * high) * Math.sqrt(GRAVITY_M_PER_S2 * slope * d84M);
}

/** VPEc as an effective Manning's n of one subsection: velocity from its mean depth A/T, n from its hydraulic radius A/P. */
export function variablePowerRoughnessN(geometry: SubsectionGeometry, slope: number, law: VariablePowerLaw): number {
  const velocityMs = variablePowerVelocityMs(geometry.areaM2 / geometry.topWidthM, slope, d84ForSlopeM(slope, law), law);
  return effectiveRoughnessN(geometry.areaM2 / geometry.wettedPerimeterM, slope, velocityMs);
}
