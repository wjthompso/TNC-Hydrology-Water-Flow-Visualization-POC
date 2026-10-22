import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { WaterSurfacePolygonBucket } from '../water-surface-polygon-generation.ts';
import { type WATER_SURFACE_ELEVATION_VARIABLE_ID } from './pipeline-configuration.ts';
import {
  DRAINAGE_AREA_RATIO_TRANSFER,
  type CROSS_SECTION,
  type RATING_CURVE,
} from './modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts';

/**
 * File shapes passed between stages. Stage entry files run on import, so the
 * shapes live here instead of in the stage that writes them.
 */

export const CROSS_SECTIONS_FILE = 'cross-sections.json';
export const RATING_CURVES_FILE = 'rating-curves.json';
/**
 * Stage 3 writes every Time Series under `03-time-series/<method-id>/v<version>/time-series/<datasetId>/<variableId>/`,
 * one compact file per TNC flowline: `<tncComid>.json`, or `<tncComid>/WY<year>.json` for an hourly Dataset.
 */
export const TIME_SERIES_DIRECTORY_NAME = 'time-series';
/** Stage 4 writes one compact `<tncComid>.json` per TNC flowline in this folder. */
export const WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME = 'water-surface-polygon-sets';
export const POLYGON_LADDERS_FILE = 'water-surface-polygon-ladders.json';

/** TNC flowline (NHD 1:24K) COMID of a Creek Segment id `<tncComid>-<vertexIndex>`. */
export function tncComidOfSegmentId(segmentId: string): string {
  return segmentId.split('-')[0] as string;
}

/** Groups records by TNC flowline COMID, keeping first-appearance order of flowlines and records. */
export function groupByTncComid<Record extends { segmentId: string }>(records: readonly Record[]): Map<string, Record[]> {
  const byTncComid = new Map<string, Record[]>();
  for (const record of records) {
    const tncComid = tncComidOfSegmentId(record.segmentId);
    byTncComid.set(tncComid, [...(byTncComid.get(tncComid) ?? []), record]);
  }
  return byTncComid;
}

export interface CrossSectionRecord {
  segmentId: string;
  networkDistanceMidM: number;
  bedElevationM: number;
  /** Raw least-squares bed slope (drop per meter downstream); may be ≤ 0 on flat or noisy reaches. */
  rawSlope: number;
  /** Slope used for Manning's equation, floored at the minimum slope. */
  slope: number;
  slopeFloored: boolean;
  representativeSectionIndex: number;
  lowestBankTopM: number;
  sections: {
    alongSegmentM: number;
    networkDistanceM: number;
    /** Signed distance from the TNC flowline to the thalweg, meters (positive = left of vertex order). */
    thalwegOffsetM: number;
    /** Thalweg point (lowest ground in the search width), EPSG 32610 meters. Stage 4 seeds its flood fill here. */
    thalwegUtm: { x: number; y: number };
    /** Thalweg elevation, m NAVD88. */
    bedElevationM: number;
    areaAtReferenceDepthM2: number;
    /** Ends of the section after the valley-edge trim, m from the TNC flowline. */
    valleyEdgeLeftOffsetM: number;
    valleyEdgeRightOffsetM: number;
    /** True when the valley-edge guard cut at least one side short of ±halfWidthM. */
    trimmedAtValleyEdge: boolean;
    /**
     * Valley-edge trim fallback: true when that side's valley edge was less than the minimum bank
     * height above the bed, so the side kept the untrimmed half-section and its end is not a valley
     * edge. Stage 2 caps the ladder on the other side.
     */
    valleyEdgeTrimFallbackLeft: boolean;
    valleyEdgeTrimFallbackRight: boolean;
    /** Bank-top offsets, m from the TNC flowline: where the main channel meets each floodplain. */
    leftBankTopOffsetM: number;
    rightBankTopOffsetM: number;
  }[];
  /**
   * Representative profile, trimmed at its valley edges: offsets (m, positive = left of vertex order)
   * and ground elevations (m NAVD88).
   */
  profileOffsetsM: number[];
  profileElevationsM: number[];
  warnings: string[];
}

