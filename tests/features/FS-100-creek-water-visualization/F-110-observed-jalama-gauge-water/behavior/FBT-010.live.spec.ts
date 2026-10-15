import { expect, test } from '../../../../support/browser/esri-response-cache.ts';
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
    await openObservedWaterPage(page, watch);

    await pinSegmentWaterSurfaceElevationM(page, GAUGE_SEGMENT_ID, PINNED_WSE_M);
    await settleScene(page, 'pin-wse');

    const seam = await readSeam(page);
    const pinnedPlacement = seam.waterGraphicGeometryIdentity.find(
      (placement) => placement.segmentId === GAUGE_SEGMENT_ID,
    );
    expect(pinnedPlacement?.bucketMinElevationM).toBe(PINNED_WSE_M);

    await moveCameraAndSettle(page, BANK_OVERLAP_CAMERA_POSE, 'bank-overlap-camera');

    const knownGoodResult = await hitTestAtGroundPoint(page, KNOWN_GOOD_GROUND_POINT_WGS84);
    expect(
      knownGoodResult.ok,
      knownGoodResult.ok ? '' : knownGoodResult.failureMessage,
    ).toBe(true);

    const holeResult = await hitTestAtGroundPoint(page, HOLE_GROUND_POINT_WGS84);
    expect(holeResult.ok, holeResult.ok ? '' : holeResult.failureMessage).toBe(true);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
