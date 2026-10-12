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
      /** Camera position height in meters. Null before the view exists. */
      readonly cameraAltitudeM: number | null;
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

export {};
