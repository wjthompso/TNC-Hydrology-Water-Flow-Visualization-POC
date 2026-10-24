import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  distanceMeters,
  expectGaugeMeasuredWaterAndInferredNeighboursOnly,
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
 * checks that Creek Segment 27714637-026 has measured (not inferred) water
 * with a water bucket, that every other segment with water is one of the
 * inferred neighbours named in the committed observed-wse-propagation.json
 * (up to 3 upstream and 3 downstream) and is flagged inferred, that no
 * segment outside that neighbourhood has water, that each segment has one
 * water graphic, that the camera target is within 300 m of the gauge
 * segment's midpoint from the committed path, and that the removed synthetic
 * controls are absent. It does not check the visual appearance of the water.
 *
 * Imagery dataset used in the visualization: Esri World Imagery.
 */
test('Open the page on measured water for the Jalama Near Lompoc gauge Creek Segment, with the camera framed there and no leftover synthetic ribbons.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    // Open Jalama Creek on the Jalama Near Lompoc gauge 15-minute readings,
    // over Esri World Imagery.
    await openObservedWaterPage(page, watch, FAST_TEST_SCENE_IMAGERY_ID);
    const seam = await readSeam(page);
    const midpoint = gaugeSegmentMidpointWgs84();

    // The gauge Creek Segment shows measured water, and only its inferred neighbours join it.
    expectGaugeMeasuredWaterAndInferredNeighboursOnly(seam);
    const gaugeWater = seam.waterGraphicGeometryIdentity.find(
      (item) => item.segmentId === GAUGE_SEGMENT_ID,
    );
    expect(gaugeWater?.bucketMinElevationM).not.toBeNull();
    // The camera is framed on that gauge Creek Segment.
    const cameraTarget = seam.cameraTargetWgs84;
    if (!cameraTarget) throw new Error('The camera target is missing.');
    expect(distanceMeters(cameraTarget, midpoint)).toBeLessThanOrEqual(300);

    // The old stage slider, renderer toggle, and extra 3D view are gone.
    await expect(page.locator('#stage-slider')).toHaveCount(0);
    await expect(page.locator('#renderer-toggle')).toHaveCount(0);
    await expect(page.locator('#three-view')).toHaveCount(0);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
