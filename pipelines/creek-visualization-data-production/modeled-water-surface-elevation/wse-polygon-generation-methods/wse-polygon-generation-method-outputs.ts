import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RecordedBuiltFromModeledWseVersion } from '../modeled-wse-derivation-methods/modeled-wse-derivation-method.ts';
import type { RecordedWsePolygonGenerationMethod } from './wse-polygon-generation-method.ts';

/**
 * Folder layout of saved WSE Polygon Generation Method output inside a Stage 4 directory:
 * `04-water-surface-polygons/<method-id>/v<version>/` holding `manifest.json`, the ladder summary,
 * and `water-surface-polygon-sets/<tncComid>.json`. Node-only and free of pipeline settings, so
 * Stage 5 and the browser dev server share it.
 */

export function wsePolygonVersionFolderName(version: number): string {
  return `v${version}`;
}

/** `<method-id>/v<version>`, relative to the Stage 4 directory, always with forward slashes. */
export function wsePolygonVersionRelativePath(methodId: string, version: number): string {
  return `${methodId}/${wsePolygonVersionFolderName(version)}`;
}

/** One completed version on disk: a `<method-id>/v<n>/manifest.json` that records its method. */
export interface SavedWsePolygonMethodVersion {
  methodId: string;
  version: number;
  /** Relative to the Stage 4 directory, e.g. `junction-sloped-terrain-fill/v1`. */
  relativePath: string;
  completedAt: string | null;
  method: RecordedWsePolygonGenerationMethod;
}

/**
 * Reads the method record a version's Stage 4 manifest holds. Null when the folder has no manifest
 * (an unfinished run) or the manifest predates WSE Polygon Generation Methods.
 */
export async function readSavedWsePolygonMethodVersion(
  stageDirectory: string,
  methodId: string,
  version: number,
): Promise<SavedWsePolygonMethodVersion | null> {
  const relativePath = wsePolygonVersionRelativePath(methodId, version);
  let manifest: { completedAt?: unknown; parameters?: { wsePolygonGenerationMethod?: unknown } };
  try {
    manifest = JSON.parse(await readFile(path.join(stageDirectory, relativePath, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    return null;
  }
  const method = manifest.parameters?.wsePolygonGenerationMethod as RecordedWsePolygonGenerationMethod | undefined;
  if (!method || typeof method.methodSha256 !== 'string') return null;
  return {
    methodId,
    version,
    relativePath,
    completedAt: typeof manifest.completedAt === 'string' ? manifest.completedAt : null,
    method,
  };
}

/**
 * The modeled WSE version a saved polygon version was built from, as its Stage 4 manifest recorded it.
 * Null when the folder has no manifest or the manifest predates UCS-296.
 */
export async function readSavedBuiltFromModeledWseVersion(
  stageDirectory: string,
  methodId: string,
  version: number,
): Promise<RecordedBuiltFromModeledWseVersion | null> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(stageDirectory, wsePolygonVersionRelativePath(methodId, version), 'manifest.json'), 'utf8'),
    ) as { parameters?: { builtFromModeledWseVersion?: RecordedBuiltFromModeledWseVersion } };
    return manifest.parameters?.builtFromModeledWseVersion ?? null;
  } catch {
    return null;
  }
}

/**
 * Every completed method version under a Stage 4 directory, sorted by method id, then version.
 * Loose files and folders without `v<n>/manifest.json` (such as the pre-method flat layout) are ignored.
 */
export async function listSavedWsePolygonMethodVersions(stageDirectory: string): Promise<SavedWsePolygonMethodVersion[]> {
  let methodFolders: string[];
  try {
    methodFolders = (await readdir(stageDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const saved: SavedWsePolygonMethodVersion[] = [];
  for (const methodId of methodFolders.sort()) {
    const versionFolders = await readdir(path.join(stageDirectory, methodId)).catch(() => [] as string[]);
    const versions = versionFolders
      .map((name) => /^v(\d+)$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
    for (const version of versions) {
      const entry = await readSavedWsePolygonMethodVersion(stageDirectory, methodId, version);
      if (entry) saved.push(entry);
    }
  }
  return saved;
}
