import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TNC_FLOWLINE_QUERY, sourceInputsDirectory } from '../constants.ts';

/**
 * Downloads every TNC flowline in the Dangermond Preserve (the layer is already
 * clipped to the preserve) in EPSG 32610 and saves it as a tracked source input,
 * like the Jalama snapshot. Stage 0 reads this file; it does not download it.
 * Rerun only to refresh the snapshot on purpose:
 *   node --experimental-strip-types pipelines/creek-visualization-data-production/modeled-water-surface-elevation/retain-dangermond-preserve-flowlines.ts
 */

export const DANGERMOND_PRESERVE_FLOWLINE_SNAPSHOT_FILE = 'tnc-flowlines-dangermond-preserve.json';
const PAGE_SIZE = 50;

interface FeatureServerPage {
  features?: unknown[];
  exceededTransferLimit?: boolean;
  spatialReference?: unknown;
  error?: { message?: string };
  [key: string]: unknown;
}

async function fetchPage(offset: number): Promise<FeatureServerPage> {
  const parameters = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '32610',
    orderByFields: 'COMID',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'json',
  });
  const response = await fetch(`${TNC_FLOWLINE_QUERY}?${parameters.toString()}`);
  if (!response.ok) throw new Error(`TNC flowline query failed with HTTP ${response.status} at offset ${offset}.`);
  const page = (await response.json()) as FeatureServerPage;
  if (page.error) throw new Error(`TNC flowline query error: ${page.error.message ?? 'unknown'}`);
  return page;
}

const firstPage = await fetchPage(0);
const features = [...(firstPage.features ?? [])];
let page = firstPage;
while (page.exceededTransferLimit && (page.features?.length ?? 0) > 0) {
  page = await fetchPage(features.length);
  features.push(...(page.features ?? []));
}

// Keep the service's own response shape (spatialReference, fields, ...) with every feature.
const snapshot = { ...firstPage, features, exceededTransferLimit: false };
const outputPath = path.join(sourceInputsDirectory, DANGERMOND_PRESERVE_FLOWLINE_SNAPSHOT_FILE);
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Saved ${features.length} TNC flowlines to ${path.relative(process.cwd(), outputPath)}.`);
