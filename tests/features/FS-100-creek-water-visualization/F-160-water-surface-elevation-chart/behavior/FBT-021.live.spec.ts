import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import {
  floodPeakObservation,
  GAUGE_SEGMENT_ID,
  openObservedWaterPage,
  readingAt,
  readSeam,
  rethrowIfExternalOutage,
  watchLiveServices,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import {
  moveCameraAndSettle,
  settleScene,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-camera.ts';
import {
  bucketFor,
  chartPointFor,
  clickSegmentWater,
  topDownPoseOverBucket,
} from '../../F-150-selected-creek-segment/behavior/selected-creek-segment-page.ts';

/** Methodology: see the FBT-021 catalog entry. */
test('Pressing on the water-surface elevation chart and dragging left or right moves the selected timestamp with the pointer.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    // Open the Observed gauge Dataset and look down on the Jalama gauge Creek Segment at the time the page opens on.
    await openObservedWaterPage(page, watch);
    const opening = await readSeam(page);
    const openingReading = opening.selectedTimeUtcMs === null ? null : readingAt(opening.selectedTimeUtcMs);
    if (opening.selectedTimeUtcMs === null || openingReading === null) {
      throw new Error('The observed page did not open on a time with a gauge reading.');
    }
    const bucket = bucketFor({ kind: 'observed' }, GAUGE_SEGMENT_ID, openingReading);
    await settleScene(page, 'opening-frame');
    await moveCameraAndSettle(page, topDownPoseOverBucket(bucket), 'gauge-segment-top-down');
    // Click that segment's water so the chart draws.
    await clickSegmentWater(page, { segmentId: GAUGE_SEGMENT_ID, bucket });

    // Press at the opening time, then drag to the 2026-01-03T15:15Z flood peak. Those readings are different times.
    const press = await chartPointFor(page, opening.selectedTimeUtcMs);
    const release = await chartPointFor(page, floodPeakObservation().timeUtcMs);
    expect(release.reading.timeUtcMs, 'the drag crosses to a different chart time').not.toBe(press.reading.timeUtcMs);

    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    const timestampAtPress = (await readSeam(page)).selectedTimeUtcMs;
    if (timestampAtPress === null) throw new Error('The chart press had no selected timestamp.');
    try {
      await page.mouse.move(release.x, release.y, { steps: 12 });
      // Read before release. A click at mouse-up moves the timestamp once and hides the missing scrub.
      await expect
        .poll(async () => (await readSeam(page)).selectedTimeUtcMs, {
          message: `selected timestamp while dragging, pressed at ${new Date(timestampAtPress).toISOString()}`,
          timeout: 1_000,
        })
        .not.toBe(timestampAtPress);
    } finally {
      await page.mouse.up();
    }
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
