import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OBSERVED_POLYGON_SET_PROVENANCE_FILE,
  OBSERVED_POLYGON_SET_SNAPSHOT_FILE,
} from '../../../../../pipelines/creek-visualization-data-production/constants.ts';

const TEST_NAME =
  "The observed gauge segment's published water polygons are identical to the modeled Stage 4 polygons for that segment.";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const GAUGE_SEGMENT_ID = '27714637-026';
const PUBLISHED_POLYGON_SETS_PATH = path.join(
  repositoryRoot,
  'apps/creek-visualization-browser/public/published-creek-visualization-data/water-surface-polygon-sets.json',
);
const RETAINED_DIRECTORY = path.join(repositoryRoot, 'data/retained-backend-source-data');
const STAGE_4_COMMAND = 'npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach';

interface PolygonSetsFile {
  segmentNetworkVersion: string;
  waterSurfacePolygonSets: Array<{ segmentId: string; elevationBuckets: unknown[] }>;
}

interface PolygonSetProvenance {
  segmentId: string;
  wsePolygonGenerationMethod: { id: string; version: number };
  source: { path: string };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function gaugeSegmentSet(file: PolygonSetsFile, label: string) {
  const sets = file.waterSurfacePolygonSets.filter((polygonSet) => polygonSet.segmentId === GAUGE_SEGMENT_ID);
  expect(sets, `${label} holds one ${GAUGE_SEGMENT_ID} polygon set`).toHaveLength(1);
  return { segmentNetworkVersion: file.segmentNetworkVersion, ...sets[0] };
}

describe('FST-004', () => {
  it(TEST_NAME, async (context) => {
    const provenance = await readJson<PolygonSetProvenance>(path.join(RETAINED_DIRECTORY, OBSERVED_POLYGON_SET_PROVENANCE_FILE));
    expect(provenance.segmentId).toBe(GAUGE_SEGMENT_ID);
    const { id, version } = provenance.wsePolygonGenerationMethod;
    expect(provenance.source.path).toContain(`/04-water-surface-polygons/${id}/v${version}/water-surface-polygon-sets/`);

    const stage4Path = path.join(repositoryRoot, provenance.source.path);
    if (!existsSync(stage4Path)) {
      // Pipeline output is gitignored and local. Skipping reports NOT RUN, never passed.
      context.skip(
        `Local Stage 4 output ${provenance.source.path} is missing, so the comparison cannot run. Run \`${STAGE_4_COMMAND}\` first.`,
      );
    }

    const stage4 = gaugeSegmentSet(await readJson<PolygonSetsFile>(stage4Path), 'Stage 4 output');
    const published = gaugeSegmentSet(await readJson<PolygonSetsFile>(PUBLISHED_POLYGON_SETS_PATH), 'Published file');
    const retained = gaugeSegmentSet(
      await readJson<PolygonSetsFile>(path.join(RETAINED_DIRECTORY, OBSERVED_POLYGON_SET_SNAPSHOT_FILE)),
      'Retained snapshot',
    );

    expect(stage4.elevationBuckets.length).toBeGreaterThan(0);
    expect(published, 'published polygons match Stage 4').toEqual(stage4);
    expect(retained, 'retained snapshot matches Stage 4').toEqual(stage4);
  });
});
