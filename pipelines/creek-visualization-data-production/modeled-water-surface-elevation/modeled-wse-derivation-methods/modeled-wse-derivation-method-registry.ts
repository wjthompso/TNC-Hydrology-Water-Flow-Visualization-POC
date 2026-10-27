import { M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD } from './m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { M2_MULTI_SECTION_MANNING_DEPTH_METHOD } from './m2-multi-section-manning-depth/method-config.ts';
import { M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD } from './m3-flowline-profile-manning-depth/method-config.ts';
import { M4_FLOWLINE_PROFILE_VARIABLE_POWER_DEPTH_METHOD } from './m4-flowline-profile-variable-power-depth/method-config.ts';
import { M5_FLOWLINE_PROFILE_JARRETT_DEPTH_METHOD } from './m5-flowline-profile-jarrett-depth/method-config.ts';
import type { ModeledWseDerivationMethodConfig } from './modeled-wse-derivation-method.ts';

/**
 * Every Modeled WSE Derivation Method, oldest first. Configs only: no pipeline code is loaded here.
 * Add a method by adding its folder (`method-config.ts` and `METHOD.md`) and registering it here.
 */
export const MODELED_WSE_DERIVATION_METHODS: readonly ModeledWseDerivationMethodConfig[] = [
  M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD,
  M2_MULTI_SECTION_MANNING_DEPTH_METHOD,
  M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD,
  M4_FLOWLINE_PROFILE_VARIABLE_POWER_DEPTH_METHOD,
  M5_FLOWLINE_PROFILE_JARRETT_DEPTH_METHOD,
];

/**
 * The method and version Stages 0–5 run. Its folder's constants are what the stage code imports, so
 * this is the version the working tree's code produces. Stage 3 writes it to
 * `03-time-series/<method-id>/v<version>/`.
 */
export const CURRENT_MODELED_WSE_DERIVATION_METHOD: ModeledWseDerivationMethodConfig =
  M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD;

export function modeledWseDerivationMethodById(methodId: string): ModeledWseDerivationMethodConfig {
  const method = MODELED_WSE_DERIVATION_METHODS.find((candidate) => candidate.id === methodId);
  if (!method) {
    throw new Error(
      `Unknown Modeled WSE Derivation Method "${methodId}". Use one of: ${MODELED_WSE_DERIVATION_METHODS.map((candidate) => candidate.id).join(', ')}.`,
    );
  }
  return method;
}

/**
 * `--modeled-wse-method=<id>` selects which saved modeled WSE method Stages 4 and 5 read (and which one a
 * method's own Stage 3 entry writes). Without it, the current method. Stages 0–3 of m1 ignore the flag.
 */
export function requestedModeledWseDerivationMethod(argv: readonly string[]): ModeledWseDerivationMethodConfig {
  const prefix = '--modeled-wse-method=';
  const flag = argv.find((argument) => argument.startsWith(prefix));
  return flag ? modeledWseDerivationMethodById(flag.slice(prefix.length)) : CURRENT_MODELED_WSE_DERIVATION_METHOD;
}

for (const method of MODELED_WSE_DERIVATION_METHODS) {
  if (!method.id.startsWith(`m${method.methodNumber}-`)) {
    throw new Error(`Modeled WSE Derivation Method id ${method.id} must start with m${method.methodNumber}- (its method number).`);
  }
}
