import path from 'node:path';
import { expectRecord, isRecord, readJson, writePrettyJson } from '../json-files.ts';
import { utm10nToUtm11n, type UtmPoint } from '../utm-geometry.ts';
import {
  roundValue,
  type CrosswalkSegment,
  type NhdplusV2ReachAssignmentFile,
  type NhdplusV2ReachCrosswalk,
} from './discharge-records.ts';
import { fetchJson, mapWithConcurrency, urlWithParams } from './http-download.ts';
import {
  DRAINAGE_AREA_RATIO,
  DRAINAGE_AREA_RATIO_TRANSFER,
  MAXIMUM_TRANSFER_DISTANCE_M,
} from './modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts';

/**
 * USGS drainage-area ratio method (see DRAINAGE_AREA_RATIO in pipeline-configuration.ts):
 * segment discharge = reach discharge × (segment drainage area ÷ reach drainage area), capped at 1.
 *
 * The segment drainage area comes from the Dangermond Preserve 2018 flow-accumulation raster
 * (2 m cells, values are upstream cell counts). This module samples every cell within the search
 * radius of a point with the ImageServer getSamples operation and keeps the largest count, then
 * turns the counts into km² and ratios. Sample results are cached in one JSON file so a rerun with
 * the same points fetches nothing.
 */

export const DRAINAGE_AREA_METHOD =
  'USGS drainage-area ratio method: segment discharge = reach discharge × drainageAreaRatio, where drainageAreaRatio = ' +
  'segmentDrainageAreaKm2 ÷ reachDrainageAreaKm2 capped to [0, 1] (flow is never increased). reachDrainageAreaKm2 is the ' +
  'NHDPlusV2 TotDASqKm of the assigned reach. segmentDrainageAreaKm2 is the largest upstream cell count within ' +
  `${DRAINAGE_AREA_RATIO.searchRadiusM} m of the Creek Segment's downstream thalweg point in the Dangermond Preserve 2018 ` +
  `flow-accumulation raster (${DRAINAGE_AREA_RATIO.cellSizeM} m cells), × ${DRAINAGE_AREA_RATIO.cellSizeM ** 2} m² per cell. ` +
  'A segment whose point lies outside the raster, or whose reach has no TotDASqKm, keeps ratio 1. ' +
  `A segment marked ${DRAINAGE_AREA_RATIO_TRANSFER.fieldName} (${DRAINAGE_AREA_RATIO_TRANSFER.label}) borrows a neighbouring creek's reach, ` +
  `so the ratio transfers that reach's discharge to it; one farther than ${MAXIMUM_TRANSFER_DISTANCE_M} m (transferDistanceM) gets no discharge.`;

/** The cached result of one getSamples request. */
interface FlowAccumulationSample {
  /** The sampled point in the raster's own coordinates (EPSG 32611 meters). */
  rasterX: number;
  rasterY: number;
  searchRadiusM: number;
  /** Cells the service returned inside the search circle. 0 means the point is outside the raster. */
  sampleCount: number;
  /** Largest upstream cell count among those cells; null when there were none. */
  maxUpstreamCells: number | null;
}

interface FlowAccumulationSampleCache {
  description: string;
  imageServerUrl: string;
  samplesBySegmentId: Record<string, FlowAccumulationSample>;
}

function circlePolygon(center: UtmPoint, radiusM: number): number[][] {
  const vertices = 24;
  return Array.from({ length: vertices + 1 }, (_, index) => {
    const angle = (index / vertices) * 2 * Math.PI;
    return [roundValue(center.x + radiusM * Math.cos(angle), 2), roundValue(center.y + radiusM * Math.sin(angle), 2)];
  });
}

/** Every raster cell inside the circle around `rasterPoint`, as upstream cell counts. */
async function fetchUpstreamCellCounts(rasterPoint: UtmPoint): Promise<number[]> {
  const url = urlWithParams(`${DRAINAGE_AREA_RATIO.flowAccumulationImageServerUrl}/getSamples`, {
    geometry: JSON.stringify({ rings: [circlePolygon(rasterPoint, DRAINAGE_AREA_RATIO.searchRadiusM)] }),
    geometryType: 'esriGeometryPolygon',
    sr: String(DRAINAGE_AREA_RATIO.rasterWkid),
    sampleDistance: String(DRAINAGE_AREA_RATIO.cellSizeM),
    returnFirstValueOnly: 'false',
    f: 'json',
  });
  const response = expectRecord(await fetchJson(url), 'flow accumulation getSamples response');
  if (isRecord(response.error)) throw new Error(`Flow accumulation getSamples failed: ${JSON.stringify(response.error)}`);
  const samples = Array.isArray(response.samples) ? response.samples : [];
  return samples.flatMap((sample) => {
    const value = isRecord(sample) ? Number(sample.value) : Number.NaN;
    return Number.isFinite(value) ? [value] : [];
  });
}

async function readSampleCache(cachePath: string): Promise<FlowAccumulationSampleCache> {
  try {
    const record = expectRecord(await readJson(cachePath), cachePath);
    if (record.imageServerUrl === DRAINAGE_AREA_RATIO.flowAccumulationImageServerUrl && isRecord(record.samplesBySegmentId)) {
      return record as unknown as FlowAccumulationSampleCache;
    }
  } catch {
    // No usable cache yet.
  }
  return {
    description:
      'Flow-accumulation raster samples per Creek Segment: the largest upstream cell count within the search radius of the ' +
      'downstream thalweg point. Reused when the point and radius are unchanged.',
    imageServerUrl: DRAINAGE_AREA_RATIO.flowAccumulationImageServerUrl,
    samplesBySegmentId: {},
  };
}

