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
    };
  }
}

export {};
