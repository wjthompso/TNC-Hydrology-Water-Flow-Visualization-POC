import { M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD } from './m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import type { ModeledWseDerivationMethodConfig } from './modeled-wse-derivation-method.ts';

/**
 * Every Modeled WSE Derivation Method, oldest first. Configs only: no pipeline code is loaded here.
 * Add a method by adding its folder (`method-config.ts` and `METHOD.md`) and registering it here.
 */
export const MODELED_WSE_DERIVATION_METHODS: readonly ModeledWseDerivationMethodConfig[] = [
  M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD,
];

/**
 * The method and version Stages 0–5 run. Its folder's constants are what the stage code imports, so
 * this is the version the working tree's code produces. Stage 3 writes it to
 * `03-time-series/<method-id>/v<version>/`.
 */
export const CURRENT_MODELED_WSE_DERIVATION_METHOD: ModeledWseDerivationMethodConfig =
  M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD;

for (const method of MODELED_WSE_DERIVATION_METHODS) {
  if (!method.id.startsWith(`m${method.methodNumber}-`)) {
    throw new Error(`Modeled WSE Derivation Method id ${method.id} must start with m${method.methodNumber}- (its method number).`);
  }
}
