import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  gaugeSegmentMidpointWgs84,
  GAUGE_SEGMENT_ID,
  openObservedWaterPage,
  watchLiveServices,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import {
  moveCameraAndSettle,
  readCameraPose,
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
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/local-pipeline-output.ts';
import {
  chooseDataset,
  countPageLoads,
  modeledWaterIsDrawn,
  readDrawnWaterSegmentIds,
  readExperienceTitle,
  readSceneSurvival,
  tagLiveScene,
} from './dataset-switching-page.ts';

const OBSERVED_DATASET_OPTION_ID = 'observed-gauge';
/** How long a switch may take to show the new Dataset's water. */
const SWITCH_BUDGET_MS = 9_000;
/** A carried camera may drift this far: about 10 m of longitude or latitude, 5 m of height, 1 degree of heading or tilt. */
const POSITION_TOLERANCE_DEGREES = 1e-4;
const HEIGHT_TOLERANCE_M = 5;
const ANGLE_TOLERANCE_DEGREES = 1;

/** Methodology: see the FBT-019 catalog entry. */
test('Switching the Dataset in the picker replaces the creek water on the same map, without reloading the page or rebuilding the scene.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    // The Jalama extent needs its National Water Model hourly output on disk before the Dataset switch can be checked.
    const missing = missingLocalPipelineOutput({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timesUtcMs: [],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);

    // Open the Observed gauge Dataset on the Jalama extent and park the camera over the Jalama gauge Creek Segment. The live map is remembered so a later switch can show a reload or a rebuilt scene.
    await openObservedWaterPage(
      page,
      watch,
      FAST_TEST_SCENE_IMAGERY_ID,
      `/?modeledExtent=${JALAMA_EXTENT_ID}`,
    );
    const [longitude, latitude] = gaugeSegmentMidpointWgs84();
    await moveCameraAndSettle(
      page,
      { positionWgs84: [longitude, latitude, 400], headingDegrees: 30, tiltDegrees: 45 },
      'observed-fixed-camera',
    );
    await settleScene(page, 'observed-loaded');
    const cameraBefore = await readCameraPose(page);
    await tagLiveScene(page);
    const pageLoads = countPageLoads(page);

    // Observed to modeled.
    await chooseDataset(page, NATIONAL_WATER_MODEL_HOURLY_DATASET_ID);
    const modeledArrived = await waitUntil(
      async () => (await readExperienceTitle(page)) === 'Modeled water' && (await modeledWaterIsDrawn(page)),
    );
    if (!modeledArrived) {
      failures.push(`Modeled water did not appear within ${SWITCH_BUDGET_MS / 1000} s of choosing the modeled Dataset.`);
    }
    await expectSameLiveScene(page, pageLoads.count(), 'observed to modeled', failures);
    await expectCameraCarried(page, cameraBefore, failures);

    // Modeled back to observed.
    if (failures.length === 0) {
      await chooseDataset(page, OBSERVED_DATASET_OPTION_ID);
      const observedArrived = await waitUntil(async () => {
        const drawn = await readDrawnWaterSegmentIds(page);
        return (await readExperienceTitle(page)) === 'Observed water' && drawn?.includes(GAUGE_SEGMENT_ID) === true;
      });
      if (!observedArrived) {
        failures.push(
          `Observed gauge water did not return within ${SWITCH_BUDGET_MS / 1000} s of choosing the observed Dataset.`,
        );
      }
      await expectSameLiveScene(page, pageLoads.count(), 'modeled back to observed', failures);
    }

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});

async function waitUntil(condition: () => Promise<boolean>): Promise<boolean> {
  try {
    await expect.poll(condition, { timeout: SWITCH_BUDGET_MS, intervals: [100, 250, 500] }).toBe(true);
    return true;
  } catch {
    return false;
  }
}

async function expectSameLiveScene(
  page: Parameters<typeof readSceneSurvival>[0],
  pageLoadsSinceTagging: number,
  step: string,
  failures: string[],
): Promise<void> {
  const survival = await readSceneSurvival(page);
  if (pageLoadsSinceTagging > 0 || !survival?.sameDocument) {
    failures.push(
      `${step}: the whole page reloaded (${pageLoadsSinceTagging} page load${pageLoadsSinceTagging === 1 ? '' : 's'} since the switch), so the map, imagery, and terrain were thrown away and rebuilt.`,
    );
  }
  if (!survival?.sameSceneCanvas) {
    failures.push(`${step}: the scene was rebuilt; the SceneView canvas on screen is not the one shown before the switch.`);
  }
}

async function expectCameraCarried(
  page: Parameters<typeof readCameraPose>[0],
  before: Awaited<ReturnType<typeof readCameraPose>>,
  failures: string[],
): Promise<void> {
  const after = await readCameraPose(page);
  const [lon0, lat0, z0] = before.positionWgs84;
  const [lon1, lat1, z1] = after.positionWgs84;
  const moved =
    Math.abs(lon1 - lon0) > POSITION_TOLERANCE_DEGREES ||
    Math.abs(lat1 - lat0) > POSITION_TOLERANCE_DEGREES ||
    Math.abs(z1 - z0) > HEIGHT_TOLERANCE_M ||
    Math.abs(after.headingDegrees - before.headingDegrees) > ANGLE_TOLERANCE_DEGREES ||
    Math.abs(after.tiltDegrees - before.tiltDegrees) > ANGLE_TOLERANCE_DEGREES;
  if (moved) {
    failures.push(
      `observed to modeled: the camera did not stay where it was (before ${JSON.stringify(before)}, after ${JSON.stringify(after)}).`,
    );
  }
}
