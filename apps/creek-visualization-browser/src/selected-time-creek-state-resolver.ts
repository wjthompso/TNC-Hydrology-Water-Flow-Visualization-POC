import { inferredJunctionSurfaces } from '../../../pipelines/creek-visualization-data-production/observed-wse-propagation.ts';
import type { ElevationBucket, LoadedCreekVisualization, ObservedApprovalStatus } from './creek-data-contract';
import type { JunctionWaterSurface } from './sloped-water-surface';

export interface SegmentWaterPlacement {
  segmentId: string;
  /** Null shows no water: a gap, a null reading, an empty bucket, or no matching bucket. */
  bucket: ElevationBucket | null;
  /**
   * True for water inferred from the gauge by Creek Segment Observed WSE Propagation. Drawn with its own
   * shading and never described as measured. False or absent for the gauge segment's observed water.
   */
  inferred?: boolean;
  /** Inferred water only: the water-surface elevation at the segment's two ends, so neighbours meet without a step. */
  junctionWaterSurface?: JunctionWaterSurface | null;
}

export interface SelectedTimeCreekState {
  timeUtcMs: number;
  /** True only when the gauge segment has a non-null reading at this exact timestamp. */
  hasObservation: boolean;
  /** The gauge segment's observed water-surface elevation at this exact timestamp, in meters NAVD88. */
  observedWaterSurfaceElevationM: number | null;
  /** USGS review status of the reading at this timestamp; null when unknown (local files carry none). */
  approvalStatus: ObservedApprovalStatus | null;
  placements: readonly SegmentWaterPlacement[];
}

/**
 * Exact timestamp match only. Null readings and gap slots are not interpolated
 * or borrowed from a neighbouring time.
 */
export function resolveSelectedTimeCreekState(
  data: LoadedCreekVisualization,
  timeUtcMs: number,
): SelectedTimeCreekState {
  const timeIndex = exactTimestampIndex(data.timestampsUtcMs, timeUtcMs);
  const stationReadings = data.waterSurfaceElevationMBySegmentId.get(data.station.segmentId);
  const stationReading =
    timeIndex >= 0 && stationReadings ? stationReadings[timeIndex] : null;

  const placements: SegmentWaterPlacement[] = data.polygonSetSegmentIds.map((segmentId) => ({
    segmentId,
    bucket: segmentId === data.station.segmentId ? bucketAtTime(data, segmentId, timeIndex) : null,
  }));

  const observedWaterSurfaceElevationM = typeof stationReading === 'number' ? stationReading : null;
  addInferredPlacements(data, timeIndex, observedWaterSurfaceElevationM, placements);

  return {
    timeUtcMs,
    hasObservation: observedWaterSurfaceElevationM !== null,
    observedWaterSurfaceElevationM,
    approvalStatus: timeIndex >= 0 ? (data.approvalStatuses?.[timeIndex] ?? null) : null,
    placements,
  };
}

/**
 * Creek Segment Observed WSE Propagation: fills the placements of the gauge segment's neighbours
 * with water at their inferred elevation, and gives each the elevation at its two ends. Nothing is
 * inferred when the gauge has no reading at this exact time or no depth above its bed.
 */
function addInferredPlacements(
  data: LoadedCreekVisualization,
  timeIndex: number,
  observedWseM: number | null,
  placements: SegmentWaterPlacement[],
): void {
  const { propagation } = data;
  if (!propagation || timeIndex < 0 || observedWseM === null) return;
  const inferredWseBySegmentId = new Map<string, number>();
  for (const segmentId of propagation.inferredSegmentIds) {
    const reading = propagation.inferredWaterSurfaceElevationMBySegmentId.get(segmentId)?.[timeIndex];
    if (typeof reading === 'number') inferredWseBySegmentId.set(segmentId, reading);
  }
  // The gauge segment is drawn flat at its bucket minimum, so inferred water next to it meets that height.
  const gaugeBucket = placements.find((placement) => placement.segmentId === data.station.segmentId)?.bucket ?? null;
  const gaugeDrawnWseM = gaugeBucket?.minWaterSurfaceElevationM ?? observedWseM;
  const junctions = inferredJunctionSurfaces(propagation.nodesById, data.station.segmentId, gaugeDrawnWseM, inferredWseBySegmentId);
  placements.forEach((placement, index) => {
    const reading = inferredWseBySegmentId.get(placement.segmentId);
    if (reading === undefined) return;
    const buckets = data.polygonBucketsBySegmentId.get(placement.segmentId);
    const bucket = buckets ? bucketForWaterSurfaceElevation(buckets, reading) : null;
    placements[index] = {
      segmentId: placement.segmentId,
      bucket,
      inferred: true,
      junctionWaterSurface: bucket ? (junctions.get(placement.segmentId) ?? null) : null,
    };
  });
}

function bucketAtTime(
  data: LoadedCreekVisualization,
  segmentId: string,
  timeIndex: number,
): ElevationBucket | null {
  if (timeIndex < 0) return null;
  const readings = data.waterSurfaceElevationMBySegmentId.get(segmentId);
  const reading = readings ? readings[timeIndex] : null;
  if (typeof reading !== 'number') return null;
  const buckets = data.polygonBucketsBySegmentId.get(segmentId);
  if (!buckets) return null;
  return bucketForWaterSurfaceElevation(buckets, reading);
}

/** Half-open match: minimum <= reading < maximum. Empty rings show no water. Shared with the modeled path. */
export function bucketForWaterSurfaceElevation(
  buckets: readonly ElevationBucket[],
  waterSurfaceElevationM: number,
): ElevationBucket | null {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const bucket = buckets[mid];
    if (waterSurfaceElevationM < bucket.minWaterSurfaceElevationM) {
      high = mid - 1;
      continue;
    }
    if (waterSurfaceElevationM >= bucket.maxWaterSurfaceElevationM) {
      low = mid + 1;
      continue;
    }
    return bucketHasSurface(bucket) ? bucket : null;
  }
  return null;
}

function bucketHasSurface(bucket: ElevationBucket): boolean {
  return bucket.ringsWgs84.some((ring) => ring.length >= 3);
}

export function exactTimestampIndex(timestampsUtcMs: readonly number[], timeUtcMs: number): number {
  let low = 0;
  let high = timestampsUtcMs.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const timestamp = timestampsUtcMs[mid];
    if (timestamp === timeUtcMs) return mid;
    if (timestamp < timeUtcMs) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}
