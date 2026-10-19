/**
 * Fixtures and helpers for FBT-010. The ground points, camera pose, and pinned
 * water-surface elevation reproduce the developer-captured red evidence stored
 * in `FBT-010-bug-reproduction.json`.
 */

import type { Page } from '../../../../support/browser/response-cache/index.ts';
import type { TestCameraPose } from '../../../../support/browser/test-mode-api';

/** Below-water, upward-tilt camera that first produced the rim-hole evidence. */
export const BANK_OVERLAP_CAMERA_POSE: TestCameraPose = {
  positionWgs84: [-120.48482532093283, 34.5136878982537, 26.03710826765746],
  headingDegrees: 342.69522920950175,
  tiltDegrees: 95.47481579768125,
};

/** Pinned water-surface elevation (m) for the Jalama gauge Creek Segment. */
export const PINNED_WSE_M = 26.5;

export interface GroundPointWgs84 {
  readonly longitude: number;
  readonly latitude: number;
  readonly z: number;
}

/** Captured hole: `view.hitTest` returned no water-surface hit here, exposing the bank. */
export const HOLE_GROUND_POINT_WGS84: GroundPointWgs84 = {
  longitude: -120.48485150773564,
  latitude: 34.51378253234741,
  z: 26.58644055498867,
};

/** Captured known-good: `view.hitTest` returned a water-surface hit for segment 27714637-026. */
export const KNOWN_GOOD_GROUND_POINT_WGS84: GroundPointWgs84 = {
  longitude: -120.48483592988221,
  latitude: 34.51372363407967,
  z: 26.499997991137207,
};

/** Jalama gauge Creek Segment identifier the pin and hit-test match against. */
const EXPECTED_SEGMENT_ID = '27714637-026';
const EXPECTED_BUCKET_MIN_ELEVATION_M = 26.5;

export async function pinSegmentWaterSurfaceElevationM(
  page: Page,
  segmentId: string,
  elevationM: number | null,
): Promise<void> {
  await page.evaluate(
    async ({ segmentId: id, elevationM: value }) => {
      const seam = window.__TNC_TEST__;
      if (!seam?.pinSegmentWaterSurfaceElevationM) {
        throw new Error(
          'The water-surface pin seam is missing. Serve the page with VITE_TEST_MODE=true.',
        );
      }
      await seam.pinSegmentWaterSurfaceElevationM(id, value);
    },
    { segmentId, elevationM },
  );
}

export type GroundPointHitResult =
  | { ok: true }
  | { ok: false; failureMessage: string };

/**
 * Viewport-independent water-surface check at a WGS84 ground point. Projects
 * the point to a screen pixel through the test seam, then calls `hitTestAtScreen`
 * on that pixel. Reports a readable failure message describing the full hit
 * list when no matching water-surface hit is returned.
 */
export async function hitTestAtGroundPoint(
  page: Page,
  groundPointWgs84: GroundPointWgs84,
): Promise<GroundPointHitResult> {
  return page.evaluate(
    async ({ groundPoint, expectedSegmentId, expectedBucketMinM }) => {
      const seam = window.__TNC_TEST__;
      if (!seam) throw new Error('The test seam is missing.');

      const screenPoint = seam.projectMapPointToScreen(groundPoint);
      const groundPointLabel = `(${groundPoint.longitude}, ${groundPoint.latitude})`;
      if (!screenPoint) {
        return {
          ok: false as const,
          failureMessage: `at ground point ${groundPointLabel} the point is off-screen`,
        };
      }

      const capture = await seam.hitTestAtScreen(screenPoint);
      const waterHitsForSegment = capture.hits.filter(
        (hit) => hit.graphicType === 'water-surface' && hit.segmentId === expectedSegmentId,
      );

      if (waterHitsForSegment.length === 0) {
        const serializedHits = capture.hits
          .map((hit) =>
            hit.graphicType === 'water-surface'
              ? `water-surface(segment ${hit.segmentId ?? '?'}, bucket ${hit.bucketMinElevationM ?? '?'}-${hit.bucketMaxElevationM ?? '?'})`
              : `other(layer ${hit.layerId ?? 'unknown'})`,
          )
          .join(', ');
        return {
          ok: false as const,
          failureMessage: `at ground point ${groundPointLabel} no water-surface hit on segment ${expectedSegmentId} was returned by hitTest; all hits: [${serializedHits}]`,
        };
      }

      const mismatchedBucket = waterHitsForSegment.find(
        (hit) => hit.bucketMinElevationM !== expectedBucketMinM,
      );
      if (mismatchedBucket) {
        return {
          ok: false as const,
          failureMessage: `water-surface hit returned bucket ${mismatchedBucket.bucketMinElevationM ?? 'null'} instead of ${expectedBucketMinM}`,
        };
      }

      return { ok: true as const };
    },
    {
      groundPoint: groundPointWgs84,
      expectedSegmentId: EXPECTED_SEGMENT_ID,
      expectedBucketMinM: EXPECTED_BUCKET_MIN_ELEVATION_M,
    },
  );
}
