import { expectRecord, readJson } from '../json-files.ts';
import {
  DRAINAGE_AREA_RATIO_TRANSFER,
  MAXIMUM_TRANSFER_DISTANCE_M,
} from './modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts';

/**
 * Normalized discharge as received from a Publisher, keyed by NHDPlusV2 COMID (reach),
 * before it is assigned to Creek Segments. Discharge is in m³/s.
 */
export interface NormalizedDischargeFile {
  publisherId: string;
  datasetId: string;
  variableId: 'discharge';
  unit: 'm3/s';
  /** How the Publisher's numbers were turned into these values. */
  normalization: string;
  timestampsUtcMs: number[];
  reaches: { nhdplusV2Comid: number; values: (number | null)[] }[];
}

/** One Creek Segment's NHDPlusV2 reach, as Stage 0 assigns it. */
export interface ReachAssignment {
  segmentId: string;
  nhdplusV2Comid: number | null;
  /** NHDPlusV2 TotDASqKm of the assigned reach; null when unmapped or the EPA service has no value. */
  reachDrainageAreaKm2: number | null;
  /**
   * Drainage-Area Ratio Transfer: true when the segment's creek has no NHDPlusV2 reach of its own, so
   * the assigned reach belongs to a neighbouring creek (see DRAINAGE_AREA_RATIO_TRANSFER).
   */
  [DRAINAGE_AREA_RATIO_TRANSFER.fieldName]: boolean;
  /**
   * Transfer segments only: distance from the segment midpoint to the nearest point of the borrowed
   * reach's NHDPlusV2 flowline geometry, meters. Null when the geometry could not be fetched.
   */
  transferDistanceM?: number | null;
  /** Present only when the NLDI answer was overridden by the REACHCODE check. */
  nldiComid?: number;
  reassignedReason?: string;
}

/** True when a transfer segment's borrowed reach is too far away for its discharge to be credible. */
export function exceedsMaximumTransferDistance(segment: ReachAssignment): boolean {
  if (!segment[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]) return false;
  const distanceM = segment.transferDistanceM ?? null;
  return distanceM !== null && distanceM > MAXIMUM_TRANSFER_DISTANCE_M;
}

/** A reach assignment plus the share of the reach's discharge the Creek Segment gets (Stage 1). */
export interface CrosswalkSegment extends ReachAssignment {
  /** Upstream area at the segment's downstream thalweg, from the flow-accumulation raster; null when it could not be sampled. */
  segmentDrainageAreaKm2: number | null;
  /** segmentDrainageAreaKm2 ÷ reachDrainageAreaKm2, capped to [0, 1]; 1 when either area is unknown. */
  drainageAreaRatio: number;
}

/** Stage 0 output in `00-acquire/`: which NHDPlusV2 reach each Creek Segment belongs to. */
export interface NhdplusV2ReachAssignmentFile {
  note: string;
  segmentNetworkVersion: string;
  method: string;
  segments: ReachAssignment[];
  /** REACHCODE per NHDPlusV2 COMID that NLDI returned. */
  reachCodes: Record<string, string | null>;
}

/** The tracked crosswalk Stage 1 writes and Stage 3 reads: reach assignment plus drainage-area ratio. */
export interface NhdplusV2ReachCrosswalk {
  note: string;
  segmentNetworkVersion: string;
  method: string;
  drainageAreaMethod: string;
  segments: CrosswalkSegment[];
}

export const CNF_DISCHARGE_FILE = 'california-natural-flows-monthly-discharge.json';
export const NWM_DISCHARGE_FILE = 'national-water-model-hourly-discharge.json';
/** Stage 0's reach assignment per Creek Segment, in `00-acquire/`. */
export const REACH_ASSIGNMENTS_FILE = 'nhdplusv2-reach-crosswalk.json';

export async function readNormalizedDischarge(filePath: string): Promise<NormalizedDischargeFile> {
  const record = expectRecord(await readJson(filePath), filePath);
  if (!Array.isArray(record.timestampsUtcMs) || !Array.isArray(record.reaches)) {
    throw new Error(`${filePath} is not a normalized discharge file.`);
  }
  return record as unknown as NormalizedDischargeFile;
}

export async function readNhdplusV2ReachAssignments(filePath: string): Promise<NhdplusV2ReachAssignmentFile> {
  const record = expectRecord(await readJson(filePath), filePath);
  if (!Array.isArray(record.segments)) throw new Error(`${filePath} has no segments list.`);
  for (const [index, segment] of record.segments.entries()) {
    const entry = expectRecord(segment, `${filePath} segment ${index}`);
    for (const requiredField of ['reachDrainageAreaKm2', DRAINAGE_AREA_RATIO_TRANSFER.fieldName]) {
      if (!(requiredField in entry)) {
        throw new Error(`${filePath}: ${String(entry.segmentId)} has no ${requiredField}. Rerun the acquire stage with --force.`);
      }
    }
  }
  return record as unknown as NhdplusV2ReachAssignmentFile;
}

export async function readNhdplusV2Crosswalk(filePath: string): Promise<NhdplusV2ReachCrosswalk> {
  const record = expectRecord(await readJson(filePath), filePath);
  if (!Array.isArray(record.segments)) throw new Error(`${filePath} has no segments list.`);
  const crosswalk = record as unknown as NhdplusV2ReachCrosswalk;
  for (const segment of crosswalk.segments) {
    if (typeof segment.drainageAreaRatio !== 'number') {
      throw new Error(`${filePath}: ${segment.segmentId} has no drainageAreaRatio. Run the cross-sections stage first.`);
    }
    if (typeof segment[DRAINAGE_AREA_RATIO_TRANSFER.fieldName] !== 'boolean') {
      throw new Error(
        `${filePath}: ${segment.segmentId} has no ${DRAINAGE_AREA_RATIO_TRANSFER.fieldName}. Rerun the acquire and cross-sections stages with --force.`,
      );
    }
  }
  return crosswalk;
}

/** Round to a fixed number of decimals without negative zero. */
export function roundValue(value: number, decimals: number): number {
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}
