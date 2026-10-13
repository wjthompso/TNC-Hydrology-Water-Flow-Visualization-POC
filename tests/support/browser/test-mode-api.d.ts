declare global {
  interface Window {
    __TNC_TEST__?: {
      ready: Promise<boolean>;
      readonly selectedTimeUtcMs: number | null;
      readonly waterSegmentIds: readonly string[];
      readonly waterGraphicGeometryIdentity: readonly {
        segmentId: string;
        bucketMinElevationM: number | null;
      }[];
      /** SceneView center as longitude, latitude. Null before the view exists. */
      readonly cameraTargetWgs84: readonly [number, number] | null;
      /** True while SceneView is drawing or loading. */
      readonly sceneUpdating: boolean;
      /** True when no camera animation or user navigation is in progress. */
      readonly sceneStationary: boolean;
      /** Camera position height in meters. Null before the view exists. */
      readonly cameraAltitudeM: number | null;
      /** Camera position, heading, and tilt. Null before the view exists. */
      readonly cameraPose: TestCameraPose | null;
      /** Moves the camera instantly. Present only when the page is served in test mode. */
      moveCamera?(pose: TestCameraPose): Promise<void>;
      /**
       * Drawn-ground elevations at screen points, from SceneView `toMap`.
       * `elevationM` is null when that ray misses the rendered terrain mesh.
       */
      sampleRenderedGroundHeights(
        screenPoints: readonly { readonly x: number; readonly y: number }[],
      ): readonly {
        readonly x: number;
        readonly y: number;
        readonly elevationM: number | null;
        readonly longitude: number | null;
        readonly latitude: number | null;
      }[];
    };
  }
}

export interface TestCameraPose {
  /** Longitude, latitude, and height in meters. */
  readonly positionWgs84: readonly [number, number, number];
  readonly headingDegrees: number;
  readonly tiltDegrees: number;
}