function sameSamplePoint(cached: FlowAccumulationSample | undefined, rasterPoint: UtmPoint): cached is FlowAccumulationSample {
  return (
    cached !== undefined &&
    cached.searchRadiusM === DRAINAGE_AREA_RATIO.searchRadiusM &&
    Math.abs(cached.rasterX - rasterPoint.x) < 0.01 &&
    Math.abs(cached.rasterY - rasterPoint.y) < 0.01
  );
}

/**
 * Segment drainage area, km², for each Creek Segment's downstream thalweg point (EPSG 32610).
 * Returns null for a point outside the raster. Reads and updates the sample cache in `cacheDirectory`.
 */
export async function sampleSegmentDrainageAreas(input: {
  pointsBySegmentId: ReadonlyMap<string, UtmPoint>;
  cacheDirectory: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ areaKm2BySegmentId: Map<string, number | null>; cachePath: string; fetched: number; reused: number }> {
  const cachePath = path.join(input.cacheDirectory, DRAINAGE_AREA_RATIO.sampleCacheFile);
  const cache = await readSampleCache(cachePath);
  const entries = [...input.pointsBySegmentId.entries()];
  let fetched = 0;
  let reused = 0;
  let done = 0;
  const samples = await mapWithConcurrency(entries, DRAINAGE_AREA_RATIO.sampleConcurrency, async ([segmentId, point]) => {
    const rasterPoint = utm10nToUtm11n(point);
    const cached = cache.samplesBySegmentId[segmentId];
    let sample: FlowAccumulationSample;
    if (sameSamplePoint(cached, rasterPoint)) {
      sample = cached;
      reused += 1;
    } else {
      const counts = await fetchUpstreamCellCounts(rasterPoint);
      sample = {
        rasterX: roundValue(rasterPoint.x, 3),
        rasterY: roundValue(rasterPoint.y, 3),
        searchRadiusM: DRAINAGE_AREA_RATIO.searchRadiusM,
        sampleCount: counts.length,
        maxUpstreamCells: counts.length === 0 ? null : Math.max(...counts),
      };
      fetched += 1;
    }
    done += 1;
    input.onProgress?.(done, entries.length);
    return [segmentId, sample] as const;
  });
  const cellAreaKm2 = DRAINAGE_AREA_RATIO.cellSizeM ** 2 / 1e6;
  const areaKm2BySegmentId = new Map<string, number | null>();
  for (const [segmentId, sample] of samples) {
    cache.samplesBySegmentId[segmentId] = sample;
    areaKm2BySegmentId.set(segmentId, sample.maxUpstreamCells === null ? null : roundValue(sample.maxUpstreamCells * cellAreaKm2, 4));
  }
  await writePrettyJson(cachePath, cache);
  return { areaKm2BySegmentId, cachePath, fetched, reused };
}

/** segment area ÷ reach area, capped to [0, 1]; 1 when either area is unknown. */
export function drainageAreaRatio(segmentAreaKm2: number | null, reachAreaKm2: number | null): number {
  if (segmentAreaKm2 === null || reachAreaKm2 === null) return 1;
  if (!Number.isFinite(segmentAreaKm2) || !Number.isFinite(reachAreaKm2) || reachAreaKm2 <= 0) return 1;
  return roundValue(Math.min(1, Math.max(0, segmentAreaKm2 / reachAreaKm2)), DRAINAGE_AREA_RATIO.ratioDecimals);
}

/** The tracked crosswalk: Stage 0's reach assignments plus each Creek Segment's drainage-area ratio. */
export function buildCrosswalkWithDrainageAreaRatios(input: {
  assignments: NhdplusV2ReachAssignmentFile;
  segmentAreaKm2BySegmentId: ReadonlyMap<string, number | null>;
}): { crosswalk: NhdplusV2ReachCrosswalk; warnings: string[] } {
  const warnings: string[] = [];
  const segments: CrosswalkSegment[] = input.assignments.segments.map((assignment) => {
    const segmentDrainageAreaKm2 = input.segmentAreaKm2BySegmentId.get(assignment.segmentId) ?? null;
    if (segmentDrainageAreaKm2 === null) {
      warnings.push(`${assignment.segmentId}: no flow-accumulation value near its downstream thalweg; drainage-area ratio kept at 1.`);
    }
    return {
      ...assignment,
      segmentDrainageAreaKm2,
      drainageAreaRatio: drainageAreaRatio(segmentDrainageAreaKm2, assignment.reachDrainageAreaKm2),
    };
  });
  return {
    crosswalk: {
      note: input.assignments.note,
      segmentNetworkVersion: input.assignments.segmentNetworkVersion,
      method: input.assignments.method,
      drainageAreaMethod: DRAINAGE_AREA_METHOD,
      segments,
    },
    warnings,
  };
}

/** Min, median, and max of the ratios, for the stage summary. */
export function summarizeRatios(ratios: readonly number[]): { min: number; median: number; max: number; belowOne: number } {
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 1,
    median: sorted[Math.floor(sorted.length / 2)] ?? 1,
    max: sorted[sorted.length - 1] ?? 1,
    belowOne: sorted.filter((ratio) => ratio < 1).length,
  };
}
