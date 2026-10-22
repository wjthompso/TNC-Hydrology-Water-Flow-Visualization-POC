/**
 * Creek Segment Observed WSE Propagation (UCS-300; glossary term of the same name).
 *
 * A Monitoring station observes one Creek Segment. Its neighbours up to
 * `hopsPerDirection` segments away, in each direction, get an inferred water-surface elevation
 * that keeps the gauge segment's observed water depth:
 *
 *   depth(t)        = observed WSE(t) − bed of the gauge segment
 *   inferred WSE(t) = bed of the neighbour + depth(t)
 *
 * The same rule runs upstream and downstream, so the water surface follows the bed slope and
 * never forms a level pool. It is an educated guess, not a hydraulic model.
 *
 * This module is pure (no Node or browser APIs) so the publish pipeline and the browser share
 * one copy of the rule and of the hop count.
 */

export const OBSERVED_WSE_PROPAGATION = {
  /**
   * Creek Segments that receive inferred water on each side of the gauge segment. Set to 0 to
   * draw observed water on the gauge segment only. Publish validates that the retained neighbour
   * polygon snapshot covers this many segments each way; the browser draws only as many as the
   * published polygons cover.
   */
  hopsPerDirection: 3,
} as const;

/** One Creek Segment of the gauge's TNC flowline, with its Stage 1 bed and its flow-order neighbours. */
export interface PropagationSegmentNode {
  segmentId: string;
  /** Stage 1 representative cross-section bed (lowest USGS 3DEP ground near the flowline), m NAVD88. */
  bedElevationM: number;
  upstreamSegmentId: string | null;
  downstreamSegmentId: string | null;
}

export type PropagationDirection = 'upstream' | 'downstream';

export interface PropagatedSegment {
  segmentId: string;
  direction: PropagationDirection;
  /** Segments between this one and the gauge segment, counting this one: 1 is the adjacent neighbour. */
  hops: number;
  bedElevationM: number;
}

/**
 * The neighbours that receive inferred water, nearest first within each direction (upstream
 * walk, then downstream walk). A walk ends at the hop limit, at a flowline end, or at a segment
 * missing from `nodesById`.
 */
export function propagatedSegmentsAround(
  gaugeSegmentId: string,
  nodesById: ReadonlyMap<string, PropagationSegmentNode>,
  hopsPerDirection: number,
): PropagatedSegment[] {
  const gauge = nodesById.get(gaugeSegmentId);
  if (!gauge) return [];
  const result: PropagatedSegment[] = [];
  const walk = (direction: PropagationDirection): void => {
    const nextOf = (node: PropagationSegmentNode): string | null =>
      direction === 'upstream' ? node.upstreamSegmentId : node.downstreamSegmentId;
    let current: PropagationSegmentNode = gauge;
    const visited = new Set<string>([gaugeSegmentId]);
    for (let hops = 1; hops <= hopsPerDirection; hops += 1) {
      const nextId = nextOf(current);
      if (nextId === null || visited.has(nextId)) return;
      const next = nodesById.get(nextId);
      if (!next) return;
      visited.add(nextId);
      result.push({ segmentId: nextId, direction, hops, bedElevationM: next.bedElevationM });
      current = next;
    }
  };
  walk('upstream');
  walk('downstream');
  return result;
}

/** Observed water depth over the gauge segment's bed, or null when there is no water above the bed. */
export function observedWaterDepthM(observedWseM: number | null, gaugeBedElevationM: number): number | null {
  if (observedWseM === null) return null;
  const depthM = observedWseM - gaugeBedElevationM;
  return depthM > 0 ? depthM : null;
}

/** A neighbour's inferred WSE: its own bed plus the gauge segment's observed depth. */
export function inferredWseM(neighbourBedElevationM: number, observedDepthM: number): number {
  return neighbourBedElevationM + observedDepthM;
}

/** The inferred Time Series of one neighbour, parallel to the gauge's observed Time Series. */
export function inferredSeriesM(
  observedSeriesM: readonly (number | null)[],
  gaugeBedElevationM: number,
  neighbourBedElevationM: number,
): (number | null)[] {
  return observedSeriesM.map((observedWseM) => {
    const depthM = observedWaterDepthM(observedWseM, gaugeBedElevationM);
    return depthM === null ? null : roundMillimeters(inferredWseM(neighbourBedElevationM, depthM));
  });
}

export interface PropagatedJunctionSurface {
  upstreamM: number;
  downstreamM: number;
}

/**
 * Water-surface elevation at each end of every inferred segment, so neighbouring water meets
 * without a step. At a vertex shared with the gauge segment the height is the observed WSE (the
 * gauge segment is drawn flat at it). At a vertex shared with another inferred segment it is the
 * higher of the two values, the same rule as modeled water (Stage 3). At a flowline end, or next
 * to a segment with no water, it is the segment's own value.
 */
export function inferredJunctionSurfaces(
  nodesById: ReadonlyMap<string, PropagationSegmentNode>,
  gaugeSegmentId: string,
  observedWseM: number,
  inferredWseBySegmentId: ReadonlyMap<string, number>,
): Map<string, PropagatedJunctionSurface> {
  const surfaces = new Map<string, PropagatedJunctionSurface>();
  for (const [segmentId, ownWseM] of inferredWseBySegmentId) {
    const node = nodesById.get(segmentId);
    const heightAt = (neighbourId: string | null | undefined): number => {
      if (!neighbourId) return ownWseM;
      if (neighbourId === gaugeSegmentId) return observedWseM;
      const neighbourWseM = inferredWseBySegmentId.get(neighbourId);
      return neighbourWseM === undefined ? ownWseM : Math.max(ownWseM, neighbourWseM);
    };
    surfaces.set(segmentId, {
      upstreamM: heightAt(node?.upstreamSegmentId),
      downstreamM: heightAt(node?.downstreamSegmentId),
    });
  }
  return surfaces;
}

function roundMillimeters(value: number): number {
  return Math.round(value * 1000) / 1000;
}
