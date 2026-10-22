import type { LoadedCreekVisualization } from './creek-data-contract';
import type { SegmentFlowlinePath, SegmentSurfaceGeometry } from './sloped-water-surface';

/**
 * Flowline geometry of every Creek Segment that draws inferred water (Creek Segment Observed WSE
 * Propagation), so the renderer can slope each polygon between its two end heights. Each segment
 * carries its own path and its neighbours' paths, all ordered upstream to downstream; the gauge
 * segment is included only as a neighbour. Empty when the data has no propagation.
 */
export function inferredWaterSegmentGeometry(
  data: LoadedCreekVisualization,
): ReadonlyMap<string, SegmentSurfaceGeometry> {
  const { propagation } = data;
  const geometryById = new Map<string, SegmentSurfaceGeometry>();
  if (!propagation) return geometryById;
  const pathInFlowOrder = (segmentId: string | null): SegmentFlowlinePath | null => {
    if (segmentId === null) return null;
    const path = data.segmentsById.get(segmentId)?.pathWgs84;
    if (!path || path.length < 2) return null;
    return propagation.flowDirection === 1 ? path : [...path].reverse();
  };
  for (const segmentId of propagation.inferredSegmentIds) {
    const node = propagation.nodesById.get(segmentId);
    const path = pathInFlowOrder(segmentId);
    if (!node || !path) continue;
    geometryById.set(segmentId, {
      path,
      upstreamNeighbourPath: pathInFlowOrder(node.upstreamSegmentId),
      downstreamNeighbourPath: pathInFlowOrder(node.downstreamSegmentId),
    });
  }
  return geometryById;
}
