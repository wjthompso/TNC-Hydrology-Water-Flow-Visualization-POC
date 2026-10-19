import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared disk store for saved live-service responses. One entry is two files in a
 * two-character shard folder: `<sha256>.body` (raw bytes, binary-safe) and
 * `<sha256>.json` (status, content type, capture time, redacted URL, byte count).
 * The hash is `sha256("GET " + keyUrl)`. Each source decides its own `keyUrl` and
 * folder; see `esri.ts` and `usgs-3dep.ts`.
 */

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface SavedResponseMeta {
  status: number;
  contentType: string | null;
  capturedAt: string;
  redactedUrl: string;
  bodyBytes: number;
}

export interface SavedResponse {
  meta: SavedResponseMeta;
  body: Buffer;
}

export interface EntryPaths {
  body: string;
  meta: string;
}

/** `.test-cache` at the repository root, or `TNC_TEST_CACHE_DIR` when set. */
export function testCacheRoot(): string {
  return process.env.TNC_TEST_CACHE_DIR
    ? path.resolve(process.env.TNC_TEST_CACHE_DIR)
    : path.join(repositoryRoot, '.test-cache');
}

export function entryPaths(sourceDirectory: string, keyUrl: string): EntryPaths {
  const key = createHash('sha256').update(`GET ${keyUrl}`).digest('hex');
  const shard = path.join(sourceDirectory, key.slice(0, 2));
  return { body: path.join(shard, `${key}.body`), meta: path.join(shard, `${key}.json`) };
}

export async function readSavedResponse(paths: EntryPaths): Promise<SavedResponse | null> {
  try {
    const meta = JSON.parse(await readFile(paths.meta, 'utf8')) as SavedResponseMeta;
    return { meta, body: await readFile(paths.body) };
  } catch {
    return null;
  }
}

/** Each file is written beside its final name and renamed, so a reader never sees half a file. */
async function writeAtomically(file: string, contents: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.${randomUUID()}.partial`;
  await writeFile(partial, contents);
  await rename(partial, file);
}

/** The body is published before its metadata, and readers require the metadata. */
export async function saveResponse(
  paths: EntryPaths,
  redactedUrl: string,
  status: number,
  contentType: string | null,
  body: Buffer,
): Promise<void> {
  const meta: SavedResponseMeta = {
    status,
    contentType,
    capturedAt: new Date().toISOString(),
    redactedUrl,
    bodyBytes: body.length,
  };
  await writeAtomically(paths.body, body);
  await writeAtomically(paths.meta, `${JSON.stringify(meta)}\n`);
}
