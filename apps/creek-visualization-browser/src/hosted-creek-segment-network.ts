/**
 * Hosted Creek Segment network.
 *
 * Loads the published creek segments layer once (every Creek Segment of the
 * extent, WGS84 two-vertex polylines) and derives the files the dev
 * middleware computes from local pipeline output, in the same JSON shapes:
 *
 * - `reach-crosswalk.json`      → `readReachCrosswalk`
 * - `creek-segment-paths.json`  → `readCreekSegmentPaths`
 * - `flowline-index.json`       → `readFlowlineIndex`
 *
 * The other hosted adapters reuse the loaded network for segment order,
 * junction ids, and Drainage-Area Ratio Transfer flags.
 */

import {
  layerUrl,
  numberOrNull,
  sqlString,
  stringOrEmpty,
  withHostedTransport,
  type HostedAdapterOptions,
} from './hosted-adapter-options.ts';
import { queryAllRows } from './hosted-feature-service-query.ts';

type LonLat = [number, number];
type Bbox = [number, number, number, number];

const WGS84_WKID = 4326;

const CREEK_SEGMENT_FIELDS = [
  'segment_id',
  'tnc_comid',
  'vertex_index_start',
  'vertex_index_end',
  'length_m',
  'flow_direction',
  'upstream_segment_id',
  'downstream_segment_id',
  'upstream_junction_id',
  'downstream_junction_id',
  'nhdplusv2_comid',
  'segment_drainage_area_km2',
  'reach_drainage_area_km2',
  'drainage_area_ratio',
  'drainage_area_ratio_transfer',
  'transfer_distance_m',
] as const;

/** Static beds the depth-style versions (m2 to m5) add to the layer; m1's layer has none. */
const CREEK_SEGMENT_BED_FIELDS = ['anchor_bed_elevation_m', 'junction_bed_upstream_m', 'junction_bed_downstream_m'] as const;

/** One row of the creek segments layer, in browser naming. */
export interface HostedCreekSegment {
  readonly segmentId: string;
  readonly tncComid: string;
  readonly vertexIndexStart: number;
  readonly vertexIndexEnd: number;
  readonly lengthM: number;
  /** +1 when a higher vertex index is farther downstream on the TNC flowline, else −1. */
  readonly flowDirection: 1 | -1;
  readonly upstreamSegmentId: string | null;
  readonly downstreamSegmentId: string | null;
  /** Segment junction ids, `<tncComid>-v<3-digit vertex index>`. */
  readonly upstreamJunctionId: string;
  readonly downstreamJunctionId: string;
  readonly nhdplusV2Comid: string | null;
  readonly segmentDrainageAreaKm2: number | null;
  readonly reachDrainageAreaKm2: number | null;
  readonly drainageAreaRatio: number | null;
  readonly drainageAreaRatioTransfer: boolean;
  readonly transferDistanceM: number | null;
  /** Flowline vertices in vertex-index order (start → end), as stored in the layer. */
  readonly pathWgs84: readonly LonLat[];
  /** Beds of a depth-style version, m NAVD88 (`anchorBedElevationM`, `junctionBed*M` of its Time Series); null when not loaded. */
  readonly beds: HostedCreekSegmentBeds | null;
}

export interface HostedCreekSegmentBeds {
  readonly anchorBedElevationM: number | null;
  readonly junctionBedUpstreamM: number | null;
  readonly junctionBedDownstreamM: number | null;
}

export interface HostedCreekSegmentNetwork {
  readonly segmentNetworkVersion: string;
  /** Every Creek Segment, sorted by TNC COMID then vertex order. */
  readonly segments: readonly HostedCreekSegment[];
  /** Creek Segments of one TNC flowline, in vertex order (`vertex_index_start` ascending). */
  readonly segmentsByTncComid: ReadonlyMap<string, readonly HostedCreekSegment[]>;
}

export interface LoadHostedCreekSegmentNetworkRequest {
  readonly modeledWseServiceUrl: string;
  readonly creekSegmentsLayerId: number;
  /** From the modeled WSE versions table (`segment_network_version`). */
  readonly segmentNetworkVersion: string;
  /** Load only this TNC flowline's Creek Segments (the observed gauge needs one flowline). Default: all. */
  readonly tncComid?: string;
  /** Also load the depth-style bed columns. Default: false (m1's layer has none). */
  readonly withBeds?: boolean;
}

