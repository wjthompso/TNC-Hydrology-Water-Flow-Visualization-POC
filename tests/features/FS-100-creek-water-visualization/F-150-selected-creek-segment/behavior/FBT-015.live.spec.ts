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
} from './selected-creek-segment-page.ts';

/** Neighbouring Jalama Creek Segments; both show wide water at the flood peak. */
const FIRST_SEGMENT_ID = '27714637-046';
const SECOND_SEGMENT_ID = '27714637-047';
const PEAK_HOUR_UTC = '2023-01-10T01:00:00Z';

/** Methodology: see the FBT-015 catalog entry. */
test('Clicking a creek segment highlights only that segment and shows its water-surface elevation chart; clicking another segment moves the highlight and the chart to it.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    // Flood peak on Jalama. Neighbouring segments 27714637-046 and 27714637-047 both have wide water.
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
    const modeled = { kind: 'modeled', extentId: JALAMA_EXTENT_ID } as const;
    const bucketOf = (segmentId: string) => {
      const elevationM = elevations?.get(segmentId);
      if (typeof elevationM !== 'number') {
        throw new Error(`The local pipeline output has no modeled value for ${segmentId} at ${PEAK_HOUR_UTC}.`);
      }
      return bucketFor(modeled, segmentId, elevationM);
    };
    const firstBucket = bucketOf(FIRST_SEGMENT_ID);
    const secondBucket = bucketOf(SECOND_SEGMENT_ID);

    // Open that hour. No segment is selected or highlighted, and the chart has no readings.
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
    const before = await readSelection(page);
    expect(before.selectedCreekSegmentId, 'nothing is selected on open').toBeNull();
    expect(before.highlightedSegmentIds, 'nothing is highlighted on open').toEqual([]);
    expect(before.chartPointCount, 'the chart is empty on open').toBe(0);

    // Click 046, then 047. Each click highlights only that segment and moves the chart to it.
    for (const [segmentId, bucket] of [
      [FIRST_SEGMENT_ID, firstBucket],
      [SECOND_SEGMENT_ID, secondBucket],
    ] as const) {
      await moveCameraAndSettle(page, topDownPoseOverBucket(bucket), `${segmentId}-top-down`);
      await waitForModeledWaterIdle(page);
      await settleScene(page, `${segmentId}-loaded`);
      await clickSegmentWater(page, { segmentId, bucket });
      await expect
        .poll(async () => (await readSelection(page)).highlightedSegmentIds, {
          message: `only ${segmentId} is highlighted`,
        })
        .toEqual([segmentId]);
      const selected = await readSelection(page);
      expect(selected.chartSegmentId, 'chart shows the clicked segment').toBe(segmentId);
      expect(selected.chartPointCount, 'chart has readings').toBeGreaterThan(0);
      await expect(page.locator('#wse-chart-segment')).toHaveText(`Creek Segment ${segmentId}`);
      await expect(page.locator('#wse-chart-plot')).toBeVisible();
    }

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
