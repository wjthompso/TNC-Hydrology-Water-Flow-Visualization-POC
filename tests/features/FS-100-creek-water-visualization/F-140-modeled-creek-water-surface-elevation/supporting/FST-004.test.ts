import { describe, expect, it } from 'vitest';
import { POLYGON_LADDER } from '../../../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/pipeline-configuration.ts';
import {
  JALAMA_EXTENT_ID,
  JALAMA_TNC_COMID,
  NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
  missingLocalPipelineOutput,
  readCrossSections,
  readWaterSurfaceElevationsAt,
  type CrossSectionsSummary,
  type SegmentThalweg,
} from '../behavior/local-pipeline-output.ts';

const TEST_NAME =
  'Adjacent wet Creek Segments leave no thalweg gap and no vertex step above 0.15 m in the local pipeline output.';

/** The two hours FBT-011 and FBT-012 look at in the browser. */
const HOURS_UTC = ['2022-12-01T12:00:00Z', '2023-01-10T01:00:00Z'] as const;
/** At most this share of adjacent wet pairs may have a dry thalweg point at the shared boundary. */
const MAXIMUM_GAP_PAIR_SHARE = 0.05;
/** The 90th percentile of the height step between neighbours' water surfaces at the boundary, m. */
const MAXIMUM_P90_STEP_M = 0.15;

interface AdjacentPair {
  readonly upstream: SegmentThalweg;
  readonly downstream: SegmentThalweg;
}

/** Consecutive Creek Segments of one TNC flowline, oriented upstream to downstream. */
function adjacentPairs(crossSections: CrossSectionsSummary, comid: string): AdjacentPair[] {
  const ids = crossSections.segmentIdsOfComid(comid);
  const direction = crossSections.downstreamIndexDirection(comid);
  const pairs: AdjacentPair[] = [];
  for (let index = 0; index + 1 < ids.length; index += 1) {
    const lower = crossSections.bySegmentId.get(ids[index] as string);
    const higher = crossSections.bySegmentId.get(ids[index + 1] as string);
    if (!lower || !higher) continue;
    pairs.push(direction === 1 ? { upstream: lower, downstream: higher } : { upstream: higher, downstream: lower });
  }
  return pairs;
}

/** The Stage 4 bucket floor a water-surface elevation falls into: the wet threshold the drawn polygon used. */
function bucketMinimumFor(waterSurfaceElevationM: number): number {
  const step = POLYGON_LADDER.fineStepM;
  return Math.floor(Math.round(waterSurfaceElevationM * 1000) / (step * 1000)) * step;
}

/** Thalweg points ordered upstream to downstream for one segment. */
function orderedBeds(segment: SegmentThalweg, direction: 1 | -1): number[] {
  const beds = segment.points.map((point) => point.bedElevationM);
  return direction === 1 ? beds : beds.reverse();
}

/**
 * Dry thalweg length at the shared boundary: the downstream-most dry points of
 * the upstream segment plus the upstream-most dry points of the downstream
 * segment, each point standing for its share of the segment's thalweg.
 */
function boundaryDryPoints(pair: AdjacentPair, direction: 1 | -1, upstreamWse: number, downstreamWse: number): number {
  const upstreamBeds = orderedBeds(pair.upstream, direction);
  const downstreamBeds = orderedBeds(pair.downstream, direction);
  const upstreamFloor = bucketMinimumFor(upstreamWse);
  const downstreamFloor = bucketMinimumFor(downstreamWse);
  let dry = 0;
  for (let index = upstreamBeds.length - 1; index >= 0 && (upstreamBeds[index] as number) >= upstreamFloor; index -= 1) dry += 1;
  for (let index = 0; index < downstreamBeds.length && (downstreamBeds[index] as number) >= downstreamFloor; index += 1) dry += 1;
  return dry;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? Number.NaN;
}

describe('FST-004', () => {
  it(TEST_NAME, (context) => {
    const timesUtcMs = HOURS_UTC.map((hour) => Date.parse(hour));
    const missing = missingLocalPipelineOutput({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timesUtcMs,
    });
    if (missing) context.skip(`SKIPPED, not passed: ${missing}`);

    const crossSections = readCrossSections(JALAMA_EXTENT_ID);
    const direction = crossSections.downstreamIndexDirection(JALAMA_TNC_COMID);
    const pairs = adjacentPairs(crossSections, JALAMA_TNC_COMID);
    expect(pairs.length, 'adjacent Creek Segment pairs on the Jalama flowline').toBeGreaterThan(10);

    const problems: string[] = [];
    for (const [hourIndex, hourUtc] of HOURS_UTC.entries()) {
      const timeUtcMs = timesUtcMs[hourIndex] as number;
      const elevations = readWaterSurfaceElevationsAt({
        extentId: JALAMA_EXTENT_ID,
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        comid: JALAMA_TNC_COMID,
        timeUtcMs,
      });
      expect(elevations, `a Time Series slot for ${hourUtc}`).not.toBeNull();
      if (!elevations) continue;

      let wetPairs = 0;
      let gapPairs = 0;
      const steps: number[] = [];
      const examples: string[] = [];
      for (const pair of pairs) {
        const upstreamWse = elevations.get(pair.upstream.segmentId) ?? null;
        const downstreamWse = elevations.get(pair.downstream.segmentId) ?? null;
        if (upstreamWse === null || downstreamWse === null) continue;
        if (upstreamWse <= pair.upstream.bedElevationM || downstreamWse <= pair.downstream.bedElevationM) continue;
        wetPairs += 1;
        const step = Math.abs(upstreamWse - downstreamWse);
        steps.push(step);
        const dryPoints = boundaryDryPoints(pair, direction, upstreamWse, downstreamWse);
        if (dryPoints > 0) gapPairs += 1;
        if (examples.length < 3 && (dryPoints > 0 || step > MAXIMUM_P90_STEP_M)) {
          examples.push(
            `${pair.upstream.segmentId}→${pair.downstream.segmentId}: water ${upstreamWse.toFixed(3)}→${downstreamWse.toFixed(3)} m ` +
              `(step ${step.toFixed(2)} m), ${dryPoints} dry thalweg point${dryPoints === 1 ? '' : 's'} at the boundary`,
          );
        }
      }
      expect(wetPairs, `adjacent wet pairs at ${hourUtc}`).toBeGreaterThan(0);

      const gapShare = gapPairs / wetPairs;
      const p90Step = percentile(steps, 0.9);
      const maxStep = Math.max(...steps);
      const figures =
        `${hourUtc}: ${wetPairs} adjacent wet pairs; ${gapPairs} (${(gapShare * 100).toFixed(0)}%) have a dry thalweg point at the shared boundary ` +
        `(limit ${(MAXIMUM_GAP_PAIR_SHARE * 100).toFixed(0)}%); water-surface step between neighbours p50 ${percentile(steps, 0.5).toFixed(2)} m, ` +
        `p90 ${p90Step.toFixed(2)} m (limit ${MAXIMUM_P90_STEP_M.toFixed(2)} m), max ${maxStep.toFixed(2)} m. Examples: ${examples.join('; ') || 'none'}.`;
      if (gapShare > MAXIMUM_GAP_PAIR_SHARE || p90Step > MAXIMUM_P90_STEP_M) problems.push(figures);
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
