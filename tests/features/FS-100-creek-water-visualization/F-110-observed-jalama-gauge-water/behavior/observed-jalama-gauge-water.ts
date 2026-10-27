import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { approvedExternalDisruptionEvidence } from '../../../../support/network/live-release-evidence.ts';
import {
  observeLiveNetwork,
  type LiveNetworkSummary,
} from '../../../../support/network/live-network-telemetry.ts';
import {
  DEFAULT_SCENE_IMAGERY_ID,
  withSceneImagery,
  type SceneImageryId,
} from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';

export const GAUGE_SEGMENT_ID = '27714637-026';
export const OBSERVATION_STEP_MS = 15 * 60 * 1000;
/** Verified against the committed observed series: this slot's reading is the flood peak. */
export const FLOOD_PEAK_UTC = '2026-01-03T15:15:00.000Z';

const SCENE_READY_MS = 75_000;

const publishedDataRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../apps/creek-visualization-browser/public/published-creek-visualization-data',
);

interface PublishedSeriesFile {
  timestampsUtcMs: number[];
  segments: Array<{
    segmentId: string;
    waterSurfaceElevationM: Array<number | null>;
  }>;
}

interface CreekSegmentsFile {
  creekSegments: Array<{
    segmentId: string;
    pathWgs84: Array<[number, number]>;
  }>;
}

interface ObservedWsePropagationFile {
  gaugeSegmentId: string;
  hopsPerDirection: number;
  segments: Array<{ segmentId: string; role: string; hops: number }>;
}

export interface ObservationClock {
  firstUtcMs: number;
  stepMs: number;
  count: number;
}

export interface SeamSnapshot {
  selectedTimeUtcMs: number | null;
  waterSegmentIds: string[];
  waterGraphicGeometryIdentity: Array<{
    segmentId: string;
    bucketMinElevationM: number | null;
    /** True for water inferred by Creek Segment Observed WSE Propagation; false for measured water. */
    inferred: boolean;
    /** Symbol layer types on the drawn water graphic, e.g. ["water"]. Empty when the graphic is hidden. */
    symbolLayerTypes: string[];
  }>;
  cameraTargetWgs84: [number, number] | null;
}

export interface LiveServiceWatch {
  pageErrors: string[];
  summarize: () => LiveNetworkSummary;
}

interface LoadedSeries {
  times: number[];
  readings: Array<number | null>;
  clock: ObservationClock;
}

let loadedSeries: LoadedSeries | undefined;

function loadSeries(): LoadedSeries {
  if (loadedSeries) return loadedSeries;
  const series = JSON.parse(
    readFileSync(
      path.join(
        publishedDataRoot,
        'creek-segment-time-series/usgs-11120600-observed-wse.json',
      ),
      'utf8',
    ),
  ) as PublishedSeriesFile;
  const segment = series.segments.find((item) => item.segmentId === GAUGE_SEGMENT_ID);
  if (!segment) {
    throw new Error(`Published series has no readings for ${GAUGE_SEGMENT_ID}.`);
  }
  const times = series.timestampsUtcMs;
  const firstUtcMs = times[0];
  const lastUtcMs = times[times.length - 1];
  if (firstUtcMs === undefined || lastUtcMs === undefined) {
    throw new Error('Published series has no timestamps.');
  }
  loadedSeries = {
    times,
    readings: segment.waterSurfaceElevationM,
    clock: {
      firstUtcMs,
      stepMs: OBSERVATION_STEP_MS,
      count: Math.floor((lastUtcMs - firstUtcMs) / OBSERVATION_STEP_MS) + 1,
    },
  };
  return loadedSeries;
}

export function publishedClock(): ObservationClock {
  return loadSeries().clock;
}

