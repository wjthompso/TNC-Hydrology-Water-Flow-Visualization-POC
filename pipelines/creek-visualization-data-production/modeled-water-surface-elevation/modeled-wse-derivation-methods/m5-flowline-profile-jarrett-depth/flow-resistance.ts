import type { SubsectionGeometry } from '../m4-flowline-profile-variable-power-depth/flow-resistance.ts';

/**
 * Jarrett (1984) flow resistance for one wetted subsection. The blend from Manning's fixed n by slope is m4's (`blendedRoughnessN` and
 * `steepCreekSubsectionRoughness` in m4's flow-resistance.ts), so an m4 − m5 difference comes from the law alone.
 */

/** n = coefficient · S^slopeExponent · R^hydraulicRadiusExponent, R in meters (SI form). */
export interface JarrettLaw {
  coefficient: number;
  slopeExponent: number;
  hydraulicRadiusExponent: number;
}

/** Jarrett's n of one subsection, from its hydraulic radius A/P. */
export function jarrettRoughnessN(geometry: SubsectionGeometry, slope: number, law: JarrettLaw): number {
  const hydraulicRadiusM = geometry.areaM2 / geometry.wettedPerimeterM;
  return law.coefficient * slope ** law.slopeExponent * hydraulicRadiusM ** law.hydraulicRadiusExponent;
}