export interface CrossSectionsFile {
  segmentNetworkVersion: string;
  description: string;
  parameters: typeof CROSS_SECTION;
  /** Absolute thalweg offset from the TNC flowline across every sampled section. */
  thalwegOffsetFromFlowlineM: { medianM: number; p90M: number; maxM: number };
  segments: CrossSectionRecord[];
}

/** +1 when a higher vertex index is farther downstream on a TNC flowline, −1 when vertex order runs upstream. */
export type DownstreamVertexDirection = 1 | -1;

/**
 * Stage 1's orientation rule for one TNC flowline: vertex order runs downstream when the first
 * sampled bed is at or above the last. Every later stage and the seam tests use the same rule.
 */
export function downstreamVertexDirection(sampledBedsInVertexOrder: readonly number[]): DownstreamVertexDirection {
  const first = sampledBedsInVertexOrder[0] ?? 0;
  const last = sampledBedsInVertexOrder[sampledBedsInVertexOrder.length - 1] ?? 0;
  return first - last >= 0 ? 1 : -1;
}

/** The rule above applied to the Stage 1 file, per TNC flowline COMID. Records are in vertex order. */
export function downstreamVertexDirectionByTncComid(crossSections: CrossSectionsFile): Map<string, DownstreamVertexDirection> {
  const bedsByTncComid = new Map<string, number[]>();
  for (const record of crossSections.segments) {
    const tncComid = tncComidOfSegmentId(record.segmentId);
    const beds = bedsByTncComid.get(tncComid) ?? [];
    for (const section of record.sections) beds.push(section.bedElevationM);
    bedsByTncComid.set(tncComid, beds);
  }
  return new Map([...bedsByTncComid].map(([tncComid, beds]) => [tncComid, downstreamVertexDirection(beds)]));
}

export interface RatingCurveRecord {
  segmentId: string;
  bedElevationM: number;
  slope: number;
  /** Ladder top: the lower of the trimmed section's lower valley edge and bed + the maximum-depth safety cap. */
  capElevationM: number;
  capReason: 'maximum-depth' | 'lower-valley-edge';
  /**
   * The lower of the representative profile's valley-edge end elevations, m NAVD88. A side that kept
   * the untrimmed half-section (valley-edge trim fallback) has no valley edge and is left out;
   * null when both sides fell back, in which case only the maximum-depth cap applies.
   */
  lowerValleyEdgeM: number | null;
  /** Where the main channel meets each floodplain (offset m from the TNC flowline, elevation m NAVD88). */
  leftBankTop: { offsetM: number; elevationM: number };
  rightBankTop: { offsetM: number; elevationM: number };
  /** Ladder steps above the lower bank top, where at least one floodplain is wet. */
  overbankLadderSteps: number;
  /** Parallel arrays, one entry per ladder step. Area, perimeter, and radius are summed over the three subsections. */
  waterSurfaceElevationM: number[];
  areaM2: number[];
  wettedPerimeterM: number[];
  hydraulicRadiusM: number[];
  /** Manning's discharge per subsection of the divided channel. */
  mainChannelDischargeM3s: number[];
  leftFloodplainDischargeM3s: number[];
  rightFloodplainDischargeM3s: number[];
  /** Sum of the three subsection discharges exactly as computed; may dip where water spills onto a bench. */
  rawManningDischargeM3s: number[];
  /** Running maximum of the raw discharge, so discharge never falls as WSE rises. Inversion uses this. */
  dischargeM3s: number[];
  flags: string[];
}

export interface RatingCurvesFile {
  segmentNetworkVersion: string;
  description: string;
  parameters: typeof RATING_CURVE;
  segments: RatingCurveRecord[];
}

/**
 * One file of a water-surface elevation (WSE) Time Series: one timestamp list plus one value list
 * per Creek Segment of one TNC flowline.
 */
export interface WaterSurfaceElevationTimeSeriesFile {
  segmentNetworkVersion: string;
  datasetId: string;
  variableId: typeof WATER_SURFACE_ELEVATION_VARIABLE_ID;
  timestampsUtcMs: number[];
  segments: WaterSurfaceElevationTimeSeriesSegment[];
}

