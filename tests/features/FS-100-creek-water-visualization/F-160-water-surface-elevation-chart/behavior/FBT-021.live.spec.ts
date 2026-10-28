import type { Page } from '@playwright/test';
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

const CHART_PLOT_SELECTOR = '#wse-chart-plot';

const iso = (timeUtcMs: number | null): string => (timeUtcMs === null ? 'null' : new Date(timeUtcMs).toISOString());

/** What the real mouse would hit at a viewport pixel, in words a failure message can print. */
async function describePointTarget(
  page: Page,
  point: { x: number; y: number },
): Promise<{
  onChartPlot: boolean;
  hit: string;
  insideViewport: boolean;
  viewport: string;
  plotBox: string;
}> {
  return page.evaluate(
    ({ x, y, plotSelector }) => {
      const hitElement = document.elementFromPoint(x, y);
      const plot = document.querySelector(plotSelector);
      const box = plot?.getBoundingClientRect();
      const label = (element: Element | null): string =>
        element
          ? `<${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}>`
          : 'nothing (the pixel is outside the window)';
      return {
        onChartPlot: hitElement !== null && plot !== null && plot.contains(hitElement),
        hit: label(hitElement),
        insideViewport: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        plotBox: box
          ? `x ${box.left.toFixed(0)}-${box.right.toFixed(0)}, y ${box.top.toFixed(0)}-${box.bottom.toFixed(0)}`
          : `${plotSelector} not found`,
      };
    },
    { ...point, plotSelector: CHART_PLOT_SELECTOR },
  );
}

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

    // Precondition: both pixels must land on the chart plot. A press outside the window or over another
    // element never reaches the chart, which looks the same as a broken scrub unless it is checked first.
    const pressTarget = await describePointTarget(page, press);
    const releaseTarget = await describePointTarget(page, release);
    expect(
      pressTarget.onChartPlot,
      [
        `The press pixel must land on the chart plot (${CHART_PLOT_SELECTOR}), but it did not.`,
        `  press pixel:   (${press.x.toFixed(1)}, ${press.y.toFixed(1)}) for ${iso(press.reading.timeUtcMs)} (opening time)`,
        `  landed on:     ${pressTarget.hit}`,
        `  inside window: ${pressTarget.insideViewport} (window ${pressTarget.viewport})`,
        `  chart plot box: ${pressTarget.plotBox}`,
      ].join('\n'),
    ).toBe(true);
    expect(
      releaseTarget.onChartPlot,
      [
        `The release pixel must land on the chart plot (${CHART_PLOT_SELECTOR}), but it did not.`,
        `  release pixel: (${release.x.toFixed(1)}, ${release.y.toFixed(1)}) for ${iso(release.reading.timeUtcMs)} (flood peak)`,
        `  landed on:     ${releaseTarget.hit}`,
        `  inside window: ${releaseTarget.insideViewport} (window ${releaseTarget.viewport})`,
        `  chart plot box: ${releaseTarget.plotBox}`,
      ].join('\n'),
    ).toBe(true);

    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    const timestampAtPress = (await readSeam(page)).selectedTimeUtcMs;
    if (timestampAtPress === null) throw new Error('The chart press had no selected timestamp.');
    try {
      await page.mouse.move(release.x, release.y, { steps: 12 });
      // Read before release. A click at mouse-up moves the timestamp once and hides the missing scrub.
      // Poll for up to 1 s, then assert once on the last value so the failure prints what was read.
      await expect
        .poll(async () => (await readSeam(page)).selectedTimeUtcMs, { timeout: 1_000 })
        .not.toBe(timestampAtPress)
        .catch(() => undefined);
      const timestampWhileDragging = (await readSeam(page)).selectedTimeUtcMs;
      expect(
        timestampWhileDragging,
        [
          'Dragging across the chart must move the selected timestamp before the button is released, but it did not.',
          `  pressed at:           ${iso(press.reading.timeUtcMs)} at (${press.x.toFixed(1)}, ${press.y.toFixed(1)})`,
          `  selected at press:    ${iso(timestampAtPress)}`,
          `  dragged to:           ${iso(release.reading.timeUtcMs)} at (${release.x.toFixed(1)}, ${release.y.toFixed(1)}) (flood peak)`,
          `  selected while drag:  ${iso(timestampWhileDragging)}`,
          `  expected:             any timestamp other than ${iso(timestampAtPress)}`,
          `  received:             ${iso(timestampWhileDragging)} (unchanged)`,
          `  release pixel is on:  ${releaseTarget.hit}`,
        ].join('\n'),
      ).not.toBe(timestampAtPress);
    } finally {
      await page.mouse.up();
    }
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
