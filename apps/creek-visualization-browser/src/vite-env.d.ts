/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARCGIS_API_KEY?: string;
  /** "true" when the page is served for automated tests. */
  readonly VITE_TEST_MODE?: string;
  /** "hosted" or "local"; default local in dev/test mode, hosted in production builds. */
  readonly VITE_CREEK_DATA_SOURCE?: string;
  /** ArcGIS Enterprise portal URL used for sign-in to private hosted items. */
  readonly VITE_ARCGIS_PORTAL_URL?: string;
  /** Modeled water surface elevation FeatureServer URL. */
  readonly VITE_MODELED_WSE_SERVICE_URL?: string;
  /** Water surface elevation polygons FeatureServer URL. */
  readonly VITE_WSE_POLYGONS_SERVICE_URL?: string;
  /** Exact ribbon rings FeatureServer URL; default: the polygons service name plus `_rings`. */
  readonly VITE_WSE_POLYGON_RINGS_SERVICE_URL?: string;
  /** Observed Creek Gauge Data FeatureServer URL (public). */
  readonly VITE_CREEK_GAUGE_SERVICE_URL?: string;
  /** "true" shows the California Natural Flows monthly Dataset; default hidden. */
  readonly VITE_SHOW_CALIFORNIA_NATURAL_FLOWS_MONTHLY?: string;
  /**
   * "true" shows the Dev tools button and honors `?devtools`. "false" hides both.
   * Default: on for the development server, off for production builds.
   */
  readonly VITE_SHOW_DEV_TOOLS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * `@arcgis/core` 4.34 ships `ElevationTileData` as a runtime-only module with no
 * bundled type declaration. The constructor is positional
 * `(values, width, height, noDataValue)`; an object argument is only honored when
 * it carries a `pixelData` key. This ambient declaration mirrors that runtime shape.
 */
declare module '@arcgis/core/layers/support/ElevationTileData' {
  export class ElevationTileData {
    constructor(
      values: Float32Array,
      width: number,
      height: number,
      noDataValue: number,
    );
    values: Float32Array;
    width: number;
    height: number;
    noDataValue: number;
    readonly hasNoDataValues: boolean;
    readonly minValue: number | null;
    readonly maxValue: number | null;
    readonly usedMemory: number;
  }
}
