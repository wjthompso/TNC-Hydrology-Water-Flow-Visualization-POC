import type { WsePolygonGenerationMethodConfig } from '../wse-polygon-generation-method.ts';

/**
 * WSE Polygon Generation Method `junction-sloped-terrain-fill`: the UCS-271 Stage 4 behaviour.
 * Changing anything in this folder, a parameter below, or a shared code file listed here changes
 * this method's output, so bump `version` with it (see METHODOLOGY.md "WSE Polygon Generation Methods").
 */
export const JUNCTION_SLOPED_TERRAIN_FILL_METHOD = {
  id: 'junction-sloped-terrain-fill',
  label: 'Junction-sloped terrain fill',
  version: 1,
  description:
    'Per elevation bucket, flood-fills USGS 3DEP terrain below a wet threshold that slopes from the mean downstream ' +
    'to the mean upstream junction WSE of the modeled values in that bucket, inside a corridor cut at the junction ' +
    'bisectors. The browser draws each polygon sloped between the junction WSEs at the selected time.',
  browserDrawing: 'sloped-between-junctions',
  sharedCodeFiles: ['pipelines/creek-visualization-data-production/water-surface-polygon-generation.ts'],
  parameters: {
    /**
     * Elevation-bucket ladder per Creek Segment. Buckets are half-open [min, max) and the
     * prepared water-surface polygon is built at the bucket minimum, as in publish.
     * Floor: the 0.05 m multiple at or below the segment bed elevation (Stage 1).
     * Fine steps run through the bucket holding the highest WSE in any modeled Time Series;
     * coarse steps then continue until the ladder reaches that WSE + the headroom.
     */
    fineStepM: 0.05,
    coarseStepM: 0.25,
    headroomAboveMaxModeledWseM: 2,
    polygonGeneration: 'publish water-surface-polygon-generation.ts: corridor width, 8-connectivity, Bank-overlap margin',
    corridorEnds: 'cut at the angle bisector of the two Creek Segments sharing each vertex, so neighbouring corridors meet on one line',
    wetThreshold:
      'sloped from the mean downstream junction WSE to the mean upstream junction WSE of the Stage 3 values in the bucket, measured between the corridor boundary lines (0 on the start boundary, 1 on the end boundary), never below the bucket minimum; flat at the bucket minimum when no value fell in it',
    fileLayout: 'one compact JSON file per TNC flowline: water-surface-polygon-sets/<tncComid>.json',
    floodFillSeeds: 'centerline cells plus every Stage 1 thalweg point inside the Creek Segment corridor',
  },
} as const satisfies WsePolygonGenerationMethodConfig;

export type JunctionSlopedTerrainFillParameters = typeof JUNCTION_SLOPED_TERRAIN_FILL_METHOD.parameters;
