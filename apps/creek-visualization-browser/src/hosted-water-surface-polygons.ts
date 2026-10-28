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
  parseJsonAttribute,
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
  /** Load and return only this Creek Segment's polygons. Default: the whole flowline. */
  readonly segmentId?: string;
  /** Load and return only these Creek Segments' polygons (the observed gauge and its inferred neighbours), in this order. */
  readonly segmentIds?: readonly string[];
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
        (request.segmentId === undefined ? '' : ` AND segment_id = ${sqlString(request.segmentId)}`) +
        (request.segmentIds === undefined ? '' : ` AND segment_id IN (${request.segmentIds.map(sqlString).join(', ')})`),
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
    (segment) =>
      (request.segmentId === undefined || segment.segmentId === request.segmentId) &&
      (request.segmentIds === undefined || request.segmentIds.includes(segment.segmentId)),
  );
  if (request.segmentIds !== undefined) {
    const order = new Map(request.segmentIds.map((segmentId, index) => [segmentId, index]));
    flowlineSegments.sort((a, b) => (order.get(a.segmentId) ?? 0) - (order.get(b.segmentId) ?? 0));
  }
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

// ---------------------------------------------------------------------------
// Channel ribbon versions (`channel-ribbon-*` drawings)

type LonLatZ = [number, number, number];

/** Stage 4 `channelRibbon` summary of one Creek Segment, in Stage 4's field order. */
export interface HostedChannelRibbonSummary {
  stationCount: number | null;
  lengthM: number | null;
  anchorLonLat: [number, number] | null;
  anchorBedElevationM: number | null;
  anchorStation: number | null;
  downstreamSegmentId: string | null;
  breachedStations: number | null;
  stationDistancesM: number[];
  trueTopWidthAtAnchorM: number[];
  displayTopWidthAtAnchorM: number[];
}

export interface HostedChannelRibbonPolygonSetsFile {
  segmentNetworkVersion: string;
  waterSurfacePolygonSets: {
    segmentId: string;
    elevationBuckets: { minWaterSurfaceElevationM: number; maxWaterSurfaceElevationM: number; ringsWgs84: LonLatZ[][] }[];
    channelRibbon?: HostedChannelRibbonSummary;
  }[];
}

export interface LoadHostedChannelRibbonPolygonsRequest {
  readonly wsePolygonsServiceUrl: string;
  /** The version's `…_channel_ribbons` table in the polygons service. */
  readonly channelRibbonsTableId: number;
  /** The version's exact-rings service and its table (`…_rings`). */
  readonly wsePolygonRingsServiceUrl: string;
  readonly ringsTableId: number;
  readonly network: HostedCreekSegmentNetwork;
  readonly tncComid: string;
}

/**
 * One TNC flowline's ribbon polygon set file. The rings come from the exact-rings table, not the polygon layer: ArcGIS
 * split the layer's self-crossing rings on publishing, and the ribbon drawing needs each ring's station order
 * (left edge stations 0…n−1, then right edge n−1…0) with its bed elevation as z.
 */
export async function loadHostedChannelRibbonPolygonsForFlowline(
  request: LoadHostedChannelRibbonPolygonsRequest,
  options?: HostedAdapterOptions,
): Promise<HostedChannelRibbonPolygonSetsFile> {
  const where = `tnc_comid = ${sqlString(request.tncComid)}`;
  const [ringRows, ribbonRows] = await Promise.all([
    queryAllRows(
      withHostedTransport(options, {
        layerUrl: layerUrl(request.wsePolygonRingsServiceUrl, request.ringsTableId),
        where,
        outFields: ['segment_id', 'bucket_index', 'min_depth_m', 'max_depth_m', 'ring_json'],
        orderByFields: ['segment_id', 'bucket_index'],
      }),
    ),
    queryAllRows(
      withHostedTransport(options, {
        layerUrl: layerUrl(request.wsePolygonsServiceUrl, request.channelRibbonsTableId),
        where,
        outFields: [
          'segment_id',
          'station_count',
          'length_m',
          'anchor_longitude',
          'anchor_latitude',
          'anchor_bed_elevation_m',
          'anchor_station',
          'downstream_segment_id',
          'breached_station_count',
          'station_distances_m_json',
          'true_top_width_at_anchor_m_json',
          'display_top_width_at_anchor_m_json',
        ],
        orderByFields: ['segment_id'],
      }),
    ),
  ]);

  type Bucket = HostedChannelRibbonPolygonSetsFile['waterSurfacePolygonSets'][number]['elevationBuckets'][number];
  const bucketsBySegmentId = new Map<string, { bucketIndex: number; bucket: Bucket }[]>();
  for (const { attributes } of ringRows) {
    const segmentId = stringOrEmpty(attributes.segment_id);
    const min = numberOrNull(attributes.min_depth_m);
    const max = numberOrNull(attributes.max_depth_m);
    if (!segmentId || min === null || max === null) continue;
    const buckets = bucketsBySegmentId.get(segmentId) ?? [];
    buckets.push({
      bucketIndex: numberOrNull(attributes.bucket_index) ?? buckets.length,
      bucket: {
        minWaterSurfaceElevationM: min,
        maxWaterSurfaceElevationM: max,
        ringsWgs84: [parseJsonAttribute<LonLatZ[]>(attributes.ring_json, [])],
      },
    });
    bucketsBySegmentId.set(segmentId, buckets);
  }
  const ribbonBySegmentId = new Map(
    ribbonRows.map(({ attributes }) => [stringOrEmpty(attributes.segment_id), readChannelRibbonSummary(attributes)]),
  );

  return {
    segmentNetworkVersion: request.network.segmentNetworkVersion,
    waterSurfacePolygonSets: (request.network.segmentsByTncComid.get(request.tncComid) ?? []).map((segment) => {
      const channelRibbon = ribbonBySegmentId.get(segment.segmentId);
      return {
        segmentId: segment.segmentId,
        elevationBuckets: (bucketsBySegmentId.get(segment.segmentId) ?? [])
          .sort((a, b) => a.bucketIndex - b.bucketIndex)
          .map((entry) => entry.bucket),
        ...(channelRibbon ? { channelRibbon } : {}),
      };
    }),
  };
}

function readChannelRibbonSummary(attributes: Record<string, unknown>): HostedChannelRibbonSummary {
  const longitude = numberOrNull(attributes.anchor_longitude);
  const latitude = numberOrNull(attributes.anchor_latitude);
  return {
    stationCount: numberOrNull(attributes.station_count),
    lengthM: numberOrNull(attributes.length_m),
    anchorLonLat: longitude === null || latitude === null ? null : [longitude, latitude],
    anchorBedElevationM: numberOrNull(attributes.anchor_bed_elevation_m),
    anchorStation: numberOrNull(attributes.anchor_station),
    downstreamSegmentId: stringOrEmpty(attributes.downstream_segment_id) || null,
    breachedStations: numberOrNull(attributes.breached_station_count),
    stationDistancesM: parseJsonAttribute<number[]>(attributes.station_distances_m_json, []),
    trueTopWidthAtAnchorM: parseJsonAttribute<number[]>(attributes.true_top_width_at_anchor_m_json, []),
    displayTopWidthAtAnchorM: parseJsonAttribute<number[]>(attributes.display_top_width_at_anchor_m_json, []),
  };
}
