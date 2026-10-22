/**
 * Hosted feature service query client.
 *
 * Reads every matching row from one ArcGIS feature layer or table through the
 * REST `/query` endpoint, paging with `resultOffset` / `resultRecordCount`.
 * Framework-independent: the browser uses `@arcgis/core/request` (so the
 * IdentityManager sign-in dialog handles private items), and Node scripts
 * inject a plain `fetch` plus a short-lived token.
 */

export const DEFAULT_PAGE_SIZE = 16000;
export const MAX_PARALLEL_PAGE_REQUESTS = 4;
/**
 * One attempt gives up after this long; a request that fails or times out is retried once.
 * A warm query answers in under 0.5 s, so 15 s caps a hung request at about 30 s in total.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
export const RETRY_DELAY_MS = 500;

export interface HostedFeatureRow {
  readonly attributes: Record<string, unknown>;
  readonly geometry?: Record<string, unknown>;
}

/** Fetch-compatible function; only `fetch(url, init)` returning `json()` is used. */
export type FetchImplementation = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface QueryAllRowsOptions {
  /** Layer or table URL, e.g. `.../FeatureServer/3`. */
  readonly layerUrl: string;
  readonly where?: string;
  readonly outFields?: readonly string[];
  /** Required for stable paging; e.g. `['location_id', 'valid_from_utc']`. */
  readonly orderByFields?: readonly string[];
  readonly returnGeometry?: boolean;
  readonly outSpatialReferenceWkid?: number;
  /**
   * Rows per request. Defaults to the layer's `standardMaxRecordCount`; set it when a service
   * returns fewer rows per request than that (the gauge service answers at most 2000).
   */
  readonly pageSize?: number;
  /** Short-lived token for Node scripts; the browser relies on IdentityManager instead. */
  readonly token?: string;
  /** Plain fetch for Node; when omitted, `@arcgis/core/request` is used. */
  readonly fetchImplementation?: FetchImplementation;
}

/** ArcGIS error codes meaning "sign in or use a valid token". */
const AUTHENTICATION_ERROR_CODES = new Set([401, 403, 498, 499]);

// Explicit fields (no constructor parameter properties) so Node's type stripping can load this module.
export class HostedFeatureServiceQueryError extends Error {
  readonly code: number | undefined;
  readonly layerUrl: string;

  constructor(message: string, code: number | undefined, layerUrl: string) {
    super(message);
    this.name = 'HostedFeatureServiceQueryError';
    this.code = code;
    this.layerUrl = layerUrl;
  }
}

/** Raised when the service rejects the request for missing or invalid credentials. */
export class HostedFeatureServiceAuthenticationError extends HostedFeatureServiceQueryError {
  constructor(message: string, code: number | undefined, layerUrl: string) {
    super(message, code, layerUrl);
    this.name = 'HostedFeatureServiceAuthenticationError';
  }
}

interface ArcgisErrorBody {
  readonly code?: number;
  readonly message?: string;
  readonly details?: readonly string[];
}

interface QueryResponseBody {
  readonly error?: ArcgisErrorBody;
  readonly count?: number;
  readonly features?: readonly HostedFeatureRow[];
  readonly exceededTransferLimit?: boolean;
}

interface LayerMetadataBody {
  readonly error?: ArcgisErrorBody;
  readonly standardMaxRecordCount?: number;
  readonly maxRecordCount?: number;
}

/** Returns every row matching `where`, in `orderByFields` order. */
export async function queryAllRows(options: QueryAllRowsOptions): Promise<HostedFeatureRow[]> {
  const pageSize = options.pageSize ?? (await readPageSize(options));
  const totalCount = await queryRowCount(options);
  if (totalCount === 0) {
    return [];
  }

  const pageOffsets: number[] = [];
  for (let offset = 0; offset < totalCount; offset += pageSize) {
    pageOffsets.push(offset);
  }

  const pages = await mapWithConcurrencyLimit(pageOffsets, MAX_PARALLEL_PAGE_REQUESTS, (offset) =>
    queryPage(options, offset, pageSize),
  );
  const rows = pages.flatMap((page) => page.rows);

  // Rows can be added between the count and the last page; keep paging until the service says done.
  let lastPage = pages[pages.length - 1];
  let nextOffset = pageOffsets[pageOffsets.length - 1] + lastPage.rows.length;
  while (lastPage.exceededTransferLimit && lastPage.rows.length > 0) {
    lastPage = await queryPage(options, nextOffset, pageSize);
    rows.push(...lastPage.rows);
    nextOffset += lastPage.rows.length;
  }
  return rows;
}

/** Number of rows matching `where` (`returnCountOnly=true`). */
export async function queryRowCount(options: QueryAllRowsOptions): Promise<number> {
  const body = await requestJson<QueryResponseBody>(options, `${options.layerUrl}/query`, {
    where: options.where ?? '1=1',
    returnCountOnly: 'true',
  });
  return body.count ?? 0;
}

async function readPageSize(options: QueryAllRowsOptions): Promise<number> {
  const metadata = await requestJson<LayerMetadataBody>(options, options.layerUrl, {});
  return metadata.standardMaxRecordCount ?? metadata.maxRecordCount ?? DEFAULT_PAGE_SIZE;
}

