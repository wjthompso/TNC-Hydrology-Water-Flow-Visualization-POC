import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { watchLiveServices } from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
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
  JALAMA_EXTENT_ID,
  JALAMA_TNC_COMID,
  NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
  missingLocalPipelineOutput,
  readWaterSurfaceElevationsAt,
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/local-pipeline-output.ts';
import {
  modeledWaterPageUrl,
  openModeledWaterPage,
  waitForModeledWaterIdle,
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/modeled-water-page.ts';
import {
  bucketFor,
  clickSegmentWater,
  readSelection,
  topDownPoseOverBucket,
} from '../../F-150-selected-creek-segment/behavior/selected-creek-segment-page.ts';

/** The chart's text for a Creek Segment with no anchor bed. Kept in the product; seeing it in this test is the UCS-301 bug. */
const MISSING_ANCHOR_BED_TEXT = 'No anchor bed elevation for Creek Segment';
/** The developer's view in UCS-301: Jan 31, 2023, 4:00 PM PST. */
const SELECTED_HOUR_UTC = '2023-02-01T00:00:00Z';
/** The reported gauge segment, and one far downstream on the same flowline, so one segment's special case cannot pass. */
const SEGMENT_IDS = ['27714637-026', '27714637-046'] as const;

type MissingAnchorBedWindow = Window & { __missingAnchorBedTexts?: string[] };

/** Methodology: see the FBT-024 catalog entry. */
test('Selecting a modeled creek segment shows its water depth chart and never says the segment has no anchor bed elevation.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  // Record the missing-bed text whenever the chart's message shows it, even for one frame.
  await page.addInitScript((missingText) => {
    const seen: string[] = [];
    (window as MissingAnchorBedWindow).__missingAnchorBedTexts = seen;
    new MutationObserver(() => {
      const text = document.getElementById('wse-chart-empty')?.textContent ?? '';
      if (text.includes(missingText) && seen.at(-1) !== text) seen.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, MISSING_ANCHOR_BED_TEXT);
  try {
    const selectedUtcMs = Date.parse(SELECTED_HOUR_UTC);
    const missing = missingLocalPipelineOutput({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timesUtcMs: [selectedUtcMs],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);
    const elevations = readWaterSurfaceElevationsAt({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timeUtcMs: selectedUtcMs,
    });
    const modeled = { kind: 'modeled', extentId: JALAMA_EXTENT_ID } as const;

    // Open the hourly modeled Dataset on Jalama at Jan 31, 2023, 4:00 PM PST. The chart shows feet by default.
    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: JALAMA_EXTENT_ID,
        timeUtc: SELECTED_HOUR_UTC,
      }),
    );
    await settleScene(page, 'opening-frame');
    await expect(page.locator('[data-water-level-unit="ft"]'), 'ft is pressed').toHaveAttribute('aria-pressed', 'true');

    // Click each segment's water. Its chart must plot water depth, never the missing-bed text.
    for (const segmentId of SEGMENT_IDS) {
      const elevationM = elevations?.get(segmentId);
      if (typeof elevationM !== 'number') {
        throw new Error(`The local pipeline output has no modeled value for ${segmentId} at ${SELECTED_HOUR_UTC}.`);
      }
      const bucket = bucketFor(modeled, segmentId, elevationM);
      await moveCameraAndSettle(page, topDownPoseOverBucket(bucket), `${segmentId}-top-down`);
      await waitForModeledWaterIdle(page);
      await settleScene(page, `${segmentId}-loaded`);
      await clickSegmentWater(page, { segmentId, bucket });

      // Wait until the chart either draws this segment or shows the missing-bed text.
      const chartState = async () => ({
        ...(await readSelection(page)),
        emptyText: (await page.locator('#wse-chart-empty').textContent()) ?? '',
      });
      await expect
        .poll(
          async () => {
            const state = await chartState();
            return (
              state.emptyText.includes(MISSING_ANCHOR_BED_TEXT) ||
              (state.chartSegmentId === segmentId && state.chartPointCount > 0)
            );
          },
          { message: `${segmentId}'s chart finished loading` },
        )
        .toBe(true);
      const state = await chartState();
      expect(state.emptyText, `${segmentId}'s chart message`).not.toContain(MISSING_ANCHOR_BED_TEXT);
      expect(state.chartSegmentId, 'chart shows the clicked segment').toBe(segmentId);
      expect(state.chartPointCount, `${segmentId}'s chart has water depth readings`).toBeGreaterThan(0);
      await expect(page.locator('#wse-chart-plot'), `${segmentId}'s chart line`).toBeVisible();
      await expect(page.locator('#wse-chart-current-value'), `${segmentId}'s depth at the selected time`).toHaveText(
        /^\d+\.\d{2} ft$/,
      );
    }

    const seen = await page.evaluate(() => (window as MissingAnchorBedWindow).__missingAnchorBedTexts ?? []);
    expect(seen, 'missing-bed text shown at any moment during the run').toEqual([]);

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
