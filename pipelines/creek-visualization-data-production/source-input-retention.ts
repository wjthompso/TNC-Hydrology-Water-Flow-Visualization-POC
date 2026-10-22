import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  COMID,
  ELEVATION_SNAPSHOT_FILE,
  ELEVATION_WINDOW_PIXELS,
  ELEVATION_WINDOW_SIZE_M,
  FLOWLINE_SNAPSHOT_FILE,
  MONITORING_LOCATION_ID,
  OBSERVATION_FIELDS,
  OBSERVATION_ORDER,
  OBSERVATION_PAGE_SIZE,
  OBSERVATION_STATION_ID,
  OBSERVATIONS_SNAPSHOT_FILE,
  RETENTION_MANIFEST_FILE,
  STATION_SNAPSHOT_FILE,
  TNC_FLOWLINE_QUERY,
  USGS_3DEP_EXPORT,
  USGS_OBSERVATION_QUERY,
  USGS_STATION_QUERY,
  sourceInputsDirectory,
} from './constants.ts';
import {
  expectNumber,
  expectNullableNumber,
  expectNullableString,
  expectRecord,
  isRecord,
  writeCompactJson,
  writePrettyJson,
} from './json-files.ts';
import { assignMonitoringStation, readMonitoringStation } from './monitoring-station-assignment.ts';
import { segmentTncFlowline } from './tnc-flowline-segmentation.ts';

interface RetainedObservation {
  id: number;
  station_id: number;
  timestamp_utc: number;
  gauge_height: number | null;
  gauge_height_units: string | null;
  approval_status: string | null;
}

interface ManifestSource {
  file: string;
  url: string;
  retrievedAt: string;
  pageUrls?: string[];
  rowCount?: number;
}

function queryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function fetchResponse(url: string): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      const body = await response.text();
      lastError = new Error(`Request failed with HTTP ${response.status} for ${url}\n${body.slice(0, 400)}`);
      const retryable = response.status >= 500 || response.status === 429;
      if (!retryable) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt === 3) break;
    await delay(1000 * attempt);
  }
  throw lastError ?? new Error(`Request failed for ${url}`);
}

async function fetchText(url: string): Promise<{ url: string; text: string; retrievedAt: string }> {
  const response = await fetchResponse(url);
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Response was not JSON for ${url}`);
  }
  if (isRecord(parsed) && 'error' in parsed) {
    throw new Error(`ArcGIS error for ${url}: ${JSON.stringify(parsed.error)}`);
  }
  return { url, text, retrievedAt: new Date().toISOString() };
}

function isTiff(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
  const bigTiff = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2b && bytes[3] === 0x00;
  return littleEndian || bigEndian || bigTiff;
}

function readObservation(value: unknown, index: number): RetainedObservation {
  const feature = expectRecord(value, `Observation feature ${index}`);
  const attributes = expectRecord(feature.attributes, `Observation feature ${index}`);
  const id = expectNumber(attributes, 'id', `Observation ${index}`);
  return {
    id,
    station_id: expectNumber(attributes, 'station_id', `Observation ${id}`),
    timestamp_utc: expectNumber(attributes, 'timestamp_utc', `Observation ${id}`),
    gauge_height: expectNullableNumber(attributes, 'gauge_height', `Observation ${id}`),
    gauge_height_units: expectNullableString(attributes, 'gauge_height_units', `Observation ${id}`),
    approval_status: expectNullableString(attributes, 'approval_status', `Observation ${id}`),
  };
}

async function retainObservations(): Promise<{
  rowCount: number;
  pageUrls: string[];
  retrievedAt: string;
}> {
  const countUrl = queryUrl(USGS_OBSERVATION_QUERY, {
    where: `station_id=${OBSERVATION_STATION_ID}`,
    returnCountOnly: 'true',
    f: 'json',
  });
  const countResponse = await fetchText(countUrl);
  const countRecord = expectRecord(JSON.parse(countResponse.text) as unknown, 'Observation count');
  const sourceRowCount = expectNumber(countRecord, 'count', 'Observation count');
  if (sourceRowCount <= 0) throw new Error('USGS observations query returned a count of 0.');

  const attributes: RetainedObservation[] = [];
  const pageUrls: string[] = [];
  while (attributes.length < sourceRowCount) {
    const pageUrl = queryUrl(USGS_OBSERVATION_QUERY, {
      where: `station_id=${OBSERVATION_STATION_ID}`,
      outFields: OBSERVATION_FIELDS.join(','),
      orderByFields: OBSERVATION_ORDER,
      returnGeometry: 'false',
      resultRecordCount: String(OBSERVATION_PAGE_SIZE),
      resultOffset: String(attributes.length),
      f: 'json',
    });
    pageUrls.push(pageUrl);
    const page = await fetchText(pageUrl);
    const pageRecord = expectRecord(JSON.parse(page.text) as unknown, 'Observation page');
    if (!Array.isArray(pageRecord.features)) throw new Error('Observation page is missing features.');
    if (pageRecord.features.length === 0) {
      throw new Error(
        `USGS observations ended at ${attributes.length} rows before source count ${sourceRowCount}.`,
      );
    }
    for (const feature of pageRecord.features) attributes.push(readObservation(feature, attributes.length));
    console.log(`Retained ${attributes.length} of ${sourceRowCount} gauge-height rows.`);
    if (attributes.length > sourceRowCount) {
      throw new Error(`USGS observations returned ${attributes.length} rows, more than source count ${sourceRowCount}.`);
    }
  }

  await writeCompactJson(path.join(sourceInputsDirectory, OBSERVATIONS_SNAPSHOT_FILE), {
    requestParams: {
      url: USGS_OBSERVATION_QUERY,
      where: `station_id=${OBSERVATION_STATION_ID}`,
      outFields: OBSERVATION_FIELDS.join(','),
      orderByFields: OBSERVATION_ORDER,
      returnGeometry: false,
      resultRecordCount: OBSERVATION_PAGE_SIZE,
      f: 'json',
    },
    sourceRowCount,
    attributes,
  });

  return { rowCount: sourceRowCount, pageUrls, retrievedAt: new Date().toISOString() };
}

function elevationWindowUrl(midpointX: number, midpointY: number): string {
  const half = ELEVATION_WINDOW_SIZE_M / 2;
  const bbox = [midpointX - half, midpointY - half, midpointX + half, midpointY + half]
    .map((value) => value.toFixed(3))
    .join(',');
  return queryUrl(USGS_3DEP_EXPORT, {
    bbox,
    bboxSR: '32610',
    imageSR: '32610',
    size: `${ELEVATION_WINDOW_PIXELS},${ELEVATION_WINDOW_PIXELS}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_NearestNeighbor',
    f: 'image',
  });
}

