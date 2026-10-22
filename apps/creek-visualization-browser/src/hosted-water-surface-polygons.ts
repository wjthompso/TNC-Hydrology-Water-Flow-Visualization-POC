/**
 * Hosted Prepared water-surface polygons.
 *
 * Rebuilds one TNC flowline's polygon set file (Stage 4
 * `WaterSurfacePolygonSetsFile` shape, read by the data store's
 * `readPolygonSetFile`) from one WSE polygons layer: one feature per
 * non-empty elevation bucket.
 *
 * Empty buckets are not published and are not re-inserted: the bucket lookup
 * is a half-open binary search that treats an empty bucket and a gap the same
 * way (no water), and `creek-data-contract.ts` only rejects overlapping or
 * out-of-order buckets, not gaps.
 */

import type { HostedCreekSegmentNetwork } from './hosted-creek-segment-network.ts';
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
type LonLatRing = LonLat[];

const WGS84_WKID = 4326;

/** Stage 4 `WaterSurfacePolygonSetsFile` shape. */
export interface HostedWaterSurfacePolygonSetsFile {
  segmentNetworkVersion: string;
  waterSurfacePolygonSets: {
    segmentId: string;
    elevationBuckets: {
      minWaterSurfaceElevationM: number;
      maxWaterSurfaceElevationM: number;
      ringsWgs84: LonLatRing[];
    }[];
  }[];
}

export interface LoadHostedWaterSurfacePolygonsRequest {
  readonly wsePolygonsServiceUrl: string;
  /** Polygon layer of one WSE Polygon Generation Method version (from `wse_polygon_versions`). */
  readonly polygonLayerId: number;
  readonly network: HostedCreekSegmentNetwork;
  readonly tncComid: string;
  /** Load and return only this Creek Segment's polygons (the observed gauge draws one segment). Default: the whole flowline. */
  readonly segmentId?: string;
}

export async function loadHostedWaterSurfacePolygonsForFlowline(
  request: LoadHostedWaterSurfacePolygonsRequest,
  options?: HostedAdapterOptions,
): Promise<HostedWaterSurfacePolygonSetsFile> {
  const rows = await queryAllRows(
    withHostedTransport(options, {
      layerUrl: layerUrl(request.wsePolygonsServiceUrl, request.polygonLayerId),
      where:
        `tnc_comid = ${sqlString(request.tncComid)}` +
        (request.segmentId === undefined ? '' : ` AND segment_id = ${sqlString(request.segmentId)}`),
      outFields: ['segment_id', 'bucket_index', 'min_wse_m', 'max_wse_m'],
      orderByFields: ['segment_id', 'bucket_index'],
      returnGeometry: true,
      outSpatialReferenceWkid: WGS84_WKID,
    }),
  );

  type Bucket = HostedWaterSurfacePolygonSetsFile['waterSurfacePolygonSets'][number]['elevationBuckets'][number];
  const bucketsBySegmentId = new Map<string, { bucketIndex: number; bucket: Bucket }[]>();
  for (const { attributes, geometry } of rows) {
    const segmentId = stringOrEmpty(attributes.segment_id);
    const min = numberOrNull(attributes.min_wse_m);
    const max = numberOrNull(attributes.max_wse_m);
    if (!segmentId || min === null || max === null) continue;
    const buckets = bucketsBySegmentId.get(segmentId) ?? [];
    buckets.push({
      bucketIndex: numberOrNull(attributes.bucket_index) ?? buckets.length,
      bucket: { minWaterSurfaceElevationM: min, maxWaterSurfaceElevationM: max, ringsWgs84: readRings(geometry) },
    });
    bucketsBySegmentId.set(segmentId, buckets);
  }

  // Every Creek Segment of the flowline, in vertex order like the local file; a segment
  // whose buckets are all empty keeps an empty ladder.
  const flowlineSegments = (request.network.segmentsByTncComid.get(request.tncComid) ?? []).filter(
    (segment) => request.segmentId === undefined || segment.segmentId === request.segmentId,
  );
  return {
    segmentNetworkVersion: request.network.segmentNetworkVersion,
    waterSurfacePolygonSets: flowlineSegments.map((segment) => ({
      segmentId: segment.segmentId,
      elevationBuckets: (bucketsBySegmentId.get(segment.segmentId) ?? [])
        .sort((a, b) => a.bucketIndex - b.bucketIndex)
        .map((entry) => entry.bucket),
    })),
  };
}

/** Esri JSON polygon `{ rings: [[[lon, lat], ...], ...] }`, rings and vertex order as returned. */
function readRings(geometry: Record<string, unknown> | undefined): LonLatRing[] {
  const rings = Array.isArray(geometry?.rings) ? (geometry.rings as unknown[]) : [];
  return rings.map((ring) =>
    (Array.isArray(ring) ? ring : []).flatMap((point) =>
      Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
        ? [[point[0], point[1]] as LonLat]
        : [],
    ),
  );
}
