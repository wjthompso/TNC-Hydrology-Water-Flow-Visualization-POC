import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import {
  floodPeakObservation,
  GAUGE_SEGMENT_ID,
  openObservedWaterPage,
  readingAt,
  readSeam,
  rethrowIfExternalOutage,
  scrubToTime,
  watchLiveServices,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import {
  moveCameraAndSettle,
  settleScene,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-camera.ts';
import {
  bucketFor,
  clickSegmentWater,
  readSelection,
  topDownPoseOverBucket,
} from '../../F-150-selected-creek-segment/behavior/selected-creek-segment-page.ts';

/** Methodology: see the FBT-016 catalog entry. */
test("Moving the time slider moves the chart's time cursor to the same time.", async ({ page }) => {
  const watch = watchLiveServices(page);
  try {
    // Open the Observed gauge Dataset and look down on the Jalama gauge Creek Segment at the time the page opens on.
    await openObservedWaterPage(page, watch);
    const openingTimeUtcMs = (await readSeam(page)).selectedTimeUtcMs;
    const openingReading = openingTimeUtcMs === null ? null : readingAt(openingTimeUtcMs);
    if (openingTimeUtcMs === null || openingReading === null) {
      throw new Error('The observed page did not open on a time with a gauge reading.');
    }
    const bucket = bucketFor({ kind: 'observed' }, GAUGE_SEGMENT_ID, openingReading);
    await settleScene(page, 'opening-frame');
    await moveCameraAndSettle(page, topDownPoseOverBucket(bucket), 'gauge-segment-top-down');
    // Click that segment's water. The chart's time cursor starts on the opening time.
    await clickSegmentWater(page, { segmentId: GAUGE_SEGMENT_ID, bucket });
    await expect.poll(async () => (await readSelection(page)).chartCursorTimeUtcMs).toBe(openingTimeUtcMs);

    // Move the time slider to the 2026-01-03T15:15Z flood peak. The chart cursor follows that time and lines up with it.
    const peak = floodPeakObservation();
    await scrubToTime(page, peak.timeUtcMs);
    await expect
      .poll(async () => (await readSelection(page)).chartCursorTimeUtcMs, { message: 'cursor after the scrub' })
      .toBe(peak.timeUtcMs);
    await expect(page.locator('#wse-chart-time-cursor')).toHaveAttribute('visibility', 'visible');

    const cursorX = await page.evaluate((time) => {
      const chart = window.__TNC_TEST__?.waterSurfaceElevationChart;
      const cursor = document.getElementById('wse-chart-time-cursor');
      const plot = document.getElementById('wse-chart-plot');
      const expected = chart?.clientPointForTime(time)?.x ?? null;
      if (!cursor || !plot || expected === null) return null;
      const drawn = plot.getBoundingClientRect().left + Number(cursor.getAttribute('x1'));
      return { drawn, expected };
    }, peak.timeUtcMs);
    expect(cursorX, 'cursor and chart positions are readable').not.toBeNull();
    expect(Math.abs((cursorX?.drawn ?? 0) - (cursorX?.expected ?? 0)), 'cursor sits on the scrubbed time').toBeLessThanOrEqual(1);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
