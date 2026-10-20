import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function isScalarArray(value: unknown): value is (number | string | boolean | null)[] {
  return Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object');
}

/**
 * Indented JSON where arrays of plain numbers/strings/nulls stay on one line.
 * Long Time Series stay readable without one line per value.
 */
export function readableJson(value: unknown, indent = ''): string {
  const inner = `${indent}  `;
  if (isScalarArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${inner}${readableJson(item, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([key, entry]) => `${inner}${JSON.stringify(key)}: ${readableJson(entry, inner)}`);
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

export async function writeReadableJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${readableJson(value)}\n`);
}
