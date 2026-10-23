// Capture shape returned by `__TNC_TEST__.hitTestAtScreen`. This schema is
// also serialized by the dev HUD "Copy capture JSON" button and consumed by
// future replay-style feature-behavior tests, so keep the field names and
// units stable.

export interface HitTestCaptureHit {
  layerId: string | null;
  graphicType: 'water-surface' | 'other';
  segmentId: string | null;
  /**
   * Bucket minimum, m NAVD88. For a `bed-parallel-depth` method, whose buckets
   * are water depths, the modeled water-surface elevation at the anchor instead
   * (and `bucketMaxElevationM` is null); the depth bounds are in the fields below.
   */
  bucketMinElevationM: number | null;
  bucketMaxElevationM: number | null;
  /** `bed-parallel-depth` water only: modeled water-surface elevation at the anchor, m NAVD88. */
  waterSurfaceElevationM?: number | null;
  /** `bed-parallel-depth` water only: the drawn bucket's water-depth bounds, m. */
  bucketMinDepthM?: number | null;
  bucketMaxDepthM?: number | null;
  mapPointWgs84: { longitude: number; latitude: number; z: number | null } | null;
  distanceM: number | null;
}

export interface HitTestCapture {
  screenPoint: { x: number; y: number };
  cameraPose: {
    positionWgs84: [number, number, number];
    headingDegrees: number;
    tiltDegrees: number;
  };
  mapHitWgs84: { longitude: number; latitude: number; z: number | null } | null;
  hits: HitTestCaptureHit[];
}
