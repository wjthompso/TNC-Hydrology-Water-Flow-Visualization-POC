import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  floodPeakObservation,
  GAUGE_SEGMENT_ID,
  openObservedWaterPage,
  readSeam,
  rethrowIfExternalOutage,
  scrubToTime,
  watchLiveServices,
} from './observed-jalama-gauge-water.ts';

/**
 * Methodology: Opens the locally served page and waits until the read-only
 * test seam reports ready, then sets the real time slider to the published
 * 2026-01-03T15:15Z flood peak so the gauge Creek Segment 27714637-026 and its
 * inferred neighbours all have water. The browser page, ArcGIS SceneView, and
 * committed published creek data are real. Esri World Imagery and Esri World
 * Elevation responses are real and are reused from a local disk cache; a
 * response missing from the cache is fetched live, and if that fetch is
 * unavailable the result is inconclusive rather than passed. Nothing else is
 * mocked. The test makes no clicks and moves no camera, so the gauge segment
 * stays selected as it is on open. The test-only seam lists, for every drawn
 * water graphic, the type of each ArcGIS symbol layer on it. The test fails
 * unless the gauge segment and at least one inferred neighbour are drawn, and
 * fails if any drawn graphic has a symbol layer other than water, which is
 * how a symbol outline (a fill layer) shows up. The selection highlight is a
 * view highlight, not a symbol layer, so the selected segment's amber outline
 * is allowed. It does not check pixels, colors, gaps between neighbouring
 * polygon footprints, or modeled water.
 *
 * Imagery dataset used in the visualization: Esri World Imagery.
 */
test('Water on neighbouring creek segments is drawn with no outline layer, so no dark line appears where segments meet.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    // Open Jalama Creek, then move to the flood peak so the gauge segment and
    // its inferred neighbours all show water.
    await openObservedWaterPage(page, watch, FAST_TEST_SCENE_IMAGERY_ID);
    await scrubToTime(page, floodPeakObservation().timeUtcMs);
    await expect
      .poll(
        async () => {
          const drawn = (await readSeam(page)).waterGraphicGeometryIdentity.filter(
            (item) => item.bucketMinElevationM !== null,
          );
          return {
            gauge: drawn.some((item) => item.segmentId === GAUGE_SEGMENT_ID),
            inferredNeighbours: drawn.filter((item) => item.inferred).length > 0,
          };
        },
        { message: 'the gauge segment and an inferred neighbour are both drawn' },
      )
      .toEqual({ gauge: true, inferredNeighbours: true });

    // Every drawn water graphic is plain water: no fill layer, so no outline
    // line across the creek where two segments meet.
    const drawn = (await readSeam(page)).waterGraphicGeometryIdentity.filter(
      (item) => item.bucketMinElevationM !== null,
    );
    const withExtraLayers = drawn
      .filter((item) => item.symbolLayerTypes.some((type) => type !== 'water'))
      .map((item) => `${item.segmentId}: [${item.symbolLayerTypes.join(', ')}]`);
    expect(withExtraLayers, 'drawn water with a symbol layer other than water').toEqual([]);
    expect(
      drawn.every((item) => item.symbolLayerTypes.length > 0),
      'every drawn water graphic reports its symbol layers',
    ).toBe(true);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