export async function loadHostedCreekSegmentNetwork(
  request: LoadHostedCreekSegmentNetworkRequest,
  options?: HostedAdapterOptions,
): Promise<HostedCreekSegmentNetwork> {
  const rows = await queryAllRows(
    withHostedTransport(options, {
      layerUrl: layerUrl(request.modeledWseServiceUrl, request.creekSegmentsLayerId),
      where: request.tncComid === undefined ? '1=1' : `tnc_comid = ${sqlString(request.tncComid)}`,
      outFields: request.withBeds ? [...CREEK_SEGMENT_FIELDS, ...CREEK_SEGMENT_BED_FIELDS] : CREEK_SEGMENT_FIELDS,
      orderByFields: ['segment_id'],
      returnGeometry: true,
      outSpatialReferenceWkid: WGS84_WKID,
    }),
  );

  const segments = rows.map((row) => readCreekSegment(row.attributes, row.geometry, Boolean(request.withBeds)));
  segments.sort(
    (a, b) => compareText(a.tncComid, b.tncComid) || a.vertexIndexStart - b.vertexIndexStart,
  );

  const segmentsByTncComid = new Map<string, HostedCreekSegment[]>();
  for (const segment of segments) {
    const flowlineSegments = segmentsByTncComid.get(segment.tncComid) ?? [];
    flowlineSegments.push(segment);
    segmentsByTncComid.set(segment.tncComid, flowlineSegments);
  }

  return { segmentNetworkVersion: request.segmentNetworkVersion, segments, segmentsByTncComid };
}

function readCreekSegment(
  attributes: Record<string, unknown>,
  geometry: Record<string, unknown> | undefined,
  withBeds: boolean,
): HostedCreekSegment {
  const segmentId = stringOrEmpty(attributes.segment_id);
  const nhdplusV2Comid = stringOrEmpty(attributes.nhdplusv2_comid);
  return {
    segmentId,
    tncComid: stringOrEmpty(attributes.tnc_comid) || segmentId.split('-')[0],
    vertexIndexStart: numberOrNull(attributes.vertex_index_start) ?? 0,
    vertexIndexEnd: numberOrNull(attributes.vertex_index_end) ?? 0,
    lengthM: numberOrNull(attributes.length_m) ?? 0,
    flowDirection: attributes.flow_direction === -1 ? -1 : 1,
    upstreamSegmentId: stringOrEmpty(attributes.upstream_segment_id) || null,
    downstreamSegmentId: stringOrEmpty(attributes.downstream_segment_id) || null,
    upstreamJunctionId: stringOrEmpty(attributes.upstream_junction_id),
    downstreamJunctionId: stringOrEmpty(attributes.downstream_junction_id),
    nhdplusV2Comid: nhdplusV2Comid || null,
    segmentDrainageAreaKm2: numberOrNull(attributes.segment_drainage_area_km2),
    reachDrainageAreaKm2: numberOrNull(attributes.reach_drainage_area_km2),
    drainageAreaRatio: numberOrNull(attributes.drainage_area_ratio),
    drainageAreaRatioTransfer: attributes.drainage_area_ratio_transfer === 1,
    transferDistanceM: numberOrNull(attributes.transfer_distance_m),
    pathWgs84: readPolylinePath(geometry),
    beds: withBeds
      ? {
          anchorBedElevationM: numberOrNull(attributes.anchor_bed_elevation_m),
          junctionBedUpstreamM: numberOrNull(attributes.junction_bed_upstream_m),
          junctionBedDownstreamM: numberOrNull(attributes.junction_bed_downstream_m),
        }
      : null,
  };
}

