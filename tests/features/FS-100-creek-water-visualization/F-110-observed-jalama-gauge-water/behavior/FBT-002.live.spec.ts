import { expect, test } from '@playwright/test';
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
 * Methodology: Starts from the opening observation, then sets the real time
 * slider to the published 2026-01-03T15:15Z flood peak and checks that the
 * selected time and water-bucket identity change while exactly one water
 * graphic remains on Creek Segment 27714637-026. The browser page and
 * committed published data are real. Esri World Imagery and Esri World
 * Elevation tiles are live; if they are unavailable the result is inconclusive
 * rather than passed. Nothing is mocked or saved. It does not check the visual appearance
 * of the water.
 */
test('Scrub to a different observation time and replace the shown water without leaving the previous water in place.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    await openObservedWaterPage(page, watch);
    const opening = await readSeam(page);
    const openingBucket = opening.waterGraphicGeometryIdentity[0]?.bucketMinElevationM;
    const peak = floodPeakObservation();

    await scrubToTime(page, peak.timeUtcMs);
    await expect
      .poll(async () => (await readSeam(page)).waterGraphicGeometryIdentity[0]?.bucketMinElevationM)
      .not.toBe(openingBucket);

    const scrubbed = await readSeam(page);
    expect(scrubbed.selectedTimeUtcMs).toBe(peak.timeUtcMs);
    expect(scrubbed.waterGraphicGeometryIdentity).toHaveLength(1);
    expect(scrubbed.waterGraphicGeometryIdentity[0]?.segmentId).toBe(GAUGE_SEGMENT_ID);
    expect(scrubbed.waterGraphicGeometryIdentity[0]?.bucketMinElevationM).not.toBe(openingBucket);
    expect(scrubbed.waterSegmentIds).toEqual([GAUGE_SEGMENT_ID]);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
