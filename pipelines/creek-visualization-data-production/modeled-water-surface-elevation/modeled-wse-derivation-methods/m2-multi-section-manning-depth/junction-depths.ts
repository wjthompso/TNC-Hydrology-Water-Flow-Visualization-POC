import type { AdjacentCreekSegments } from '../../../creek-segment-adjacency.ts';
import { ANCHOR_POSITION_ALONG_SEGMENT, JUNCTION_DEPTH } from './method-config.ts';

/**
 * Junction depths of m2 (version 2) and the depth they give at the anchor point (version 3): the water
 * depth at each vertex of a run of Creek Segments, from the segments' raw anchor depths only. See METHOD.md "Junctions".
 *
 * A run is a chain of Creek Segments of one TNC flowline joined at shared vertices, in vertex order.
 * Vertex `k` of a run lies between segment `k − 1` and segment `k`; segment `k` starts at vertex `k`
 * and ends at vertex `k + 1`. An anchor depth is `null` where the segment has no value, `0` where it is
 * dry, and above 0 where it is wet.
 */

/** Wet segments only: a dry segment (0), a missing one (null), and a position past a run end (undefined) are not. */
function isWet(anchorDepthM: number | null | undefined): anchorDepthM is number {
  return anchorDepthM !== null && anchorDepthM !== undefined && anchorDepthM > 0;
}

/**
 * Length-weighted mean of the anchor depths around vertex `vertexIndex`. Starting at the two segments
 * that meet there, it walks outward on each side across wet segments until it has covered
 * `smoothingHalfWindowM` of flowline or reaches a dry, missing, or absent segment. Each segment counts
 * by the length of it that lies inside the window, so a 2 m segment weighs less than a 30 m one.
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
 * The depth at the start and end vertex of every segment of one run, at one timestamp. A vertex shared
 * by two wet segments gets the same smoothed depth on both sides. Everywhere else the segment keeps its
 * own anchor depth: at a flowline end, next to a dry or missing segment (so dry never takes a wet
 * neighbour's depth and a wet segment never loses its own to a dry one), and on a dry segment (0).
 */
export function junctionDepthsAlongRun(
  anchorDepthsM: readonly (number | null)[],
  segmentLengthsM: readonly number[],
): { atStartM: (number | null)[]; atEndM: (number | null)[] } {
  const depthAtVertex = (segmentIndex: number, vertexIndex: number, neighbourIndex: number): number | null => {
    const own = anchorDepthsM[segmentIndex] ?? null;
    if (!isWet(own) || !isWet(anchorDepthsM[neighbourIndex])) return own;
    return smoothedAnchorDepthAtVertex(anchorDepthsM, segmentLengthsM, vertexIndex);
  };
  return {
    atStartM: anchorDepthsM.map((_depth, segment) => depthAtVertex(segment, segment, segment - 1)),
    atEndM: anchorDepthsM.map((_depth, segment) => depthAtVertex(segment, segment + 1, segment + 1)),
  };
}

/**
 * Version 3: the depth of the smoothed surface at the anchor point, the segment's own depth in the Time Series. The browser draws
 * the depth linearly from one junction depth to the other, so at the anchor position it draws `depthAtStartM` +
 * (`depthAtEndM` − `depthAtStartM`) × `ANCHOR_POSITION_ALONG_SEGMENT`. Both arguments are the junction depths as written to the file.
 * A dry segment has 0 at both ends and so gets 0; a wet segment next to a dry one keeps its own raw anchor depth at that vertex.
 */
export function smoothedDepthAtAnchor(depthAtStartM: number, depthAtEndM: number): number {
  return depthAtStartM + (depthAtEndM - depthAtStartM) * ANCHOR_POSITION_ALONG_SEGMENT;
}

/**
 * Splits the Creek Segments of one flowline (in vertex order) into runs: a run starts at a segment with
 * no neighbour at its start vertex and follows the shared end vertices. A multi-path flowline has one
 * run per path, because segments across a path gap share no vertex.
 */
export function segmentRuns<Segment extends { segmentId: string }>(
  segments: readonly Segment[],
  adjacentById: ReadonlyMap<string, AdjacentCreekSegments>,
): Segment[][] {
  const segmentById = new Map(segments.map((segment) => [segment.segmentId, segment]));
  const runs: Segment[][] = [];
  for (const first of segments) {
    if (adjacentById.get(first.segmentId)?.atStart) continue;
    const run: Segment[] = [];
    for (let next: Segment | undefined = first; next; next = segmentById.get(adjacentById.get(next.segmentId)?.atEnd?.segmentId ?? '')) run.push(next);
    runs.push(run);
  }
  return runs;
}
