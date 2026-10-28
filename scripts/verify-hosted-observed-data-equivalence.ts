/**
 * Verifies that the browser's hosted observed-gauge adapter rebuilds the same data as the files
 * shipped in apps/creek-visualization-browser/public/published-creek-visualization-data/, against
 * the LIVE public ArcGIS services (no token needed). Read-only: only `/query` and layer-metadata
 * requests are sent.
 *
 *   npm run data-products:verify-hosted-observed-data
 *
 * Checks (zero mismatches required):
 * - the browser's gauge datum, feet-to-meters factor, and conversion equal the pipeline's;
 * - Time Series: timestamps and water-surface elevation values over the shipped range, exactly
 *   (rows after the shipped snapshot's last timestamp are reported separately);
 * - prepared polygons of the gauge's Creek Segment: exact buckets, rings within 1e-7 degrees;
 * - Creek Segments of TNC flowline 27714637: ids, vertex indices, lengths, path geometry;
 * - the data contract accepts the hosted files (one shared segment network version) and the
 *   assembled data matches the local assembly.
 * It also reports Provisional vs Approved counts.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { FEET_TO_METERS as PIPELINE_FEET_TO_METERS, GAUGE_DATUM_FT as PIPELINE_GAUGE_DATUM_FT } from '../pipelines/creek-visualization-data-production/constants.ts';
import { waterSurfaceElevationM as pipelineWaterSurfaceElevationM } from '../pipelines/creek-visualization-data-production/observed-time-series-publication.ts';
import { assembleLoadedCreekVisualization } from '../apps/creek-visualization-browser/src/creek-data-contract.ts';
import { creekDataSourceConfiguration } from '../apps/creek-visualization-browser/src/creek-data-source-configuration.ts';
import type { FetchImplementation } from '../apps/creek-visualization-browser/src/hosted-feature-service-query.ts';
import { JALAMA_GAUGE, loadHostedObservedGauge } from '../apps/creek-visualization-browser/src/hosted-observed-gauge.ts';
import {
  FEET_TO_METERS,
  GAUGE_DATUM_FT,
  waterSurfaceElevationMFromGaugeHeightFt,
} from '../apps/creek-visualization-browser/src/observed-gauge-readings.ts';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_ROOT = path.join(REPOSITORY_ROOT, 'apps/creek-visualization-browser/public/published-creek-visualization-data');
const COORDINATE_TOLERANCE_DEG = 1e-7;
const MAX_LISTED_MISMATCHES = 8;

type LonLat = readonly [number, number];

interface ShippedFiles {
  creekSegments: {
    segmentNetworkVersion: string;
    creekSegments: {
      segmentId: string;
      comid: number | string;
      vertexIndexStart: number;
      vertexIndexEnd: number;
      lengthM: number;
      pathWgs84: LonLat[];
    }[];
  };
  waterSurfacePolygonSets: {
    segmentNetworkVersion: string;
    waterSurfacePolygonSets: {
      segmentId: string;
      elevationBuckets: { minWaterSurfaceElevationM: number; maxWaterSurfaceElevationM: number; ringsWgs84: LonLat[][] }[];
    }[];
  };
  monitoringStations: unknown;
  dataSourceMetadata: unknown;
  observedTimeSeries: {
    segmentNetworkVersion: string;
    timestampsUtcMs: number[];
    segments: { segmentId: string; waterSurfaceElevationM: (number | null)[] }[];
  };
}

// ---------------------------------------------------------------------------
// Request accounting

const requestStats = { requests: 0, rows: 0 };

/** Plain fetch that counts requests and returned rows (features). */
const countingFetch: FetchImplementation = async (url, init) => {
  requestStats.requests += 1;
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    async json() {
      const body = (await response.json()) as { features?: unknown[] };
      if (Array.isArray(body.features)) requestStats.rows += body.features.length;
      return body;
    },
  };
};

// ---------------------------------------------------------------------------
// Comparison results

interface ComparisonResult {
  name: string;
  checked: number;
  mismatchCount: number;
  mismatches: string[];
  notes: string[];
}

const results: ComparisonResult[] = [];