/** One Creek Segment's values in a Time Series file. */
export interface WaterSurfaceElevationTimeSeriesSegment {
  segmentId: string;
  values: (number | null)[];
  /**
   * Junction WSE at the segment's upstream and downstream vertices, parallel to `values`: the higher
   * of this segment's value and its neighbour's at that vertex, so both sides of a junction carry
   * the same height and neither segment's water is pulled below its own value. At a flowline end, or
   * when the neighbour has no value, it is the segment's own value; null where the value is null.
   * Stage 3 always writes both; a hand-made fixture may omit them.
   */
  junctionWseUpstreamM?: (number | null)[];
  junctionWseDownstreamM?: (number | null)[];
  /**
   * Drainage-Area Ratio Transfer: present (true) only when the segment's discharge was transferred
   * from a neighbouring creek's NHDPlusV2 reach (see DRAINAGE_AREA_RATIO_TRANSFER). Absent means false.
   */
  [DRAINAGE_AREA_RATIO_TRANSFER.fieldName]?: true;
}

/**
 * How a modeled WSE Time Series was derived, written to `05-catalog/catalog.json` per Time Series so
 * the numbers are not a black box. `derivedFrom`, `method`, and `derivedBy` keep the former shape;
 * the other fields spell out the inputs, steps, parameters, assumptions, and sensitivity.
 */
export interface TimeSeriesDerivation {
  derivedFrom: string;
  /** One-sentence summary of the method. */
  method: string;
  derivedBy: string;
  /** What went in, by role. */
  inputs: { role: string; source: string }[];
  /** Ordered plain-language steps. */
  steps: string[];
  parameters: {
    name: string;
    value: number;
    /** Empty string when the value has no unit (for example Manning's n or a ratio). */
    unit: string;
    basis: string;
    /** Published minimum and maximum the value was chosen from, when a table gives one. */
    publishedRange?: readonly [number, number];
    citations: readonly string[];
  }[];
  assumptions: string[];
  sensitivity: string;
}

/** Same shape as the published `water-surface-polygon-sets.json` the browser reads; one file per TNC flowline. */
export interface WaterSurfacePolygonSetsFile {
  segmentNetworkVersion: string;
  waterSurfacePolygonSets: { segmentId: string; elevationBuckets: WaterSurfacePolygonBucket[] }[];
}

/** Per Creek Segment summary of the Stage 4 elevation-bucket ladder, for inspection. */
export interface PolygonLaddersFile {
  segmentNetworkVersion: string;
  description: string;
  segments: {
    segmentId: string;
    bedElevationM: number;
    maxModeledWaterSurfaceElevationM: number;
    ceilingM: number;
    fineBuckets: number;
    coarseBuckets: number;
    /** Buckets traced with a wet threshold sloping between the segment's two junction WSEs. Stage 4 always writes it. */
    slopedBuckets?: number;
    emptyBuckets: number;
  }[];
}

/**
 * Every Time Series file one modeled WSE version wrote, as paths relative to that version's folder
 * (`03-time-series/<method-id>/v<version>/`), grouped by datasetId.
 */
export async function listTimeSeriesFiles(timeSeriesStageDirectory: string): Promise<Map<string, string[]>> {
  const root = path.join(timeSeriesStageDirectory, TIME_SERIES_DIRECTORY_NAME);
  const entries = await readdir(root, { recursive: true });
  const byDatasetId = new Map<string, string[]>();
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const relativePath = path.posix.join(TIME_SERIES_DIRECTORY_NAME, entry.split(path.sep).join('/'));
    const datasetId = entry.split(path.sep)[0] as string;
    byDatasetId.set(datasetId, [...(byDatasetId.get(datasetId) ?? []), relativePath]);
  }
  return byDatasetId;
}

/**
 * Every water-surface polygon set file one WSE Polygon Generation Method version wrote, as sorted
 * paths relative to that version's folder (`04-water-surface-polygons/<method-id>/v<version>/`).
 */
export async function listWaterSurfacePolygonSetFiles(methodVersionDirectory: string): Promise<string[]> {
  const entries = await readdir(path.join(methodVersionDirectory, WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME));
  return entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.posix.join(WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME, name));
}
