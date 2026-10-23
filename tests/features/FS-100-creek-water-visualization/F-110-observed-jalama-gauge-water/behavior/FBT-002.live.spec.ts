import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  expectGaugeMeasuredWaterAndInferredNeighboursOnly,
  floodPeakObservation,
  GAUGE_SEGMENT_ID,
  openObservedWaterPage,
  readSeam,
  rethrowIfExternalOutage,
  scrubToTime,
  watchLiveServices,
} from './observed-jalama-gauge-water.ts';

/**
 * Methodology: Starts from the opening observation, then sets the real time
 * slider to the published 2026-01-03T15:15Z flood peak and checks that the
 * selected time and the water bucket of Creek Segment 27714637-026 change,
 * and that the water set stays that segment's measured water plus only its
 * inferred neighbours from the committed observed-wse-propagation.json, so
 * no previous water is left behind. The browser page and
 * committed published data are real. Esri World Imagery and Esri World
 * Elevation responses are real and are reused from a local disk cache; a
 * response missing from the cache is fetched live, and if that fetch is
 * unavailable the result is inconclusive rather than passed. Nothing else is
 * mocked. It does not check the visual appearance
 * of the water.
 *
 * Imagery dataset used in the visualization: Esri World Imagery.
 */
test('Scrub to a different observation time and replace the shown water without leaving the previous water in place.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    await openObservedWaterPage(page, watch, FAST_TEST_SCENE_IMAGERY_ID);
    const opening = await readSeam(page);
    const gaugeBucket = (snapshot: typeof opening) =>
      snapshot.waterGraphicGeometryIdentity.find((item) => item.segmentId === GAUGE_SEGMENT_ID)
        ?.bucketMinElevationM;
    const openingBucket = gaugeBucket(opening);
    expect(openingBucket, 'gauge segment water at the opening time').not.toBeUndefined();
    expect(openingBucket, 'gauge segment water at the opening time').not.toBeNull();
    const peak = floodPeakObservation();

    await scrubToTime(page, peak.timeUtcMs);
    await expect
      .poll(async () => gaugeBucket(await readSeam(page)))
      .not.toBe(openingBucket);

    const scrubbed = await readSeam(page);
    expect(scrubbed.selectedTimeUtcMs).toBe(peak.timeUtcMs);
    expect(gaugeBucket(scrubbed)).not.toBe(openingBucket);
    expect(gaugeBucket(scrubbed)).not.toBeNull();
    expectGaugeMeasuredWaterAndInferredNeighboursOnly(scrubbed);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