function runComparison(name: string, compare: (result: ComparisonResult) => void): void {
  const result: ComparisonResult = { name, checked: 0, mismatchCount: 0, mismatches: [], notes: [] };
  try {
    compare(result);
  } catch (error) {
    recordMismatch(result, `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  results.push(result);
  process.stdout.write(`${result.mismatchCount === 0 ? 'OK  ' : 'FAIL'} ${name}: ${result.checked} checked, ${result.mismatchCount} mismatches\n`);
  for (const note of result.notes) process.stdout.write(`       note: ${note}\n`);
  for (const mismatch of result.mismatches) process.stdout.write(`       - ${mismatch}\n`);
}

function recordMismatch(result: ComparisonResult, message: string): void {
  result.mismatchCount += 1;
  if (result.mismatches.length < MAX_LISTED_MISMATCHES) result.mismatches.push(message);
}

function pointsClose(a: readonly number[], b: readonly number[]): boolean {
  return Math.abs(a[0] - b[0]) <= COORDINATE_TOLERANCE_DEG && Math.abs(a[1] - b[1]) <= COORDINATE_TOLERANCE_DEG;
}

// ---------------------------------------------------------------------------
// Main

const configuration = creekDataSourceConfiguration;
process.stdout.write(
  `Hosted observed gauge equivalence check\n  gauge service: ${configuration.creekGaugeServiceUrl}\n` +
    `  modeled WSE: ${configuration.observedGaugeModeledWseServiceUrl}\n  WSE polygons: ${configuration.observedGaugeWsePolygonsServiceUrl}\n` +
    `  shipped files: ${path.relative(REPOSITORY_ROOT, SHIPPED_ROOT)}\n\n`,
);

async function readShippedJson<Value>(relativePath: string): Promise<Value> {
  return JSON.parse(await readFile(path.join(SHIPPED_ROOT, relativePath), 'utf8')) as Value;
}

const shipped: ShippedFiles = {
  creekSegments: await readShippedJson('creek-segments.json'),
  waterSurfacePolygonSets: await readShippedJson('water-surface-polygon-sets.json'),
  monitoringStations: await readShippedJson('monitoring-stations.json'),
  dataSourceMetadata: await readShippedJson('data-source-metadata.json'),
  observedTimeSeries: await readShippedJson('creek-segment-time-series/usgs-11120600-observed-wse.json'),
};

const startedAt = performance.now();
const { files: hostedFiles, droppedDuplicateCount } = await loadHostedObservedGauge(
  {
    modeledWseServiceUrl: configuration.observedGaugeModeledWseServiceUrl,
    wsePolygonsServiceUrl: configuration.observedGaugeWsePolygonsServiceUrl,
    creekGaugeServiceUrl: configuration.creekGaugeServiceUrl,
  },
  { fetchImplementation: countingFetch },
);
const hosted = hostedFiles as unknown as ShippedFiles & {
  observedTimeSeries: { approvalStatuses: (string | null)[] };
};
process.stdout.write(
  `Loaded hosted observed gauge in ${((performance.now() - startedAt) / 1000).toFixed(1)} s: ` +
    `${requestStats.requests} requests, ${requestStats.rows} rows\n\n`,
);

runComparison('Conversion constants and formula equal the pipeline', (result) => {
  if (GAUGE_DATUM_FT !== PIPELINE_GAUGE_DATUM_FT) recordMismatch(result, `gauge datum ${GAUGE_DATUM_FT} ≠ ${PIPELINE_GAUGE_DATUM_FT}`);
  if (FEET_TO_METERS !== PIPELINE_FEET_TO_METERS) recordMismatch(result, `feet to meters ${FEET_TO_METERS} ≠ ${PIPELINE_FEET_TO_METERS}`);
  for (let gaugeHeightFt = -5; gaugeHeightFt <= 30; gaugeHeightFt += 0.01) {
    const height = Number(gaugeHeightFt.toFixed(2));
    if (waterSurfaceElevationMFromGaugeHeightFt(height) !== pipelineWaterSurfaceElevationM(height)) {
      recordMismatch(result, `gauge height ${height} ft converts differently`);
    }
    result.checked += 1;
  }
});

runComparison('Time Series: timestamps and water-surface elevation over the shipped range', (result) => {
  const local = shipped.observedTimeSeries;
  const live = hosted.observedTimeSeries;
  const liveValues = live.segments[0].waterSurfaceElevationM;
  const localValues = local.segments[0].waterSurfaceElevationM;
  if (live.segments.length !== 1 || live.segments[0].segmentId !== local.segments[0].segmentId) {
    recordMismatch(result, `segment ${live.segments[0]?.segmentId} ≠ ${local.segments[0].segmentId}`);
  }
  for (let index = 0; index < local.timestampsUtcMs.length; index += 1) {
    if (live.timestampsUtcMs[index] !== local.timestampsUtcMs[index]) {
      recordMismatch(result, `timestamp ${index}: ${live.timestampsUtcMs[index]} ≠ ${local.timestampsUtcMs[index]}`);
    } else if (liveValues[index] !== localValues[index]) {
      recordMismatch(result, `value at ${index}: ${liveValues[index]} ≠ ${localValues[index]}`);
    }
    result.checked += 1;
  }
  const extra = live.timestampsUtcMs.length - local.timestampsUtcMs.length;
  result.notes.push(
    `${live.timestampsUtcMs.length} live readings, ${local.timestampsUtcMs.length} shipped; ${extra} extra live rows after ` +
      `${new Date(local.timestampsUtcMs[local.timestampsUtcMs.length - 1]).toISOString()}; ` +
      `${droppedDuplicateCount} identical duplicate timestamps dropped; ` +
      `${liveValues.filter((value) => value === null).length} null readings live, ${localValues.filter((value) => value === null).length} shipped`,
  );
  if (extra < 0) recordMismatch(result, `live service has ${-extra} fewer readings than the shipped file`);

  const counts = new Map<string, number>();
  for (const status of live.approvalStatuses) counts.set(String(status), (counts.get(String(status)) ?? 0) + 1);
  result.notes.push(
    `approval status of ${live.approvalStatuses.length} readings: ` +
      `${counts.get('Provisional') ?? 0} Provisional, ${counts.get('Approved') ?? 0} Approved, ${counts.get('null') ?? 0} unknown`,
  );
  if (live.approvalStatuses.length !== live.timestampsUtcMs.length) recordMismatch(result, 'approval statuses are not parallel to timestamps');
});

runComparison(`Prepared polygons of ${JALAMA_GAUGE.segmentId}: buckets and rings`, (result) => {
  const localSet = shipped.waterSurfacePolygonSets.waterSurfacePolygonSets.find((set) => set.segmentId === JALAMA_GAUGE.segmentId);
  const hostedSets = hosted.waterSurfacePolygonSets.waterSurfacePolygonSets;
  const hostedSet = hostedSets.find((set) => set.segmentId === JALAMA_GAUGE.segmentId);
  if (!localSet || !hostedSet || hostedSets.length !== 1) {
    recordMismatch(result, 'polygon set missing, or hosted returned a segment other than the gauge segment');
    return;
  }
  const localBuckets = localSet.elevationBuckets.filter((bucket) => bucket.ringsWgs84.length > 0);
  if (localBuckets.length !== hostedSet.elevationBuckets.length) {
    recordMismatch(result, `${hostedSet.elevationBuckets.length} buckets ≠ ${localBuckets.length}`);
    return;
  }
  let rings = 0;
  localBuckets.forEach((localBucket, index) => {
    const hostedBucket = hostedSet.elevationBuckets[index];
    if (
      localBucket.minWaterSurfaceElevationM !== hostedBucket.minWaterSurfaceElevationM ||
      localBucket.maxWaterSurfaceElevationM !== hostedBucket.maxWaterSurfaceElevationM
    ) {
      recordMismatch(result, `bucket ${index} bounds differ`);
    }
    if (localBucket.ringsWgs84.length !== hostedBucket.ringsWgs84.length) {
      recordMismatch(result, `bucket ${index}: ${hostedBucket.ringsWgs84.length} rings ≠ ${localBucket.ringsWgs84.length}`);
    } else {
      localBucket.ringsWgs84.forEach((localRing, ringIndex) => {
        const hostedRing = hostedBucket.ringsWgs84[ringIndex];
        rings += 1;
        if (localRing.length !== hostedRing.length || !localRing.every((point, pointIndex) => pointsClose(point, hostedRing[pointIndex]))) {
          recordMismatch(result, `bucket ${index} ring ${ringIndex} differs`);
        }
      });
    }
    result.checked += 1;
  });
  result.notes.push(`${localBuckets.length} buckets, ${rings} rings compared in order`);
});

runComparison('Creek Segments of flowline 27714637: ids, vertex indices, lengths, paths', (result) => {
  const local = shipped.creekSegments.creekSegments;
  const live = hosted.creekSegments.creekSegments;
  if (local.length !== live.length) recordMismatch(result, `${live.length} segments ≠ ${local.length}`);
  const liveById = new Map(live.map((segment) => [segment.segmentId, segment]));
  let maxOffsetDeg = 0;
  for (const localSegment of local) {
    const liveSegment = liveById.get(localSegment.segmentId);
    if (!liveSegment) {
      recordMismatch(result, `${localSegment.segmentId} missing from hosted`);
      continue;
    }
    if (liveSegment.vertexIndexStart !== localSegment.vertexIndexStart || liveSegment.vertexIndexEnd !== localSegment.vertexIndexEnd) {
      recordMismatch(result, `${localSegment.segmentId} vertex indices differ`);
    }
    if (liveSegment.lengthM !== localSegment.lengthM) {
      recordMismatch(result, `${localSegment.segmentId} length ${liveSegment.lengthM} ≠ ${localSegment.lengthM}`);
    }
    if (String(liveSegment.comid) !== String(localSegment.comid)) recordMismatch(result, `${localSegment.segmentId} comid differs`);
    if (liveSegment.pathWgs84.length !== localSegment.pathWgs84.length) {
      recordMismatch(result, `${localSegment.segmentId} path vertex count differs`);
    } else {
      localSegment.pathWgs84.forEach((point, index) => {
        const livePoint = liveSegment.pathWgs84[index];
        maxOffsetDeg = Math.max(maxOffsetDeg, Math.abs(point[0] - livePoint[0]), Math.abs(point[1] - livePoint[1]));
      });
      if (!localSegment.pathWgs84.every((point, index) => pointsClose(point, liveSegment.pathWgs84[index]))) {
        recordMismatch(result, `${localSegment.segmentId} path differs by more than ${COORDINATE_TOLERANCE_DEG}°`);
      }
    }
    result.checked += 1;
  }
  result.notes.push(`largest vertex offset ${maxOffsetDeg.toExponential(2)}°`);
});

runComparison('Data contract accepts the hosted files; assembled data matches local', (result) => {
  const localData = assembleLoadedCreekVisualization(shipped, JALAMA_GAUGE.stationId);
  const hostedData = assembleLoadedCreekVisualization(hostedFiles, JALAMA_GAUGE.stationId);
  result.notes.push(`segmentNetworkVersion local ${localData.segmentNetworkVersion}, hosted ${hostedData.segmentNetworkVersion}`);
  const checks: [string, boolean][] = [
    ['station', JSON.stringify(localData.station) === JSON.stringify(hostedData.station)],
    ['segment ids', [...localData.segmentsById.keys()].join() === [...hostedData.segmentsById.keys()].join()],
    ['polygon set segment ids', localData.polygonSetSegmentIds.join() === hostedData.polygonSetSegmentIds.join()],
    ['clock first slot', localData.clock.firstUtcMs === hostedData.clock.firstUtcMs && localData.clock.stepMs === hostedData.clock.stepMs],
    ['opening grid index', localData.openingGridIndex === hostedData.openingGridIndex],
    ['hosted approval statuses present', hostedData.approvalStatuses?.length === hostedData.timestampsUtcMs.length],
    ['local approval statuses absent', localData.approvalStatuses === undefined],
  ];
  for (const [label, same] of checks) {
    if (!same) recordMismatch(result, `${label} differs`);
    result.checked += 1;
  }
});

const failed = results.filter((result) => result.mismatchCount > 0);
process.stdout.write(
  `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} comparisons without mismatches; ` +
    `${requestStats.requests} requests, ${requestStats.rows} rows, ${((performance.now() - startedAt) / 1000).toFixed(1)} s total\n`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
