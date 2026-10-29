/**
 * Playwright helpers for the Selected Creek Segment (F-150) and the
 * Water-Surface Elevation Chart (F-160): find a pixel of one Creek Segment's
 * drawn water, click it with the real mouse, and read the selection and chart
 * state from the page's read-only test seam.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '../../../../support/browser/response-cache/index.ts';
import type { TestCameraPose } from '../../../../support/browser/test-mode-api';
import { localPipelineOutputDirectory } from '../../F-140-modeled-creek-water-surface-elevation/behavior/local-pipeline-output.ts';

type LonLatRing = readonly (readonly [number, number])[];

interface PolygonBucket {
  minWaterSurfaceElevationM: number;
  maxWaterSurfaceElevationM: number;
  ringsWgs84: LonLatRing[];
}

interface PolygonSetFile {
  waterSurfacePolygonSets: { segmentId: string; elevationBuckets: PolygonBucket[] }[];
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const publishedPolygonSetsFile = path.join(
  repositoryRoot,
  'apps/creek-visualization-browser/public/published-creek-visualization-data/water-surface-polygon-sets.json',
);
/** The WSE Polygon Generation Method version a modeled source reads unless it names another; its buckets are water-surface elevations. */
const MODELED_POLYGON_SETS_RELATIVE_PATH =
  '04-water-surface-polygons/junction-sloped-terrain-fill/v1/water-surface-polygon-sets';

const polygonSetCache = new Map<string, PolygonSetFile>();

function readPolygonSets(file: string): PolygonSetFile {
  let parsed = polygonSetCache.get(file);
  if (!parsed) {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as PolygonSetFile;
    polygonSetCache.set(file, parsed);
  }
  return parsed;
}

/**
 * Where a Creek Segment's prepared water-surface polygons come from.
 *
 * A modeled source reads the junction-sloped terrain fill, whose buckets are water-surface elevations,
 * unless `polygonSetsRelativePath` names another saved version under the extent's pipeline output
 * (`04-water-surface-polygons/<method-id>/v<version>/water-surface-polygon-sets`). The
 * `flowline-channel-ribbon` buckets are water depths above the bed and their rings carry the bed as z,
 * so pass a depth to `bucketFor` and do not use that bucket with `topDownPoseOverBucket`,
 * `findSegmentWaterPixel`, or `clickSegmentWater`; use `clickSegmentWaterAtGroundPoint`.
 */
export type PolygonSource =
  | { readonly kind: 'observed' }
  | { readonly kind: 'modeled'; readonly extentId: string; readonly polygonSetsRelativePath?: string };

function polygonSetFile(source: PolygonSource, segmentId: string): string {
  if (source.kind === 'observed') return publishedPolygonSetsFile;
  const comid = segmentId.split('-')[0];
  return path.join(
    localPipelineOutputDirectory(source.extentId),
    source.polygonSetsRelativePath ?? MODELED_POLYGON_SETS_RELATIVE_PATH,
    `${comid}.json`,
  );
}

/**
 * The prepared bucket holding a value (half-open, like the browser): a water-surface elevation, or for a
 * depth-bucket source such as the channel ribbon, a water depth above the bed.
 */
export function bucketFor(source: PolygonSource, segmentId: string, elevationM: number): PolygonBucket {
  const set = readPolygonSets(polygonSetFile(source, segmentId)).waterSurfacePolygonSets.find(
    (entry) => entry.segmentId === segmentId,
  );
  if (!set) throw new Error(`No prepared water-surface polygons for Creek Segment ${segmentId}.`);
  const bucket = set.elevationBuckets.find(
    (entry) => elevationM >= entry.minWaterSurfaceElevationM && elevationM < entry.maxWaterSurfaceElevationM,
  );
  if (!bucket) throw new Error(`No prepared bucket holds ${elevationM} m on Creek Segment ${segmentId}.`);
  return bucket;
}

/** Camera height above the water surface for the straight-down selection frames. */
const TOP_DOWN_HEIGHT_ABOVE_WATER_M = 150;

/**
 * Straight down over the vertex mean of the bucket's largest ring, 150 m above
 * the water. The water then sits at the center of the view, clear of the sidebar.
 */
