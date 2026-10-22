/**
 * Shapes shared by every Modeled WSE Derivation Method: a named, versioned way to turn modeled
 * discharge into a modeled water-surface elevation (WSE) Time Series for each Creek Segment
 * (Stages 0–3). Each method lives in `modeled-wse-derivation-methods/<method-id>/`:
 * `method-config.ts` (identity and parameters) and `METHOD.md` (what the method does and why).
 * Each version keeps its own saved Stage 3 output under
 * `03-time-series/<method-id>/v<version>/`, so versions can coexist and be compared.
 * Types and pure helpers only, so anything can import this file without loading pipeline code.
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
   * files or parameters; Stages 0–3 refuse to run when a saved version folder's recorded fingerprint differs.
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
   * method's output. Every file in the method folder except Markdown is always fingerprinted.
   */
  sharedCodeFiles: readonly string[];
  /** Every tunable value of the method, grouped by the stage that reads it. */
  parameters: Readonly<Record<string, unknown>>;
}

/**
 * What a version's Stage 3 manifest records under `parameters.modeledWseDerivationMethod`. Read back
 * by Stages 0–5 and the freeze scripts, so an old version keeps its own identity and change note
 * even after the code moved on.
 */
export interface RecordedModeledWseDerivationMethod {
  id: string;
  methodNumber: number;
  version: number;
  label: string;
  description: string;
  changeType: ModeledWseChangeType;
  changeNote: string;
  parameters: Readonly<Record<string, unknown>>;
  /** SHA-256 per fingerprinted code file, keyed by repository-relative path. */
  codeSha256ByFile: Readonly<Record<string, string>>;
  /** SHA-256 over the code hashes and parameters together; the version rule compares this. */
  methodSha256: string;
}

/**
 * What a WSE polygon version's Stage 4 manifest records under `parameters.builtFromModeledWseVersion`:
 * the modeled WSE version whose Time Series it was traced from.
 */
export interface RecordedBuiltFromModeledWseVersion {
  product: 'modeled-wse';
  methodId: string;
  /** Data-Product Version label, for example `m1-v1`. */
  versionLabel: string;
  version: number;
  methodSha256: string;
}

/** Data-Product Version label, for example `m1-v1`. */
export function modeledWseVersionLabel(method: Pick<ModeledWseDerivationMethodConfig, 'methodNumber' | 'version'>): string {
  return `m${method.methodNumber}-v${method.version}`;
}

/** `<method-id>/v<version>`, relative to the Stage 3 directory, always with forward slashes. */
export function modeledWseVersionRelativePath(methodId: string, version: number): string {
  return `${methodId}/v${version}`;
}

/** The record a polygon version stores to name the modeled WSE version it was traced from. */
export function builtFromModeledWseVersion(method: RecordedModeledWseDerivationMethod): RecordedBuiltFromModeledWseVersion {
  return {
    product: 'modeled-wse',
    methodId: method.id,
    versionLabel: modeledWseVersionLabel(method),
    version: method.version,
    methodSha256: method.methodSha256,
  };
}
