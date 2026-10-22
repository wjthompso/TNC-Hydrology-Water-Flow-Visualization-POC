/**
 * Shapes shared by every Modeled WSE Derivation Method: a named, versioned way to turn modeled
 * discharge into a modeled water-surface elevation (WSE) Time Series for each Creek Segment
 * (Stages 0–3). Each method lives in `modeled-wse-derivation-methods/<method-id>/`:
 * `method-config.ts` (identity and parameters) and `METHOD.md` (what the method does and why).
 * Types only, so anything can import this file without loading pipeline code.
 */

/** Why a version exists. Recorded as `change_type` on the published Data-Product Version. */
export type ModeledWseChangeType = 'new method' | 'implementation fix' | 'parameter change';

export interface ModeledWseDerivationMethodConfig {
  /**
   * `m<methodNumber>-<plain descriptive kebab-case name>`. Also the method folder name and the
   * Data-Product Version `method_id`. Never reused for a different method.
   */
  id: string;
  /** `m<N>`: changes when the idea changes (a different approach), not for a fix or a new setting. */
  methodNumber: number;
  /**
   * `v<N>`: whole number starting at 1. Bump it on every change to the method's output-affecting code
   * files or parameters.
   */
  version: number;
  /** Short human label. */
  label: string;
  /** One or two plain sentences: what the method does. `METHOD.md` holds the full description. */
  description: string;
  changeType: ModeledWseChangeType;
  /** One line: what this version changed relative to the previous one. */
  changeNote: string;
  /**
   * Repository-relative Stage 0–3 code files outside the method folder whose change changes this
   * method's output.
   */
  sharedCodeFiles: readonly string[];
  /** Every tunable value of the method, grouped by the stage that reads it. */
  parameters: Readonly<Record<string, unknown>>;
}

/** Data-Product Version label, for example `m1-v1`. */
export function modeledWseVersionLabel(method: Pick<ModeledWseDerivationMethodConfig, 'methodNumber' | 'version'>): string {
  return `m${method.methodNumber}-v${method.version}`;
}
