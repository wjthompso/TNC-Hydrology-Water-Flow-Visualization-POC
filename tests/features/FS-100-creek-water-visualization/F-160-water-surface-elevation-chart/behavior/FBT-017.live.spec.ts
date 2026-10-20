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
  formatPacificTime,
  readSelection,
  readTimeSlider,
  topDownPoseOverBucket,
} from '../../F-150-selected-creek-segment/behavior/selected-creek-segment-page.ts';

/** Methodology: see the FBT-017 catalog entry. */
test('Hovering over the chart shows the time and elevation under the pointer without moving the time slider.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    await openObservedWaterPage(page, watch);
    const opening = await readSeam(page);
    const openingReading = opening.selectedTimeUtcMs === null ? null : readingAt(opening.selectedTimeUtcMs);
    if (opening.selectedTimeUtcMs === null || openingReading === null) {
      throw new Error('The observed page did not open on a time with a gauge reading.');
    }
    const bucket = bucketFor({ kind: 'observed' }, GAUGE_SEGMENT_ID, openingReading);
    await settleScene(page, 'opening-frame');
    await moveCameraAndSettle(page, topDownPoseOverBucket(bucket), 'gauge-segment-top-down');
    await clickSegmentWater(page, { segmentId: GAUGE_SEGMENT_ID, bucket });
    await expect.poll(async () => (await readSelection(page)).chartPointCount).toBeGreaterThan(0);

    const sliderBefore = await readTimeSlider(page);
    const identityBefore = (await readSeam(page)).waterGraphicGeometryIdentity;
    const target = await chartPointFor(page, floodPeakObservation().timeUtcMs);
    await page.mouse.move(target.x, target.y, { steps: 4 });

    await expect.poll(async () => (await readSelection(page)).chartHoverTimeUtcMs).not.toBeNull();
    const hoverTimeUtcMs = (await readSelection(page)).chartHoverTimeUtcMs as number;
    const hoverReading = readingAt(hoverTimeUtcMs);
    expect(hoverReading, 'the hovered time has a committed gauge reading').not.toBeNull();
    await expect(page.locator('#wse-chart-hover')).toHaveText(
      `${formatPacificTime(hoverTimeUtcMs)} · ${(hoverReading as number).toFixed(2)} m`,
    );

    // Hold the pointer still briefly so a delayed time change would show.
    await page.waitForTimeout(500);
    expect(await readTimeSlider(page), 'time slider, spoken value, and readout are unchanged').toEqual(sliderBefore);
    const after = await readSeam(page);
    expect(after.selectedTimeUtcMs, 'selected time is unchanged').toBe(opening.selectedTimeUtcMs);
    expect(after.waterGraphicGeometryIdentity, 'drawn water is unchanged').toEqual(identityBefore);
    expect((await readSelection(page)).chartCursorTimeUtcMs, 'chart time cursor is unchanged').toBe(
      opening.selectedTimeUtcMs,
    );
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
