/**
 * Options and small helpers shared by the hosted ArcGIS adapters
 * (`hosted-*.ts`). Every adapter accepts `HostedAdapterOptions` and passes
 * `token` / `fetchImplementation` through to `queryAllRows`, so a Node
 * verification script can reuse the same adapter functions as the browser.
 */

import type { FetchImplementation, QueryAllRowsOptions } from './hosted-feature-service-query.ts';

export interface HostedAdapterOptions {
  /** Short-lived token for Node scripts; the browser relies on IdentityManager instead. */
  readonly token?: string;
  /** Plain fetch for Node; when omitted, `@arcgis/core/request` is used. */
  readonly fetchImplementation?: FetchImplementation;
}

/** Copies only the authentication / transport fields into `queryAllRows` options. */
export function withHostedTransport(
  options: HostedAdapterOptions | undefined,
  query: Omit<QueryAllRowsOptions, 'token' | 'fetchImplementation'>,
): QueryAllRowsOptions {
  return {
    ...query,
    token: options?.token,
    fetchImplementation: options?.fetchImplementation,
  };
}

/** Joins a FeatureServer URL and a layer or table id. */
export function layerUrl(serviceUrl: string, layerId: number): string {
  return `${serviceUrl.replace(/\/+$/, '')}/${layerId}`;
}

/** SQL string literal for a `where` clause (single quotes doubled). */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SQL timestamp literal ArcGIS Enterprise accepts for date fields (UTC). */
export function sqlTimestamp(utcMs: number): string {
  const iso = new Date(utcMs).toISOString();
  return `TIMESTAMP '${iso.slice(0, 10)} ${iso.slice(11, 19)}'`;
}

/** Reads a numeric attribute; returns null for null / missing / non-numeric values. */
export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reads a string attribute; numbers are stringified (e.g. a numeric TNC COMID). */
export function stringOrEmpty(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** Parses a JSON text attribute; returns `fallback` when empty or invalid. */
export function parseJsonAttribute<Value>(value: unknown, fallback: Value): Value {
  if (typeof value !== 'string' || value.trim() === '') {
    return (value ?? fallback) as Value;
  }
  try {
    return JSON.parse(value) as Value;
  } catch {
    return fallback;
  }
}
