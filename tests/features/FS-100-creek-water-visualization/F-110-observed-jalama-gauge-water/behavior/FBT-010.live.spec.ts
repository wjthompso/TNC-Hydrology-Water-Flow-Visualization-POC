import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  GAUGE_SEGMENT_ID,
  openObservedWaterPage,
  readSeam,
  rethrowIfExternalOutage,
  watchLiveServices,
} from './observed-jalama-gauge-water.ts';
import {
  moveCameraAndSettle,
  settleScene,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-camera.ts';
import {
  BANK_OVERLAP_CAMERA_POSE,
  HOLE_GROUND_POINT_WGS84,
  KNOWN_GOOD_GROUND_POINT_WGS84,
  PINNED_WSE_M,
  hitTestAtGroundPoint,
  pinSegmentWaterSurfaceElevationM,
} from './bank-overlap-margin-fixtures.ts';

/**
 * Bug Check: at a below-water, upward-tilt camera, the water-surface polygon
 * rim leaves a hole that exposes the bank terrain beyond. The pinned WSE of
 * 26.50 m, the camera pose, and the two ground points come from the developer
 * capture stored in `FBT-010-bug-reproduction.json`.
 */
test('Looking up from below the water surface, the water-surface polygon fills the view and does not leave a hole exposing the bank terrain beyond.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    // Open observed Jalama gauge readings on Esri World Imagery.
    await openObservedWaterPage(page, watch, FAST_TEST_SCENE_IMAGERY_ID);

    // The gauge Creek Segment's water is held at 26.50 m.
    await pinSegmentWaterSurfaceElevationM(page, GAUGE_SEGMENT_ID, PINNED_WSE_M);
    await settleScene(page, 'pin-wse');

    const seam = await readSeam(page);
    const pinnedPlacement = seam.waterGraphicGeometryIdentity.find(
      (placement) => placement.segmentId === GAUGE_SEGMENT_ID,
    );
    expect(pinnedPlacement?.bucketMinElevationM).toBe(PINNED_WSE_M);

    // Look up at the bank from just below the water.
    await moveCameraAndSettle(page, BANK_OVERLAP_CAMERA_POSE, 'bank-overlap-camera');

    // A point on the water still hits the water surface.
    const knownGoodResult = await hitTestAtGroundPoint(page, KNOWN_GOOD_GROUND_POINT_WGS84);
    expect(
      knownGoodResult.ok,
      knownGoodResult.ok ? '' : knownGoodResult.failureMessage,
    ).toBe(true);

    // The former hole over the bank now hits the water surface too.
    const holeResult = await hitTestAtGroundPoint(page, HOLE_GROUND_POINT_WGS84);
    expect(holeResult.ok, holeResult.ok ? '' : holeResult.failureMessage).toBe(true);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