/** Esri JSON polyline `{ paths: [[[lon, lat], ...], ...] }` → one vertex list (paths joined). */
function readPolylinePath(geometry: Record<string, unknown> | undefined): LonLat[] {
  const paths = Array.isArray(geometry?.paths) ? (geometry.paths as unknown[]) : [];
  const vertices: LonLat[] = [];
  for (const path of paths) {
    for (const point of Array.isArray(path) ? path : []) {
      if (Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number') {
        vertices.push([point[0], point[1]]);
      }
    }
  }
  return vertices;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Derived files, same shapes the dev middleware serves

/** `reach-crosswalk.json` shape, read by `readReachCrosswalk`. */
export function buildReachCrosswalkFile(network: HostedCreekSegmentNetwork): {
  segmentNetworkVersion: string;
  segments: {
    segmentId: string;
    nhdplusV2Comid: string | null;
    segmentDrainageAreaKm2: number | null;
    reachDrainageAreaKm2: number | null;
    drainageAreaRatio: number | null;
    drainageAreaRatioTransfer: boolean;
    transferDistanceM: number | null;
  }[];
} {
  return {
    segmentNetworkVersion: network.segmentNetworkVersion,
    segments: network.segments.map((segment) => ({
      segmentId: segment.segmentId,
      nhdplusV2Comid: segment.nhdplusV2Comid,
      segmentDrainageAreaKm2: segment.segmentDrainageAreaKm2,
      reachDrainageAreaKm2: segment.reachDrainageAreaKm2,
      drainageAreaRatio: segment.drainageAreaRatio,
      // Always a boolean, so the reader reports `hasTransferFlags: true`.
      drainageAreaRatioTransfer: segment.drainageAreaRatioTransfer,
      transferDistanceM: segment.transferDistanceM,
    })),
  };
}

/** `creek-segment-paths.json` shape, read by `readCreekSegmentPaths`: paths ordered upstream → downstream. */
export function buildCreekSegmentPathsFile(network: HostedCreekSegmentNetwork): {
  segmentNetworkVersion: string;
  segments: {
    segmentId: string;
    pathWgs84: LonLat[];
    upstreamSegmentId: string | null;
    downstreamSegmentId: string | null;
  }[];
} {
  return {
    segmentNetworkVersion: network.segmentNetworkVersion,
    segments: network.segments.map((segment) => {
      const pathWgs84 = segment.pathWgs84.map(([lon, lat]) => [lon, lat] as LonLat);
      return {
        segmentId: segment.segmentId,
        pathWgs84: segment.flowDirection === 1 ? pathWgs84 : pathWgs84.reverse(),
        upstreamSegmentId: segment.upstreamSegmentId,
        downstreamSegmentId: segment.downstreamSegmentId,
      };
    }),
  };
}

/**
 * `flowline-index.json` shape, read by `readFlowlineIndex`.
 *
 * The local index measures each segment's prepared water polygons; hosted
 * mode measures the segment's flowline path instead, so the whole polygon
 * layer is never downloaded. Bounding boxes are therefore tighter (flowline
 * only, no floodplain) and every segment gets a center, including segments
 * whose buckets are all empty.
 */
export function buildFlowlineIndexFile(network: HostedCreekSegmentNetwork): {
  segmentNetworkVersion: string;
  flowlines: {
    tncComid: string;
    bboxWgs84: Bbox;
    segments: { segmentId: string; centerWgs84: LonLat | null }[];
  }[];
} {
  const flowlines = [...network.segmentsByTncComid.entries()].flatMap(([tncComid, segments]) => {
    const flowlineBbox = emptyBbox();
    const indexSegments = segments.map((segment) => {
      const segmentBbox = emptyBbox();
      for (const [lon, lat] of segment.pathWgs84) growBbox(segmentBbox, lon, lat);
      const hasExtent = Number.isFinite(segmentBbox[0]);
      if (hasExtent) {
        growBbox(flowlineBbox, segmentBbox[0], segmentBbox[1]);
        growBbox(flowlineBbox, segmentBbox[2], segmentBbox[3]);
      }
      return {
        segmentId: segment.segmentId,
        centerWgs84: hasExtent
          ? ([(segmentBbox[0] + segmentBbox[2]) / 2, (segmentBbox[1] + segmentBbox[3]) / 2] as LonLat)
          : null,
      };
    });
    return Number.isFinite(flowlineBbox[0]) ? [{ tncComid, bboxWgs84: flowlineBbox, segments: indexSegments }] : [];
  });
  return { segmentNetworkVersion: network.segmentNetworkVersion, flowlines };
}

function emptyBbox(): Bbox {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

function growBbox(bbox: Bbox, lon: number, lat: number): void {
  if (lon < bbox[0]) bbox[0] = lon;
  if (lat < bbox[1]) bbox[1] = lat;
  if (lon > bbox[2]) bbox[2] = lon;
  if (lat > bbox[3]) bbox[3] = lat;
}
