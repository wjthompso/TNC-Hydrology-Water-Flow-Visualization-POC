import type { ElevationBucket, LoadedCreekVisualization, ObservedApprovalStatus } from './creek-data-contract';

export interface SegmentWaterPlacement {
  segmentId: string;
  /** Null shows no water: a gap, a null reading, an empty bucket, or no matching bucket. */
  bucket: ElevationBucket | null;
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

  const placements = data.polygonSetSegmentIds.map((segmentId) => ({
    segmentId,
    bucket: bucketAtTime(data, segmentId, timeIndex),
  }));

  const observedWaterSurfaceElevationM = typeof stationReading === 'number' ? stationReading : null;

  return {
    timeUtcMs,
    hasObservation: observedWaterSurfaceElevationM !== null,
    observedWaterSurfaceElevationM,
    approvalStatus: timeIndex >= 0 ? (data.approvalStatuses?.[timeIndex] ?? null) : null,
    placements,
  };
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

function exactTimestampIndex(timestampsUtcMs: readonly number[], timeUtcMs: number): number {
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
