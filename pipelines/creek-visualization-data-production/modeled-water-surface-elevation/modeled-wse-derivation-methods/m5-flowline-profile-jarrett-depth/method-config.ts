import type { ModeledWseDerivationMethodConfig } from '../modeled-wse-derivation-method.ts';
import { M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD } from '../m3-flowline-profile-manning-depth/method-config.ts';
import {
  CHANNEL_FROM_MODELED_WSE_VERSION,
  STEEP_CREEK_ROUGHNESS_BLEND,
  STEEP_CREEK_SHARED_CODE_FILES,
} from '../m4-flowline-profile-variable-power-depth/method-config.ts';

/**
 * Modeled WSE Derivation Method `m5-flowline-profile-jarrett-depth`: m4 with Jarrett's (1984) flow-resistance law instead of the
 * variable-power law. It needs no grain size. The channel source, the blend from Manning's n by slope, the rating-curve builder, the
 * anchor section and Stage 3 are m4's (imported), so an m4 − m5 difference comes from the law alone, and an m3 v2 − m5 difference
 * from the roughness alone. Read METHOD.md in this folder. Every value below changes this method's output, so bump `version` with it.
 */

/**
 * Jarrett (1984), SI form: n = 0.32 S^0.38 R^−0.16 (US customary 0.39 with R in feet; 0.39 × 3.281^−0.16 = 0.32). Fitted on 75
 * measurements in 21 Colorado cobble and boulder streams at slopes 0.2–4% and hydraulic radii 0.15–2.1 m. Applied to each wetted
 * subsection with R = A/P.
 */
export const JARRETT_FLOW_RESISTANCE = {
  coefficient: 0.32,
  slopeExponent: 0.38,
  hydraulicRadiusExponent: -0.16,
  hydraulicRadius: 'A / P of the wetted subsection',
  citation: 'Jarrett, R.D. (1984), Hydraulics of high-gradient streams, Journal of Hydraulic Engineering 110(11):1519–1539, doi:10.1061/(ASCE)0733-9429(1984)110:11(1519)',
} as const;

const PIPELINE_CODE_FOLDER = 'pipelines/creek-visualization-data-production';
const M4_CODE_FOLDER = `${PIPELINE_CODE_FOLDER}/modeled-water-surface-elevation/modeled-wse-derivation-methods/m4-flowline-profile-variable-power-depth`;

export const M5_FLOWLINE_PROFILE_JARRETT_DEPTH_METHOD = {
  id: 'm5-flowline-profile-jarrett-depth',
  methodNumber: 5,
  version: 1,
  label: 'Flowline channel profile (Jarrett steep-creek depth)',
  description:
    'm3 v2’s channel, raw lidar bed, anchor cross-section, discharge and pool-filled water surface, with a steep-creek roughness: ' +
    'Jarrett (1984), n = 0.32 S^0.38 R^−0.16, which needs no grain size, blended from Manning’s n 0.04/0.07 over 2–8% slope as in m4.',
  changeType: 'new method',
  changeNote: 'New method: m3 v2 with Jarrett’s (1984) flow resistance on slopes above 2% (full law from 8%), the same blend as m4.',
  sharedCodeFiles: [
    ...STEEP_CREEK_SHARED_CODE_FILES,
    ...['flow-resistance.ts', 'steep-creek-rating-curve.ts', 'steep-creek-anchor-section.ts', 'steep-creek-time-series.ts', 'method-config.ts'].map(
      (fileName) => `${M4_CODE_FOLDER}/${fileName}`,
    ),
  ],
  parameters: {
    ...M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD.parameters,
    sharedWithM3: 'everything of m3 v2 except the flow resistance: channel, bed, anchor, anchor section, slope, discharge, ladder, inversion, dry rule, junction depths, pool-filled water surface, Time Series fields',
    channelFromModeledWseVersion: CHANNEL_FROM_MODELED_WSE_VERSION,
    steepCreekRoughnessBlend: STEEP_CREEK_ROUGHNESS_BLEND,
    flowResistance: JARRETT_FLOW_RESISTANCE,
  },
} as const satisfies ModeledWseDerivationMethodConfig;
