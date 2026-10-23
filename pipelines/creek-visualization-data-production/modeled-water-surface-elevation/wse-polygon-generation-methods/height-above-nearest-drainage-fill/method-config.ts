import type { WsePolygonGenerationMethodConfig } from '../wse-polygon-generation-method.ts';

/**
 * WSE Polygon Generation Method `height-above-nearest-drainage-fill`. Traces water by its DEPTH above
 * the local creek bed (height above nearest drainage, HAND) instead of by elevation, so a steep
 * Creek Segment gets a ribbon of water that follows the bed downhill instead of a flat lake.
 *
 * IMPORTANT: in this method's polygon sets, `minWaterSurfaceElevationM` and `maxWaterSurfaceElevationM`
 * of each bucket are WATER DEPTHS in meters above the local bed, not elevations. The field names are
 * kept so the file shape stays the same. `browserDrawing: 'bed-parallel-depth'` tells the browser,
 * and every ring vertex is `[lon, lat, bedReferenceM]` so the browser draws z = bedReferenceM + depth.
 * Needs a Time Series with m2's depth fields (`m2-multi-section-manning-depth`).
 *
 * Changing anything in this folder or a parameter below changes the output, so bump `version` with it.
 */
export const HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD = {
  id: 'height-above-nearest-drainage-fill',
  label: 'Height above nearest drainage (bed-parallel) fill',
  version: 1,
  description:
    'Per depth bucket, flood-fills USGS 3DEP cells whose height above the local creek bed (interpolated along the Stage 1 ' +
    'thalweg points) is below the bucket depth, inside a corridor cut at the junction bisectors. Bucket bounds are depths, ' +
    'not elevations; the browser draws each ring vertex at its bed reference plus the modeled depth, so water follows the bed.',
  browserDrawing: 'bed-parallel-depth',
  sharedCodeFiles: ['pipelines/creek-visualization-data-production/water-surface-polygon-generation.ts'],
  parameters: {
    bucketUnits:
      'DEPTH in meters above the local bed: minWaterSurfaceElevationM / maxWaterSurfaceElevationM hold depths for this method, not elevations',
    /**
     * Depth ladder per Creek Segment, half-open [min, max) buckets in meters of depth: fine steps
     * from 0 through the bucket holding the segment's largest modeled depth, then coarse steps until
     * the top reaches that depth + the headroom. A polygon is traced at its bucket minimum depth.
     */
    fineStepM: 0.05,
    coarseStepM: 0.25,
    headroomAboveMaxModeledDepthM: 2,
    maxModeledDepth: 'largest of (value − anchorBedElevationM), junctionDepthUpstreamM, and junctionDepthDownstreamM over every Time Series file',
    /** Bucket 0 (depth 0) would wet nothing; a cell is wet when its HAND is below max(bucket minimum depth, this floor). */
    wetDepthFloorM: 0.02,
    /**
     * A cell more than this far BELOW the local reference bed is lower than this creek's own channel, so it
     * drains to a different channel (a confluence floodplain, a neighbouring gully) and stays dry. HAND assumes
     * every cell drains to the nearest drainage; this is where that assumption fails. 27714697-045 had 563 cells
     * more than 2 m below its bed at its downstream end; on 27714697-044 and 27714637-026 no wet cell is below −0.5 m.
     */
    maximumDepthBelowReferenceBedM: 0.5,
    referenceThalweg:
      "polyline through the Stage 1 thalweg points (with each section's bed elevation) in vertex order: the start-vertex neighbour's 2 sections nearest the shared vertex, " +
      "this segment's 5 sections, and the end-vertex neighbour's 2 nearest sections, so the bed field is continuous across each junction",
    referenceBed:
      'bed linearly interpolated (by distance along the polyline piece) at the nearest point of the reference thalweg polyline; ' +
      'past either end of the polyline (a flowline end, or a corridor reaching beyond the neighbour sections) the bed continues at the end grade',
    /** End grade = bed change over the outermost this-many polyline pieces ÷ their length. */
    endExtrapolationPieces: 2,
    heightAboveNearestDrainage:
      'cell elevation − reference bed; cells the reference thalweg polyline crosses are the drainage itself and get HAND 0, so the channel line is always wet and connected',
    /** Step along the reference thalweg polyline when marking the cells it crosses, meters. */
    referenceThalwegRasterStepM: 0.25,
    polygonGeneration: 'publish water-surface-polygon-generation.ts rules: ±100 m corridor, 8-connectivity, Bank-overlap margin dilation, d3-contour vectorizing',
    corridorEnds: 'cut at the angle bisector of the two Creek Segments sharing each vertex, so neighbouring corridors meet on one line',
    floodFillSeeds: 'cells the reference thalweg polyline crosses, every Stage 1 thalweg point inside the corridor, and the centerline cells',
    ringVertex: '[longitude, latitude, bedReferenceM]: 7 decimals for longitude and latitude, 3 for the reference bed (m NAVD88) at that vertex',
    ladderSummary:
      'bedElevationM = anchor bed (Stage 1 section 2); maxModeledWaterSurfaceElevationM = anchor bed + max modeled depth; ceilingM = anchor bed + ladder top depth',
    fileLayout: 'one compact JSON file per TNC flowline: water-surface-polygon-sets/<tncComid>.json',
  },
} as const satisfies WsePolygonGenerationMethodConfig;
