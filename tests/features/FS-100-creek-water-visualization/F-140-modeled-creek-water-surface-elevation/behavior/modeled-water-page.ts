/**
 * Playwright helpers for the modeled-water page (`?dataset=...`). Opening,
 * waiting for the modeled seam to go idle, a fixed top-down camera, and
 * hit-testing creek-bed points for water-surface graphics.
 */

import type { Page } from '../../../../support/browser/esri-response-cache.ts';
import type { TestCameraPose } from '../../../../support/browser/test-mode-api';
import { approvedExternalDisruptionEvidence } from '../../../../support/network/live-release-evidence.ts';
import type { LiveServiceWatch } from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import type { LonLat } from './local-pipeline-output.ts';

const SCENE_READY_MS = 75_000;
/** Camera height above the creek bed for the straight-down junction frames. */
const TOP_DOWN_HEIGHT_ABOVE_GROUND_M = 130;

export function modeledWaterPageUrl(input: { datasetId: string; extentId: string; timeUtc: string }): string {
  const params = new URLSearchParams({
    dataset: input.datasetId,
    modeledExtent: input.extentId,
    time: input.timeUtc,
  });
  return `/?${params.toString()}`;
}

/**
 * Opens the modeled-water page and waits until the test seam reports ready and
 * the modeled seam has finished its first loads. Mirrors the observed page's
 * readiness handling: an Esri outage is inconclusive, anything else is a failure.
 */
export async function openModeledWaterPage(page: Page, watch: LiveServiceWatch, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
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
    if (/unavailable/i.test(note)) throw new Error(`INCONCLUSIVE: ${note}`);
    await waitForModeledWaterIdle(page);
    return;
  }

  const banner = (await page.locator('#experience-error').textContent())?.trim() ?? '';
  const evidence = approvedExternalDisruptionEvidence({
    message: `${outcome} ${banner}`,
    pageErrors: watch.pageErrors,
    network: watch.summarize(),
  });
  if (
    evidence ||
    /arcgisonline\.com|elevation3d\.arcgis\.com|ibasemaps/i.test(`${banner}\n${watch.pageErrors.join('\n')}`)
  ) {
    throw new Error(
      `INCONCLUSIVE: Esri World Imagery or Esri World Elevation did not become available. ${evidence ?? (banner || outcome)}`,
    );
  }
  throw new Error(banner || `Timeout waiting for the modeled-water scene (${outcome}).`);
}

/** Waits until every pending modeled-water fetch landed and the renderer drew the result. */
export async function waitForModeledWaterIdle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const modeled = window.__TNC_MODELED__;
    if (!modeled) throw new Error('The modeled-water seam is missing. Open the page with ?dataset=<modeled dataset>.');
    await modeled.whenIdle();
  });
}

export async function readModeledSelectedTimeUtcMs(page: Page): Promise<number | null> {
  return page.evaluate(() => window.__TNC_MODELED__?.selectedTimeUtcMs ?? null);
}

/** The pipeline's modeled water-surface elevation the page holds for one Creek Segment, m. */
export async function readModeledElevationM(page: Page, segmentId: string): Promise<number | null> {
  return page.evaluate((id) => window.__TNC_MODELED__?.readSegment(id)?.elevationM ?? null, segmentId);
}

/** Straight down over a point, high enough that about 130 m of creek fits the frame. */
export function topDownCameraPose(target: LonLat, groundElevationM: number): TestCameraPose {
  return {
    positionWgs84: [target.longitude, target.latitude, groundElevationM + TOP_DOWN_HEIGHT_ABOVE_GROUND_M],
    headingDegrees: 0,
    tiltDegrees: 0,
  };
}

export interface WaterSurfaceHit {
  readonly segmentId: string | null;
  readonly bucketMinElevationM: number | null;
  /** Height of the drawn water surface where the screen ray met it, m; null when ArcGIS gave none. */
  readonly surfaceElevationM: number | null;
  readonly distanceM: number | null;
}

export interface WaterHitSample {
  readonly longitude: number;
  readonly latitude: number;
  /** Null when the point projected outside the viewport. */
  readonly screen: { readonly x: number; readonly y: number } | null;
  /** Every water-surface graphic the screen ray met, nearest first. */
  readonly waterHits: readonly WaterSurfaceHit[];
  /**
   * Height of the drawn surface under that pixel from SceneView `toMap`, m:
   * the terrain, or the water where water covers it. Null when the ray missed.
   */
  readonly drawnSurfaceElevationM: number | null;
  /** The other hits (not water), for the failure message. */
  readonly otherHitLayers: readonly string[];
}

