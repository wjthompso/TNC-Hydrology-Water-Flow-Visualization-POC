import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
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
 * Bug Check (Linear UCS-271): at a low-flow hour the water of neighbouring Creek Segments must meet at their
 * shared boundary with no step and no dry bed between them. Setup is the default modeled pairing: WSE Polygon
 * Generation Method `flowline-channel-ribbon` v2 drawn with the `m5-flowline-profile-jarrett-depth` v1 Time Series.
 *
 * The hour is 2023-02-01T00:00Z (Jan 31 2023, 4:00 PM PST), the last hour of the hourly record. Side creek
 * 27714697 carries about 5 cm of water there. The old hour, 2017-10-01T00:00Z, has no water on this creek under
 * the default pairing, so this test no longer covers it.
 *
 * The first click is the developer's own, captured with the dev tools on Creek Segment 044's water. The second is the
 * shared boundary station of 043 and 044, taken from the saved ribbon polygons
 * (data/pipeline-working-output/dangermond-preserve/04-water-surface-polygons/flowline-channel-ribbon/v2/
 * water-surface-polygon-sets/27714697.json): the last station of 043 and the first station of 044 have identical
 * edge vertices at every rung, and the click is the midpoint between that station's left and right edge vertex at
 * the hour's junction depth (0.05 m), at the ring z (the lidar bed there).
 *
 * A third click, at the 044/045 boundary, was left out on purpose: the browser terrain sits above the thin water
 * there, so no water is hit. The developer judged the remaining stair-stepping small and in another place, and
 * will add a click of their own if they want to guard it.
 */
const WET_HOUR_UTC = '2023-02-01T00:00:00Z';
const PRESERVE_EXTENT_ID = 'dangermond-preserve';
const SIDE_CREEK_TNC_COMID = '27714697';
/** The default pairing's Time Series, whose files the page reads at that hour. */
const DEFAULT_MODELED_WSE_VERSION_PATH = 'm5-flowline-profile-jarrett-depth/v1';
const RIBBON_POLYGON_SETS_FILE = `04-water-surface-polygons/flowline-channel-ribbon/v2/water-surface-polygon-sets/${SIDE_CREEK_TNC_COMID}.json`;

/** The developer's camera over Creek Segments 043 to 045; every click below projects inside its viewport. */
const DEVELOPER_CAMERA_POSE: TestCameraPose = {
  positionWgs84: [-120.48016660362681, 34.53959749625079, 261.04989957343787],
  headingDegrees: 339.46268439187014,
  tiltDegrees: 80.99470992922816,
};

const CREEK_BED_CLICKS: readonly DeveloperCreekBedClick[] = [
  // The developer's click on Creek Segment 044's water (water hit z 253.66231 m).
  {
    nearestSegmentId: '27714697-044',
    cameraPose: DEVELOPER_CAMERA_POSE,
    groundWgs84: { longitude: -120.48100753356474, latitude: 34.54115811410782, z: 253.66231 },
  },
  // Shared boundary station of Creek Segments 043 (upstream) and 044.
  {
    nearestSegmentId: '27714697-043',
    cameraPose: DEVELOPER_CAMERA_POSE,
    groundWgs84: { longitude: -120.481047, latitude: 34.54128305, z: 257.405 },
  },
];

test('No stair-stepping (proper water polygon slanting): Modeled water at a low-flow hour shows no stair-stepping between neighbouring Creek Segments — clicking the creek bed at the segment boundary returns a water-surface hit.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    // Wet hour on side creek 27714697. Stop if that hour's saved output is missing.
    const timeUtcMs = Date.parse(WET_HOUR_UTC);
    const missing = missingLocalPipelineOutput({
      extentId: PRESERVE_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: SIDE_CREEK_TNC_COMID,
      timesUtcMs: [timeUtcMs],
      modeledWseVersionPath: DEFAULT_MODELED_WSE_VERSION_PATH,
      extraRelativePaths: [RIBBON_POLYGON_SETS_FILE],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);

    // Open modeled water at that hour and let the first frame settle.
    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: PRESERVE_EXTENT_ID,
        timeUtc: WET_HOUR_UTC,
        imagery: FAST_TEST_SCENE_IMAGERY_ID,
      }),
    );
    expect(await readModeledSelectedTimeUtcMs(page), 'opening time from the URL').toBe(timeUtcMs);
    await settleScene(page, 'opening-frame');

    // The developer's water click and the 043/044 segment-boundary click must each hit water.
    failures.push(
      ...(await replayDeveloperClicks(page, CREEK_BED_CLICKS, WET_HOUR_UTC, async (pose, label) => {
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