export function topDownPoseOverBucket(bucket: PolygonBucket): TestCameraPose {
  const ring = [...bucket.ringsWgs84].sort((a, b) => b.length - a.length)[0];
  if (!ring || ring.length < 3) throw new Error('The bucket has no water polygon to frame.');
  const longitude = ring.reduce((sum, [lon]) => sum + lon, 0) / ring.length;
  const latitude = ring.reduce((sum, [, lat]) => sum + lat, 0) / ring.length;
  return {
    positionWgs84: [longitude, latitude, bucket.minWaterSurfaceElevationM + TOP_DOWN_HEIGHT_ABOVE_WATER_M],
    headingDegrees: 0,
    tiltDegrees: 0,
  };
}

/**
 * Ground points inside the drawn polygon's rings: each ring's vertex mean,
 * and points 30%, 55%, and 80% of the way from that mean to every vertex.
 */
function candidatePoints(bucket: PolygonBucket): { longitude: number; latitude: number; z: number }[] {
  const points: { longitude: number; latitude: number; z: number }[] = [];
  const z = bucket.minWaterSurfaceElevationM;
  for (const ring of bucket.ringsWgs84) {
    if (ring.length < 3) continue;
    const meanLongitude = ring.reduce((sum, [lon]) => sum + lon, 0) / ring.length;
    const meanLatitude = ring.reduce((sum, [, lat]) => sum + lat, 0) / ring.length;
    points.push({ longitude: meanLongitude, latitude: meanLatitude, z });
    for (const fraction of [0.3, 0.55, 0.8]) {
      for (const [lon, lat] of ring) {
        points.push({
          longitude: meanLongitude + (lon - meanLongitude) * fraction,
          latitude: meanLatitude + (lat - meanLatitude) * fraction,
          z,
        });
      }
    }
  }
  return points;
}

interface GroundPoint {
  longitude: number;
  latitude: number;
  z: number;
}

/**
 * The first ground point whose screen pixel hits this Creek Segment's drawn water and is clear of the
 * sidebar: SceneView.hitTest there reports that segment's water as the nearest water hit. A click under
 * the sidebar reaches the panel and not the scene, so those pixels are skipped.
 */
async function findWaterPixelAmong(
  page: Page,
  segmentId: string,
  candidates: readonly GroundPoint[],
): Promise<{ x: number; y: number }> {
  const sidebar = await page.locator('aside:not(#dev-tools-hud)').boundingBox();
  const pixel = await page.evaluate(
    async ({ segmentId, candidates, blocked }) => {
      const seam = window.__TNC_TEST__;
      if (!seam) throw new Error('The test seam is missing.');
      const tried = new Set<string>();
      for (const candidate of candidates) {
        const screen = seam.projectMapPointToScreen(candidate);
        if (!screen) continue;
        const key = `${Math.round(screen.x)},${Math.round(screen.y)}`;
        if (tried.has(key)) continue;
        tried.add(key);
        if (
          blocked &&
          screen.x >= blocked.x - 8 &&
          screen.x <= blocked.x + blocked.width + 8 &&
          screen.y >= blocked.y - 8 &&
          screen.y <= blocked.y + blocked.height + 8
        ) {
          continue;
        }
        const capture = await seam.hitTestAtScreen(screen);
        const nearestWater = capture.hits
          .filter((hit) => hit.graphicType === 'water-surface')
          .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity))[0];
        if (nearestWater?.segmentId === segmentId) return { x: Math.round(screen.x), y: Math.round(screen.y) };
        if (tried.size >= 160) break;
      }
      return null;
    },
    { segmentId, candidates, blocked: sidebar },
  );
  if (!pixel) {
    throw new Error(`No visible pixel of Creek Segment ${segmentId}'s drawn water is clear of the sidebar.`);
  }
  return pixel;
}

/**
 * A viewport pixel where a click lands on this Creek Segment's drawn water, searched among points inside
 * the elevation bucket's rings. Not for depth buckets (the channel ribbon): their ring z is the bed.
 */
export async function findSegmentWaterPixel(
  page: Page,
  input: { segmentId: string; bucket: PolygonBucket },
): Promise<{ x: number; y: number }> {
  return findWaterPixelAmong(page, input.segmentId, candidatePoints(input.bucket));
}

/** Clicks a pixel with the real mouse and waits until the page selects the Creek Segment. */
async function clickPixelSelecting(page: Page, segmentId: string, pixel: { x: number; y: number }): Promise<void> {
  await page.mouse.click(pixel.x, pixel.y);
  await expect
    .poll(() => readSelection(page).then((state) => state.selectedCreekSegmentId), {
      message: `clicking Creek Segment ${segmentId}'s water at (${pixel.x}, ${pixel.y}) selects it`,
    })
    .toBe(segmentId);
}

