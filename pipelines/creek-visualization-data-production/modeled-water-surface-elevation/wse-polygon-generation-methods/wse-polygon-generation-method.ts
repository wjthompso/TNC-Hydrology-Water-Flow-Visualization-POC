/**
 * Shapes shared by every WSE Polygon Generation Method: a named, versioned way to turn modeled
 * water-surface elevations into the water polygons drawn for each Creek Segment. Each version keeps
 * its own saved output under `04-water-surface-polygons/<method-id>/v<version>/`, so methods can be
 * compared on the map. This file holds types only, so the browser dev server can import the registry
 * without loading any pipeline code.
 */

/**
 * How the browser draws a polygon of this method at the selected time.
 * - `sloped-between-junctions`: each ring vertex is lifted to the height interpolated between the
 *   Creek Segment's upstream and downstream junction WSEs (`sloped-water-surface.ts`).
 * - `flat-at-bucket-minimum`: the polygon is drawn flat at its elevation bucket's minimum.
 * - `bed-parallel-depth`: bucket bounds are water depths above the local creek bed, not elevations.
 *   Each ring vertex is `[lon, lat, bedReferenceM]`; the browser draws it at `bedReferenceM` plus the
 *   depth interpolated between the segment's junction depths (`junctionDepthUpstreamM` /
 *   `junctionDepthDownstreamM`), so the water surface runs parallel to the bed.
 * - `channel-ribbon-depth`: like `bed-parallel-depth` (bucket bounds are depths, vertices are `[lon, lat, bedProfileM]`), but the segment's
 *   buckets are morph targets: every bucket holds one ring with the same vertices in the same order (left edge stations upstream to downstream,
 *   then right edge back), and the browser slides each station's two edge vertices between the two depth rungs around that station's own depth.
 */
export type WsePolygonBrowserDrawing =
  | 'sloped-between-junctions'
  | 'flat-at-bucket-minimum'
  | 'bed-parallel-depth'
  | 'channel-ribbon-depth';

export interface WsePolygonGenerationMethodConfig {
  /** Plain descriptive kebab-case id; also the output folder name. Never reused for a different method. */
  id: string;
  /** Short human label for the dev tools 'Polygon method' select. */
  label: string;
  /**
   * Whole number, starting at 1. Bump it on every change to the method's code files or parameters;
   * Stage 4 refuses to overwrite an existing version folder whose recorded fingerprint differs.
   */
  version: number;
  /** One or two plain sentences: what the method does differently. Shown in the dev tools. */
  description: string;
  browserDrawing: WsePolygonBrowserDrawing;
  /**
   * Repository-relative files outside the method folder whose change changes this method's output.
   * Every file inside the method folder is always fingerprinted.
   */
  sharedCodeFiles: readonly string[];
  /** Every tunable value and rule of the method. Recorded in the version's manifest and fingerprinted. */
  parameters: Readonly<Record<string, unknown>>;
}

/**
 * What a version's Stage 4 manifest records under `parameters.wsePolygonGenerationMethod`.
 * Read back by Stage 5 and the browser dev server, so an old version keeps its own label and
 * drawing rule even after the code moved on.
 */
export interface RecordedWsePolygonGenerationMethod {
  id: string;
  label: string;
  version: number;
  description: string;
  browserDrawing: WsePolygonBrowserDrawing;
  parameters: Readonly<Record<string, unknown>>;
  /** SHA-256 per fingerprinted code file, keyed by repository-relative path. */
  codeSha256ByFile: Readonly<Record<string, string>>;
  /** SHA-256 over the code hashes and parameters together; the version rule compares this. */
  methodSha256: string;
}
