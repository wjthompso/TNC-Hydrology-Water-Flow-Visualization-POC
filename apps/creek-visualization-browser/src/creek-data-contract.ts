import {
  inferredSeriesM,
  type PropagationSegmentNode,
} from '../../../pipelines/creek-visualization-data-production/observed-wse-propagation.ts';

/** Nominal observed-source step. Gap slots stay on this grid and are not filled in. */
export const OBSERVATION_GRID_STEP_MS = 15 * 60 * 1000;

export class PublishedCreekDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishedCreekDataError';
  }
}

export interface ObservationClock {
  firstUtcMs: number;
  stepMs: number;
  count: number;
}

export type LonLat = readonly [number, number];
export type LonLatRing = readonly LonLat[];

export interface CreekSegment {
  segmentId: string;
  comid: number | string;
  vertexIndexStart: number;
  vertexIndexEnd: number;
  lengthM: number;
  pathWgs84: readonly LonLat[];
}

export interface ElevationBucket {
  minWaterSurfaceElevationM: number;
  maxWaterSurfaceElevationM: number;
  /** Closed lon/lat rings. An empty list shows no water. */
  ringsWgs84: readonly LonLatRing[];
}

/** USGS review status of one gauge reading. */
export type ObservedApprovalStatus = 'Provisional' | 'Approved';

export interface MonitoringStation {
  stationId: string;
  name: string;
  segmentId: string;
  observedSourceId: string;
  locationWgs84: readonly [number, number];
  snapDistanceM: number;
}

/**
 * Creek Segment Observed WSE Propagation (UCS-300): the Creek Segments around the gauge segment that
 * draw inferred water, and the inferred Time Series that water follows. Absent when the published
 * data carries no propagation file, in which case only the gauge segment draws water.
 */
export interface LoadedObservedWsePropagation {
  hopsPerDirection: number;
  /** +1 when a higher vertex index is farther downstream on the gauge's flowline, −1 otherwise. */
  flowDirection: 1 | -1;
  gaugeBedElevationM: number;
  /** The gauge segment and its inferred neighbours, with beds and flow-order neighbour ids. */
  nodesById: ReadonlyMap<string, PropagationSegmentNode>;
  /** Neighbours that draw inferred water: upstream nearest first, then downstream nearest first. */
  inferredSegmentIds: readonly string[];
  /** Parallel to `LoadedCreekVisualization.timestampsUtcMs`; null where the gauge has no usable depth. */
  inferredWaterSurfaceElevationMBySegmentId: ReadonlyMap<string, readonly (number | null)[]>;
}

export interface LoadedCreekVisualization {
  segmentNetworkVersion: string;
  segmentsById: ReadonlyMap<string, CreekSegment>;
  polygonBucketsBySegmentId: ReadonlyMap<string, readonly ElevationBucket[]>;
  polygonSetSegmentIds: readonly string[];
  station: MonitoringStation;
  timestampsUtcMs: readonly number[];
  /** Parallel to `timestampsUtcMs`. Absent for the shipped local files, which do not carry it. */
  approvalStatuses?: readonly (ObservedApprovalStatus | null)[];
  waterSurfaceElevationMBySegmentId: ReadonlyMap<string, readonly (number | null)[]>;
  /** Null when the published data has no observed WSE propagation file. */
  propagation: LoadedObservedWsePropagation | null;
  clock: ObservationClock;
  openingGridIndex: number;
}

export interface PublishedCreekFiles {
  creekSegments: unknown;
  waterSurfacePolygonSets: unknown;
  monitoringStations: unknown;
  dataSourceMetadata: unknown;
  observedTimeSeries: unknown;
  /** `observed-wse-propagation.json`. Optional so a data set without it draws the gauge segment only. */
  observedWsePropagation?: unknown;
}

export function timeAtGridIndex(clock: ObservationClock, index: number): number {
  return clock.firstUtcMs + index * clock.stepMs;
}

