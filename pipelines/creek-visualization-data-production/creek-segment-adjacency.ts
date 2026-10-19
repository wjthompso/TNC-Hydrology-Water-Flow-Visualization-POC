import type { CreekSegment } from './tnc-flowline-segmentation.ts';

/**
 * The Creek Segments that share this segment's start and end vertices on the same TNC flowline.
 * Stage 4 clips each corridor end at the angle bisector of the two segments' directions, and the
 * browser slopes each water polygon between the same two bisector lines, so neighbouring
 * polygons meet on one line at one height. Absent, an end is cut at the segment's own
 * perpendicular, as publish does.
 */
export interface AdjacentCreekSegments {
  atStart?: CreekSegment;
  atEnd?: CreekSegment;
}

/**
 * For every Creek Segment, the neighbours that share its start and end vertices: the previous
 * and next segment of the same TNC flowline whose vertex coincides exactly. Segments across a
 * path gap of a multi-path flowline share no vertex and are not neighbours. This module reads
 * no configuration, so the browser's dev middleware can use the same rule.
 */
export function adjacentSegmentsById(segments: readonly CreekSegment[]): Map<string, AdjacentCreekSegments> {
  const sameVertex = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => a.x === b.x && a.y === b.y;
  const byId = new Map<string, AdjacentCreekSegments>();
  segments.forEach((segment, index) => {
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const adjacent: AdjacentCreekSegments = {};
    if (previous && previous.comid === segment.comid && sameVertex(previous.endUtm, segment.startUtm)) adjacent.atStart = previous;
    if (next && next.comid === segment.comid && sameVertex(segment.endUtm, next.startUtm)) adjacent.atEnd = next;
    byId.set(segment.segmentId, adjacent);
  });
  return byId;
}
