import { test } from '../../../../support/browser/response-cache/index.ts';
import { openObservedWaterPage, watchLiveServices } from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import { COAST_CAMERA, moveCameraAndSettle, settleScene } from './scene-camera.ts';
import {
  finishSceneCheck,
  rethrowSceneFailure,
  sidebarMask,
  watchTerrainTraffic,
} from './scene-check-outcome.ts';
import { sampleFlatFrame } from './scene-flat-color.ts';

/**
 * Methodology: Opens the locally served page in test mode and waits until the
 * test seam reports ready and SceneView has finished loading with a still
 * camera. The browser page, ArcGIS SceneView, and committed published creek
 * data are real. Esri World Imagery and Esri World Elevation responses are real
 * and are reused from a local disk cache; a response missing from the cache is
 * fetched live and saved. When a live fetch fails with DNS, TLS, HTTP 429, or
 * HTTP 5xx and no frame failed, or no terrain tiles arrive, the result is
 * inconclusive rather than passed. Nothing else is mocked. After the opening
 * frame, the test-mode camera command moves the camera instantly to a fixed
 * coast-scale pose about 12 km up, the pose three mouse-wheel notches reach,
 * and waits again until the scene has finished loading. At the opening frame
 * and the coast frame it screenshots a 640×480 clip of the scene, masks the
 * sidebar using its DOM bounding box, samples every fourth pixel, and fails
 * when the share of those pixels whose RGB exactly equals the single most
 * common RGB exceeds 10%. A measured flat-color failure stays a failure even
 * when Esri also reported an outage. The failure names the step, camera
 * height, flat color, and share, and attaches the screenshot. It does not
 * check mouse-wheel input, intermediate zoom levels, a white far-zoom frame,
 * imagery sharpness, tile vintage differences, terrain accuracy, or water
 * appearance.
 */

/**
 * Regression RCA (root cause analysis)
 * Symptom: zooming out from the Jalama Creek Segment exposes an empty flat-color coastal void.
 * Root cause: old USGSImageryOnly transparent coastal tiles let the navy ground color show through.
 * Red evidence: commit cac781c measured 34% flat navy in the optimized crop; fixed coast frames stay at or below 4.4%.
 * Fix: Esri World Imagery replaces those transparent coastal tiles.
 * Future triage: if a coast frame is flat navy, inspect imagery tile transparency and ground show-through before treating the frame as an imagery outage.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test('Zoom out from the Jalama Creek Segment without exposing an empty flat-color coastal void.', async ({
  page,
}, testInfo) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const evidenceDir = process.env.FBT006_EVIDENCE_DIR;
  const samples: string[] = [];
  const failures: string[] = [];

  try {
    await openObservedWaterPage(page, watch);
    await settleScene(page, 'opening');
    const sidebar = await sidebarMask(page);
    const cdp = await page.context().newCDPSession(page);

    await sampleFlatFrame(page, cdp, testInfo, 'opening', samples, failures, evidenceDir, sidebar);
    await moveCameraAndSettle(page, COAST_CAMERA, 'coast');
    await sampleFlatFrame(page, cdp, testInfo, 'coast', samples, failures, evidenceDir, sidebar);

    await cdp.detach();
    console.log(samples.join('\n'));
    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
