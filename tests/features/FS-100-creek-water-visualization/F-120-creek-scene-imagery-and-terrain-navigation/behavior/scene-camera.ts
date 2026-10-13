import type { Page } from '../../../../support/browser/esri-response-cache.ts';
import type { TestCameraPose } from '../../../../support/browser/test-mode-api';

export type { TestCameraPose };

/**
 * Coast-scale camera, about 12 km up, looking back toward the Jalama Creek Segment.
 * This is where three mouse-wheel notches from the opening frame arrive.
 */
export const COAST_CAMERA: TestCameraPose = {
  positionWgs84: [-120.349866, 34.375175, 12_445.6],
  headingDegrees: 321.26,
  tiltDegrees: 57.82,
};

/** The camera where the old custom elevation layer drew 100% missed ground rays. */
export const SLAB_CAMERA: TestCameraPose = {
  positionWgs84: [-120.474, 34.502, 1_245],
  headingDegrees: 321,
  tiltDegrees: 58,
};

/** About 340 km up, well past the old 80 km far clip. */
export const FAR_CAMERA: TestCameraPose = {
  positionWgs84: [-117.296442, 31.075474, 338_423.5],
  headingDegrees: 322.92,
  tiltDegrees: 53.64,
};

/** The old 80 km far clip only cleared frames once the camera was beyond it. */
export const FAR_ZOOM_ALTITUDE_M = 100_000;

/** The scene must stay finished and still for this long before a frame counts. */
const SETTLED_QUIET_MS = 250;
const SETTLE_BUDGET_MS = 15_000;

export async function readCameraPose(page: Page): Promise<TestCameraPose> {
  const pose = await page.evaluate(() => window.__TNC_TEST__?.cameraPose ?? null);
  if (!pose) throw new Error('The test seam has no camera pose.');
  return pose;
}

export async function readCameraAltitudeM(page: Page): Promise<number | null> {
  return page.evaluate(() => window.__TNC_TEST__?.cameraAltitudeM ?? null);
}

export function formatAltitude(altitudeM: number | null): string {
  if (altitudeM === null) return 'unavailable';
  if (altitudeM >= 1000) return `${(altitudeM / 1000).toFixed(1)} km`;
  return `${Math.round(altitudeM)} m`;
}

/**
 * Waits until SceneView has finished loading and drawing, with no camera movement,
 * for 250 ms, then for two more drawn frames. A frame is never sampled after the
 * 15 s budget runs out.
 */
export async function settleScene(page: Page, step: string): Promise<void> {
  const settled = await page.evaluate(
    async ({ quietMs, budgetMs }) => {
      const deadline = performance.now() + budgetMs;
      let quietSince = 0;
      while (performance.now() < deadline) {
        const seam = window.__TNC_TEST__;
        const finished = seam?.sceneUpdating === false && seam.sceneStationary === true;
        if (!finished) {
          quietSince = 0;
        } else if (quietSince === 0) {
          quietSince = performance.now();
        } else if (performance.now() - quietSince >= quietMs) {
          const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          await nextFrame();
          await nextFrame();
          return true;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 16));
      }
      return false;
    },
    { quietMs: SETTLED_QUIET_MS, budgetMs: SETTLE_BUDGET_MS },
  );
  if (!settled) {
    const altitudeM = await readCameraAltitudeM(page).catch(() => null);
    throw new Error(
      `${step}: the scene timed out after ${SETTLE_BUDGET_MS / 1000} s without finishing loading (camera ${formatAltitude(altitudeM)}).`,
    );
  }
}

export async function moveCameraAndSettle(page: Page, pose: TestCameraPose, step: string): Promise<void> {
  await page.evaluate(async (target) => {
    const seam = window.__TNC_TEST__;
    if (!seam?.moveCamera) {
      throw new Error('The camera command is missing. Serve the page with VITE_TEST_MODE=true.');
    }
    await seam.moveCamera(target);
  }, pose);
  await settleScene(page, step);
}
