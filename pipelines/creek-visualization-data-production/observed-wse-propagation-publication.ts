import { SEGMENT_NETWORK_VERSION } from './constants.ts';
import { adjacentSegmentsById } from './creek-segment-adjacency.ts';
import { expectNumber, expectRecord } from './json-files.ts';
import {
  OBSERVED_WSE_PROPAGATION,
  observedWaterDepthM,
  propagatedSegmentsAround,
  inferredSeriesM,
  type PropagationDirection,
  type PropagationSegmentNode,
} from './observed-wse-propagation.ts';
import type { CreekSegment } from './tnc-flowline-segmentation.ts';
import type { CorridorBoundingBox, WaterSurfacePolygonBucket } from './water-surface-polygon-generation.ts';

/**
 * Retained Stage 1 bed elevations for the gauge's TNC flowline: the tracked copy of
 * `cross-sections.json`'s representative `bedElevationM` per Creek Segment, plus Stage 1's
 * flow-direction verdict for the flowline. Publish reads this instead of the git-ignored Stage 1
 * output, so it still needs no network and no pipeline working output.
 */
export interface CrossSectionBedsSnapshot {
  segmentNetworkVersion: string;
  /** +1 when a higher vertex index is farther downstream on the flowline, −1 when vertex order runs upstream. */
  flowDirection: 1 | -1;
  /** Stage 1 representative cross-section bed per Creek Segment, m NAVD88. */
  bedElevationMBySegmentId: Record<string, number>;
}

export function readCrossSectionBedsSnapshot(value: unknown): CrossSectionBedsSnapshot {
  const record = expectRecord(value, 'Cross-section beds snapshot');
  const beds = expectRecord(record.bedElevationMBySegmentId, 'Cross-section beds snapshot bedElevationMBySegmentId');
  const flowDirection = expectNumber(record, 'flowDirection', 'Cross-section beds snapshot');
  if (flowDirection !== 1 && flowDirection !== -1) throw new Error('Cross-section beds snapshot flowDirection must be 1 or -1.');
  if (record.segmentNetworkVersion !== SEGMENT_NETWORK_VERSION) {
    throw new Error(`Cross-section beds snapshot segmentNetworkVersion is ${String(record.segmentNetworkVersion)}, expected ${SEGMENT_NETWORK_VERSION}.`);
  }
  const bedElevationMBySegmentId: Record<string, number> = {};
  for (const segmentId of Object.keys(beds)) bedElevationMBySegmentId[segmentId] = expectNumber(beds, segmentId, 'Cross-section beds snapshot');
  return { segmentNetworkVersion: SEGMENT_NETWORK_VERSION, flowDirection, bedElevationMBySegmentId };
}

/**
 * Every Creek Segment of the flowline with its bed and its upstream and downstream neighbour.
 * Neighbours come from the same shared-vertex rule Stage 4 uses; the flow direction decides which
 * side is upstream.
 */
export function propagationNodesById(
  segments: readonly CreekSegment[],
  beds: CrossSectionBedsSnapshot,
): Map<string, PropagationSegmentNode> {
  const adjacentById = adjacentSegmentsById(segments);
  const nodes = new Map<string, PropagationSegmentNode>();
  for (const segment of segments) {
    const bedElevationM = beds.bedElevationMBySegmentId[segment.segmentId];
    if (bedElevationM === undefined) throw new Error(`Cross-section beds snapshot has no bed for Creek Segment ${segment.segmentId}.`);
    const adjacent = adjacentById.get(segment.segmentId) ?? {};
    const atStart = adjacent.atStart?.segmentId ?? null;
    const atEnd = adjacent.atEnd?.segmentId ?? null;
    nodes.set(segment.segmentId, {
      segmentId: segment.segmentId,
      bedElevationM,
      upstreamSegmentId: beds.flowDirection === 1 ? atStart : atEnd,
      downstreamSegmentId: beds.flowDirection === 1 ? atEnd : atStart,
    });
  }
  return nodes;
}

export interface PublishedPropagationSegment {
  segmentId: string;
  /** `gauge` for the Monitoring station's own Creek Segment, otherwise the side of the gauge segment. */
  role: 'gauge' | PropagationDirection;
  /** Creek Segments between this one and the gauge segment, counting this one. 0 for the gauge segment. */
  hops: number;
  bedElevationM: number;
  upstreamSegmentId: string | null;
  downstreamSegmentId: string | null;
}

export interface ObservedWsePropagationDocument {
  segmentNetworkVersion: string;
  gaugeSegmentId: string;
  hopsPerDirection: number;
  /** +1 when a higher vertex index is farther downstream on the flowline, −1 otherwise. */
  flowDirection: 1 | -1;
  rule: string;
  /** The gauge segment first, then its neighbours upstream (nearest first), then downstream (nearest first). */
  segments: PublishedPropagationSegment[];
}

