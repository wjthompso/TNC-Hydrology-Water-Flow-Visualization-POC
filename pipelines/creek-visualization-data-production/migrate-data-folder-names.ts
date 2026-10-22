/**
 * One-off migration for the UCS-295 data folder rename:
 *   data/retained-backend-source-data/                     → data/source-inputs/
 *   data/modeled-water-surface-elevation-pipeline-output/  → data/pipeline-working-output/
 *
 * Every modeled WSE stage manifest records its input and output files as repository-relative
 * paths. `runStage` skips a stage only when the recorded input paths and hashes match, and checks
 * that every recorded output path still exists, so manifests written before the rename would
 * force a full rerun (Stage 0 alone downloads for about 30 minutes). This script rewrites only the
 * path prefix in every manifest key and string value under data/pipeline-working-output/. Hashes,
 * byte counts, timestamps, and parameters are left as they were; moving a file does not change
 * its SHA-256. Running it again changes nothing.
 *
 * Migrating an old checkout (see data/README.md):
 *   1. git pull / merge, so data/source-inputs/ arrives through git.
 *   2. mv data/modeled-water-surface-elevation-pipeline-output data/pipeline-working-output
 *   3. node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *        pipelines/creek-visualization-data-production/migrate-data-folder-names.ts
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from './constants.ts';

/** Repository-relative data folder prefixes renamed in UCS-295, old → current. */
export const RENAMED_DATA_FOLDER_PREFIXES: ReadonlyArray<{ oldPrefix: string; currentPrefix: string }> = [
  { oldPrefix: 'data/retained-backend-source-data/', currentPrefix: 'data/source-inputs/' },
  { oldPrefix: 'data/modeled-water-surface-elevation-pipeline-output/', currentPrefix: 'data/pipeline-working-output/' },
];

/**
 * A recorded repository-relative path with a pre-UCS-295 data folder prefix replaced by its
 * current name. Paths that already use the current names come back unchanged.
 */
export function currentRepositoryRelativePath(recordedPath: string): string {
  for (const { oldPrefix, currentPrefix } of RENAMED_DATA_FOLDER_PREFIXES) {
    if (recordedPath.startsWith(oldPrefix)) return currentPrefix + recordedPath.slice(oldPrefix.length);
  }
  return recordedPath;
}

const PIPELINE_WORKING_OUTPUT_DIRECTORY = path.join(repositoryRoot, 'data/pipeline-working-output');
/** Cached National Water Model chunks hold no manifests; skipping them keeps the walk fast. */
const SKIPPED_FOLDER_NAMES = new Set(['national-water-model-zarr-chunk-cache']);

interface MigrationCounts {
  renamedPaths: number;
}

/** Rewrites path prefixes in object keys and string values, recursively. Numbers and other fields are untouched. */
function migrateValue(value: unknown, counts: MigrationCounts): unknown {
  if (typeof value === 'string') {
    const current = currentRepositoryRelativePath(value);
    if (current !== value) counts.renamedPaths += 1;
    return current;
  }
  if (Array.isArray(value)) return value.map((item) => migrateValue(item, counts));
  if (typeof value === 'object' && value !== null) {
    const migrated: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const currentKey = currentRepositoryRelativePath(key);
      if (currentKey !== key) counts.renamedPaths += 1;
      migrated[currentKey] = migrateValue(item, counts);
    }
    return migrated;
  }
  return value;
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

/** Same layout `writePrettyJson` gives stage manifests: two-space indent and a trailing newline. */
function formatManifest(manifest: unknown): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function migrateDataFolderNames(): Promise<void> {
  const oldOutputFolder = path.join(repositoryRoot, 'data/modeled-water-surface-elevation-pipeline-output');
  const hasOldFolder = await readdir(oldOutputFolder).then(
    () => true,
    () => false,
  );
  if (hasOldFolder) {
    throw new Error(
      `${path.relative(repositoryRoot, oldOutputFolder)} still exists. Move it to data/pipeline-working-output first.`,
    );
  }
  const manifestFiles = await findManifestFiles(PIPELINE_WORKING_OUTPUT_DIRECTORY).catch(() => [] as string[]);
  if (manifestFiles.length === 0) {
    console.log('No stage manifests under data/pipeline-working-output; nothing to migrate.');
    return;
  }

  let rewrittenFiles = 0;
  let renamedPaths = 0;
  for (const manifestFile of manifestFiles) {
    const original = await readFile(manifestFile, 'utf8');
    const counts: MigrationCounts = { renamedPaths: 0 };
    const migrated = migrateValue(JSON.parse(original) as unknown, counts);
    const relativeFile = path.relative(repositoryRoot, manifestFile);
    if (counts.renamedPaths === 0) {
      console.log(`  unchanged  ${relativeFile}`);
      continue;
    }
    await writeFile(manifestFile, formatManifest(migrated));
    rewrittenFiles += 1;
    renamedPaths += counts.renamedPaths;
    console.log(`  rewrote    ${relativeFile} (${counts.renamedPaths} paths)`);
  }
  console.log(
    `Data folder migration: ${manifestFiles.length} manifests checked, ${rewrittenFiles} rewritten, ` +
      `${renamedPaths} paths renamed, ${manifestFiles.length - rewrittenFiles} already current.`,
  );
}

const isCommandLineEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCommandLineEntryPoint) {
  try {
    await migrateDataFolderNames();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