/** Fetch unchanged source snapshots, including a 3DEP window centered on the assigned Creek Segment. */
export async function retainSourceInputs(): Promise<void> {
  await mkdir(sourceInputsDirectory, { recursive: true });

  const flowlineUrl = queryUrl(TNC_FLOWLINE_QUERY, {
    where: `COMID=${COMID}`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '32610',
    f: 'json',
  });
  const stationUrl = queryUrl(USGS_STATION_QUERY, {
    where: `monitoring_location_id='${MONITORING_LOCATION_ID}'`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '32610',
    f: 'json',
  });

  const flowlineTask = fetchText(flowlineUrl);
  const stationTask = fetchText(stationUrl);
  const observationTask = retainObservations();
  let flowline: Awaited<ReturnType<typeof fetchText>>;
  let station: Awaited<ReturnType<typeof fetchText>>;
  try {
    [flowline, station] = await Promise.all([flowlineTask, stationTask]);
  } catch (error) {
    await observationTask.catch(() => undefined);
    throw error;
  }

  await writeFile(path.join(sourceInputsDirectory, FLOWLINE_SNAPSHOT_FILE), flowline.text);
  await writeFile(path.join(sourceInputsDirectory, STATION_SNAPSHOT_FILE), station.text);
  console.log(`Retained ${FLOWLINE_SNAPSHOT_FILE} and ${STATION_SNAPSHOT_FILE}.`);

  const segments = segmentTncFlowline(JSON.parse(flowline.text) as unknown);
  const monitoringStation = readMonitoringStation(JSON.parse(station.text) as unknown);
  const assignment = assignMonitoringStation(monitoringStation, segments);
  const midpointX = (assignment.segment.startUtm.x + assignment.segment.endUtm.x) / 2;
  const midpointY = (assignment.segment.startUtm.y + assignment.segment.endUtm.y) / 2;
  const elevationUrl = elevationWindowUrl(midpointX, midpointY);
  try {
    const elevationResponse = await fetchResponse(elevationUrl);
    const elevationBytes = Buffer.from(await elevationResponse.arrayBuffer());
    if (!isTiff(elevationBytes)) {
      throw new Error(
        `USGS 3DEP export was not a TIFF. Body starts: ${elevationBytes.subarray(0, 180).toString('utf8')}`,
      );
    }
    await writeFile(path.join(sourceInputsDirectory, ELEVATION_SNAPSHOT_FILE), elevationBytes);
    const elevationRetrievedAt = new Date().toISOString();
    console.log(
      `Retained ${ELEVATION_SNAPSHOT_FILE} (${elevationBytes.length} bytes) around Creek Segment ${assignment.reviewed.segmentId}.`,
    );

    const observations = await observationTask;
    const sources: ManifestSource[] = [
      { file: FLOWLINE_SNAPSHOT_FILE, url: flowline.url, retrievedAt: flowline.retrievedAt },
      { file: STATION_SNAPSHOT_FILE, url: station.url, retrievedAt: station.retrievedAt },
      {
        file: OBSERVATIONS_SNAPSHOT_FILE,
        url: USGS_OBSERVATION_QUERY,
        pageUrls: observations.pageUrls,
        rowCount: observations.rowCount,
        retrievedAt: observations.retrievedAt,
      },
      { file: ELEVATION_SNAPSHOT_FILE, url: elevationUrl, retrievedAt: elevationRetrievedAt },
    ];
    await writePrettyJson(path.join(sourceInputsDirectory, RETENTION_MANIFEST_FILE), { sources });
    console.log(`Source Input Retention wrote ${sources.length} snapshots to ${sourceInputsDirectory}.`);
  } catch (error) {
    await observationTask.catch(() => undefined);
    throw error;
  }
}
