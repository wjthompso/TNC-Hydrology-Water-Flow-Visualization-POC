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
      /**
       * Runs `SceneView.hitTest` at a screen point and returns a camera pose,
       * ground hit, and every reported graphic. Shared with the dev HUD so
       * HUD-captured fixtures and future replay tests use one capture shape.
       */
      hitTestAtScreen(screen: {
        readonly x: number;
        readonly y: number;
      }): Promise<TestHitTestCapture>;
      /**
       * Projects a WGS84 ground point to a screen pixel. Returns null when the
       * SceneView is not ready, when the ArcGIS `toScreen` call returns null,
       * or when the projected pixel lies outside the view's viewport. Available
       * in all environments so viewport-independent hit-testing fixtures do not
       * require test mode.
       */
      projectMapPointToScreen(mapPoint: {
        readonly longitude: number;
        readonly latitude: number;
        readonly z?: number | null;
      }): { readonly x: number; readonly y: number } | null;
      /**
       * Test-only pin that forces a specific water-surface elevation on one
       * Creek Segment, replacing the resolved placement's bucket with the
       * matching prepared bucket. Passing `null` clears the pin. Awaits a
       * renderer flush so the frame reflects the pin before resolving.
       * Present only when the page is served in test mode.
       */
      pinSegmentWaterSurfaceElevationM?(
        segmentId: string,
        elevationM: number | null,
      ): Promise<void>;
      /**
       * Frozen view of the renderer's current segment identity list. Mirrors
       * `waterGraphicGeometryIdentity`.
       */
      readonly segmentPlacements: readonly {
        readonly segmentId: string;
        readonly bucketMinElevationM: number | null;
      }[];
    };
    /**
     * Modeled-water experience seam, present only on a page opened with a
     * modeled Dataset (`?dataset=...`). Installed by modeled-creek-experience.ts.
     */
    __TNC_MODELED__?: {
      readonly datasetId: string;
      readonly extentId: string;
      readonly selectedTimeUtcMs: number;
      /** True while a per-flowline polygon or Time Series file is still loading. */
      readonly isLoading: boolean;
      /** Resolves once every pending fetch landed and the renderer drew the result. */
      whenIdle(): Promise<void>;
      /** The modeled water on one Creek Segment at the selected time; null when not in the extent. */
      readSegment(segmentId: string): {
        readonly segmentId: string;
        readonly tncComid: string;
        readonly elevationM: number | null;
        readonly isLoaded: boolean;
        readonly drainageAreaRatioTransfer: boolean;
      } | null;
    };
  }
}

export interface TestHitTestCaptureHit {
  readonly layerId: string | null;
  readonly graphicType: 'water-surface' | 'other';
  readonly segmentId: string | null;
  readonly bucketMinElevationM: number | null;
  readonly bucketMaxElevationM: number | null;
  readonly mapPointWgs84: {
    readonly longitude: number;
    readonly latitude: number;
    readonly z: number | null;
  } | null;
  readonly distanceM: number | null;
}

export interface TestHitTestCapture {
  readonly screenPoint: { readonly x: number; readonly y: number };
  readonly cameraPose: {
    readonly positionWgs84: readonly [number, number, number];
    readonly headingDegrees: number;
    readonly tiltDegrees: number;
  };
  readonly mapHitWgs84: {
    readonly longitude: number;
    readonly latitude: number;
    readonly z: number | null;
  } | null;
  readonly hits: readonly TestHitTestCaptureHit[];
}

export interface TestCameraPose {
  /** Longitude, latitude, and height in meters. */
  readonly positionWgs84: readonly [number, number, number];
  readonly headingDegrees: number;
  readonly tiltDegrees: number;
}