export function buildObservedWsePropagationDocument(
  gaugeSegmentId: string,
  nodesById: ReadonlyMap<string, PropagationSegmentNode>,
  flowDirection: 1 | -1,
  hopsPerDirection: number = OBSERVED_WSE_PROPAGATION.hopsPerDirection,
): ObservedWsePropagationDocument {
  const gauge = nodesById.get(gaugeSegmentId);
  if (!gauge) throw new Error(`Creek Segment ${gaugeSegmentId} has no cross-section bed.`);
  const publishedNode = (node: PropagationSegmentNode, role: PublishedPropagationSegment['role'], hops: number): PublishedPropagationSegment => ({
    segmentId: node.segmentId,
    role,
    hops,
    bedElevationM: node.bedElevationM,
    upstreamSegmentId: node.upstreamSegmentId,
    downstreamSegmentId: node.downstreamSegmentId,
  });
  const neighbours = propagatedSegmentsAround(gaugeSegmentId, nodesById, hopsPerDirection).map((neighbour) =>
    publishedNode(nodesById.get(neighbour.segmentId) as PropagationSegmentNode, neighbour.direction, neighbour.hops),
  );
  return {
    segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    gaugeSegmentId,
    hopsPerDirection,
    flowDirection,
    rule: 'Inferred WSE = neighbour bed + (observed WSE − gauge segment bed) while that depth is above zero; otherwise no water. Beds are Stage 1 representative cross-section beds (USGS 3DEP).',
    segments: [publishedNode(gauge, 'gauge', 0), ...neighbours],
  };
}

/**
 * Release check for propagated water: every inferred reading falls in a bucket of its segment's
 * prepared ladder, so no inferred water silently disappears. Returns the problems found.
 */
export function inferredReadingsOutsideLadders(
  document: ObservedWsePropagationDocument,
  observedWseM: readonly (number | null)[],
  bucketsBySegmentId: ReadonlyMap<string, readonly WaterSurfacePolygonBucket[]>,
): string[] {
  const gauge = document.segments.find((segment) => segment.role === 'gauge');
  if (!gauge) return ['The propagation document has no gauge segment.'];
  const problems: string[] = [];
  for (const segment of document.segments) {
    if (segment.role === 'gauge') continue;
    const buckets = bucketsBySegmentId.get(segment.segmentId);
    if (!buckets) {
      problems.push(`Inferred water on ${segment.segmentId} has no prepared water-surface polygon set.`);
      continue;
    }
    const lowest = buckets[0]?.minWaterSurfaceElevationM ?? Infinity;
    const highest = buckets[buckets.length - 1]?.maxWaterSurfaceElevationM ?? -Infinity;
    const outside = inferredSeriesM(observedWseM, gauge.bedElevationM, segment.bedElevationM).filter(
      (value) => value !== null && (value < lowest || value >= highest),
    );
    if (outside.length > 0) {
      problems.push(`${outside.length} inferred readings on ${segment.segmentId} fall outside its prepared ladder ${lowest}–${highest} m.`);
    }
  }
  return problems;
}

/** Readings that carry observed water at the gauge but no depth above the gauge bed, so nothing is propagated. */
export function countReadingsWithoutPropagation(observedWseM: readonly (number | null)[], gaugeBedElevationM: number): number {
  return observedWseM.filter((value) => value !== null && observedWaterDepthM(value, gaugeBedElevationM) === null).length;
}

const METERS_PER_DEGREE_LATITUDE = 111_320;
/** Farthest a prepared polygon vertex can lie from its segment's chord: the 100 m corridor half-width and the 100 m reach past a slanted end, as the hypotenuse, rounded up. */
const CORRIDOR_REACH_M = 142;

/**
 * A bounding box guaranteed to hold a Creek Segment's whole corridor: the segment's path grown by
 * the corridor's reach. Weaker than the exact corridor box (which needs the 3DEP terrain window,
 * and the retained window only covers the gauge segment's corridor), but it still rejects a
 * polygon placed on the wrong stretch of creek.
 */
export function corridorReachBoundingBox(pathWgs84: readonly (readonly [number, number])[]): CorridorBoundingBox {
  const longitudes = pathWgs84.map((position) => position[0]);
  const latitudes = pathWgs84.map((position) => position[1]);
  const meanLatitude = latitudes.reduce((sum, value) => sum + value, 0) / latitudes.length;
  const latitudeMargin = CORRIDOR_REACH_M / METERS_PER_DEGREE_LATITUDE;
  const longitudeMargin = CORRIDOR_REACH_M / (METERS_PER_DEGREE_LATITUDE * Math.cos((meanLatitude * Math.PI) / 180));
  return {
    west: Math.min(...longitudes) - longitudeMargin,
    east: Math.max(...longitudes) + longitudeMargin,
    south: Math.min(...latitudes) - latitudeMargin,
    north: Math.max(...latitudes) + latitudeMargin,
  };
}