/**
 * Projects each WGS84 point to a screen pixel through the test seam and runs
 * SceneView.hitTest there. Water-surface hits are returned nearest first, so
 * the first one is the surface a viewer would see at that pixel.
 */
export async function hitTestWaterAtPoints(
  page: Page,
  points: readonly { readonly longitude: number; readonly latitude: number; readonly z: number }[],
): Promise<WaterHitSample[]> {
  return page.evaluate(async (targets) => {
    const seam = window.__TNC_TEST__;
    if (!seam) throw new Error('The test seam is missing.');
    const samples: WaterHitSample[] = [];
    for (const target of targets) {
      const screen = seam.projectMapPointToScreen(target);
      if (!screen) {
        samples.push({
          longitude: target.longitude,
          latitude: target.latitude,
          screen: null,
          waterHits: [],
          drawnSurfaceElevationM: null,
          otherHitLayers: [],
        });
        continue;
      }
      const capture = await seam.hitTestAtScreen(screen);
      const ground = seam.sampleRenderedGroundHeights([screen])[0];
      const waterHits = capture.hits
        .filter((hit) => hit.graphicType === 'water-surface')
        .map((hit) => ({
          segmentId: hit.segmentId,
          bucketMinElevationM: hit.bucketMinElevationM,
          surfaceElevationM: hit.mapPointWgs84?.z ?? null,
          distanceM: hit.distanceM,
        }))
        .sort((a, b) => (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY));
      samples.push({
        longitude: target.longitude,
        latitude: target.latitude,
        screen,
        waterHits,
        drawnSurfaceElevationM: ground?.elevationM ?? null,
        otherHitLayers: capture.hits
          .filter((hit) => hit.graphicType !== 'water-surface')
          .map((hit) => hit.layerId ?? 'unknown'),
      });
    }
    return samples;
  }, points);
}

/** The water surface a viewer sees at the sample: the nearest water hit, or null when there is none. */
export function visibleWaterSurface(sample: WaterHitSample): WaterSurfaceHit | null {
  return sample.waterHits[0] ?? null;
}

export function formatLonLat(point: LonLat): string {
  return `(${point.longitude.toFixed(7)}, ${point.latitude.toFixed(7)})`;
}

/**
 * One click the developer captured with the dev tools where water was
 * expected. The ground point SceneView reported under the cursor is projected
 * back to a pixel at run time, so the replay does not depend on viewport size.
 */
export interface DeveloperCreekBedClick {
  readonly nearestSegmentId: string;
  readonly cameraPose: TestCameraPose;
  readonly groundWgs84: { readonly longitude: number; readonly latitude: number; readonly z: number };
}

/**
 * Moves to each distinct camera pose in order, waits for a finished frame,
 * and hit-tests that pose's clicks. Returns one failure message per click
 * with no water-surface hit.
 */
export async function replayDeveloperClicks(
  page: Page,
  clicks: readonly DeveloperCreekBedClick[],
  timeLabel: string,
  settle: (pose: TestCameraPose, label: string) => Promise<void>,
): Promise<string[]> {
  const failures: string[] = [];
  const poses = [...new Set(clicks.map((click) => click.cameraPose))];
  for (const [poseIndex, cameraPose] of poses.entries()) {
    await settle(cameraPose, `developer-camera-${poseIndex + 1}`);
    const poseClicks = clicks.filter((click) => click.cameraPose === cameraPose);
    const hits = await hitTestWaterAtPoints(
      page,
      poseClicks.map((click) => click.groundWgs84),
    );
    for (const [index, hit] of hits.entries()) {
      const click = poseClicks[index] as DeveloperCreekBedClick;
      if (hit.screen === null) {
        throw new Error(`Developer click ${formatLonLat(click.groundWgs84)} projected off-screen.`);
      }
      if (visibleWaterSurface(hit)) continue;
      const elevationM = await readModeledElevationM(page, click.nearestSegmentId);
      failures.push(
        `No water-surface hit at creek-bed click ${formatLonLat(click.groundWgs84)} near Creek Segment ` +
          `${click.nearestSegmentId} at ${timeLabel}: ground clicked ${click.groundWgs84.z.toFixed(2)} m, ` +
          `drawn surface ${hit.drawnSurfaceElevationM?.toFixed(2) ?? 'none'} m, modeled water-surface elevation ` +
          `${elevationM?.toFixed(2) ?? 'none'} m, other hits [${hit.otherHitLayers.join(', ')}].`,
      );
    }
  }
  return failures;
}
