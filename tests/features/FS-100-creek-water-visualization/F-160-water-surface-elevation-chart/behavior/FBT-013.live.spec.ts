import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import {
  expectGaugeMeasuredWaterAndInferredNeighboursOnly,
  floodPeakObservation,
  GAUGE_SEGMENT_ID,
  gridIndexForTime,
  openObservedWaterPage,
  readingAt,
  readSeam,
  watchLiveServices,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import {
  moveCameraAndSettle,
  settleScene,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-camera.ts';
import {
  finishSceneCheck,
  rethrowSceneFailure,
  watchTerrainTraffic,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-check-outcome.ts';
import {
  bucketFor,
  bucketMinOf,
  chartPointFor,
  clickSegmentWater,
  formatPacificTime,
  readSelection,
  readTimeSlider,
  topDownPoseOverBucket,
} from '../../F-150-selected-creek-segment/behavior/selected-creek-segment-page.ts';

const OBSERVED = { kind: 'observed' } as const;

/**
 * Methodology: see the FBT-013 catalog entry. Opens the observed page, clicks
 * the gauge Creek Segment's water with the real mouse, then clicks the
 * Water-Surface Elevation Chart at the 2026-01-03T15:15Z flood peak and checks
 * the time slider, the time readout, and the drawn water against the
 * committed observed series.
 */
test("Clicking a time on the Jalama gauge water-surface elevation chart moves the time slider to that time and redraws the gauge segment's water at that time's elevation.", async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    await openObservedWaterPage(page, watch);
    const opening = await readSeam(page);
    const openingTimeUtcMs = opening.selectedTimeUtcMs;
    const openingReading = openingTimeUtcMs === null ? null : readingAt(openingTimeUtcMs);
    if (openingTimeUtcMs === null || openingReading === null) {
      throw new Error('The observed page did not open on a time with a gauge reading.');
    }
    const openingBucket = bucketFor(OBSERVED, GAUGE_SEGMENT_ID, openingReading);
    await settleScene(page, 'opening-frame');
    await moveCameraAndSettle(page, topDownPoseOverBucket(openingBucket), 'gauge-segment-top-down');

    await clickSegmentWater(page, { segmentId: GAUGE_SEGMENT_ID, bucket: openingBucket });
    await expect.poll(async () => (await readSelection(page)).chartPointCount).toBeGreaterThan(0);

    const peak = floodPeakObservation();
    const target = await chartPointFor(page, peak.timeUtcMs);
    await page.mouse.move(target.x, target.y);
    await expect.poll(async () => (await readSelection(page)).chartHoverTimeUtcMs).not.toBeNull();
    const pointedTimeUtcMs = (await readSelection(page)).chartHoverTimeUtcMs as number;
    await page.mouse.click(target.x, target.y);

    await expect
      .poll(async () => (await readSeam(page)).selectedTimeUtcMs, { message: 'selected time after the chart click' })
      .toBe(pointedTimeUtcMs);
    const pointedReading = readingAt(pointedTimeUtcMs);
    if (pointedReading === null) throw new Error('The chart click landed on a time without a gauge reading.');

    // One chart pixel spans about 30 hours of 15-minute readings, so the click
    // selects the reading under the pointer, within a pixel of the peak.
    const pixelSpanMs = await page.evaluate(() => {
      const chart = window.__TNC_TEST__?.waterSurfaceElevationChart;
      const plot = document.getElementById('wse-chart-plot');
      if (!chart?.domainUtcMs || !plot) return null;
      return (chart.domainUtcMs[1] - chart.domainUtcMs[0]) / Math.max(1, plot.clientWidth - 52);
    });
    expect(pixelSpanMs, 'chart time span per pixel').not.toBeNull();
    expect(Math.abs(pointedTimeUtcMs - peak.timeUtcMs), 'clicked time is within one chart pixel of the peak').toBeLessThanOrEqual(
      (pixelSpanMs as number) * 1.5,
    );
    expect(pointedTimeUtcMs, 'the click moved the time away from the opening').not.toBe(openingTimeUtcMs);

    const slider = await readTimeSlider(page);
    const label = formatPacificTime(pointedTimeUtcMs);
    expect(slider.value, 'time slider slot').toBe(String(gridIndexForTime(pointedTimeUtcMs)));
    expect(slider.valueText, 'time slider spoken value').toBe(label);
    expect(slider.readout, 'time readout').toBe(label);

    const expectedBucket = bucketFor(OBSERVED, GAUGE_SEGMENT_ID, pointedReading);
    await expect
      .poll(async () => bucketMinOf((await readSeam(page)).waterGraphicGeometryIdentity, GAUGE_SEGMENT_ID), {
        message: `gauge segment water drawn at the ${pointedReading} m reading's bucket`,
      })
      .toBe(expectedBucket.minWaterSurfaceElevationM);
    expect(expectedBucket.minWaterSurfaceElevationM, 'the redrawn water differs from the opening water').not.toBe(
      openingBucket.minWaterSurfaceElevationM,
    );
    expectGaugeMeasuredWaterAndInferredNeighboursOnly(await readSeam(page));
    expect((await readSelection(page)).chartCursorTimeUtcMs, 'chart time cursor').toBe(pointedTimeUtcMs);

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
