import { readJson } from '../json-files.ts';
import { segmentTncFlowline, segmentTncFlowlines, type CreekSegment } from '../tnc-flowline-segmentation.ts';
import { adjacentSegmentsById } from '../creek-segment-adjacency.ts';
import { MODELED_EXTENT } from './pipeline-configuration.ts';
import { tncComidOfSegmentId, type DownstreamVertexDirection } from './stage-file-formats.ts';

export { adjacentSegmentsById };

export interface NetworkCreekSegment extends CreekSegment {
  /** Distance from the first original vertex of this segment's TNC flowline to the segment start, meters. */
  networkDistanceStartM: number;
}

/**
 * The Creek Segments of the selected extent, cut the same way publish cuts them. The Jalama
 * gauge-reach extent reads the single retained flowline exactly as publish does; a
 * multi-flowline extent cuts every flowline in its snapshot. Network distance restarts at 0
 * on each TNC flowline (COMID).
 */
export async function loadCreekSegmentNetwork(): Promise<NetworkCreekSegment[]> {
  const response = await readJson(MODELED_EXTENT.flowlineSnapshotPath);
  const segments = MODELED_EXTENT.extentId === 'jalama-gauge-reach' ? segmentTncFlowline(response) : segmentTncFlowlines(response);
  const distanceByComid = new Map<number, number>();
  return segments.map((segment) => {
    const networkDistanceStartM = distanceByComid.get(segment.comid) ?? 0;
    distanceByComid.set(segment.comid, networkDistanceStartM + segment.preciseLengthM);
    return { ...segment, networkDistanceStartM };
  });
}

/** The Creek Segments on either side of one segment along the flow, by id; null at a flowline end. */
export interface JunctionNeighbours {
  upstreamSegmentId: string | null;
  downstreamSegmentId: string | null;
}

/**
 * The upstream and downstream neighbour of every Creek Segment. The neighbour at the start vertex
 * is upstream when the flowline's vertex order runs downstream (direction +1), otherwise downstream.
 */
export function junctionNeighboursById(
  segments: readonly CreekSegment[],
  directionByTncComid: ReadonlyMap<string, DownstreamVertexDirection>,
): Map<string, JunctionNeighbours> {
  const adjacentById = adjacentSegmentsById(segments);
  const byId = new Map<string, JunctionNeighbours>();
  for (const segment of segments) {
    const adjacent = adjacentById.get(segment.segmentId) ?? {};
    const atStart = adjacent.atStart?.segmentId ?? null;
    const atEnd = adjacent.atEnd?.segmentId ?? null;
    const direction = directionByTncComid.get(tncComidOfSegmentId(segment.segmentId)) ?? 1;
    byId.set(
      segment.segmentId,
      direction === 1
        ? { upstreamSegmentId: atStart, downstreamSegmentId: atEnd }
        : { upstreamSegmentId: atEnd, downstreamSegmentId: atStart },
    );
  }
  return byId;
}

export function segmentMidpointUtm(segment: CreekSegment): { x: number; y: number } {
  return {
    x: (segment.startUtm.x + segment.endUtm.x) / 2,
    y: (segment.startUtm.y + segment.endUtm.y) / 2,
  };
}
