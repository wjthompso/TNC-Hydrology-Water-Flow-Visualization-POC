/**
 * One-off migration for UCS-296: Stage 3 now writes `03-time-series/<method-id>/v<version>/` instead of
 * writing straight into `03-time-series/`. This moves each extent's existing flat Stage 3 output
 * (`manifest.json`, `time-series/`, the inspection hydrograph) into the current Modeled WSE Derivation
 * Method's version folder, so nothing is recomputed, redownloaded, or deleted:
 *
 *   data/pipeline-working-output/<extent>/03-time-series/{manifest.json,time-series/,*.svg}
 *     → data/pipeline-working-output/<extent>/03-time-series/<method-id>/v<version>/…
 *
 * It then rewrites the recorded paths (not hashes) in the stage manifests that name those files, writes the
 * method's fingerprint into the Stage 3 manifest, and records in each Stage 4 manifest which modeled WSE
 * version it was built from, after checking that every Time Series hash Stage 4 read equals the hash Stage 3
 * wrote. Stages 0–4 then skip. Stage 5 reruns once because the catalog's Time Series paths gain the folder.
 *
 * Baseline: the saved output was made by the Stage 0–3 code from before this change, which is
 * output-neutral. The fingerprint recorded is the current code's, and the manifest says so under
 * `migration`. Running the script again changes nothing.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     pipelines/creek-visualization-data-production/migrate-modeled-wse-version-folders.ts [--extent=<extentId>]
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from './constants.ts';
import { fingerprintModeledWseDerivationMethod } from './modeled-water-surface-elevation/modeled-wse-derivation-methods/modeled-wse-derivation-method-fingerprint.ts';
import {
  builtFromModeledWseVersion,
  modeledWseVersionLabel,
  modeledWseVersionRelativePath,
} from './modeled-water-surface-elevation/modeled-wse-derivation-methods/modeled-wse-derivation-method.ts';
import { CURRENT_MODELED_WSE_DERIVATION_METHOD } from './modeled-water-surface-elevation/modeled-wse-derivation-methods/modeled-wse-derivation-method-registry.ts';

const PIPELINE_WORKING_OUTPUT_DIRECTORY = path.join(repositoryRoot, 'data/pipeline-working-output');
const SKIPPED_FOLDER_NAMES = new Set(['national-water-model-zarr-chunk-cache']);

type Json = Record<string, unknown>;

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function readJson(filePath: string): Promise<Json> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Json;
}

/** Same layout `writePrettyJson` gives stage manifests: two-space indent and a trailing newline. */
async function writeManifest(filePath: string, manifest: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Replaces the flat Time Series prefix with the version folder prefix in every key of `record`. */
function rewriteKeys(record: unknown, flatPrefix: string, versionPrefix: string): { value: Json; count: number } {
  const rewritten: Json = {};
  let count = 0;
  for (const [key, item] of Object.entries((record ?? {}) as Json)) {
    if (key.startsWith(flatPrefix) && !key.startsWith(versionPrefix)) {
      rewritten[versionPrefix + key.slice(flatPrefix.length)] = item;
      count += 1;
    } else {
      rewritten[key] = item;
    }
  }
  return { value: rewritten, count };
}

async function findManifestFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDER_NAMES.has(entry.name)) found.push(...(await findManifestFiles(entryPath)));
    } else if (entry.name === 'manifest.json') {
      found.push(entryPath);
    }
  }
  return found.sort();
}

