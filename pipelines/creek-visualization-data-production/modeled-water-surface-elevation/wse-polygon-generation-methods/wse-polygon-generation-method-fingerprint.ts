import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../../json-files.ts';
import { repositoryRoot } from '../../constants.ts';
import type { RecordedWsePolygonGenerationMethod, WsePolygonGenerationMethodConfig } from './wse-polygon-generation-method.ts';

/**
 * The version rule's fingerprint: SHA-256 of every file in the method's folder, of each shared code
 * file the method lists, and of its parameters and browser drawing rule. Any change to those means a
 * different method version, so Stage 4 compares this against the version folder's manifest.
 */

const methodsDirectory = path.dirname(fileURLToPath(import.meta.url));

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Stable JSON so the fingerprint does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function methodCodeFiles(method: WsePolygonGenerationMethodConfig): Promise<string[]> {
  const methodFolder = path.join(methodsDirectory, method.id);
  const ownFiles = (await readdir(methodFolder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  if (ownFiles.length === 0) throw new Error(`WSE Polygon Generation Method ${method.id} has no files in ${methodFolder}.`);
  const sharedFiles = method.sharedCodeFiles.map((relativePath) => path.join(repositoryRoot, relativePath));
  return [...new Set([...ownFiles, ...sharedFiles])].sort();
}

export async function fingerprintWsePolygonGenerationMethod(
  method: WsePolygonGenerationMethodConfig,
): Promise<RecordedWsePolygonGenerationMethod> {
  const codeSha256ByFile: Record<string, string> = {};
  for (const filePath of await methodCodeFiles(method)) {
    const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
    codeSha256ByFile[relativePath] = sha256(await readFile(filePath));
  }
  const methodSha256 = sha256(
    canonicalJson({ codeSha256ByFile, parameters: method.parameters, browserDrawing: method.browserDrawing }),
  );
  return {
    id: method.id,
    label: method.label,
    version: method.version,
    description: method.description,
    browserDrawing: method.browserDrawing,
    parameters: method.parameters,
    codeSha256ByFile,
    methodSha256,
  };
}

/** Names the files whose hash changed, so the bump message says what moved. */
export function changedMethodFiles(
  previous: RecordedWsePolygonGenerationMethod,
  current: RecordedWsePolygonGenerationMethod,
): string[] {
  const files = new Set([...Object.keys(previous.codeSha256ByFile), ...Object.keys(current.codeSha256ByFile)]);
  const changed = [...files].filter((file) => previous.codeSha256ByFile[file] !== current.codeSha256ByFile[file]).sort();
  if (canonicalJson(previous.parameters) !== canonicalJson(current.parameters)) changed.push('(parameters)');
  if (previous.browserDrawing !== current.browserDrawing) changed.push('(browserDrawing)');
  return changed;
}
