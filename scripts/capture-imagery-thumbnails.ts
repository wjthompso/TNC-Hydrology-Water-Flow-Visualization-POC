// Regenerates the imagery chooser thumbnails (UCS-262): one overhead frame of the
// same creek bend per imagery choice, so the three squares compare like for like.
//
// Serve the app in test mode first (it adds the camera command to the page):
//   VITE_TEST_MODE=true npm run dev -w creek-visualization-browser -- --port 5176 --strictPort
// Then run:
//   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/capture-imagery-thumbnails.ts
//
// Frames are written at 2x the 64-pixel chooser square so they stay sharp on high-density screens.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { SCENE_IMAGERY_OPTIONS, withSceneImagery } from '../apps/creek-visualization-browser/src/scene-imagery-options.ts';

const BASE_URL = process.env.THUMBNAIL_BASE_URL ?? 'http://127.0.0.1:5176';
const OUTPUT_DIR = 'apps/creek-visualization-browser/public/imagery-thumbnails';
const CAPTURE_SQUARE_PX = 512;
const THUMBNAIL_PX = 128;
const SETTLE_QUIET_MS = 500;
const SETTLE_BUDGET_MS = 60_000;

/** Straight down on dry ground just off the creek, so no water covers the imagery, and close enough for the 8 cm Preserve imagery to show detail. */
const THUMBNAIL_CAMERA = {
  positionWgs84: [-120.4738, 34.5126, 250],
  headingDegrees: 0,
  tiltDegrees: 0,
} as const;

mkdirSync(OUTPUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
try {
  for (const option of SCENE_IMAGERY_OPTIONS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${BASE_URL}${withSceneImagery('/', option.id)}`);
    await page.evaluate(() => window.__TNC_TEST__?.ready);
    await page.evaluate(async (pose) => window.__TNC_TEST__?.moveCamera?.(pose), THUMBNAIL_CAMERA);
    await page.evaluate(
      async ({ quietMs, budgetMs }) => {
        const deadline = performance.now() + budgetMs;
        let quietSince = 0;
        while (performance.now() < deadline) {
          const seam = window.__TNC_TEST__;
          const finished = seam?.sceneUpdating === false && seam.sceneStationary === true;
          if (!finished) quietSince = 0;
          else if (quietSince === 0) quietSince = performance.now();
          else if (performance.now() - quietSince >= quietMs) return;
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        throw new Error('The scene did not finish drawing.');
      },
      { quietMs: SETTLE_QUIET_MS, budgetMs: SETTLE_BUDGET_MS },
    );
    const viewport = page.viewportSize()!;
    const fullSize = `${OUTPUT_DIR}/${option.id}.full.jpg`;
    const output = `${OUTPUT_DIR}/${option.id}.jpg`;
    await page.screenshot({
      path: fullSize,
      type: 'jpeg',
      quality: 90,
      clip: {
        // Clear of the sidebar (left), the map buttons (top right), and the legend (bottom).
        x: viewport.width - CAPTURE_SQUARE_PX - 90,
        y: 90,
        width: CAPTURE_SQUARE_PX,
        height: CAPTURE_SQUARE_PX,
      },
    });
    // macOS image tool; keeps this script free of an image-processing dependency.
    execFileSync('sips', ['-z', String(THUMBNAIL_PX), String(THUMBNAIL_PX), fullSize, '--out', output], { stdio: 'ignore' });
    rmSync(fullSize);
    console.log(`Wrote ${output}`);
    await page.close();
  }
} finally {
  await browser.close();
}
