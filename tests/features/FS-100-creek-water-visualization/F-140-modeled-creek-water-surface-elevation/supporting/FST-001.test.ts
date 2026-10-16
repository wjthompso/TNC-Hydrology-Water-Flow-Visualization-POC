import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MODELED_WSE_VALIDATION_CHECKS,
  validateModeledWaterSurfaceElevationOutputs,
} from '../../../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-water-surface-elevation-validation.ts';
import {
  CROSS_SECTION,
  WATER_SURFACE_ELEVATION_VARIABLE_ID,
} from '../../../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/pipeline-configuration.ts';
import type {
  CrossSectionRecord,
  CrossSectionsFile,
  PolygonLaddersFile,
  WaterSurfaceElevationTimeSeriesFile,
  WaterSurfacePolygonSetsFile,
} from '../../../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/stage-file-formats.ts';

const TEST_NAME = "Modeled water-surface elevation validation rejects a value below its Creek Segment's bed.";

/** Synthetic two-segment network. Nothing here comes from real pipeline output. */
const SEGMENT_NETWORK_VERSION = 'synthetic-fst-001-network-v1';
const DATASET_ID = 'synthetic-modeled-dataset';
const TIME_SERIES_RELATIVE_PATH = `time-series/${DATASET_ID}/2020.json`;
const UPSTREAM = { segmentId: 'synthetic-segment-001', bedElevationM: 100, ceilingM: 104 };
const DOWNSTREAM = { segmentId: 'synthetic-segment-002', bedElevationM: 50, ceilingM: 54 };
const TIMESTAMPS_UTC_MS = [Date.UTC(2020, 0, 1), Date.UTC(2020, 1, 1), Date.UTC(2020, 2, 1)];

function crossSectionRecord(segment: typeof UPSTREAM): CrossSectionRecord {
  return {
    segmentId: segment.segmentId,
    networkDistanceMidM: 0,
    bedElevationM: segment.bedElevationM,
    rawSlope: 0.01,
    slope: 0.01,
    slopeFloored: false,
    representativeSectionIndex: 0,
    lowestBankTopM: segment.ceilingM,
    sections: [],
    profileOffsetsM: [],
    profileElevationsM: [],
    warnings: [],
  };
}

const crossSections: CrossSectionsFile = {
  segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
  description: 'Synthetic FST-001 cross-sections.',
  parameters: CROSS_SECTION,
  thalwegOffsetFromFlowlineM: { medianM: 0, p90M: 0, maxM: 0 },
  segments: [crossSectionRecord(UPSTREAM), crossSectionRecord(DOWNSTREAM)],
};

const ladders: PolygonLaddersFile = {
  segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
  description: 'Synthetic FST-001 polygon ladders.',
  segments: [UPSTREAM, DOWNSTREAM].map((segment) => ({
    segmentId: segment.segmentId,
    bedElevationM: segment.bedElevationM,
    maxModeledWaterSurfaceElevationM: segment.ceilingM - 1,
    ceilingM: segment.ceilingM,
    fineBuckets: 1,
    coarseBuckets: 0,
    emptyBuckets: 0,
  })),
};

const polygonSets: WaterSurfacePolygonSetsFile = {
  segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
  waterSurfacePolygonSets: [
    { segmentId: UPSTREAM.segmentId, elevationBuckets: [] },
    { segmentId: DOWNSTREAM.segmentId, elevationBuckets: [] },
  ],
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Writes one Time Series file into a fresh temp Stage 3 directory and validates it. */
async function validateFixture(upstreamValues: (number | null)[]) {
  const timeSeriesDirectory = await mkdtemp(path.join(os.tmpdir(), 'fst-001-'));
  temporaryDirectories.push(timeSeriesDirectory);
  const timeSeriesFile: WaterSurfaceElevationTimeSeriesFile = {
    segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    datasetId: DATASET_ID,
    variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID,
    timestampsUtcMs: TIMESTAMPS_UTC_MS,
    segments: [
      { segmentId: UPSTREAM.segmentId, values: upstreamValues },
      { segmentId: DOWNSTREAM.segmentId, values: [50.4, 51.2, null] },
    ],
  };
  const absolutePath = path.join(timeSeriesDirectory, TIME_SERIES_RELATIVE_PATH);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(timeSeriesFile));
  return validateModeledWaterSurfaceElevationOutputs({
    expectedSegmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    segmentIds: [UPSTREAM.segmentId, DOWNSTREAM.segmentId],
    crossSections,
    ladders,
    polygonSetFiles: [{ relativePath: 'water-surface-polygon-sets/synthetic.json', contents: polygonSets }],
    catalogDatasets: [{ datasetId: DATASET_ID }],
    timeSeriesDirectory,
  });
}

describe('FST-001', () => {
  it(TEST_NAME, async () => {
    // A value exactly at the bed is legal, so the valid fixture includes one.
    const valid = await validateFixture([UPSTREAM.bedElevationM, null, 101.5]);
    expect(valid.checks.filter((check) => !check.passed)).toEqual([]);
    expect(valid.passed).toBe(true);
    expect(valid.valuesChecked).toBe(4);

    const belowBedValue = Number((UPSTREAM.bedElevationM - 0.1).toFixed(3));
    const invalid = await validateFixture([100.2, belowBedValue, 101.5]);
    expect(invalid.passed).toBe(false);
    const failedChecks = invalid.checks.filter((check) => !check.passed);
    expect(failedChecks.map((check) => check.check)).toEqual([MODELED_WSE_VALIDATION_CHECKS.valuesAtOrAboveBed]);
    const [belowBed] = failedChecks;
    expect(belowBed?.violations).toBe(1);
    expect(belowBed?.examples).toHaveLength(1);
    const example = belowBed?.examples[0] ?? '';
    expect(example).toContain(TIME_SERIES_RELATIVE_PATH);
    expect(example).toContain(UPSTREAM.segmentId);
    expect(example).not.toContain(DOWNSTREAM.segmentId);
    expect(example).toContain(new Date(TIMESTAMPS_UTC_MS[1] as number).toISOString());
    expect(example).toContain(`${belowBedValue} m < bed ${UPSTREAM.bedElevationM} m`);
  });
});
