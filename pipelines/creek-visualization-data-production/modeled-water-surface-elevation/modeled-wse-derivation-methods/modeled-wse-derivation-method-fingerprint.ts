import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from '../../constants.ts';
import { canonicalJson, changedCodeFiles, hashFilesByRepositoryPath, sha256 } from '../method-fingerprint.ts';
import type { ModeledWseDerivationMethodConfig, RecordedModeledWseDerivationMethod } from './modeled-wse-derivation-method.ts';

/**
 * The version rule's fingerprint: SHA-256 of every non-Markdown file in the method's folder, of each
 * shared Stage 0–3 code file the method lists, and of its parameters. Any change to those means a
 * different method version, so Stages 0–3 compare this against the Stage 3 version folder's manifest.
 */

const methodsDirectory = path.dirname(fileURLToPath(import.meta.url));

async function methodCodeFiles(method: ModeledWseDerivationMethodConfig): Promise<string[]> {
  const methodFolder = path.join(methodsDirectory, method.id);
  // METHOD.md and other Markdown describe the method; editing prose never changes output.
  const ownFiles = (await readdir(methodFolder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.md'))
    .map((entry) => path.join(entry.parentPath, entry.name));
  if (ownFiles.length === 0) throw new Error(`Modeled WSE Derivation Method ${method.id} has no code files in ${methodFolder}.`);
  const sharedFiles = method.sharedCodeFiles.map((relativePath) => path.join(repositoryRoot, relativePath));
  return [...new Set([...ownFiles, ...sharedFiles])].sort();
}

export async function fingerprintModeledWseDerivationMethod(
  method: ModeledWseDerivationMethodConfig,
): Promise<RecordedModeledWseDerivationMethod> {
  const codeSha256ByFile = await hashFilesByRepositoryPath(await methodCodeFiles(method));
  return {
    id: method.id,
    methodNumber: method.methodNumber,
    version: method.version,
    label: method.label,
    description: method.description,
    changeType: method.changeType,
    changeNote: method.changeNote,
    parameters: method.parameters,
    codeSha256ByFile,
    methodSha256: sha256(canonicalJson({ codeSha256ByFile, parameters: method.parameters })),
  };
}

/** Names the files whose hash changed, so the bump message says what moved. */
export function changedModeledWseMethodFiles(
  previous: RecordedModeledWseDerivationMethod,
  current: RecordedModeledWseDerivationMethod,
): string[] {
  const changed = changedCodeFiles(previous.codeSha256ByFile, current.codeSha256ByFile);
  if (canonicalJson(previous.parameters) !== canonicalJson(current.parameters)) changed.push('(parameters)');
  return changed;
}
