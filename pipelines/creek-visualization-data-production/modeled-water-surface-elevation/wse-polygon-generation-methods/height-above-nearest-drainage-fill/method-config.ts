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
  version: 4,
  description:
    'Per depth bucket, flood-fills USGS 3DEP cells whose height above the local creek bed (the drainage line traced on the 1 m lidar ' +
    'between the Stage 1 thalweg points) is below the bucket depth, inside a corridor cut at the junction bisectors. Bucket bounds are depths, ' +
    'not elevations; the browser draws each ring vertex at its bed reference plus the modeled depth, so water follows the bed. ' +
    'Where the bed is steep, a footprint is cut into short slices across the flow so the triangulated surface stays close to bed reference + depth. ' +
    'Version 4 is rebuilt on m2-v3, whose Time Series values are the smoothed surface at the anchor point.',
  browserDrawing: 'bed-parallel-depth',
  sharedCodeFiles: ['pipelines/creek-visualization-data-production/water-surface-polygon-generation.ts'],
  parameters: {
    /**
     * What changed in this version. The method configuration has no `changeNote` field (Modeled WSE Derivation Methods do), so
     * the note lives here, where the version's manifest records it.
     */
    changeNote: 'rebuilt on m2-v3 Time Series; geometry rules unchanged from v3',
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
    bedLine: {
      /**
       * The drainage line of a Creek Segment (version 2). Between each pair of consecutive Stage 1 thalweg points (this
       * segment's 5, plus the start-vertex neighbour's 2 nearest and the end-vertex neighbour's 2 nearest, in vertex order)
       * a least-cost path of 8-connected 1 m lidar cells is traced, then the line is resampled every `spacingM` and its bed
       * median-filtered. Version 1 joined the thalweg points with straight lines and interpolated the 5 section beds.
       */
      tracing:
        'least-cost path over 8-connected 1 m lidar cells between consecutive Stage 1 thalweg points, restricted to cells within bandHalfWidthM of the straight chord; ' +
        'entering a cell costs step length × (cell height above the lowest cell of the band, measured above the line joining the two end cells + costFloorM); ' +
        'a piece with no lidar path falls back to the straight chord with the Stage 1 section beds',
      bandHalfWidthM: 4,
      costFloorM: 0.05,
      /** Meters between resampled points of the bed line. */
      spacingM: 1,
      /** Median-filter window on the bed along the line, meters; it shrinks toward each end so the end beds stay the lidar values. A moving average rounded off steps (see bed-line-tracing.ts). */
      bedSmoothingWindowM: 5,
      bed: 'the lidar ground elevation of each traced cell, interpolated along the resampled line and median-filtered; not the Stage 1 section beds',
    },
    referenceBed:
      'bed linearly interpolated (by distance along the piece) at the nearest point of the bed line; ' +
      'past either end of the line (a flowline end, or a corridor reaching beyond the neighbour sections) the bed continues at the end grade',
    /** End grade = bed change over the outermost this-many meters of the bed line ÷ that length. */
    endGradeLengthM: 15,
    heightAboveNearestDrainage:
      'cell elevation − reference bed; cells the bed line crosses are the drainage itself and get HAND 0, so the channel line is always wet and connected',
    /** Step along the bed line when marking the cells it crosses, meters. */
    bedLineRasterStepM: 0.25,
    polygonGeneration: 'publish water-surface-polygon-generation.ts rules: ±100 m corridor, 8-connectivity, Bank-overlap margin dilation, d3-contour vectorizing',
    corridorEnds: 'cut at the angle bisector of the two Creek Segments sharing each vertex, so neighbouring corridors meet on one line',
    floodFillSeeds: 'cells the bed line crosses, every Stage 1 thalweg point inside the corridor, and the centerline cells',
    /**
     * Slicing (version 3). ArcGIS triangulates a polygon from its RIM vertices only, so a long footprint on a steep bed
     * draws a surface that can sit meters off bed reference + depth in its interior. A footprint is therefore cut into
     * slices across the flow, only where its triangulated surface deviates from the ideal surface.
     */
    slicing: {
      rule:
        'the footprint is the version 2 polygon (d3-contour of the footprint cells, corridor clip, collinear removal), taken apart into one piece per 2 × 2 block of neighbouring ' +
        'cell centers; a slice is a run of blocks ordered by their arc length along the bed line (the mean of the nearest-bed-line-point positions of the block\'s wet centers), ' +
        'so neighbouring slices meet on lines between cell centers and the slices add up to exactly the version 2 polygon. Start with one slice; while the slice with the ' +
        'largest deviation exceeds the tolerance at tolerancePercentile (earcut on its rim vertices, as ArcGIS draws, against the bed reference at each wet cell center it covers), ' +
        'is at least 2 × minimumSliceLengthM long along the bed line, and fewer than maximumSlicesPerBucket slices exist, cut it at the middle of its arc-length interval',
      /**
       * Largest allowed |triangulated surface − (bed reference + depth)| over a slice's wet cells at the percentile below, meters:
       * max(toleranceM, toleranceDepthFraction × the bucket's minimum depth). Version 3 uses 0.3 m and 1.0 because the first tolerance tried,
       * a constant 0.05 m, wrote 2,464 MiB (15.6 × version 2; METHOD.md has the whole curve); the depth term keeps deep water, whose surface
       * error rarely decides whether a point shows, from being cut for deviations that hardly matter.
       */
      toleranceM: 0.3,
      toleranceDepthFraction: 1,
      tolerancePercentile: 0.95,
      /** No cut makes a slice shorter than this along the bed line, meters. */
      minimumSliceLengthM: 1,
      /** Cap per depth bucket polygon (each bucket is cut independently); a bucket that hits the cap or the minimum length keeps its remaining deviation and is counted. */
      maximumSlicesPerBucket: 64,
      sharedVertices:
        'a vertex that appears in more than one slice is never dropped as collinear, and one stored position (7 decimals) gets one bed reference (computed once), so neighbouring slices have identical vertices and z on their cut edge',
      triangulation: 'the earcut bundled in @arcgis/core (the library the browser draws with), on the slice rim vertices',
    },
    ringVertex:
      '[longitude, latitude, bedReferenceM]: 7 decimals for longitude and latitude, 3 for the reference bed (m NAVD88) at that vertex. A bucket holds the rings of all its slices: outer rings clockwise, holes counter-clockwise',
    ladderSummary:
      'bedElevationM = anchor bed (Stage 1 section 2); maxModeledWaterSurfaceElevationM = anchor bed + max modeled depth; ceilingM = anchor bed + ladder top depth',
    fileLayout: 'one compact JSON file per TNC flowline: water-surface-polygon-sets/<tncComid>.json',
  },
} as const satisfies WsePolygonGenerationMethodConfig;