/** Returns null when the timestamp is not an exact grid slot. */
export function gridIndexForTimestamp(
  clock: ObservationClock,
  timeUtcMs: number,
): number | null {
  const index = Math.round((timeUtcMs - clock.firstUtcMs) / clock.stepMs);
  if (index < 0 || index >= clock.count) return null;
  if (Math.abs(timeAtGridIndex(clock, index) - timeUtcMs) > 1) return null;
  return index;
}

export function assembleLoadedCreekVisualization(
  files: PublishedCreekFiles,
  stationId: string,
): LoadedCreekVisualization {
  const segments = readCreekSegments(files.creekSegments);
  const polygonSets = readPolygonSets(files.waterSurfacePolygonSets);
  const stations = readMonitoringStations(files.monitoringStations);
  const sources = readDataSources(files.dataSourceMetadata);
  const series = readObservedTimeSeries(files.observedTimeSeries);

  const segmentNetworkVersion = sharedSegmentNetworkVersion([
    ['creek-segments', segments.segmentNetworkVersion],
    ['water-surface-polygon-sets', polygonSets.segmentNetworkVersion],
    ['monitoring-stations', stations.segmentNetworkVersion],
    ['observed time series', series.segmentNetworkVersion],
  ]);

  const segmentsById = new Map<string, CreekSegment>();
  for (const segment of segments.creekSegments) {
    if (segmentsById.has(segment.segmentId)) {
      fail(`Creek segments list ${segment.segmentId} more than once.`);
    }
    segmentsById.set(segment.segmentId, segment);
  }

  const station = stations.monitoringStations.find((item) => item.stationId === stationId);
  if (!station) fail(`Monitoring stations do not include ${stationId}.`);
  if (!segmentsById.has(station.segmentId)) {
    fail(`Gauge ${stationId} points at a creek segment that is not in the network.`);
  }

  const observedSource = sources.find((source) => source.sourceId === station.observedSourceId);
  if (!observedSource) {
    fail(`No data source matches the gauge's observed source.`);
  }
  if (observedSource.kind !== 'observed') {
    fail(`The gauge's data source is not an observed source.`);
  }
  if (series.sourceId !== station.observedSourceId) {
    fail(`The observed time series does not match the gauge's observed source.`);
  }

  const polygonBucketsBySegmentId = new Map<string, readonly ElevationBucket[]>();
  const polygonSetSegmentIds: string[] = [];
  for (const polygonSet of polygonSets.waterSurfacePolygonSets) {
    if (!segmentsById.has(polygonSet.segmentId)) {
      fail(`A prepared polygon set points at a creek segment that is not in the network.`);
    }
    if (polygonBucketsBySegmentId.has(polygonSet.segmentId)) {
      fail(`Prepared polygons list ${polygonSet.segmentId} more than once.`);
    }
    polygonBucketsBySegmentId.set(polygonSet.segmentId, polygonSet.elevationBuckets);
    polygonSetSegmentIds.push(polygonSet.segmentId);
  }
  if (!polygonBucketsBySegmentId.has(station.segmentId)) {
    fail(`The gauge's creek segment has no prepared water-surface polygons.`);
  }

  const waterSurfaceElevationMBySegmentId = new Map<string, readonly (number | null)[]>();
  for (const segmentSeries of series.segments) {
    if (!segmentsById.has(segmentSeries.segmentId)) {
      fail(`The observed time series names a creek segment that is not in the network.`);
    }
    if (segmentSeries.waterSurfaceElevationM.length !== series.timestampsUtcMs.length) {
      fail(`Observed readings do not line up with the observed timestamps.`);
    }
    if (waterSurfaceElevationMBySegmentId.has(segmentSeries.segmentId)) {
      fail(`The observed time series lists ${segmentSeries.segmentId} more than once.`);
    }
    waterSurfaceElevationMBySegmentId.set(
      segmentSeries.segmentId,
      segmentSeries.waterSurfaceElevationM,
    );
  }
  const stationReadings = waterSurfaceElevationMBySegmentId.get(station.segmentId);
  if (!stationReadings) {
    fail(`The observed time series has no readings for the gauge's creek segment.`);
  }

  const propagation =
    files.observedWsePropagation === undefined
      ? null
      : assemblePropagation({
          file: readObservedWsePropagationFile(files.observedWsePropagation),
          segmentNetworkVersion,
          gaugeSegmentId: station.segmentId,
          segmentsById,
          polygonBucketsBySegmentId,
          stationReadings,
        });

  const clock = clockCovering(series.timestampsUtcMs);
  return {
    segmentNetworkVersion,
    segmentsById,
    polygonBucketsBySegmentId,
    polygonSetSegmentIds,
    station,
    timestampsUtcMs: series.timestampsUtcMs,
    ...(series.approvalStatuses ? { approvalStatuses: series.approvalStatuses } : {}),
    waterSurfaceElevationMBySegmentId,
    propagation,
    clock,
    openingGridIndex: openingGridIndexFor(
      clock,
      series.timestampsUtcMs,
      stationReadings,
    ),
  };
}

