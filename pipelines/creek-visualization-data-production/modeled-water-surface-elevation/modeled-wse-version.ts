import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { repositoryRoot } from '../constants.ts';
import { stageDirectory } from './pipeline-configuration.ts';
import {
  changedModeledWseMethodFiles,
  fingerprintModeledWseDerivationMethod,
} from './modeled-wse-derivation-methods/modeled-wse-derivation-method-fingerprint.ts';
import {
  modeledWseVersionLabel,
  modeledWseVersionRelativePath,
  type ModeledWseDerivationMethodConfig,
  type RecordedModeledWseDerivationMethod,
} from './modeled-wse-derivation-methods/modeled-wse-derivation-method.ts';
import { readSavedModeledWseVersion } from './modeled-wse-derivation-methods/modeled-wse-derivation-method-outputs.ts';
import { requestedModeledWseDerivationMethod } from './modeled-wse-derivation-methods/modeled-wse-derivation-method-registry.ts';

/**
 * The modeled WSE version the working tree's Stage 0–3 code produces, and the rule that protects a
 * saved one. Stage 3 writes `03-time-series/<method-id>/v<version>/`; the version's manifest records
 * the method's fingerprint (`methodSha256`). When that folder already holds output with a different
 * fingerprint, every stage from 0 to 5 stops, even with `--force`, names the changed files, and asks
 * for a version bump, so a saved version is never overwritten by changed code. Other version folders
 * are never touched. See METHODOLOGY.md "Modeled WSE Derivation Methods".
 */

/** The current method, or the one named by `--modeled-wse-method=<id>` (see the registry). */
const config = requestedModeledWseDerivationMethod(process.argv);

/** Where the current version's Stage 3 output lives. Synchronous, so stage files can use it at load time. */
export const CURRENT_MODELED_WSE_VERSION_RELATIVE_PATH = modeledWseVersionRelativePath(config.id, config.version);
export const CURRENT_MODELED_WSE_VERSION_LABEL = modeledWseVersionLabel(config);

/** Absolute Stage 3 output folder of the current version. */
export function currentModeledWseVersionDirectory(): string {
  return path.join(stageDirectory('timeSeries'), CURRENT_MODELED_WSE_VERSION_RELATIVE_PATH);
}

export interface CurrentModeledWseVersion {
  method: RecordedModeledWseDerivationMethod;
  /** Data-Product Version label, for example `m1-v1`. */
  versionLabel: string;
  /** `<method-id>/v<version>`, relative to the Stage 3 directory. */
  relativePath: string;
  outputDirectory: string;
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

/** Stage 3 output written before UCS-296 sits directly in `03-time-series/`; a migration moves it into a version folder. */
async function refuseFlatLayout(stage: string): Promise<void> {
  const stageFolder = stageDirectory('timeSeries');
  if ((await exists(path.join(stageFolder, 'manifest.json'))) || (await exists(path.join(stageFolder, 'time-series')))) {
    throw new Error(
      `[${stage}] ${path.relative(repositoryRoot, stageFolder)}/ still holds Stage 3 output in the flat layout used before UCS-296.\n` +
        '  Move it into its version folder (nothing is recomputed or deleted):\n' +
        '  node --experimental-strip-types --disable-warning=ExperimentalWarning ' +
        'pipelines/creek-visualization-data-production/migrate-modeled-wse-version-folders.ts',
    );
  }
}

async function currentVersionWithFingerprint(method: ModeledWseDerivationMethodConfig = config): Promise<CurrentModeledWseVersion> {
  const relativePath = modeledWseVersionRelativePath(method.id, method.version);
  return {
    method: await fingerprintModeledWseDerivationMethod(method),
    versionLabel: modeledWseVersionLabel(method),
    relativePath,
    outputDirectory: path.join(stageDirectory('timeSeries'), relativePath),
  };
}

function bumpMessage(
  stage: string,
  current: CurrentModeledWseVersion,
  saved: RecordedModeledWseDerivationMethod,
): string {
  const changed = changedModeledWseMethodFiles(saved, current.method);
  return [
    `[${stage}] Modeled WSE Derivation Method ${current.method.id} v${current.method.version} (${current.versionLabel}) already has ` +
      `saved output in ${path.relative(repositoryRoot, current.outputDirectory)}/ from different method code or parameters.`,
    `  Saved fingerprint ${saved.methodSha256.slice(0, 12)}…, current ${current.method.methodSha256.slice(0, 12)}….`,
    `  Changed: ${changed.join(', ') || '(unknown)'}.`,
    `  Bump \`version\` to ${current.method.version + 1} in modeled-wse-derivation-methods/${current.method.id}/method-config.ts ` +
      '(and set changeType and changeNote), or revert the change. A saved version is kept so versions can be compared; ' +
      'no stage overwrites one. After a bump, rerun the stages whose code you changed with --force: Stages 0–2 skip when ' +
      'their input files are unchanged, and they do not hash code.',
  ].join('\n');
}

/**
 * For Stages 0–3: throws the bump message when the current version's folder already holds Stage 3
 * output from different method code or parameters. Passes when the folder is new or holds the same fingerprint.
 */
export async function refuseToOverwriteADifferentModeledWseVersion(stage: string): Promise<CurrentModeledWseVersion> {
  await refuseFlatLayout(stage);
  const current = await currentVersionWithFingerprint();
  const saved = await readSavedModeledWseVersion(stageDirectory('timeSeries'), current.method.id, current.method.version);
  if (saved && saved.method.methodSha256 !== current.method.methodSha256) throw new Error(bumpMessage(stage, current, saved.method));
  return current;
}

/**
 * For Stages 4 and 5, which read the current version's Time Series: the version must exist and match
 * the code. Otherwise they would read Time Series made by other code than the stage believes.
 */
export async function requireSavedCurrentModeledWseVersion(stage: string): Promise<CurrentModeledWseVersion> {
  return requireSavedModeledWseVersion(stage, config);
}

/** `requireSavedCurrentModeledWseVersion` for a method chosen by the stage (Stage 5 reads the default pairing's Time Series). */
export async function requireSavedModeledWseVersion(
  stage: string,
  method: ModeledWseDerivationMethodConfig,
): Promise<CurrentModeledWseVersion> {
  await refuseFlatLayout(stage);
  const current = await currentVersionWithFingerprint(method);
  const saved = await readSavedModeledWseVersion(stageDirectory('timeSeries'), current.method.id, current.method.version);
  if (!saved) {
    throw new Error(
      `[${stage}] No Stage 3 output for Modeled WSE Derivation Method ${current.method.id} v${current.method.version} ` +
        `in ${path.relative(repositoryRoot, current.outputDirectory)}/. Run Stage 3 first.`,
    );
  }
  if (saved.method.methodSha256 !== current.method.methodSha256) throw new Error(bumpMessage(stage, current, saved.method));
  return current;
}
