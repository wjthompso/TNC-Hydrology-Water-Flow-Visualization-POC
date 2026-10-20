import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isRecord, writePrettyJson } from '../json-files.ts';
import { repositoryRoot } from '../constants.ts';
import { MODELED_EXTENT } from './pipeline-configuration.ts';

/**
 * Every stage writes `manifest.json` next to its outputs. A stage is skipped when
 * its input file hashes and parameters match the previous manifest and every
 * previous output file still exists. `--force` reruns it anyway.
 */

export interface StageResult {
  /** Absolute paths of files the stage wrote (excluding manifest.json). */
  outputFiles: string[];
  counts: Record<string, number>;
  warnings: string[];
  /** Extra measurements worth keeping, such as bytes downloaded. */
  measurements?: Record<string, unknown>;
  /** One-line human summaries printed after the stage finishes. */
  summaryLines: string[];
}

interface StageManifest {
  stage: string;
  completedAt: string;
  durationMs: number;
  inputs: Record<string, string>;
  parameters: unknown;
  counts: Record<string, number>;
  warnings: string[];
  measurements: Record<string, unknown>;
  outputs: Record<string, { sha256: string; bytes: number }>;
}

export function hasForceFlag(): boolean {
  return process.argv.includes('--force');
}

export async function sha256OfFile(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function repositoryRelative(filePath: string): string {
  return path.relative(repositoryRoot, filePath);
}

async function hashInputs(inputFiles: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of [...inputFiles].sort()) {
    try {
      hashes[repositoryRelative(file)] = await sha256OfFile(file);
    } catch (error) {
      throw new Error(`Stage input ${repositoryRelative(file)} is missing. Run the earlier stage first.`, {
        cause: error,
      });
    }
  }
  return hashes;
}

async function readPreviousManifest(manifestPath: string): Promise<StageManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    return isRecord(parsed) ? (parsed as unknown as StageManifest) : null;
  } catch {
    return null;
  }
}

async function allOutputsExist(manifest: StageManifest): Promise<boolean> {
  for (const relativePath of Object.keys(manifest.outputs)) {
    try {
      await access(path.join(repositoryRoot, relativePath));
    } catch {
      return false;
    }
  }
  return true;
}

/** Stable JSON so parameter comparison does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function runStage(input: {
  stage: string;
  outputDirectory: string;
  inputFiles: string[];
  parameters: unknown;
  run: () => Promise<StageResult>;
}): Promise<void> {
  if (MODELED_EXTENT.blockedReason !== null) {
    throw new Error(`[${input.stage}] Extent ${MODELED_EXTENT.extentId} is blocked: ${MODELED_EXTENT.blockedReason}`);
  }
  console.log(`[${input.stage}] Extent ${MODELED_EXTENT.extentId} (${MODELED_EXTENT.segmentNetworkVersion}).`);
  const manifestPath = path.join(input.outputDirectory, 'manifest.json');
  const inputs = await hashInputs(input.inputFiles);
  const previous = await readPreviousManifest(manifestPath);
  const unchanged =
    previous !== null &&
    canonicalJson(previous.inputs) === canonicalJson(inputs) &&
    canonicalJson(previous.parameters) === canonicalJson(input.parameters) &&
    (await allOutputsExist(previous));

  if (unchanged && !hasForceFlag()) {
    console.log(
      `[${input.stage}] Skipped: inputs and parameters unchanged since ${previous.completedAt}. Use --force to rerun.`,
    );
    return;
  }

  await mkdir(input.outputDirectory, { recursive: true });
  console.log(`[${input.stage}] Running…`);
  const startedAt = Date.now();
  const result = await input.run();
  const durationMs = Date.now() - startedAt;

  const outputs: StageManifest['outputs'] = {};
  for (const file of [...result.outputFiles].sort()) {
    outputs[repositoryRelative(file)] = { sha256: await sha256OfFile(file), bytes: (await stat(file)).size };
  }
  const manifest: StageManifest = {
    stage: input.stage,
    completedAt: new Date().toISOString(),
    durationMs,
    inputs,
    parameters: input.parameters,
    counts: result.counts,
    warnings: result.warnings,
    measurements: result.measurements ?? {},
    outputs,
  };
  await writePrettyJson(manifestPath, manifest);

  console.log(`[${input.stage}] Finished in ${(durationMs / 1000).toFixed(1)} s.`);
  for (const line of result.summaryLines) console.log(`  ${line}`);
  for (const [file, { bytes }] of Object.entries(outputs)) console.log(`  wrote ${file} (${formatBytes(bytes)})`);
  if (result.warnings.length > 0) {
    console.log(`  ${result.warnings.length} warning(s):`);
    for (const warning of result.warnings.slice(0, 10)) console.log(`    - ${warning}`);
    if (result.warnings.length > 10) console.log(`    … ${result.warnings.length - 10} more in manifest.json`);
  }
}

/** Shared entry-point wrapper so each stage file exits non-zero with a readable message. */
export async function runStageEntryPoint(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause) console.error('Caused by:', error.cause);
    process.exitCode = 1;
  }
}