export interface ObservedWsePropagationFileNode {
  segmentId: string;
  role: 'gauge' | 'upstream' | 'downstream';
  hops: number;
  bedElevationM: number;
  upstreamSegmentId: string | null;
  downstreamSegmentId: string | null;
}

export interface ObservedWsePropagationFile {
  segmentNetworkVersion: string;
  gaugeSegmentId: string;
  hopsPerDirection: number;
  flowDirection: 1 | -1;
  segments: ObservedWsePropagationFileNode[];
}

/** Reads `observed-wse-propagation.json`; the gauge segment is the single `gauge` entry. */
export function readObservedWsePropagationFile(value: unknown): ObservedWsePropagationFile {
  const record = readRecord(value, 'observed-wse-propagation');
  const flowDirection = readFiniteNumber(record.flowDirection, 'observed-wse-propagation flowDirection');
  if (flowDirection !== 1 && flowDirection !== -1) fail('observed-wse-propagation flowDirection must be 1 or -1.');
  const segments = readArray(record.segments, 'observed-wse-propagation segments').map((item, index): ObservedWsePropagationFileNode => {
    const label = `observed-wse-propagation segment ${index + 1}`;
    const node = readRecord(item, label);
    const role = node.role;
    if (role !== 'gauge' && role !== 'upstream' && role !== 'downstream') {
      fail(`${label} role must be gauge, upstream, or downstream.`);
    }
    return {
      segmentId: readId(node.segmentId, label),
      role,
      hops: readFiniteNumber(node.hops, `${label} hops`),
      bedElevationM: readFiniteNumber(node.bedElevationM, `${label} bed`),
      upstreamSegmentId: readNeighbourId(node.upstreamSegmentId, `${label} upstream neighbour`),
      downstreamSegmentId: readNeighbourId(node.downstreamSegmentId, `${label} downstream neighbour`),
    };
  });
  if (segments.filter((segment) => segment.role === 'gauge').length !== 1) {
    fail('observed-wse-propagation must list exactly one gauge segment.');
  }
  return {
    segmentNetworkVersion: readVersion(record, 'observed-wse-propagation'),
    gaugeSegmentId: readId(record.gaugeSegmentId, 'observed-wse-propagation gaugeSegmentId'),
    hopsPerDirection: readFiniteNumber(record.hopsPerDirection, 'observed-wse-propagation hopsPerDirection'),
    flowDirection,
    segments,
  };
}

function readNeighbourId(value: unknown, label: string): string | null {
  return value === null ? null : readId(value, label);
}

