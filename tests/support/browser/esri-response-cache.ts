import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Route } from '@playwright/test';
import { esriResponseCacheDirectory as esriResponseCacheDirectoryForRoot } from './esri-response-cache-location.ts';

/**
 * Live browser tests reuse saved Esri responses so repeat runs skip Esri round trips
 * and rate limits. A response missing from the cache is fetched live and saved, so a
 * new request never fails a test. `npm run test:refresh-map-cache` deletes the saved
 * responses and runs every live browser test to download them again.
 */
const ESRI_HOST = /(^|\.)(arcgis\.com|arcgisonline\.com)$/i;
/** Credentials and cache-busters. They never reach the cache key or the disk. */
const SECRET_OR_VOLATILE_PARAMS = new Set(['token', 'apikey', 'api_key', 'key', 'access_token', 'secret', '_ts']);
/** 404 is a real Esri answer for a tile that does not exist; 429 and 5xx are not saved. */
const SAVED_STATUSES = new Set([200, 404]);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface SavedResponse {
  status: number;
  contentType: string | null;
  capturedAt: string;
  redactedUrl: string;
  bodyBytes: number;
}

export function esriResponseCacheDirectory(): string {
  const cacheRoot = process.env.TNC_TEST_CACHE_DIR
    ? path.resolve(process.env.TNC_TEST_CACHE_DIR)
    : path.join(repositoryRoot, '.test-cache');
  return esriResponseCacheDirectoryForRoot(cacheRoot);
}

function isEsriRequest(url: URL): boolean {
  return (url.protocol === 'https:' || url.protocol === 'http:') && ESRI_HOST.test(url.hostname);
}

function withoutSecrets(url: URL): URL {
  const cleaned = new URL(url.href);
  cleaned.hash = '';
  for (const name of [...cleaned.searchParams.keys()]) {
    if (SECRET_OR_VOLATILE_PARAMS.has(name.toLowerCase())) cleaned.searchParams.delete(name);
  }
  cleaned.searchParams.sort();
  return cleaned;
}

function entryPaths(url: URL): { body: string; meta: string } {
  const key = createHash('sha256').update(`GET ${withoutSecrets(url).href}`).digest('hex');
  const shard = path.join(esriResponseCacheDirectory(), key.slice(0, 2));
  return { body: path.join(shard, `${key}.body`), meta: path.join(shard, `${key}.json`) };
}

async function readSavedResponse(paths: { body: string; meta: string }) {
  try {
    const meta = JSON.parse(await readFile(paths.meta, 'utf8')) as SavedResponse;
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
async function saveResponse(paths: { body: string; meta: string }, url: URL, status: number, contentType: string | null, body: Buffer) {
  const meta: SavedResponse = {
    status,
    contentType,
    capturedAt: new Date().toISOString(),
    redactedUrl: withoutSecrets(url).href,
    bodyBytes: body.length,
  };
  await writeAtomically(paths.body, body);
  await writeAtomically(paths.meta, `${JSON.stringify(meta)}\n`);
}

function responseHeaders(contentType: string | null): Record<string, string> {
  return {
    ...(contentType ? { 'content-type': contentType } : {}),
    'access-control-allow-origin': '*',
  };
}

/** Maps a failed live fetch to the browser error the live-outage checks already recognize. */
function abortReason(error: unknown): 'namenotresolved' | 'connectionreset' {
  return /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(String(error)) ? 'namenotresolved' : 'connectionreset';
}

async function serveEsriRequest(route: Route): Promise<void> {
  const request = route.request();
  if (request.method() !== 'GET') return route.fallback();
  const url = new URL(request.url());
  const paths = entryPaths(url);

  const saved = await readSavedResponse(paths);
  if (saved) {
    await route.fulfill({
      status: saved.meta.status,
      headers: responseHeaders(saved.meta.contentType),
      body: saved.body,
    });
    return;
  }

  try {
    const response = await route.fetch();
    const body = await response.body();
    const contentType = response.headers()['content-type'] ?? null;
    if (SAVED_STATUSES.has(response.status())) {
      await saveResponse(paths, url, response.status(), contentType, body);
    }
    await route.fulfill({ status: response.status(), headers: responseHeaders(contentType), body });
  } catch (error) {
    await route.abort(abortReason(error)).catch(() => undefined);
  }
}

export const test = base.extend<{ esriResponseCache: void }>({
  esriResponseCache: [
    async ({ context }, use) => {
      await context.route(isEsriRequest, serveEsriRequest);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
export type { CDPSession, Page, TestInfo } from '@playwright/test';
