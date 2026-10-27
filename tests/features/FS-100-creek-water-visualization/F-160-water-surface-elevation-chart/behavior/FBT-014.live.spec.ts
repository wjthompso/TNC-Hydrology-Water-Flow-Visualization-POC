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
  readAnchorBedElevationM,
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
    // Read the National Water Model hourly elevation for the Jalama gauge Creek Segment at 2022-10-01T00:00Z, the low-flow start of water year 2023.
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

    // Open that Dataset on the Jalama extent at 2022-10-01T00:00Z and look down on the segment.
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

    // Click the segment's water so its Water-Surface Elevation Chart appears.
    await clickSegmentWater(page, { segmentId: SEGMENT_ID, bucket: openingBucket });
    await expect.poll(async () => (await readSelection(page)).chartPointCount).toBeGreaterThan(0);

    // Aim at the 2023-01-10T01:00Z flood peak on the chart, then click the reading under the pointer.
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

    // The time slider and the readout show that clicked hour in Pacific time.
    const slider = await readTimeSlider(page);
    const label = formatPacificTime(pointed.timeUtcMs);
    expect(slider.valueText, 'time slider spoken value').toBe(label);
    expect(slider.readout, 'time readout').toBe(label);
    expect(Number(slider.value), 'time slider slot').toBe(Math.round((pointed.timeUtcMs - Date.parse('2017-10-01T00:00:00Z')) / HOUR_MS));

    // The chart plots Anchor Water Depth: the pipeline's elevation for the clicked hour minus the segment's anchor bed.
    const pipelineInput = {
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timeUtcMs: pointed.timeUtcMs,
    };
    const clickedElevationM = readWaterSurfaceElevationsAt(pipelineInput)?.get(SEGMENT_ID);
    const anchorBedM = readAnchorBedElevationM({ ...pipelineInput, segmentId: SEGMENT_ID });
    if (typeof clickedElevationM !== 'number' || anchorBedM === null) {
      throw new Error(`The local pipeline output has no elevation and anchor bed for ${SEGMENT_ID} at the clicked hour.`);
    }
    expect(pointed.valueM, 'charted water depth is the clicked hour\'s elevation minus the anchor bed').toBeCloseTo(
      Math.max(0, clickedElevationM - anchorBedM),
      6,
    );

    // The segment's modeled water redraws at that hour's elevation, and the chart cursor sits on that hour.
    await waitForModeledWaterIdle(page);
    expect(await readModeledElevationM(page, SEGMENT_ID), 'modeled elevation the page holds').toBe(clickedElevationM);
    const expectedBucket = bucketFor(modeled, SEGMENT_ID, clickedElevationM);
    expect(expectedBucket.minWaterSurfaceElevationM, 'the peak water differs from the opening water').not.toBe(
      openingBucket.minWaterSurfaceElevationM,
    );
    await expect
      .poll(async () => bucketMinOf((await readSeam(page)).waterGraphicGeometryIdentity, SEGMENT_ID), {
        message: `segment water drawn at the clicked hour's ${clickedElevationM} m elevation bucket`,
      })
      .toBe(expectedBucket.minWaterSurfaceElevationM);
    expect((await readSelection(page)).chartCursorTimeUtcMs, 'chart time cursor').toBe(pointed.timeUtcMs);

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