export function gridIndexForTime(timeUtcMs: number): number {
  const clock = publishedClock();
  const index = Math.round((timeUtcMs - clock.firstUtcMs) / clock.stepMs);
  const slot = clock.firstUtcMs + index * clock.stepMs;
  if (index < 0 || index >= clock.count || Math.abs(slot - timeUtcMs) > 1) {
    throw new Error(`${new Date(timeUtcMs).toISOString()} is not on the observation grid.`);
  }
  return index;
}

export function timeAtGridIndex(index: number): number {
  const clock = publishedClock();
  return clock.firstUtcMs + index * clock.stepMs;
}

/** Latest non-null reading. The page opens here. */
export function openingObservation(): { timeUtcMs: number; waterSurfaceElevationM: number } {
  const { times, readings } = loadSeries();
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const reading = readings[index];
    const timeUtcMs = times[index];
    if (typeof reading === 'number' && timeUtcMs !== undefined) {
      return { timeUtcMs, waterSurfaceElevationM: reading };
    }
  }
  throw new Error('Published series has no non-null reading.');
}

export function floodPeakObservation(): { timeUtcMs: number; waterSurfaceElevationM: number } {
  const timeUtcMs = Date.parse(FLOOD_PEAK_UTC);
  const reading = readingAt(timeUtcMs);
  if (reading === null) {
    throw new Error(`Published series is missing the ${FLOOD_PEAK_UTC} peak.`);
  }
  return { timeUtcMs, waterSurfaceElevationM: reading };
}

export function readingAt(timeUtcMs: number): number | null {
  const { times, readings } = loadSeries();
  const index = times.indexOf(timeUtcMs);
  if (index < 0) return null;
  const reading = readings[index];
  return typeof reading === 'number' ? reading : null;
}

/**
 * First missing grid slot inside the 135-minute span on 2026-06-09.
 * The span is the time from the last present reading to the next one.
 */
export function gapSlotOn9June2026(): number {
  const { times, clock } = loadSeries();
  const present = new Set(times);
  for (let index = 1; index < clock.count; index += 1) {
    const missing = timeAtGridIndex(index);
    if (present.has(missing) || !present.has(timeAtGridIndex(index - 1))) continue;
    let nextPresentIndex = index;
    while (nextPresentIndex < clock.count && !present.has(timeAtGridIndex(nextPresentIndex))) {
      nextPresentIndex += 1;
    }
    const spanMinutes = (timeAtGridIndex(nextPresentIndex) - timeAtGridIndex(index - 1)) / 60_000;
    const day = new Date(missing).toISOString().slice(0, 10);
    if (spanMinutes === 135 && day === '2026-06-09') return missing;
  }
  throw new Error('Published series has no 135-minute gap on 2026-06-09.');
}

/** First null reading in the committed series. */
export function nullReadingSlot(): number {
  const { times, readings } = loadSeries();
  const index = readings.findIndex((reading) => reading === null);
  const timeUtcMs = index >= 0 ? times[index] : undefined;
  if (timeUtcMs === undefined) throw new Error('Published series has no null reading.');
  return timeUtcMs;
}

/** An observed mid-grid slot with room for playback to advance. */
export function midRecordObservation(): number {
  const { times, readings, clock } = loadSeries();
  const readingByTime = new Map(times.map((time, index) => [time, readings[index]]));
  const middle = Math.floor(clock.count / 2);
  for (let offset = 0; offset < clock.count; offset += 1) {
    for (const index of [middle + offset, middle - offset]) {
      if (index < 10 || index > clock.count - 40) continue;
      const timeUtcMs = timeAtGridIndex(index);
      if (typeof readingByTime.get(timeUtcMs) === 'number') return timeUtcMs;
    }
  }
  throw new Error('Published series has no mid-record observation.');
}

