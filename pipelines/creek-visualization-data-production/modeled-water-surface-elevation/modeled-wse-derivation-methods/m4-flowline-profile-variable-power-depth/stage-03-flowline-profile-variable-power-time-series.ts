import { RATING_CURVE } from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { steepCreekSubsectionRoughness, variablePowerRoughnessN } from './flow-resistance.ts';
import {
  CHANNEL_FROM_MODELED_WSE_VERSION,
  M4_FLOWLINE_PROFILE_VARIABLE_POWER_DEPTH_METHOD,
  STEEP_CREEK_ROUGHNESS_BLEND,
  VARIABLE_POWER_FLOW_RESISTANCE,
} from './method-config.ts';
import { runSteepCreekTimeSeriesStage } from './steep-creek-time-series.ts';

/**
 * m4 Stage 3: m3 v2's Stage 3 on m3 v2's channel, with each subsection's Manning's n blended by slope toward the Ferguson & Recking
 * (2025) variable-power law. Writes `03-time-series/m4-flowline-profile-variable-power-depth/v<version>/`. Run with
 * `--modeled-wse-method=m4-flowline-profile-variable-power-depth`. See METHOD.md in this folder.
 */
await runSteepCreekTimeSeriesStage({
  method: M4_FLOWLINE_PROFILE_VARIABLE_POWER_DEPTH_METHOD,
  channelFromModeledWseVersion: CHANNEL_FROM_MODELED_WSE_VERSION,
  roughnessN: steepCreekSubsectionRoughness({
    manningN: { mainChannel: RATING_CURVE.manningRoughnessN, floodplain: RATING_CURVE.floodplainManningRoughnessN },
    steepLawN: (geometry, slope) => variablePowerRoughnessN(geometry, slope, VARIABLE_POWER_FLOW_RESISTANCE),
    blend: STEEP_CREEK_ROUGHNESS_BLEND,
  }),
  blend: STEEP_CREEK_ROUGHNESS_BLEND,
});
