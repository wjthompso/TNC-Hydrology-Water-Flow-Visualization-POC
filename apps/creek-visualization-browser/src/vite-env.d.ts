/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARCGIS_API_KEY?: string;
  /** "true" when the page is served for automated tests. */
  readonly VITE_TEST_MODE?: string;
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
