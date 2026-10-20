import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  distanceMeters,
  GAUGE_SEGMENT_ID,
  gaugeSegmentMidpointWgs84,
  openObservedWaterPage,
  readSeam,
  rethrowIfExternalOutage,
  watchLiveServices,
} from './observed-jalama-gauge-water.ts';

/**
 * Methodology: Opens the locally served page and waits until the read-only
 * test seam reports ready. The browser page, ArcGIS SceneView, and committed
 * published creek data are real. Esri World Imagery and Esri World Elevation
 * responses are real and are reused from a local disk cache; a response missing
 * from the cache is fetched live, and if that fetch is unavailable the result is
 * inconclusive rather than passed. Nothing else is mocked. The test-only seam supplies
 * the water-segment list, water-graphic identity, and camera target. The test
 * checks that only Creek Segment 27714637-026 has water, that exactly one
 * water graphic exists for that segment, that the camera target is within
 * 300 m of that segment's midpoint from the committed path, and that the
 * removed synthetic controls are absent. It does not check the visual
 * appearance of the water.
 *
 * Imagery dataset used in the visualization: Esri World Imagery.
 */
test('Open the page on water for the Jalama Near Lompoc gauge Creek Segment only, with the camera framed there and no leftover synthetic ribbons.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    await openObservedWaterPage(page, watch, FAST_TEST_SCENE_IMAGERY_ID);
    const seam = await readSeam(page);
    const midpoint = gaugeSegmentMidpointWgs84();

    expect(seam.waterSegmentIds).toEqual([GAUGE_SEGMENT_ID]);
    expect(seam.waterGraphicGeometryIdentity).toHaveLength(1);
    expect(seam.waterGraphicGeometryIdentity[0]?.segmentId).toBe(GAUGE_SEGMENT_ID);
    expect(seam.waterGraphicGeometryIdentity[0]?.bucketMinElevationM).not.toBeNull();
    const cameraTarget = seam.cameraTargetWgs84;
    if (!cameraTarget) throw new Error('The camera target is missing.');
    expect(distanceMeters(cameraTarget, midpoint)).toBeLessThanOrEqual(300);

    await expect(page.locator('#stage-slider')).toHaveCount(0);
    await expect(page.locator('#renderer-toggle')).toHaveCount(0);
    await expect(page.locator('#three-view')).toHaveCount(0);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
