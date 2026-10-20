import { test } from '../../../../support/browser/response-cache/index.ts';
import { openObservedWaterPage, watchLiveServices } from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import {
  FAR_CAMERA,
  FAR_ZOOM_ALTITUDE_M,
  formatAltitude,
  moveCameraAndSettle,
  readCameraPose,
  settleScene,
} from './scene-camera.ts';
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
 * data are real. Preserve Aerial Imagery Overlay, Esri World Imagery, and Esri
 * World Elevation responses are real and are reused from a local disk cache; a
 * response missing from the cache is fetched live and saved. When a live fetch fails with DNS, TLS, HTTP 429, or
 * HTTP 5xx and no frame failed, or no terrain tiles arrive, the result is
 * inconclusive rather than passed. Nothing else is mocked. After the opening
 * frame, the test-mode camera command moves the camera instantly to a fixed
 * far pose about 340 km up, then back to the opening camera, waiting each time
 * until the scene has finished loading. At the opening frame, the far frame,
 * and the return frame it screenshots a 640×480 clip of the scene, masks the
 * sidebar using its DOM bounding box, samples every fourth pixel, and fails
 * when the share of those pixels whose RGB exactly equals the single most
 * common RGB exceeds 10%. It also fails when the far camera altitude is not
 * above 100,000 m. A measured flat-color failure stays a failure even when Esri
 * also reported an outage. It does not check mouse-wheel input, intermediate
 * zoom levels, imagery sharpness, tile vintage differences, terrain accuracy,
 * or water appearance.
 *
 * Imagery dataset used in the visualization: Jack and Laura Dangermond Preserve Aerial Imagery - 2024 (8 cm, January 2024, via Vandenberg), over Esri World Imagery outside the Preserve.
 */

/**
 * Regression RCA (root cause analysis)
 * Symptom: zooming far out clears the scene to an all-white frame, and zooming back in does not reliably recover it.
 * Root cause: the old local SceneView constraints.clipDistance.far of 80000 cleared the frame once view rays exceeded the 80 km far clip.
 * Red evidence: baseline commit cac781c; the optimized crop measured 92% flat white.
 * Fix: a global SceneView with no 80 km far clip.
 * Future triage: compare camera altitude with the view clipping constraints before investigating an imagery outage.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test('Zoom far out from the Jalama Creek Segment and back in without the scene clearing to a flat white frame.', async ({
  page,
}, testInfo) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const evidenceDir = process.env.FBT008_EVIDENCE_DIR;
  const samples: string[] = [];
  const failures: string[] = [];

  try {
    await openObservedWaterPage(page, watch);
    await settleScene(page, 'opening');
    const openingCamera = await readCameraPose(page);
    const sidebar = await sidebarMask(page);
    const cdp = await page.context().newCDPSession(page);

    await sampleFlatFrame(page, cdp, testInfo, 'opening', samples, failures, evidenceDir, sidebar);
    await moveCameraAndSettle(page, FAR_CAMERA, 'far');
    const farAltitudeM = await sampleFlatFrame(page, cdp, testInfo, 'far', samples, failures, evidenceDir, sidebar);
    if (farAltitudeM === null || farAltitudeM <= FAR_ZOOM_ALTITUDE_M) {
      failures.push(`The far camera stopped at ${formatAltitude(farAltitudeM)}, which is not beyond 100 km.`);
    }
    await moveCameraAndSettle(page, openingCamera, 'return');
    await sampleFlatFrame(page, cdp, testInfo, 'return', samples, failures, evidenceDir, sidebar);

    await cdp.detach();
    console.log(samples.join('\n'));
    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
