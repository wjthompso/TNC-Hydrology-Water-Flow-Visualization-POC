import { test } from '@playwright/test';
import { openObservedWaterPage, watchLiveServices } from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import {
  COAST_WHEEL_EVENTS,
  WHEEL_DELTA_Y,
  finishFlatColorCheck,
  moveToWheelPoint,
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
 * scene canvas outside the sidebar, one grouped notch of three events
 * (deltaY 420), far enough to reach a coast-scale camera around 12 km. At the
 * opening frame and the coast frame it screenshots a 640×480 clip of the
 * scene, masks the sidebar using its DOM bounding box, samples every fourth
 * pixel, and fails when the share of those pixels whose RGB exactly equals the
 * single most common RGB exceeds 10%. The failure names the step, camera
 * height, flat color, and share, and attaches the screenshot. It does not zoom
 * past the coast frame, zoom back in, or check a white far-zoom frame. It does
 * not check imagery sharpness, tile vintage differences, terrain accuracy, or
 * water appearance.
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
  const samples: string[] = [];
  const failures: string[] = [];

  try {
    await openObservedWaterPage(page, watch);
    await settleOpening(page, terrain);
    const sidebar = await sidebarMask(page);
    await moveToWheelPoint(page);
    const cdp = await page.context().newCDPSession(page);

    const openingAltitudeM = await sampleFlatFrame(
      page,
      cdp,
      testInfo,
      'opening',
      samples,
      failures,
      process.env.FBT006_EVIDENCE_DIR,
      sidebar,
    );
    await wheelBurst(page, COAST_WHEEL_EVENTS, WHEEL_DELTA_Y, sidebar);
    await settleAfterZoom(page, terrain, openingAltitudeM);
    await sampleFlatFrame(
      page,
      cdp,
      testInfo,
      'coast',
      samples,
      failures,
      process.env.FBT006_EVIDENCE_DIR,
      sidebar,
    );

    await cdp.detach();
    finishFlatColorCheck(samples, failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