function assemblePropagation(input: {
  file: ObservedWsePropagationFile;
  segmentNetworkVersion: string;
  gaugeSegmentId: string;
  segmentsById: ReadonlyMap<string, CreekSegment>;
  polygonBucketsBySegmentId: ReadonlyMap<string, readonly ElevationBucket[]>;
  stationReadings: readonly (number | null)[];
}): LoadedObservedWsePropagation {
  const { file } = input;
  if (file.segmentNetworkVersion !== input.segmentNetworkVersion) {
    fail(
      `observed-wse-propagation segmentNetworkVersion is ${file.segmentNetworkVersion}, expected ${input.segmentNetworkVersion}.`,
    );
  }
  if (file.gaugeSegmentId !== input.gaugeSegmentId) {
    fail('observed-wse-propagation names a gauge segment other than the monitoring station\'s.');
  }
  const nodesById = new Map<string, PropagationSegmentNode>();
  for (const node of file.segments) {
    if (!input.segmentsById.has(node.segmentId)) {
      fail(`observed-wse-propagation names ${node.segmentId}, which is not in the creek network.`);
    }
    if (!input.polygonBucketsBySegmentId.has(node.segmentId)) {
      fail(`${node.segmentId} draws inferred water but has no prepared water-surface polygons.`);
    }
    nodesById.set(node.segmentId, {
      segmentId: node.segmentId,
      bedElevationM: node.bedElevationM,
      upstreamSegmentId: node.upstreamSegmentId,
      downstreamSegmentId: node.downstreamSegmentId,
    });
  }
  const gaugeNode = file.segments.find((node) => node.role === 'gauge');
  if (!gaugeNode || gaugeNode.segmentId !== input.gaugeSegmentId) {
    fail('observed-wse-propagation gauge entry is not the monitoring station\'s segment.');
  }
  const inferredNodes = file.segments.filter((node) => node.role !== 'gauge');
  const inferredWaterSurfaceElevationMBySegmentId = new Map<string, readonly (number | null)[]>();
  for (const node of inferredNodes) {
    inferredWaterSurfaceElevationMBySegmentId.set(
      node.segmentId,
      inferredSeriesM(input.stationReadings, gaugeNode.bedElevationM, node.bedElevationM),
    );
  }
  return {
    hopsPerDirection: file.hopsPerDirection,
    flowDirection: file.flowDirection,
    gaugeBedElevationM: gaugeNode.bedElevationM,
    nodesById,
    inferredSegmentIds: inferredNodes.map((node) => node.segmentId),
    inferredWaterSurfaceElevationMBySegmentId,
  };
}

function clockCovering(timestampsUtcMs: readonly number[]): ObservationClock {
  const firstUtcMs = timestampsUtcMs[0];
  const lastUtcMs = timestampsUtcMs[timestampsUtcMs.length - 1];
  const steps = Math.floor((lastUtcMs - firstUtcMs) / OBSERVATION_GRID_STEP_MS);
  return {
    firstUtcMs,
    stepMs: OBSERVATION_GRID_STEP_MS,
    count: steps + 1,
  };
}

/** First grid slot whose reading is present. Zero when every reading is missing. */
function openingGridIndexFor(
  clock: ObservationClock,
  timestampsUtcMs: readonly number[],
  readings: readonly (number | null)[],
): number {
  for (let index = 0; index < readings.length; index += 1) {
    if (typeof readings[index] !== 'number') continue;
    const gridIndex = gridIndexForTimestamp(clock, timestampsUtcMs[index]);
    if (gridIndex != null) return gridIndex;
  }
  return 0;
}

function sharedSegmentNetworkVersion(parts: readonly (readonly [string, string])[]): string {
  const first = parts[0];
  if (!first || first[1].length === 0) {
    fail('Published creek files are missing segmentNetworkVersion.');
  }
  const mismatched = parts.filter((part) => part[1] !== first[1]);
  if (mismatched.length > 0) {
    const detail = mismatched
      .map(([label, version]) => `${label} (${version})`)
      .join(', ');
    fail(
      `Published creek files do not share one segmentNetworkVersion. ${first[0]} is ${first[1]}; ${detail} differ.`,
    );
  }
  return first[1];
}

function readCreekSegments(value: unknown): {
  segmentNetworkVersion: string;
  creekSegments: CreekSegment[];
} {
  const record = readRecord(value, 'creek-segments');
  const segmentNetworkVersion = readVersion(record, 'creek-segments');
  const creekSegments = readArray(record.creekSegments, 'creek-segments').map((item, index) =>
    readCreekSegment(item, index),
  );
  if (creekSegments.length === 0) fail('creek-segments does not include any creek segments.');
  return { segmentNetworkVersion, creekSegments };
}

