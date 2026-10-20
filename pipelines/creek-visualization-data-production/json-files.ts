import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object.`);
  return value;
}

export function expectNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} is missing a finite number for ${key}.`);
  }
  return value;
}

export function expectString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing text for ${key}.`);
  }
  return value;
}

export function expectNullableNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  if (!(key in record)) throw new Error(`${label} is missing ${key}.`);
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} has a non-numeric ${key}.`);
  }
  return value;
}

export function expectNullableString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (!(key in record)) throw new Error(`${label} is missing ${key}.`);
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} has a non-text ${key}.`);
  return value;
}

export async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${filePath}. Run npm run pipeline:acquire first.`, { cause: error });
  }
}

export async function writePrettyJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeCompactJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}
