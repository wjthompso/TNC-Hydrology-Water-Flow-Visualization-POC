import { setTimeout as delay } from 'node:timers/promises';

/**
 * A rate-limited service (HTTP 429) that asks for a wait up to this long is waited for; a longer
 * wait (the USGS NLDI quota is 3,600 requests per hour) fails at once with the time to retry.
 */
const MAXIMUM_RETRY_AFTER_WAIT_MS = 60_000;

/** The wait a 429 response asks for, in milliseconds, or null when it gives none. */
function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * Small retrying fetch for public services. Retries HTTP 429, 5xx, and network errors three times,
 * honouring a short Retry-After on 429.
 */
export async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let waitMs = 1000 * attempt;
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      const body = await response.text();
      lastError = new Error(`Request failed with HTTP ${response.status} for ${url}\n${body.slice(0, 400)}`);
      const retryable = response.status >= 500 || response.status === 429;
      if (!retryable) break;
      if (response.status === 429) {
        const requestedWaitMs = retryAfterMs(response);
        if (requestedWaitMs !== null && requestedWaitMs > MAXIMUM_RETRY_AFTER_WAIT_MS) {
          const retryAt = new Date(Date.now() + requestedWaitMs).toISOString();
          lastError = new Error(`Rate limited (HTTP 429) by ${new URL(url).host}; it asks to retry after ${retryAt}.`, { cause: lastError });
          break;
        }
        waitMs = Math.max(waitMs, requestedWaitMs ?? 0);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt === 3) break;
    await delay(waitMs);
  }
  throw lastError ?? new Error(`Request failed for ${url}`);
}

export async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetchWithRetry(url);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetchWithRetry(url);
  return response.text();
}

export async function fetchJson(url: string): Promise<unknown> {
  const text = await fetchText(url);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Response was not JSON for ${url}. Body starts: ${text.slice(0, 200)}`);
  }
}

export function urlWithParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Run `work` over `items` with at most `concurrency` in flight, keeping result order. After the
 * first failure no further item is started (a rate-limited service must not be hit thousands more
 * times); the in-flight items finish, then the first error is rethrown.
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  async function worker(): Promise<void> {
    while (nextIndex < items.length && firstError === null) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index] as Item;
      try {
        results[index] = await work(item, index);
      } catch (error) {
        if (firstError === null) firstError = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  if (firstError !== null) throw firstError;
  return results;
}