/** Mean of the committed path vertices for the gauge Creek Segment. */
export function gaugeSegmentMidpointWgs84(): [number, number] {
  const file = JSON.parse(
    readFileSync(path.join(publishedDataRoot, 'creek-segments.json'), 'utf8'),
  ) as CreekSegmentsFile;
  const segment = file.creekSegments.find((item) => item.segmentId === GAUGE_SEGMENT_ID);
  if (!segment || segment.pathWgs84.length === 0) {
    throw new Error(`Published creek segments are missing ${GAUGE_SEGMENT_ID}.`);
  }
  let longitude = 0;
  let latitude = 0;
  for (const [vertexLongitude, vertexLatitude] of segment.pathWgs84) {
    longitude += vertexLongitude;
    latitude += vertexLatitude;
  }
  return [longitude / segment.pathWgs84.length, latitude / segment.pathWgs84.length];
}

/**
 * The Creek Segments that may draw inferred water beside the gauge Creek Segment, read from the
 * committed Creek Segment Observed WSE Propagation data: up to `hopsPerDirection` upstream and
 * downstream. A neighbour is dry, so absent from the scene, when the inferred depth is not above zero.
 */
export function inferredNeighbourSegmentIds(): string[] {
  const file = JSON.parse(
    readFileSync(path.join(publishedDataRoot, 'observed-wse-propagation.json'), 'utf8'),
  ) as ObservedWsePropagationFile;
  if (file.gaugeSegmentId !== GAUGE_SEGMENT_ID) {
    throw new Error(`Propagation data is centred on ${file.gaugeSegmentId}, not ${GAUGE_SEGMENT_ID}.`);
  }
  const neighbours = file.segments.filter((item) => item.role !== 'gauge');
  if (neighbours.length === 0 || neighbours.some((item) => item.hops < 1 || item.hops > file.hopsPerDirection)) {
    throw new Error('Propagation data has no neighbours, or a neighbour outside hopsPerDirection.');
  }
  return neighbours.map((item) => item.segmentId);
}

/**
 * The water set is the gauge Creek Segment's measured water plus, at most, the inferred
 * neighbours. Every drawn segment other than the gauge is a propagation neighbour flagged
 * inferred, the gauge's own water is not flagged inferred and has a bucket, and no segment
 * outside the gauge neighbourhood has water.
 */
export function expectGaugeMeasuredWaterAndInferredNeighboursOnly(seam: SeamSnapshot): void {
  const neighbourIds = new Set(inferredNeighbourSegmentIds());
  const drawn = seam.waterGraphicGeometryIdentity.filter((item) => item.bucketMinElevationM !== null);

  const gauge = drawn.find((item) => item.segmentId === GAUGE_SEGMENT_ID);
  expect(gauge, `gauge segment ${GAUGE_SEGMENT_ID} has water`).toBeDefined();
  expect(gauge?.inferred, 'gauge segment water is measured, not inferred').toBe(false);

  const others = drawn.filter((item) => item.segmentId !== GAUGE_SEGMENT_ID);
  expect(
    others.filter((item) => !neighbourIds.has(item.segmentId)).map((item) => item.segmentId),
    'drawn water outside the gauge neighbourhood',
  ).toEqual([]);
  expect(
    others.filter((item) => !item.inferred).map((item) => item.segmentId),
    'neighbour water not flagged inferred',
  ).toEqual([]);

  expect(new Set(drawn.map((item) => item.segmentId)).size, 'one water graphic per segment').toBe(drawn.length);
  expect(
    [...seam.waterSegmentIds].sort(),
    'segments listed as having water match the drawn graphics',
  ).toEqual(drawn.map((item) => item.segmentId).sort());
}

