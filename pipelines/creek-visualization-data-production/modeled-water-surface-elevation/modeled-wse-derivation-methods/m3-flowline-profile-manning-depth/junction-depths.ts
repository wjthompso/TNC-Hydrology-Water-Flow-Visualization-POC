import { JUNCTION_DEPTH } from './method-config.ts';

/**
 * Junction depths of m3 (the rule of m2 version 2, copied so m3 does not depend on a file other methods may change): the water depth
 * at each end of every segment of one run, from the segments' raw anchor depths only. A run is a chain of Creek Segments of one flowline
 * joined at shared vertices IN FLOW ORDER, so segment `k` starts at vertex `k` (upstream) and ends at vertex `k + 1` (downstream).
 * An anchor depth is `null` where the segment has no value, `0` where it is dry, and above 0 where it is wet.
 */

/** Wet segments only: a dry segment (0), a missing one (null), and a position past a run end (undefined) are not. */
function isWet(anchorDepthM: number | null | undefined): anchorDepthM is number {
  return anchorDepthM !== null && anchorDepthM !== undefined && anchorDepthM > 0;
}

/**
 * Length-weighted mean of the anchor depths around vertex `vertexIndex`. Starting at the two segments that meet there, it walks outward
 * on each side across wet segments until it has covered `smoothingHalfWindowM` of flowline or reaches a dry, missing, or absent segment.
 * Each segment counts by the length of it that lies inside the window.
 */
function smoothedAnchorDepthAtVertex(anchorDepthsM: readonly (number | null)[], segmentLengthsM: readonly number[], vertexIndex: number): number {
  let weightedDepthSum = 0;
  let weightSumM = 0;
  for (const side of [{ firstSegment: vertexIndex - 1, step: -1 }, { firstSegment: vertexIndex, step: 1 }]) {
    let coveredM = 0;
    for (let segment = side.firstSegment; isWet(anchorDepthsM[segment]) && coveredM < JUNCTION_DEPTH.smoothingHalfWindowM; segment += side.step) {
      const weightM = Math.min(segmentLengthsM[segment] as number, JUNCTION_DEPTH.smoothingHalfWindowM - coveredM);
      weightedDepthSum += weightM * (anchorDepthsM[segment] as number);
      weightSumM += weightM;
      coveredM += weightM;
    }
  }
  return weightedDepthSum / weightSumM;
}

/**
 * The depth at the upstream and downstream end of every segment of one run at one timestamp. A vertex shared by two wet segments gets the
 * same smoothed depth on both sides. Everywhere else the segment keeps its own anchor depth: at a flowline end, next to a dry or missing
 * segment (so dry never takes a wet neighbour's depth and a wet segment never loses its own to a dry one), and on a dry segment (0).
 */
export function junctionDepthsAlongRun(
  anchorDepthsM: readonly (number | null)[],
  segmentLengthsM: readonly number[],
): { upstreamM: (number | null)[]; downstreamM: (number | null)[] } {
  const depthAtVertex = (segmentIndex: number, vertexIndex: number, neighbourIndex: number): number | null => {
    const own = anchorDepthsM[segmentIndex] ?? null;
    if (!isWet(own) || !isWet(anchorDepthsM[neighbourIndex])) return own;
    return smoothedAnchorDepthAtVertex(anchorDepthsM, segmentLengthsM, vertexIndex);
  };
  return {
    upstreamM: anchorDepthsM.map((_depth, segment) => depthAtVertex(segment, segment, segment - 1)),
    downstreamM: anchorDepthsM.map((_depth, segment) => depthAtVertex(segment, segment + 1, segment + 1)),
  };
}
