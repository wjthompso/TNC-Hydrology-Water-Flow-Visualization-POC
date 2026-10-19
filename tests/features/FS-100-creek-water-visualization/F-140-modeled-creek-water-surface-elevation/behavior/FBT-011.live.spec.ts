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
import { NATIONAL_WATER_MODEL_HOURLY_DATASET_ID, missingLocalPipelineOutput } from './local-pipeline-output.ts';
import {
  modeledWaterPageUrl,
  openModeledWaterPage,
  readModeledSelectedTimeUtcMs,
  replayDeveloperClicks,
  waitForModeledWaterIdle,
  type DeveloperCreekBedClick,
} from './modeled-water-page.ts';

/**
 * Bug Check (Linear UCS-271): at a low-flow hour the flat per-segment water
 * terraces float as separate steps above the sloping creek bed, leaving it dry
 * between neighbouring Creek Segments. The developer clicked these three
 * creek-bed points on side creek 27714697 (Creek Segments 043 and 044) and
 * got no water-surface hit.
 */
const LOW_FLOW_HOUR_UTC = '2017-10-01T00:00:00Z';
const PRESERVE_EXTENT_ID = 'dangermond-preserve';
const SIDE_CREEK_TNC_COMID = '27714697';

const DEVELOPER_CAMERA_POSE: TestCameraPose = {
  positionWgs84: [-120.4799349146629, 34.53827269369139, 354.00081856921315],
  headingDegrees: 343.88632274684943,
  tiltDegrees: 71.89897249249287,
};

const CREEK_BED_CLICKS: readonly DeveloperCreekBedClick[] = [
  {
    nearestSegmentId: '27714697-043',
    cameraPose: DEVELOPER_CAMERA_POSE,
    groundWgs84: { longitude: -120.48115697677166, latitude: 34.54147165225473, z: 263.9188833956932 },
  },
  {
    nearestSegmentId: '27714697-044',
    cameraPose: DEVELOPER_CAMERA_POSE,
    groundWgs84: { longitude: -120.4808975352711, latitude: 34.540894472119504, z: 243.20766696840792 },
  },
  {
    nearestSegmentId: '27714697-043',
    cameraPose: DEVELOPER_CAMERA_POSE,
    groundWgs84: { longitude: -120.48111600470645, latitude: 34.541508705514694, z: 264.75220041930436 },
  },
];

test('No stair-stepping (proper water polygon slanting): Modeled water at a low-flow hour shows no stair-stepping between neighbouring Creek Segments — clicking the creek bed at the segment boundary returns a water-surface hit.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    const timeUtcMs = Date.parse(LOW_FLOW_HOUR_UTC);
    const missing = missingLocalPipelineOutput({
      extentId: PRESERVE_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: SIDE_CREEK_TNC_COMID,
      timesUtcMs: [timeUtcMs],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);

    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: PRESERVE_EXTENT_ID,
        timeUtc: LOW_FLOW_HOUR_UTC,
      }),
    );
    expect(await readModeledSelectedTimeUtcMs(page), 'opening time from the URL').toBe(timeUtcMs);
    await settleScene(page, 'opening-frame');

    failures.push(
      ...(await replayDeveloperClicks(page, CREEK_BED_CLICKS, LOW_FLOW_HOUR_UTC, async (pose, label) => {
        await moveCameraAndSettle(page, pose, label);
        await waitForModeledWaterIdle(page);
        await settleScene(page, `${label}-frame`);
      })),
    );
    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
