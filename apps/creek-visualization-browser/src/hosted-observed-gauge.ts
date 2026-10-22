/**
 * Hosted observed gauge data (UCS-285).
 *
 * Rebuilds the five files `assembleLoadedCreekVisualization` reads for the
 * Jalama Near Lompoc gauge (USGS 11120600) from ArcGIS services instead of
 * `/published-creek-visualization-data/`:
 *
 * - `creekSegments`: the 61 Creek Segments of TNC flowline 27714637, from the
 *   modeled WSE service's creek segments layer;
 * - `waterSurfacePolygonSets`: the prepared water-surface polygons of the gauge's
 *   Creek Segment, from the WSE polygons service (default WSE Polygon Generation Method);
 * - `observedTimeSeries`: every Creek Gauge Data row of station 1 from the public
 *   gauge service, converted by `observed-gauge-readings.ts` (same rules as the pipeline),
 *   plus each reading's USGS approval status;
 * - `monitoringStations` and `dataSourceMetadata`: the small app configuration below.
 *
 * The station and data source are app configuration, not datasets: a few constants
 * are simpler and safer than deriving them from the gauge service's locations layer.
 * Every file carries the hosted Creek Segment network version, so the data contract's
 * one-shared-version check holds.
 */

import { readObservedWsePropagationFile, type PublishedCreekFiles } from './creek-data-contract.ts';
import {
  layerUrl,
  numberOrNull,
  withHostedTransport,
  type HostedAdapterOptions,
} from './hosted-adapter-options.ts';
import { loadHostedCreekSegmentNetwork } from './hosted-creek-segment-network.ts';
import { queryAllRows } from './hosted-feature-service-query.ts';
import { loadHostedModeledWseVersion, loadHostedWsePolygonMethods } from './hosted-modeled-catalog.ts';
import { loadHostedWaterSurfacePolygonsForFlowline } from './hosted-water-surface-polygons.ts';
import {
  buildObservedGaugeReadings,
  OBSERVATION_STATION_ID,
  readApprovalStatus,
  type ObservedGaugeRow,
} from './observed-gauge-readings.ts';

/** Layer id of the "Creek Gauge Data" table in the gauge service. */
export const CREEK_GAUGE_DATA_LAYER_ID = 2;
/** The gauge service answers at most 2000 rows per request, below its advertised standard limit. */
export const CREEK_GAUGE_DATA_PAGE_SIZE = 2000;

/** Jalama Near Lompoc gauge configuration (same values as the shipped monitoring-stations.json). */
export const JALAMA_GAUGE = {
  stationId: 'USGS-11120600',
  name: 'Jalama Creek near Lompoc',
  tncComid: '27714637',
  segmentId: '27714637-026',
  observedSourceId: 'usgs-11120600-observed-wse',
  observedSourceName: 'USGS 11120600 Jalama Creek near Lompoc gauge height',
  locationWgs84: [-120.484894, 34.513686] as const,
  snapDistanceM: 7.73,
} as const;

export interface LoadHostedObservedGaugeRequest {
  readonly modeledWseServiceUrl: string;
  readonly wsePolygonsServiceUrl: string;
  readonly creekGaugeServiceUrl: string;
  /**
   * `observed-wse-propagation.json` (Creek Segment Observed WSE Propagation, UCS-300): the gauge segment's
   * beds and neighbours. Hosted services carry no bed elevations, so this small file ships with the app.
   * When given, the neighbours' polygons load too. Absent, only the gauge segment draws water.
   */
  readonly observedWsePropagation?: unknown;
}

export interface HostedObservedGauge {
  readonly files: PublishedCreekFiles;
  /** Rows dropped as identical duplicates of an earlier timestamp. */
  readonly droppedDuplicateCount: number;
}