async function migrateExtent(extentFolder: string): Promise<void> {
  const extentId = path.basename(extentFolder);
  const config = CURRENT_MODELED_WSE_DERIVATION_METHOD;
  const stageFolder = path.join(extentFolder, '03-time-series');
  const flatManifestPath = path.join(stageFolder, 'manifest.json');
  const flatTimeSeriesFolder = path.join(stageFolder, 'time-series');
  if (!(await exists(flatManifestPath)) && !(await exists(flatTimeSeriesFolder))) {
    console.log(`  ${extentId}: no flat Stage 3 output; nothing to migrate.`);
    return;
  }
  const relativeVersionPath = modeledWseVersionRelativePath(config.id, config.version);
  const versionFolder = path.join(stageFolder, relativeVersionPath);
  if (await exists(versionFolder)) {
    throw new Error(
      `${path.relative(repositoryRoot, versionFolder)} already exists next to flat Stage 3 output. Resolve by hand; this script never merges.`,
    );
  }
  const extentRelative = path.relative(repositoryRoot, extentFolder).split(path.sep).join('/');
  const flatPrefix = `${extentRelative}/03-time-series/`;
  const versionPrefix = `${flatPrefix}${relativeVersionPath}/`;

  // 1. Move the flat output into the version folder (a rename on one volume: nothing is copied or recomputed).
  await mkdir(versionFolder, { recursive: true });
  const versionTopFolderName = relativeVersionPath.split('/')[0] as string;
  const movedNames: string[] = [];
  for (const entry of await readdir(stageFolder)) {
    if (entry === versionTopFolderName) continue;
    await rename(path.join(stageFolder, entry), path.join(versionFolder, entry));
    movedNames.push(entry);
  }

  // 2. Stage 3 manifest: output paths, the method's fingerprint, and the baseline note.
  const method = await fingerprintModeledWseDerivationMethod(config);
  const stage3ManifestPath = path.join(versionFolder, 'manifest.json');
  const stage3Manifest = await readJson(stage3ManifestPath);
  const outputs = rewriteKeys(stage3Manifest.outputs, flatPrefix, versionPrefix);
  for (const relativePath of Object.keys(outputs.value)) {
    if (!(await exists(path.join(repositoryRoot, relativePath)))) {
      throw new Error(`Stage 3 manifest lists ${relativePath}, which is missing after the move.`);
    }
  }
  stage3Manifest.outputs = outputs.value;
  stage3Manifest.parameters = { modeledWseDerivationMethod: method, ...(stage3Manifest.parameters as Json) };
  stage3Manifest.migration = {
    ticket: 'UCS-296',
    movedAtUtc: new Date().toISOString(),
    note:
      `Moved from the flat 03-time-series/ layout into ${relativeVersionPath}/. The output was made by the Stage 0–3 code from before ` +
      'UCS-296, which changed no parameter or output (a rerun skipped every stage); methodSha256 is the fingerprint of the code at the move.',
  };
  await writeManifest(stage3ManifestPath, stage3Manifest);
  const stage3OutputHashes = new Map(
    Object.entries(outputs.value).map(([relativePath, item]) => [relativePath, (item as { sha256: string }).sha256]),
  );

  // 3. Every other manifest that names a Time Series file.
  const builtFrom = builtFromModeledWseVersion(method);
  let rewrittenManifests = 1;
  for (const manifestPath of await findManifestFiles(extentFolder)) {
    if (manifestPath === stage3ManifestPath) continue;
    const manifest = await readJson(manifestPath);
    const inputs = rewriteKeys(manifest.inputs, flatPrefix, versionPrefix);
    if (inputs.count === 0) continue;
    manifest.inputs = inputs.value;
    const isStage4 = path.relative(extentFolder, manifestPath).startsWith('04-water-surface-polygons');
    if (isStage4) {
      const mismatched = Object.entries(inputs.value).filter(
        ([relativePath, hash]) => relativePath.startsWith(versionPrefix) && stage3OutputHashes.get(relativePath) !== hash,
      );
      if (mismatched.length > 0) {
        throw new Error(
          `${path.relative(repositoryRoot, manifestPath)} read ${mismatched.length} Time Series file(s) that differ from Stage 3's ` +
            `output, e.g. ${mismatched[0]?.[0]}. It was not built from this Stage 3 output; rerun Stage 4.`,
        );
      }
      manifest.parameters = { ...(manifest.parameters as Json), builtFromModeledWseVersion: builtFrom };
    }
    await writeManifest(manifestPath, manifest);
    rewrittenManifests += 1;
    console.log(`    rewrote ${path.relative(repositoryRoot, manifestPath)} (${inputs.count} paths${isStage4 ? ', built-from recorded' : ''})`);
  }
  console.log(
    `  ${extentId}: moved ${movedNames.join(', ')} into ${relativeVersionPath}/ (${modeledWseVersionLabel(config)}); ` +
      `${outputs.count} output paths and ${rewrittenManifests} manifests rewritten.`,
  );
}

async function migrate(): Promise<void> {
  const onlyExtent = process.argv.find((argument) => argument.startsWith('--extent='))?.slice('--extent='.length);
  const extentFolders = (await readdir(PIPELINE_WORKING_OUTPUT_DIRECTORY, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !SKIPPED_FOLDER_NAMES.has(entry.name))
    .filter((entry) => onlyExtent === undefined || entry.name === onlyExtent)
    .map((entry) => path.join(PIPELINE_WORKING_OUTPUT_DIRECTORY, entry.name))
    .sort();
  if (extentFolders.length === 0) {
    console.log('No extents under data/pipeline-working-output; nothing to migrate.');
    return;
  }
  console.log('Moving flat Stage 3 output into modeled WSE version folders:');
  for (const extentFolder of extentFolders) await migrateExtent(extentFolder);
  console.log('Done. Stage 5 reruns once on the next `npm run pipeline:modeled-wse:all` (its catalog paths gain the version folder).');
}

const isCommandLineEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCommandLineEntryPoint) {
  try {
    await migrate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
