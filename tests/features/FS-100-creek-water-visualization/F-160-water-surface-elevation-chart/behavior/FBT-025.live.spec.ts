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

/** Jan 31, 2023, 4:00 PM PST: inside the typical Jan–May spawning season, with water in the creek. */
const SELECTED_HOUR_UTC = '2023-02-01T00:00:00Z';
/** The gauge Creek Segment, which has water at the selected hour. */
const SEGMENT_ID = '27714637-026';
/** One life stage per button, in the order the test presses them. The label is what the chart reports for its bands. */
const LIFE_STAGES = [
  { dataValue: 'eggs', label: 'Eggs' },
  { dataValue: 'juveniles', label: 'Juveniles' },
  { dataValue: 'adults', label: 'Adults' },
] as const;
/** The chart paints each zone as a rectangle with one of these Tailwind fill classes. */
const BAND_FILL_CLASSES = {
  Suitable: 'fill-green-500/20',
  Marginal: 'fill-yellow-400/20',
  Unsuitable: 'fill-red-500/20',
} as const;

/** Methodology: see the FBT-025 catalog entry. */
test("Turning on steelhead trout conditions draws red, yellow, and green depth bands behind a modeled creek segment's water depth chart for each life stage: Eggs, Juveniles, and Adults.", async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
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
    const elevationM = elevations?.get(SEGMENT_ID);
    if (typeof elevationM !== 'number') {
      throw new Error(`The local pipeline output has no modeled value for ${SEGMENT_ID} at ${SELECTED_HOUR_UTC}.`);
    }
    const modeled = { kind: 'modeled', extentId: JALAMA_EXTENT_ID } as const;

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

    // Click the segment's water so its depth chart is on screen.
    const bucket = bucketFor(modeled, SEGMENT_ID, elevationM);
    await moveCameraAndSettle(page, topDownPoseOverBucket(bucket), `${SEGMENT_ID}-top-down`);
    await waitForModeledWaterIdle(page);
    await settleScene(page, `${SEGMENT_ID}-loaded`);
    await clickSegmentWater(page, { segmentId: SEGMENT_ID, bucket });
    await expect
      .poll(async () => {
        const state = await readSelection(page);
        return state.chartSegmentId === SEGMENT_ID && state.chartPointCount > 0;
      }, { message: `${SEGMENT_ID}'s chart finished loading` })
      .toBe(true);

    await page.locator('#trout-conditions-toggle').check();

    for (const stage of LIFE_STAGES) {
      await page.locator(`[data-steelhead-life-stage="${stage.dataValue}"]`).click();

      // The chart reports which stage its bands are drawn for; null means it drew none.
      await expect
        .poll(async () => (await readSelection(page)).chartConditionBandsStageLabel, {
          message: `the chart draws ${stage.label} bands for ${SEGMENT_ID}`,
        })
        .toBe(stage.label);

      // One green, one yellow, and one red zone inside the chart plot.
      for (const [zone, fillClass] of Object.entries(BAND_FILL_CLASSES)) {
        await expect(
          page.locator(`#wse-chart-plot rect[class~="${fillClass}"]`),
          `${stage.label}: the ${zone} band is drawn behind the chart line`,
        ).toHaveCount(1);
      }

      // The sidebar does not tell the person this stage has no depth band, or that the segment has no bed.
      await expect(page.locator('#trout-conditions-no-band'), `${stage.label}: no-depth-band note`).toBeHidden();
      await expect(page.locator('#trout-conditions-segment-note'), `${stage.label}: segment note`).toBeHidden();
    }

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
