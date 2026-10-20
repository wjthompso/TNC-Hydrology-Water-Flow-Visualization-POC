import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import {
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
  JALAMA_EXTENT_ID,
  JALAMA_TNC_COMID,
  NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
  missingLocalPipelineOutput,
  readWaterSurfaceElevationsAt,
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/local-pipeline-output.ts';
import {
  modeledWaterPageUrl,
  openModeledWaterPage,
  readModeledElevationM,
  readModeledSelectedTimeUtcMs,
  waitForModeledWaterIdle,
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/modeled-water-page.ts';
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

/** The Jalama gauge Creek Segment; the modeled page frames it on open. */
const SEGMENT_ID = '27714637-026';
/** Low-flow opening hour, the first of water year 2023. */
const OPENING_HOUR_UTC = '2022-10-01T00:00:00Z';
/** The water year 2023 flood peak on this segment in the local pipeline output. */
const PEAK_HOUR_UTC = '2023-01-10T01:00:00Z';
const HOUR_MS = 60 * 60 * 1000;

/** Methodology: see the FBT-014 catalog entry. */
test("Clicking a time on a modeled creek segment's water-surface elevation chart moves the time slider to that time and redraws that segment's modeled water at the charted elevation.", async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    const openingUtcMs = Date.parse(OPENING_HOUR_UTC);
    const peakUtcMs = Date.parse(PEAK_HOUR_UTC);
    const missing = missingLocalPipelineOutput({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timesUtcMs: [openingUtcMs],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);
    const openingElevationM = readWaterSurfaceElevationsAt({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timeUtcMs: openingUtcMs,
    })?.get(SEGMENT_ID);
    if (typeof openingElevationM !== 'number') {
      throw new Error(`The local pipeline output has no modeled value for ${SEGMENT_ID} at ${OPENING_HOUR_UTC}.`);
    }
    const modeled = { kind: 'modeled', extentId: JALAMA_EXTENT_ID } as const;
    const openingBucket = bucketFor(modeled, SEGMENT_ID, openingElevationM);

    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: JALAMA_EXTENT_ID,
        timeUtc: OPENING_HOUR_UTC,
      }),
    );
    expect(await readModeledSelectedTimeUtcMs(page), 'opening time from the URL').toBe(openingUtcMs);
    await settleScene(page, 'opening-frame');
    await moveCameraAndSettle(page, topDownPoseOverBucket(openingBucket), 'segment-top-down');
    await waitForModeledWaterIdle(page);
    await settleScene(page, 'segment-top-down-loaded');

    await clickSegmentWater(page, { segmentId: SEGMENT_ID, bucket: openingBucket });
    await expect.poll(async () => (await readSelection(page)).chartPointCount).toBeGreaterThan(0);

    const target = await chartPointFor(page, peakUtcMs);
    await page.mouse.move(target.x, target.y);
    await expect.poll(async () => (await readSelection(page)).chartHoverTimeUtcMs).not.toBeNull();
    const pointed = await page.evaluate(() => {
      const chart = window.__TNC_TEST__?.waterSurfaceElevationChart;
      const time = chart?.hoverTimeUtcMs ?? null;
      return time === null ? null : chart?.nearestReading(time) ?? null;
    });
    if (!pointed) throw new Error('The chart reported no reading under the pointer.');
    await page.mouse.click(target.x, target.y);

    await expect
      .poll(() => readModeledSelectedTimeUtcMs(page), { message: 'selected time after the chart click' })
      .toBe(pointed.timeUtcMs);
    // One chart pixel spans several hours of a water year, so the click selects within a few hours of the peak.
    expect(Math.abs(pointed.timeUtcMs - peakUtcMs), 'clicked time is near the flood peak').toBeLessThanOrEqual(
      24 * HOUR_MS,
    );

    const slider = await readTimeSlider(page);
    const label = formatPacificTime(pointed.timeUtcMs);
    expect(slider.valueText, 'time slider spoken value').toBe(label);
    expect(slider.readout, 'time readout').toBe(label);
    expect(Number(slider.value), 'time slider slot').toBe(Math.round((pointed.timeUtcMs - Date.parse('2017-10-01T00:00:00Z')) / HOUR_MS));

    await waitForModeledWaterIdle(page);
    expect(await readModeledElevationM(page, SEGMENT_ID), 'modeled elevation the page holds').toBe(pointed.valueM);
    const expectedBucket = bucketFor(modeled, SEGMENT_ID, pointed.valueM);
    expect(expectedBucket.minWaterSurfaceElevationM, 'the peak water differs from the opening water').not.toBe(
      openingBucket.minWaterSurfaceElevationM,
    );
    await expect
      .poll(async () => bucketMinOf((await readSeam(page)).waterGraphicGeometryIdentity, SEGMENT_ID), {
        message: `segment water drawn at the charted ${pointed.valueM} m value's bucket`,
      })
      .toBe(expectedBucket.minWaterSurfaceElevationM);
    expect((await readSelection(page)).chartCursorTimeUtcMs, 'chart time cursor').toBe(pointed.timeUtcMs);

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