export function distanceMeters(
  from: readonly [number, number],
  to: readonly [number, number],
): number {
  const earthRadiusM = 6_378_137;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(to[1] - from[1]);
  const longitudeDelta = toRadians(to[0] - from[0]);
  const fromLatitude = toRadians(from[1]);
  const toLatitude = toRadians(to[1]);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function watchLiveServices(page: Page): LiveServiceWatch {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  return { pageErrors, summarize: observeLiveNetwork(page) };
}

/**
 * Opens the observed-water page. `imagery` picks the scene imagery dataset; a test
 * whose promise is not about imagery passes the fast one and names it in its methodology.
 * `pagePath` adds query parameters (for example `/?modeledExtent=jalama-gauge-reach`) that a
 * later Dataset switch carries along.
 */
export async function openObservedWaterPage(
  page: Page,
  watch: LiveServiceWatch,
  imagery: SceneImageryId = DEFAULT_SCENE_IMAGERY_ID,
  pagePath = '/',
): Promise<void> {
  await page.goto(withSceneImagery(pagePath, imagery), { waitUntil: 'commit', timeout: 30_000 });
  const outcome = await page.evaluate(async (readyBudgetMs: number) => {
    const started = performance.now();
    while (performance.now() - started < readyBudgetMs) {
      const seam = window.__TNC_TEST__;
      if (!seam) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        continue;
      }
      const ready = await seam.ready;
      return ready ? 'ready' : 'failed';
    }
    return 'timeout';
  }, SCENE_READY_MS);

  if (outcome === 'ready') {
    const note = (await page.locator('#scene-note').textContent())?.trim() ?? '';
    if (/unavailable/i.test(note)) {
      throw new Error(`INCONCLUSIVE: ${note}`);
    }
    return;
  }

  const banner = (await page.locator('#experience-error').textContent())?.trim() ?? '';
  const evidence = approvedExternalDisruptionEvidence({
    message: `${outcome} ${banner}`,
    pageErrors: watch.pageErrors,
    network: watch.summarize(),
  });
  if (evidence || /arcgisonline\.com|elevation3d\.arcgis\.com|ibasemaps/i.test(`${banner}\n${watch.pageErrors.join('\n')}`)) {
    throw new Error(
      `INCONCLUSIVE: Esri World Imagery or Esri World Elevation did not become available. ${evidence ?? (banner || outcome)}`,
    );
  }
  throw new Error(banner || `Timeout waiting for the observed-water scene (${outcome}).`);
}

export function rethrowIfExternalOutage(watch: LiveServiceWatch, error: unknown): never {
  if (error instanceof Error && error.message.startsWith('INCONCLUSIVE:')) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const evidence = approvedExternalDisruptionEvidence({
    message,
    pageErrors: watch.pageErrors,
    network: watch.summarize(),
  });
  const blockedByOutage =
    evidence !== null &&
    /timeout|timed out|exceeded|net::|ERR_|NS_ERROR|did not become available|did not start/i.test(
      message,
    );
  if (blockedByOutage) throw new Error(`INCONCLUSIVE: ${evidence}`);
  throw error;
}

export async function readSeam(page: Page): Promise<SeamSnapshot> {
  return page.evaluate(() => {
    const seam = window.__TNC_TEST__;
    if (!seam) throw new Error('The test seam is missing.');
    const target = seam.cameraTargetWgs84;
    return {
      selectedTimeUtcMs: seam.selectedTimeUtcMs,
      waterSegmentIds: [...seam.waterSegmentIds],
      waterGraphicGeometryIdentity: seam.waterGraphicGeometryIdentity.map((item) => ({
        segmentId: item.segmentId,
        bucketMinElevationM: item.bucketMinElevationM,
        inferred: item.inferred === true,
        symbolLayerTypes: [...(item.symbolLayerTypes ?? [])],
      })),
      cameraTargetWgs84: target ? [target[0], target[1]] : null,
    };
  });
}

/** Sets the real range input and dispatches input and change, the same events a user scrub fires. */
export async function scrubToTime(page: Page, timeUtcMs: number): Promise<void> {
  const index = gridIndexForTime(timeUtcMs);
  await page.locator('#timeline-slider').evaluate((element, nextIndex) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('The observation time slider is missing.');
    }
    element.value = String(nextIndex);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
  await expect.poll(async () => (await readSeam(page)).selectedTimeUtcMs).toBe(timeUtcMs);
}

