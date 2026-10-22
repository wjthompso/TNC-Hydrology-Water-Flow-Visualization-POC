import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../json-files.ts';
import { repositoryRoot } from '../constants.ts';

/**
 * Hashing shared by the Modeled WSE Derivation Method and WSE Polygon Generation Method version
 * rules. A method's fingerprint (`methodSha256`) is the SHA-256 of its code files' hashes and its
 * parameters, so any change to either means a different version.
 */

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Stable JSON so a fingerprint does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 per file, keyed by repository-relative path with forward slashes, in sorted order. */
export async function hashFilesByRepositoryPath(absolutePaths: readonly string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const filePath of [...absolutePaths].sort()) {
    const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
    hashes[relativePath] = sha256(await readFile(filePath));
  }
  return hashes;
}

/** Names the code files whose hash differs between two recorded fingerprints. */
export function changedCodeFiles(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): string[] {
  const files = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...files].filter((file) => previous[file] !== current[file]).sort();
}