async function queryPage(
  options: QueryAllRowsOptions,
  resultOffset: number,
  resultRecordCount: number,
): Promise<{ rows: HostedFeatureRow[]; exceededTransferLimit: boolean }> {
  const parameters: Record<string, string> = {
    where: options.where ?? '1=1',
    outFields: options.outFields?.join(',') ?? '*',
    returnGeometry: String(options.returnGeometry ?? false),
    resultOffset: String(resultOffset),
    resultRecordCount: String(resultRecordCount),
  };
  if (options.orderByFields?.length) {
    parameters.orderByFields = options.orderByFields.join(',');
  }
  if (options.outSpatialReferenceWkid !== undefined) {
    parameters.outSR = String(options.outSpatialReferenceWkid);
  }

  const body = await requestJson<QueryResponseBody>(options, `${options.layerUrl}/query`, parameters);
  return {
    rows: [...(body.features ?? [])],
    exceededTransferLimit: Boolean(body.exceededTransferLimit),
  };
}

/**
 * Sends one `f=json` request, then throws a typed error if the body carries an ArcGIS `error`.
 * Each attempt times out after `REQUEST_TIMEOUT_MS`; a timeout, network failure, or 5xx is retried once.
 */
async function requestJson<Body extends { error?: ArcgisErrorBody }>(
  options: QueryAllRowsOptions,
  url: string,
  parameters: Record<string, string>,
): Promise<Body> {
  const query = { ...parameters, f: 'json' };
  return withTimeoutAndOneRetry(url, async (signal) => {
    const body = options.fetchImplementation
      ? await requestWithFetch<Body>(options.fetchImplementation, url, query, options.token, signal)
      : await requestWithArcgisCore<Body>(url, query, options.token, signal);

    if (body.error) {
      throw createQueryError(body.error.code, describeArcgisError(body.error), url);
    }
    return body;
  });
}

async function withTimeoutAndOneRetry<Value>(
  url: string,
  attempt: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  try {
    return await attemptWithTimeout(url, attempt);
  } catch (error) {
    if (!isWorthRetrying(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return attemptWithTimeout(url, attempt);
  }
}

async function attemptWithTimeout<Value>(
  url: string,
  attempt: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    return await attempt(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new HostedFeatureServiceQueryError(
        `Hosted feature service request timed out after ${REQUEST_TIMEOUT_MS / 1000} s for ${url}.`,
        undefined,
        url,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Network failures, timeouts, and 5xx answers can pass on a second try; sign-in and 4xx answers cannot. */
function isWorthRetrying(error: unknown): boolean {
  if (error instanceof HostedFeatureServiceAuthenticationError) return false;
  if (error instanceof HostedFeatureServiceQueryError) {
    return error.code === undefined || error.code >= 500;
  }
  return true;
}

/** POST form body keeps long `where` clauses under URL length limits; token travels in the body. */
async function requestWithFetch<Body>(
  fetchImplementation: FetchImplementation,
  url: string,
  query: Record<string, string>,
  token: string | undefined,
  signal: AbortSignal,
): Promise<Body> {
  const form = new URLSearchParams(token ? { ...query, token } : query);
  const response = await fetchImplementation(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal,
  });
  if (!response.ok) {
    throw createQueryError(response.status, `HTTP ${response.status}`, url);
  }
  return (await response.json()) as Body;
}

async function requestWithArcgisCore<Body>(
  url: string,
  query: Record<string, string>,
  token: string | undefined,
  signal: AbortSignal,
): Promise<Body> {
  const { default: esriRequest } = await import('@arcgis/core/request');
  try {
    const response = await esriRequest(url, {
      query: token ? { ...query, token } : query,
      responseType: 'json',
      signal,
    });
    return response.data as Body;
  } catch (error) {
    throw toQueryErrorFromArcgisCore(error, url);
  }
}

/** `esriRequest` rejects with an `esri.core.Error`; its details carry the HTTP or ArcGIS code. */
function toQueryErrorFromArcgisCore(error: unknown, url: string): HostedFeatureServiceQueryError {
  const errorLike = error as {
    name?: string;
    message?: string;
    details?: { httpStatus?: number; messageCode?: string; raw?: { code?: number } };
  };
  const code = errorLike.details?.raw?.code ?? errorLike.details?.httpStatus;
  // IdentityManager rejects with `identity-manager:*` names (user-aborted, not-authorized, …)
  // when the person cancels the sign-in dialog or the credentials are refused.
  if (errorLike.name?.startsWith('identity-manager:')) {
    return new HostedFeatureServiceAuthenticationError(`Sign-in failed (${errorLike.name}).`, code, url);
  }
  return createQueryError(code, errorLike.message ?? String(error), url);
}

function createQueryError(
  code: number | undefined,
  description: string,
  url: string,
): HostedFeatureServiceQueryError {
  const message = `Hosted feature service request failed (code ${code ?? 'unknown'}) for ${url}: ${description}`;
  return code !== undefined && AUTHENTICATION_ERROR_CODES.has(code)
    ? new HostedFeatureServiceAuthenticationError(message, code, url)
    : new HostedFeatureServiceQueryError(message, code, url);
}

function describeArcgisError(error: ArcgisErrorBody): string {
  const details = error.details?.filter(Boolean).join('; ');
  return [error.message ?? 'Unknown error', details].filter(Boolean).join(' — ');
}

/** Runs `task` over `items` with at most `limit` in flight; results keep input order. */
async function mapWithConcurrencyLimit<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