export async function loadHostedObservedGauge(
  request: LoadHostedObservedGaugeRequest,
  options?: HostedAdapterOptions,
): Promise<HostedObservedGauge> {
  const [version, polygonMethods] = await Promise.all([
    loadHostedModeledWseVersion({ modeledWseServiceUrl: request.modeledWseServiceUrl }, options),
    loadHostedWsePolygonMethods({ wsePolygonsServiceUrl: request.wsePolygonsServiceUrl }, options),
  ]);
  const segmentNetworkVersion = version.segmentNetworkVersion;

  const defaultMethod = polygonMethods.methodList.versions
    .filter((method) => method.methodId === polygonMethods.methodList.defaultMethodId)
    .at(-1);
  const polygonLayerId = defaultMethod
    ? polygonMethods.polygonLayerIdByMethodKey.get(`${defaultMethod.methodId}@v${defaultMethod.version}`)
    : undefined;
  if (polygonLayerId === undefined) {
    throw new Error('The WSE polygons service has no default WSE Polygon Generation Method layer.');
  }

  // Inferred neighbours draw the same default-method polygons as the gauge segment.
  const polygonSegmentIds =
    request.observedWsePropagation === undefined
      ? [JALAMA_GAUGE.segmentId]
      : readObservedWsePropagationFile(request.observedWsePropagation).segments.map((segment) => segment.segmentId);

  const [network, gaugeRows] = await Promise.all([
    loadHostedCreekSegmentNetwork(
      {
        modeledWseServiceUrl: request.modeledWseServiceUrl,
        creekSegmentsLayerId: version.layerIds.creekSegments,
        segmentNetworkVersion,
        tncComid: JALAMA_GAUGE.tncComid,
      },
      options,
    ),
    loadObservedGaugeRows(request.creekGaugeServiceUrl, options),
  ]);
  const polygonSets = await loadHostedWaterSurfacePolygonsForFlowline(
    {
      wsePolygonsServiceUrl: request.wsePolygonsServiceUrl,
      polygonLayerId,
      network,
      tncComid: JALAMA_GAUGE.tncComid,
      segmentIds: polygonSegmentIds,
    },
    options,
  );

  const readings = buildObservedGaugeReadings(gaugeRows);
  return {
    droppedDuplicateCount: readings.droppedDuplicateCount,
    files: {
      creekSegments: {
        segmentNetworkVersion,
        creekSegments: (network.segmentsByTncComid.get(JALAMA_GAUGE.tncComid) ?? []).map((segment) => ({
          segmentId: segment.segmentId,
          comid: Number(segment.tncComid),
          vertexIndexStart: segment.vertexIndexStart,
          vertexIndexEnd: segment.vertexIndexEnd,
          lengthM: segment.lengthM,
          pathWgs84: segment.pathWgs84,
        })),
      },
      waterSurfacePolygonSets: polygonSets,
      monitoringStations: {
        segmentNetworkVersion,
        monitoringStations: [
          {
            stationId: JALAMA_GAUGE.stationId,
            name: JALAMA_GAUGE.name,
            segmentId: JALAMA_GAUGE.segmentId,
            observedSourceId: JALAMA_GAUGE.observedSourceId,
            locationWgs84: JALAMA_GAUGE.locationWgs84,
            snapDistanceM: JALAMA_GAUGE.snapDistanceM,
          },
        ],
      },
      dataSourceMetadata: {
        dataSources: [
          { sourceId: JALAMA_GAUGE.observedSourceId, name: JALAMA_GAUGE.observedSourceName, kind: 'observed' },
        ],
      },
      observedTimeSeries: {
        segmentNetworkVersion,
        sourceId: JALAMA_GAUGE.observedSourceId,
        timestampsUtcMs: readings.timestampsUtcMs,
        approvalStatuses: readings.approvalStatuses,
        segments: [{ segmentId: JALAMA_GAUGE.segmentId, waterSurfaceElevationM: readings.waterSurfaceElevationM }],
      },
      ...(request.observedWsePropagation === undefined ? {} : { observedWsePropagation: request.observedWsePropagation }),
    },
  };
}

/** Every Creek Gauge Data row of the Jalama Near Lompoc gauge, ordered by timestamp then id. */
async function loadObservedGaugeRows(
  gaugeServiceUrl: string,
  options: HostedAdapterOptions | undefined,
): Promise<ObservedGaugeRow[]> {
  const rows = await queryAllRows(
    withHostedTransport(options, {
      layerUrl: layerUrl(gaugeServiceUrl, CREEK_GAUGE_DATA_LAYER_ID),
      where: `station_id=${OBSERVATION_STATION_ID}`,
      outFields: ['id', 'station_id', 'timestamp_utc', 'gauge_height', 'gauge_height_units', 'approval_status'],
      orderByFields: ['timestamp_utc', 'id'],
      pageSize: CREEK_GAUGE_DATA_PAGE_SIZE,
    }),
  );
  return rows.map(({ attributes }) => ({
    id: requiredNumber(attributes.id, 'id'),
    stationId: requiredNumber(attributes.station_id, 'station_id'),
    timestampUtcMs: requiredNumber(attributes.timestamp_utc, 'timestamp_utc'),
    gaugeHeightFt: numberOrNull(attributes.gauge_height),
    gaugeHeightUnits: typeof attributes.gauge_height_units === 'string' ? attributes.gauge_height_units : null,
    approvalStatus: readApprovalStatus(attributes.approval_status),
  }));
}

function requiredNumber(value: unknown, field: string): number {
  const number = numberOrNull(value);
  if (number === null) throw new Error(`A Creek Gauge Data row has no numeric ${field}.`);
  return number;
}
