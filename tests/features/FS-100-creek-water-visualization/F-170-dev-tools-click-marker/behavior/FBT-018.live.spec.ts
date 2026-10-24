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
  topDownPoseOverBucket,
} from '../../F-150-selected-creek-segment/behavior/selected-creek-segment-page.ts';
import {
  countClickMarkerPixels,
  MIN_CLICK_MARKER_PIXELS,
  setDevToolsOpen,
} from './dev-tools-click-marker-page.ts';

/** Wide water at the flood peak, the same segment FBT-015 clicks first. */
const SEGMENT_ID = '27714637-046';
const PEAK_HOUR_UTC = '2023-01-10T01:00:00Z';

/** Methodology: see the FBT-018 catalog entry. */
test('Clicking the map while DevTools are closed, then opening DevTools, shows a yellow ring at that on-map click location; collapsing DevTools removes the ring, and opening DevTools again shows the same ring.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try { 
    // Read the National Water Model hourly elevation for Creek Segment 27714637-046 at the 2023-01-10T01:00Z flood peak.
    const peakUtcMs = Date.parse(PEAK_HOUR_UTC);
    const missing = missingLocalPipelineOutput({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timesUtcMs: [peakUtcMs],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);
    const elevations = readWaterSurfaceElevationsAt({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timeUtcMs: peakUtcMs,
    });
    const elevationM = elevations?.get(SEGMENT_ID);
    if (typeof elevationM !== 'number') {
      throw new Error(`The local pipeline output has no modeled value for ${SEGMENT_ID} at ${PEAK_HOUR_UTC}.`);
    }
    const bucket = bucketFor({ kind: 'modeled', extentId: JALAMA_EXTENT_ID }, SEGMENT_ID, elevationM);

    // Open that Dataset at 2023-01-10T01:00Z with DevTools closed, and look down on the segment.
    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: JALAMA_EXTENT_ID,
        timeUtc: PEAK_HOUR_UTC,
      }),
    );
    await settleScene(page, 'opening-frame');
    await expect(page.locator('#dev-tools-toggle')).toHaveAttribute('aria-expanded', 'false');

    await moveCameraAndSettle(page, topDownPoseOverBucket(bucket), `${SEGMENT_ID}-top-down`);
    await waitForModeledWaterIdle(page);
    await settleScene(page, `${SEGMENT_ID}-loaded`);
    // Click the segment's water while DevTools stay closed. The yellow click ring stays hidden.
    const click = await clickSegmentWater(page, { segmentId: SEGMENT_ID, bucket });
    const cdp = await page.context().newCDPSession(page);

    await expect
      .poll(() => countClickMarkerPixels(page, cdp, click), {
        message: 'the yellow ring stays off the map while dev tools are closed',
        timeout: 4_000,
      })
      .toBe(0);

    // Open DevTools. The yellow ring appears at that click.
    await setDevToolsOpen(page, true);
    await expect
      .poll(() => countClickMarkerPixels(page, cdp, click), {
        message: 'opening dev tools shows the yellow ring at the click',
        timeout: 4_000,
      })
      .toBeGreaterThanOrEqual(MIN_CLICK_MARKER_PIXELS);

    // Collapse DevTools. The yellow ring leaves the map.
    await setDevToolsOpen(page, false);
    await expect
      .poll(() => countClickMarkerPixels(page, cdp, click), {
        message: 'collapsing dev tools removes the yellow ring',
        timeout: 4_000,
      })
      .toBe(0);

    // Open DevTools again. The same yellow ring comes back.
    await setDevToolsOpen(page, true);
    await expect
      .poll(() => countClickMarkerPixels(page, cdp, click), {
        message: 'opening dev tools again shows the same yellow ring',
        timeout: 4_000,
      })
      .toBeGreaterThanOrEqual(MIN_CLICK_MARKER_PIXELS);

    await cdp.detach();
    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
