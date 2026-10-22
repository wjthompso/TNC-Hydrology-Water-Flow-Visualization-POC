import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { modeledWseVersionRelativePath, type RecordedModeledWseDerivationMethod } from './modeled-wse-derivation-method.ts';

/**
 * Folder layout of saved Modeled WSE Derivation Method output inside a Stage 3 directory:
 * `03-time-series/<method-id>/v<version>/` holding `manifest.json`, `time-series/…`, and the
 * inspection hydrograph. Node-only and free of pipeline settings, so Stage 4, Stage 5, and the
 * migration script share it.
 */

/** One completed version on disk: a `<method-id>/v<n>/manifest.json` that records its method. */
export interface SavedModeledWseVersion {
  methodId: string;
  version: number;
  /** Relative to the Stage 3 directory, e.g. `m1-drainage-area-ratio-manning-rating-curve/v1`. */
  relativePath: string;
  completedAt: string | null;
  method: RecordedModeledWseDerivationMethod;
}

/**
 * Reads the method record a version's Stage 3 manifest holds. Null when the folder has no manifest
 * (an unfinished run) or the manifest predates Modeled WSE Derivation Methods.
 */
export async function readSavedModeledWseVersion(
  stageDirectory: string,
  methodId: string,
  version: number,
): Promise<SavedModeledWseVersion | null> {
  const relativePath = modeledWseVersionRelativePath(methodId, version);
  let manifest: { completedAt?: unknown; parameters?: { modeledWseDerivationMethod?: unknown } };
  try {
    manifest = JSON.parse(await readFile(path.join(stageDirectory, relativePath, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    return null;
  }
  const method = manifest.parameters?.modeledWseDerivationMethod as RecordedModeledWseDerivationMethod | undefined;
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
 * Every completed modeled WSE version under a Stage 3 directory, sorted by method id, then version.
 * Loose files and folders without `v<n>/manifest.json` (such as the flat layout before UCS-296) are ignored.
 */
export async function listSavedModeledWseVersions(stageDirectory: string): Promise<SavedModeledWseVersion[]> {
  let methodFolders: string[];
  try {
    methodFolders = (await readdir(stageDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const saved: SavedModeledWseVersion[] = [];
  for (const methodId of methodFolders.sort()) {
    const versionFolders = await readdir(path.join(stageDirectory, methodId)).catch(() => [] as string[]);
    const versions = versionFolders
      .map((name) => /^v(\d+)$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
    for (const version of versions) {
      const entry = await readSavedModeledWseVersion(stageDirectory, methodId, version);
      if (entry) saved.push(entry);
    }
  }
  return saved;
}
