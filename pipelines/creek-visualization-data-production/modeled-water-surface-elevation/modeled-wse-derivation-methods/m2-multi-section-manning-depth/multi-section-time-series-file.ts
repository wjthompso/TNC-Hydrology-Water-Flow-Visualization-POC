import type { WaterSurfaceElevationTimeSeriesFile, WaterSurfaceElevationTimeSeriesSegment } from '../../stage-file-formats.ts';

/**
 * One Creek Segment in an m2 Time Series file: m1's fields (`values`, junction WSEs, the
 * Drainage-Area Ratio Transfer flag) plus the depth fields that let the browser draw water parallel
 * to the bed. Same file layout as m1, one compact file per TNC flowline. See METHOD.md "Output".
 */
export interface MultiSectionTimeSeriesSegment extends WaterSurfaceElevationTimeSeriesSegment {
  /** Stage 1 bed of the anchor (mid-segment) section, m NAVD88. Depth at the anchor = value − anchorBedElevationM. */
  anchorBedElevationM: number;
  /** Water depth at the upstream and downstream vertex, m, parallel to `values`; null where the value is null. */
  junctionDepthUpstreamM: (number | null)[];
  junctionDepthDownstreamM: (number | null)[];
  /** Bed at the upstream and downstream vertex, m NAVD88. */
  junctionBedUpstreamM: number;
  junctionBedDownstreamM: number;
}

export interface MultiSectionTimeSeriesFile extends WaterSurfaceElevationTimeSeriesFile {
  segments: MultiSectionTimeSeriesSegment[];
}

/** True when a Time Series segment carries m2's depth fields. */
export function hasDepthFields(segment: WaterSurfaceElevationTimeSeriesSegment): segment is MultiSectionTimeSeriesSegment {
  const candidate = segment as Partial<MultiSectionTimeSeriesSegment>;
  return (
    typeof candidate.anchorBedElevationM === 'number' &&
    Array.isArray(candidate.junctionDepthUpstreamM) &&
    Array.isArray(candidate.junctionDepthDownstreamM)
  );
}
