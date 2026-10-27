import { RATING_CURVE } from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { steepCreekSubsectionRoughness } from '../m4-flowline-profile-variable-power-depth/flow-resistance.ts';
import { CHANNEL_FROM_MODELED_WSE_VERSION, STEEP_CREEK_ROUGHNESS_BLEND } from '../m4-flowline-profile-variable-power-depth/method-config.ts';
import { runSteepCreekTimeSeriesStage } from '../m4-flowline-profile-variable-power-depth/steep-creek-time-series.ts';
import { jarrettRoughnessN } from './flow-resistance.ts';
import { JARRETT_FLOW_RESISTANCE, M5_FLOWLINE_PROFILE_JARRETT_DEPTH_METHOD } from './method-config.ts';

/**
 * m5 Stage 3: m4's Stage 3 (m3 v2's, on m3 v2's channel) with each subsection's Manning's n blended by slope toward Jarrett's (1984)
 * law. Writes `03-time-series/m5-flowline-profile-jarrett-depth/v<version>/`. Run with
 * `--modeled-wse-method=m5-flowline-profile-jarrett-depth`. See METHOD.md in this folder.
 */
await runSteepCreekTimeSeriesStage({
  method: M5_FLOWLINE_PROFILE_JARRETT_DEPTH_METHOD,
  channelFromModeledWseVersion: CHANNEL_FROM_MODELED_WSE_VERSION,
  roughnessN: steepCreekSubsectionRoughness({
    manningN: { mainChannel: RATING_CURVE.manningRoughnessN, floodplain: RATING_CURVE.floodplainManningRoughnessN },
    steepLawN: (geometry, slope) => jarrettRoughnessN(geometry, slope, JARRETT_FLOW_RESISTANCE),
    blend: STEEP_CREEK_ROUGHNESS_BLEND,
  }),
  blend: STEEP_CREEK_ROUGHNESS_BLEND,
});