function readCreekSegment(value: unknown, index: number): CreekSegment {
  const label = `creek segment ${index + 1}`;
  const record = readRecord(value, label);
  const path = readLonLatPath(record.pathWgs84, label);
  if (path.length < 2) fail(`${label} needs at least two vertices.`);
  return {
    segmentId: readId(record.segmentId, label),
    comid: readComid(record.comid, label),
    vertexIndexStart: readFiniteNumber(record.vertexIndexStart, `${label} vertexIndexStart`),
    vertexIndexEnd: readFiniteNumber(record.vertexIndexEnd, `${label} vertexIndexEnd`),
    lengthM: readFiniteNumber(record.lengthM, `${label} length`),
    pathWgs84: path,
  };
}

function readPolygonSets(value: unknown): {
  segmentNetworkVersion: string;
  waterSurfacePolygonSets: { segmentId: string; elevationBuckets: ElevationBucket[] }[];
} {
  const record = readRecord(value, 'water-surface-polygon-sets');
  const segmentNetworkVersion = readVersion(record, 'water-surface-polygon-sets');
  const waterSurfacePolygonSets = readArray(
    record.waterSurfacePolygonSets,
    'water-surface-polygon-sets',
  ).map((item, index) => readPolygonSet(item, index));
  return { segmentNetworkVersion, waterSurfacePolygonSets };
}

function readPolygonSet(
  value: unknown,
  index: number,
): { segmentId: string; elevationBuckets: ElevationBucket[] } {
  const label = `polygon set ${index + 1}`;
  const record = readRecord(value, label);
  const segmentId = readId(record.segmentId, label);
  const elevationBuckets = readArray(record.elevationBuckets, `${label} buckets`).map(
    (item, bucketIndex) => readElevationBucket(item, segmentId, bucketIndex),
  );
  for (let bucketIndex = 1; bucketIndex < elevationBuckets.length; bucketIndex += 1) {
    const previous = elevationBuckets[bucketIndex - 1];
    const bucket = elevationBuckets[bucketIndex];
    if (previous.maxWaterSurfaceElevationM - bucket.minWaterSurfaceElevationM > 1e-6) {
      fail(`Elevation buckets for ${segmentId} overlap or are out of order.`);
    }
  }
  return { segmentId, elevationBuckets };
}

function readElevationBucket(value: unknown, segmentId: string, index: number): ElevationBucket {
  const label = `elevation bucket ${index + 1} for ${segmentId}`;
  const record = readRecord(value, label);
  const minWaterSurfaceElevationM = readFiniteNumber(
    record.minWaterSurfaceElevationM,
    `${label} minimum`,
  );
  const maxWaterSurfaceElevationM = readFiniteNumber(
    record.maxWaterSurfaceElevationM,
    `${label} maximum`,
  );
  if (!(maxWaterSurfaceElevationM - minWaterSurfaceElevationM > 1e-6)) {
    fail(`Elevation buckets for ${segmentId} must be half-open ranges.`);
  }
  return {
    minWaterSurfaceElevationM,
    maxWaterSurfaceElevationM,
    ringsWgs84: readRings(record.ringsWgs84, label),
  };
}

function readMonitoringStations(value: unknown): {
  segmentNetworkVersion: string;
  monitoringStations: MonitoringStation[];
} {
  const record = readRecord(value, 'monitoring-stations');
  const segmentNetworkVersion = readVersion(record, 'monitoring-stations');
  const monitoringStations = readArray(record.monitoringStations, 'monitoring-stations').map(
    (item, index) => readMonitoringStation(item, index),
  );
  return { segmentNetworkVersion, monitoringStations };
}

function readMonitoringStation(value: unknown, index: number): MonitoringStation {
  const label = `monitoring station ${index + 1}`;
  const record = readRecord(value, label);
  return {
    stationId: readId(record.stationId, label),
    name: readText(record.name, `${label} name`),
    segmentId: readId(record.segmentId, `${label} segment`),
    observedSourceId: readId(record.observedSourceId, `${label} observed source`),
    locationWgs84: readLonLat(record.locationWgs84, `${label} location`),
    snapDistanceM: readFiniteNumber(record.snapDistanceM, `${label} snap distance`),
  };
}