/** Clicks the segment's drawn water with the real mouse and waits until the page selects it. */
export async function clickSegmentWater(
  page: Page,
  input: { segmentId: string; bucket: PolygonBucket },
): Promise<{ x: number; y: number }> {
  const pixel = await findSegmentWaterPixel(page, input);
  await clickPixelSelecting(page, input.segmentId, pixel);
  return pixel;
}

/**
 * Clicks the segment's drawn water at a fixed ground point (a developer-captured click on the water
 * surface) with the real mouse and waits until the page selects the segment. The point is projected to
 * a pixel at run time, so the click follows the viewport. The caller moves to the camera pose the point
 * was captured from first. Works for any polygon source, including depth buckets.
 */
export async function clickSegmentWaterAtGroundPoint(
  page: Page,
  input: { segmentId: string; groundWgs84: GroundPoint },
): Promise<{ x: number; y: number }> {
  const pixel = await findWaterPixelAmong(page, input.segmentId, [input.groundWgs84]);
  await clickPixelSelecting(page, input.segmentId, pixel);
  return pixel;
}

export interface SelectionSnapshot {
  selectedCreekSegmentId: string | null;
  highlightedSegmentIds: string[];
  chartSegmentId: string | null;
  chartPointCount: number;
  chartCursorTimeUtcMs: number | null;
  chartHoverTimeUtcMs: number | null;
  chartConditionBandsStageLabel: string | null;
}

export async function readSelection(page: Page): Promise<SelectionSnapshot> {
  return page.evaluate(() => {
    const seam = window.__TNC_TEST__;
    if (!seam) throw new Error('The test seam is missing.');
    const chart = seam.waterSurfaceElevationChart;
    return {
      selectedCreekSegmentId: seam.selectedCreekSegmentId,
      highlightedSegmentIds: [...seam.highlightedSegmentIds],
      chartSegmentId: chart?.segmentId ?? null,
      chartPointCount: chart?.pointCount ?? 0,
      chartCursorTimeUtcMs: chart?.cursorTimeUtcMs ?? null,
      chartHoverTimeUtcMs: chart?.hoverTimeUtcMs ?? null,
      chartConditionBandsStageLabel: chart?.conditionBandsStageLabel ?? null,
    };
  });
}

/** Viewport pixel of the chart line at the reading nearest the time, and that reading. */
export async function chartPointFor(
  page: Page,
  timeUtcMs: number,
): Promise<{ x: number; y: number; reading: { timeUtcMs: number; valueM: number } }> {
  // The chart sits low in the scrolling control panel, so its low readings can lie below the window.
  // Scroll the whole plot into view first. The scroll is instant, so the pixels read next are final.
  await page.locator('#wse-chart-plot').evaluate((plot) => plot.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
  const point = await page.evaluate((time) => {
    const chart = window.__TNC_TEST__?.waterSurfaceElevationChart;
    if (!chart) throw new Error('The Water-Surface Elevation Chart is missing from the test seam.');
    const pixel = chart.clientPointForTime(time);
    const reading = chart.nearestReading(time);
    return pixel && reading ? { x: pixel.x, y: pixel.y, reading } : null;
  }, timeUtcMs);
  if (!point) throw new Error(`The chart cannot place ${new Date(timeUtcMs).toISOString()}.`);
  return point;
}

/** The time slider's slot, its spoken value, and the readout text. */
export async function readTimeSlider(page: Page): Promise<{ value: string; valueText: string; readout: string }> {
  const slider = page.locator('#timeline-slider');
  return {
    value: await slider.inputValue(),
    valueText: (await slider.getAttribute('aria-valuetext')) ?? '',
    readout: ((await page.locator('#timeline-readout').textContent()) ?? '').trim(),
  };
}

/** Same formatter as the page's time readout. */
export function formatPacificTime(timeUtcMs: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(timeUtcMs);
}

/**
 * The depth bucket (m above the bed) the segment's drawn water holds. The seam reports it only for
 * depth-drawn modeled water such as the channel ribbon, and null when the segment is not drawn.
 */
export async function drawnBucketMinDepthM(page: Page, segmentId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const item = window.__TNC_TEST__?.waterGraphicGeometryIdentity.find((entry) => entry.segmentId === id);
    const depthM = (item as { bucketMinDepthM?: number | null } | undefined)?.bucketMinDepthM;
    return depthM ?? null;
  }, segmentId);
}

export function bucketMinOf(
  identity: readonly { segmentId: string; bucketMinElevationM: number | null }[],
  segmentId: string,
): number | null {
  return identity.find((item) => item.segmentId === segmentId)?.bucketMinElevationM ?? null;
}
