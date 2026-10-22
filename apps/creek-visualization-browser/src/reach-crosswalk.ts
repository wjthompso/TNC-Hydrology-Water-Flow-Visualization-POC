// Reader for the extent's reviewed NHDPlusV2 reach crosswalk, served by the dev
// plugin as `reach-crosswalk.json`. Each entry maps one Creek Segment to its
// Reach, its drainage-area ratio, and (once the pipeline writes it) the
// Drainage-Area Ratio Transfer flag. The browser uses it as a fallback source of
// transfer flags while the Time Series files do not carry them yet, and as the
// only source of each segment's drainage-area ratio. The file is optional: a
// missing or malformed crosswalk yields null and the experience carries on.

import { modeledDataSource } from './modeled-data-source';

export const REACH_CROSSWALK_PATH = 'reach-crosswalk.json';

export interface ReachCrosswalkSegment {
  segmentId: string;
  /** NHDPlusV2 COMID of the Reach whose discharge the segment uses. */
  nhdplusV2Comid: string | null;
  /** Segment drainage area ÷ Reach drainage area, capped at 1. */
  drainageAreaRatio: number | null;
  drainageAreaRatioTransfer: boolean;
  /** Distance from the segment midpoint to the borrowed Reach, when recorded. */
  transferDistanceM: number | null;
}

export interface ReachCrosswalk {
  segmentNetworkVersion: string | null;
  /** True when at least one entry carries the `drainageAreaRatioTransfer` field. */
  hasTransferFlags: boolean;
  segmentsById: ReadonlyMap<string, ReachCrosswalkSegment>;
  transferSegmentIds: ReadonlySet<string>;
}

/** Null when the extent has no crosswalk on this server or the file is unreadable. */
export async function loadReachCrosswalk(extentId: string): Promise<ReachCrosswalk | null> {
  try {
    return readReachCrosswalk(await modeledDataSource().loadReachCrosswalk(extentId));
  } catch (error) {
    console.info('[reach-crosswalk] No usable crosswalk for this extent.', error);
    return null;
  }
}

export function readReachCrosswalk(value: unknown): ReachCrosswalk {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The reach crosswalk must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.segments)) throw new Error('The reach crosswalk has no segments list.');
  const segmentsById = new Map<string, ReachCrosswalkSegment>();
  const transferSegmentIds = new Set<string>();
  let hasTransferFlags = false;
  for (const item of record.segments) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.segmentId !== 'string') continue;
    if (typeof entry.drainageAreaRatioTransfer === 'boolean') hasTransferFlags = true;
    const segment: ReachCrosswalkSegment = {
      segmentId: entry.segmentId,
      nhdplusV2Comid:
        typeof entry.nhdplusV2Comid === 'number' || typeof entry.nhdplusV2Comid === 'string'
          ? String(entry.nhdplusV2Comid)
          : null,
      drainageAreaRatio: finiteOrNull(entry.drainageAreaRatio),
      drainageAreaRatioTransfer: entry.drainageAreaRatioTransfer === true,
      transferDistanceM: finiteOrNull(entry.transferDistanceM),
    };
    segmentsById.set(segment.segmentId, segment);
    if (segment.drainageAreaRatioTransfer) transferSegmentIds.add(segment.segmentId);
  }
  return {
    segmentNetworkVersion:
      typeof record.segmentNetworkVersion === 'string' ? record.segmentNetworkVersion : null,
    hasTransferFlags,
    segmentsById,
    transferSegmentIds,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