function readDataSources(value: unknown): { sourceId: string; kind: 'observed' | 'modeled' }[] {
  const record = readRecord(value, 'data-source-metadata');
  return readArray(record.dataSources, 'data-source-metadata').map((item, index) => {
    const source = readRecord(item, `data source ${index + 1}`);
    const kind = source.kind;
    if (kind !== 'observed' && kind !== 'modeled') {
      fail(`Data source ${index + 1} must be observed or modeled.`);
    }
    readText(source.name, `data source ${index + 1} name`);
    return {
      sourceId: readId(source.sourceId, `data source ${index + 1}`),
      kind,
    };
  });
}

function readObservedTimeSeries(value: unknown): {
  segmentNetworkVersion: string;
  sourceId: string;
  timestampsUtcMs: number[];
  approvalStatuses: (ObservedApprovalStatus | null)[] | null;
  segments: { segmentId: string; waterSurfaceElevationM: (number | null)[] }[];
} {
  const record = readRecord(value, 'observed time series');
  const timestampsUtcMs = readArray(record.timestampsUtcMs, 'observed timestamps').map(
    (item, index) => readFiniteNumber(item, `observed timestamp ${index + 1}`),
  );
  if (timestampsUtcMs.length === 0) fail('The observed time series has no timestamps.');
  for (let index = 1; index < timestampsUtcMs.length; index += 1) {
    if (!(timestampsUtcMs[index] > timestampsUtcMs[index - 1])) {
      fail('Observed timestamps must be strictly ascending.');
    }
  }
  const segments = readArray(record.segments, 'observed time series segments').map(
    (item, index) => {
      const segment = readRecord(item, `observed segment ${index + 1}`);
      const waterSurfaceElevationM = readArray(
        segment.waterSurfaceElevationM,
        `observed readings ${index + 1}`,
      ).map((reading) => readReading(reading));
      return {
        segmentId: readId(segment.segmentId, `observed segment ${index + 1}`),
        waterSurfaceElevationM,
      };
    },
  );
  return {
    segmentNetworkVersion: readVersion(record, 'observed time series'),
    sourceId: readId(record.sourceId, 'observed time series source'),
    timestampsUtcMs,
    approvalStatuses: readApprovalStatuses(record.approvalStatuses, timestampsUtcMs.length),
    segments,
  };
}

/** Optional list parallel to the timestamps; the shipped local file has none. */
function readApprovalStatuses(
  value: unknown,
  timestampCount: number,
): (ObservedApprovalStatus | null)[] | null {
  if (value === undefined) return null;
  const statuses = readArray(value, 'observed approval statuses').map((status) => {
    if (status === null || status === 'Provisional' || status === 'Approved') return status;
    return fail('An observed approval status must be Provisional, Approved, or null.');
  });
  if (statuses.length !== timestampCount) {
    fail('Observed approval statuses do not line up with the observed timestamps.');
  }
  return statuses;
}

function readReading(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('An observed reading must be a number or null.');
  }
  return value;
}

function readRings(value: unknown, label: string): LonLatRing[] {
  return readArray(value, `${label} rings`).map((ring, ringIndex) =>
    readLonLatPath(ring, `${label} ring ${ringIndex + 1}`),
  );
}

function readLonLatPath(value: unknown, label: string): LonLat[] {
  return readArray(value, label).map((point, index) =>
    readLonLat(point, `${label} point ${index + 1}`),
  );
}

function readLonLat(value: unknown, label: string): LonLat {
  const pair = readArray(value, label);
  if (pair.length < 2) fail(`${label} must be a longitude and latitude.`);
  const lon = readFiniteNumber(pair[0], `${label} longitude`);
  const lat = readFiniteNumber(pair[1], `${label} latitude`);
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    fail(`${label} is outside longitude and latitude bounds.`);
  }
  return [lon, lat];
}

function readComid(value: unknown, label: string): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value;
  fail(`${label} is missing its COMID.`);
}

function readVersion(record: Record<string, unknown>, label: string): string {
  return readText(record.segmentNetworkVersion, `${label} segmentNetworkVersion`);
}

function readId(value: unknown, label: string): string {
  return readText(value, label);
}

function readText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be text.`);
  }
  return value;
}

function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be a finite number.`);
  }
  return value;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be a list.`);
  return value;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new PublishedCreekDataError(message);
}
