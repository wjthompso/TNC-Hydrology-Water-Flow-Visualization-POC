import { test } from '@playwright/test';
import { openObservedWaterPage, watchLiveServices } from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import {
  FAR_ZOOM_ALTITUDE_M,
  FAR_ZOOM_WHEEL_BURSTS,
  WHEEL_DELTA_Y,
  finishFlatColorCheck,
  formatAltitude,
  moveToWheelPoint,
  readCameraAltitudeM,
  rethrowSceneFailure,
  sampleFlatFrame,
  settleAfterZoom,
  settleOpening,
  sidebarMask,
  watchTerrainTraffic,
  wheelBurst,
} from './scene-flat-color.ts';

/**
 * Methodology: Opens the locally served page and waits until the read-only
 * test seam reports ready, then until SceneView stops updating and live tile
 * requests stay quiet. The browser page, ArcGIS SceneView, and committed
 * published creek data are real. Esri World Imagery and Esri World Elevation
 * tiles are live external services; if those requests fail with DNS, TLS,
 * HTTP 429, or HTTP 5xx, or no initial terrain tiles arrive, the result is
 * inconclusive rather than passed. Nothing is mocked or saved. From a settled
 * opening frame the test sends real mouse-wheel events at a fixed point on the
 * scene canvas outside the sidebar, in the far grouped notches of three events
 * then two events (deltaY 420), which reaches a camera altitude above 100 km.
 * It then reverses those same wheel events to zoom back in. At the opening
 * frame, the far frame, and the return frame it screenshots a 640×480 clip of
 * the scene, masks the sidebar using its DOM bounding box, samples every
 * fourth pixel, and fails when the share of those pixels whose RGB exactly
 * equals the single most common RGB exceeds 10%. It also fails when the far
 * camera altitude is not above 100,000 m. The final return frame must pass the
 * same flat-color check. It does not check that the camera target returns to
 * the Creek Segment midpoint, imagery sharpness, tile vintage differences,
 * terrain accuracy, or water appearance.
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
  const samples: string[] = [];
  const failures: string[] = [];

  try {
    await openObservedWaterPage(page, watch);
    await settleOpening(page, terrain);
    const sidebar = await sidebarMask(page);
    await moveToWheelPoint(page);
    const cdp = await page.context().newCDPSession(page);
    const evidenceDir = process.env.FBT008_EVIDENCE_DIR;

    let altitudeM = await sampleFlatFrame(
      page,
      cdp,
      testInfo,
      'opening',
      samples,
      failures,
      evidenceDir,
      sidebar,
    );

    for (const [index, wheelCount] of FAR_ZOOM_WHEEL_BURSTS.entries()) {
      await wheelBurst(page, wheelCount, WHEEL_DELTA_Y, sidebar);
      await settleAfterZoom(page, terrain, altitudeM);
      const isFarFrame = index === FAR_ZOOM_WHEEL_BURSTS.length - 1;
      altitudeM = isFarFrame
        ? await sampleFlatFrame(page, cdp, testInfo, 'far', samples, failures, evidenceDir, sidebar)
        : await readCameraAltitudeM(page);
    }

    if (altitudeM === null || altitudeM <= FAR_ZOOM_ALTITUDE_M) {
      throw new Error(
        `Zoom-out stopped at camera height ${formatAltitude(altitudeM)}, which is not beyond 100 km.`,
      );
    }

    for (const [index, wheelCount] of [...FAR_ZOOM_WHEEL_BURSTS].reverse().entries()) {
      await wheelBurst(page, wheelCount, -WHEEL_DELTA_Y, sidebar);
      await settleAfterZoom(page, terrain, altitudeM);
      const isReturnFrame = index === FAR_ZOOM_WHEEL_BURSTS.length - 1;
      altitudeM = isReturnFrame
        ? await sampleFlatFrame(page, cdp, testInfo, 'return', samples, failures, evidenceDir, sidebar)
        : await readCameraAltitudeM(page);
    }

    await cdp.detach();
    finishFlatColorCheck(samples, failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
