import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import type { TestCameraPose } from '../../../../support/browser/test-mode-api';
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
  chartPointFor,
  clickSegmentWaterAtGroundPoint,
  drawnBucketMinDepthM,
  formatPacificTime,
  readSelection,
  readTimeSlider,
} from '../../F-150-selected-creek-segment/behavior/selected-creek-segment-page.ts';

/** The Jalama gauge Creek Segment, on the Dangermond Preserve extent whose default pairing is drawn here. */
const SEGMENT_ID = '27714637-026';
const PRESERVE_EXTENT_ID = 'dangermond-preserve';
/**
 * The default modeled pairing: WSE Polygon Generation Method `flowline-channel-ribbon` v2 drawn with the
 * Modeled WSE Derivation Method `m5-flowline-profile-jarrett-depth` v1 Time Series. The ribbon's buckets are
 * water depths above the bed.
 */
const DEFAULT_MODELED_WSE_VERSION_PATH = 'm5-flowline-profile-jarrett-depth/v1';
const RIBBON_POLYGON_SETS_RELATIVE_PATH =
  '04-water-surface-polygons/flowline-channel-ribbon/v2/water-surface-polygon-sets';
/** A wet opening hour in water year 2023: 0.547 m of water at the segment's anchor (26.431 m over a 25.884 m bed). */
const OPENING_HOUR_UTC = '2023-01-31T22:00:00Z';
/** The water year 2023 flood peak on this segment in the local pipeline output. */
const PEAK_HOUR_UTC = '2023-01-10T01:00:00Z';
const HOUR_MS = 60 * 60 * 1000;

/**
 * The developer's own capture of this segment's water at a wet hour of the default pairing: the camera pose,
 * and the point on the drawn water (water surface 26.4312 m) the click hit.
 */
const OPENING_CAMERA_POSE: TestCameraPose = {
  positionWgs84: [-120.4840912073295, 34.513262361155014, 178.9492517421022],
  headingDegrees: 305.0169456454853,
  tiltDegrees: 33.963001711450985,
};
const OPENING_WATER_CLICK_WGS84 = { longitude: -120.48486438241306, latitude: 34.51375635350349, z: 26.4312 };

/** Methodology: see the FBT-014 catalog entry. */
test("Clicking a time on a modeled creek segment's water-surface elevation chart moves the time slider to that time and redraws that segment's modeled water at the charted elevation.", async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    // Read the default pairing's National Water Model hourly elevation and anchor bed for the Creek Segment at 2023-01-31T22:00Z, a wet hour of water year 2023.
    const openingUtcMs = Date.parse(OPENING_HOUR_UTC);
    const peakUtcMs = Date.parse(PEAK_HOUR_UTC);
    const pipelineOutput = {
      extentId: PRESERVE_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      modeledWseVersionPath: DEFAULT_MODELED_WSE_VERSION_PATH,
    } as const;
    const missing = missingLocalPipelineOutput({
      ...pipelineOutput,
      timesUtcMs: [openingUtcMs, peakUtcMs],
      extraRelativePaths: [`${RIBBON_POLYGON_SETS_RELATIVE_PATH}/${JALAMA_TNC_COMID}.json`],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);
    const openingElevationM = readWaterSurfaceElevationsAt({ ...pipelineOutput, timeUtcMs: openingUtcMs })?.get(SEGMENT_ID);
    const openingBedM = readAnchorBedElevationM({ ...pipelineOutput, timeUtcMs: openingUtcMs, segmentId: SEGMENT_ID });
    if (typeof openingElevationM !== 'number' || openingBedM === null) {
      throw new Error(`The local pipeline output has no elevation and anchor bed for ${SEGMENT_ID} at ${OPENING_HOUR_UTC}.`);
    }
    // The ribbon's prepared buckets are water depths above the bed, so a bucket is found from a depth.
    const ribbonPolygons = {
      kind: 'modeled',
      extentId: PRESERVE_EXTENT_ID,
      polygonSetsRelativePath: RIBBON_POLYGON_SETS_RELATIVE_PATH,
    } as const;
    const openingBucket = bucketFor(ribbonPolygons, SEGMENT_ID, openingElevationM - openingBedM);

    // Open that Dataset on the Preserve extent at 2023-01-31T22:00Z and look at the segment from the developer's captured camera.
    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: PRESERVE_EXTENT_ID,
        timeUtc: OPENING_HOUR_UTC,
      }),
    );
    expect(await readModeledSelectedTimeUtcMs(page), 'opening time from the URL').toBe(openingUtcMs);
    await settleScene(page, 'opening-frame');
    await moveCameraAndSettle(page, OPENING_CAMERA_POSE, 'segment-developer-camera');
    await waitForModeledWaterIdle(page);
    await settleScene(page, 'segment-developer-camera-loaded');

    // Click the segment's water so its Water-Surface Elevation Chart appears.
    await clickSegmentWaterAtGroundPoint(page, { segmentId: SEGMENT_ID, groundWgs84: OPENING_WATER_CLICK_WGS84 });
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
    const pipelineInput = { ...pipelineOutput, timeUtcMs: pointed.timeUtcMs };
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
    const expectedBucket = bucketFor(ribbonPolygons, SEGMENT_ID, clickedElevationM - anchorBedM);
    expect(expectedBucket.minWaterSurfaceElevationM, 'the peak water differs from the opening water').not.toBe(
      openingBucket.minWaterSurfaceElevationM,
    );
    await expect
      .poll(() => drawnBucketMinDepthM(page, SEGMENT_ID), {
        message: `segment water drawn at the clicked hour's ${clickedElevationM} m elevation depth bucket`,
      })
      .toBe(expectedBucket.minWaterSurfaceElevationM);
    expect((await readSelection(page)).chartCursorTimeUtcMs, 'chart time cursor').toBe(pointed.timeUtcMs);

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
