import type { ModeledWseDerivationMethodConfig } from '../modeled-wse-derivation-method.ts';
import { M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD } from '../m3-flowline-profile-manning-depth/method-config.ts';

/**
 * Modeled WSE Derivation Method `m4-flowline-profile-variable-power-depth`: m3 v2 in every respect (channel, raw lidar bed, anchor,
 * anchor cross-section, slope, discharge, ladder, inversion, junction depths, smoothed pool-filled water surface, Time Series fields)
 * except the flow resistance. On steep creeks the roughness rises with slope following the Ferguson & Recking (2025) calibrated
 * variable-power law, blended from m3's Manning's n by slope. Read METHOD.md in this folder.
 *
 * m3 v2's constants and code are imported, not copied, except where m3's code hard-wires the shared rating-curve builder (the anchor
 * section cut and the Stage 3 orchestration, copied into this folder). m5 uses this folder's steep-creek files with its own law.
 * Every value below changes this method's output, so bump `version` with it (see METHODOLOGY.md "Modeled WSE Derivation Methods").
 */

/**
 * The Modeled WSE version whose channel this method solves on. Stage 3 refuses to run unless m3's code still has that version's saved
 * fingerprint, so the channel, station beds and anchors are exactly the ones `flowline-channel-ribbon` v2 was built on, and records
 * the version as `channelFromModeledWseVersion` in its manifest so ribbon v2 can draw this method's Time Series.
 */
export const CHANNEL_FROM_MODELED_WSE_VERSION = {
  methodId: M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD.id,
  version: 2,
} as const;

/**
 * Where the steep law applies: Manning's fixed n (m3's 0.04 main channel, 0.07 floodplain) at or below 2% slope, the full steep law at or
 * above 8%, and between them ln n interpolated linearly in ln slope, so depth has no jump where the law changes. Each subsection (main
 * channel, each floodplain) is blended with its own Manning's n, and the steep n is floored at that Manning's n.
 */
export const STEEP_CREEK_ROUGHNESS_BLEND = {
  manningOnlyAtOrBelowSlope: 0.02,
  steepLawOnlyAtOrAboveSlope: 0.08,
  rule: 'per wetted subsection at every ladder step: w = 0 at S ≤ manningOnlyAtOrBelowSlope, 1 at S ≥ steepLawOnlyAtOrAboveSlope, ln(S / lower) / ln(upper / lower) between; ln n = (1 − w) ln n_Manning + w ln max(n_Manning, n_steep)',
} as const;

/**
 * Ferguson & Recking (2025) calibrated variable-power equation (VPEc, their eq. 19): U** = 1.6 q**^0.6 (1 + 0.1 q**^0.6)^−0.33 with
 * U** = U / √(g S D84) and q** = q / √(g S D84³), q = U h the discharge per meter of width. Fitted on 2,717 field measurements at
 * slopes 0.009–18% and relative depths h/D84 0.2–183. Applied to each wetted subsection with h = its mean depth A/T, and turned into an
 * effective n = R^(2/3) S^(1/2) / U with R = A/P. No grain sizes were measured on the Preserve, so D84 is assumed from slope:
 * 0.25 m × (S / 0.10)^0.5 (0.18 m at 5%, 0.25 m at 10%, 0.35 m at 20%, 0.62 m at 61%). In the law's shallow limit U ∝ S^0.2 D84^−0.4,
 * so this exponent makes velocity nearly independent of slope, as Comiti et al. (2007) and Schneider et al. (2015) measured.
 */
export const VARIABLE_POWER_FLOW_RESISTANCE = {
  coefficient: 1.6,
  exponent: 0.6,
  deepFlowCoefficient: 0.1,
  deepFlowExponent: -0.33,
  d84: { referenceM: 0.25, referenceSlope: 0.1, slopeExponent: 0.5 },
  meanDepth: 'A / T of the wetted subsection',
  citation: 'Ferguson, R. & Recking, A. (2025), Water Resources Research 61, e2024WR038852, doi:10.1029/2024WR038852 (eq. 19)',
  d84Basis:
    'assumed, no grain-size data: between fish-ladder D84 0.18–0.26 m at 2.6–10% (D’Agostino & Michelini 2015) and alpine step-pool D84 0.33–0.63 m at 8–21% (Comiti et al. 2007, doi:10.1016/j.jhydrol.2007.03.021); ' +
    'roughness ∝ S^0.74 above 6% and velocity nearly constant with slope at the Riedbach, 2.8–41% (Schneider et al. 2015, doi:10.1002/2015WR016934)',
} as const;

const PIPELINE_CODE_FOLDER = 'pipelines/creek-visualization-data-production';
const MODELED_WSE_CODE_FOLDER = `${PIPELINE_CODE_FOLDER}/modeled-water-surface-elevation`;
const M3_CODE_FOLDER = `${MODELED_WSE_CODE_FOLDER}/modeled-wse-derivation-methods/m3-flowline-profile-manning-depth`;

/**
 * Code outside this folder that m4's output depends on: m3's shared code list (less the shared rating-curve builder, which m4 does not
 * run) and the m3 v2 files imported for the channel, anchors, junction depths, pool filling and inversion. m5 adds this folder's files.
 */
export const STEEP_CREEK_SHARED_CODE_FILES = [
  ...M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD.sharedCodeFiles.filter((file) => file !== `${MODELED_WSE_CODE_FOLDER}/rating-curve-inversion.ts`),
  ...[
    'flowline-channel.ts',
    'lidar-mosaic.ts',
    'series-smoothing.ts',
    'junction-depths.ts',
    'pool-filled-water-surface.ts',
    'rating-curve-lookup.ts',
    'method-config.ts',
  ].map((fileName) => `${M3_CODE_FOLDER}/${fileName}`),
];

export const M4_FLOWLINE_PROFILE_VARIABLE_POWER_DEPTH_METHOD = {
  id: 'm4-flowline-profile-variable-power-depth',
  methodNumber: 4,
  version: 1,
  label: 'Flowline channel profile (variable-power steep-creek depth)',
  description:
    'm3 v2’s channel, raw lidar bed, anchor cross-section, discharge and pool-filled water surface, with a steep-creek roughness: ' +
    'the Ferguson & Recking (2025) variable-power flow-resistance law with D84 assumed from slope, blended from Manning’s n 0.04/0.07 over 2–8% slope.',
  changeType: 'new method',
  changeNote: 'New method: m3 v2 with the Ferguson & Recking (2025) VPEc flow resistance on slopes above 2% (full law from 8%), D84 = 0.25 m × (S/0.10)^0.5.',
  sharedCodeFiles: STEEP_CREEK_SHARED_CODE_FILES,
  parameters: {
    ...M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD.parameters,
    sharedWithM3: 'everything of m3 v2 except the flow resistance: channel, bed, anchor, anchor section, slope, discharge, ladder, inversion, dry rule, junction depths, pool-filled water surface, Time Series fields',
    channelFromModeledWseVersion: CHANNEL_FROM_MODELED_WSE_VERSION,
    steepCreekRoughnessBlend: STEEP_CREEK_ROUGHNESS_BLEND,
    flowResistance: VARIABLE_POWER_FLOW_RESISTANCE,
  },
} as const satisfies ModeledWseDerivationMethodConfig;
