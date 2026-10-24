import type { ModeledWseDerivationMethodConfig } from '../modeled-wse-derivation-method.ts';
import {
  CROSS_SECTION,
  DRAINAGE_AREA_RATIO_TRANSFER,
  MANNING_ROUGHNESS_BASIS,
  MAXIMUM_TRANSFER_DISTANCE_M,
  RATING_CURVE,
} from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';

/**
 * Modeled WSE Derivation Method `m2-multi-section-manning-depth`: the same discharge as m1, but a
 * Manning's rating curve at the middle (anchor) one of each Creek Segment's five Stage 1 cross-sections,
 * with its own bed and a local bed slope. The water depth at each junction is a smoothed mean of the
 * neighbouring segments' anchor depths, so the surface is continuous and the water can be drawn parallel to
 * the bed. From v3 the segment's water-surface elevation (WSE) is the WSE of that smoothed surface at the
 * anchor point; the raw Manning WSE at the anchor is kept as `rawAnchorWseM`. Read METHOD.md in this folder
 * for the full description.
 *
 * Stages 0–2 are shared with m1 (this method reuses their saved output and m1's constants); only
 * Stage 3 differs, and it runs from `stage-03-multi-section-time-series.ts` in this folder. Every
 * value below changes this method's output, so bump `version` with it (see METHODOLOGY.md
 * "Modeled WSE Derivation Methods").
 */

/** Stage 1 section index this method solves a rating curve at (Stage 1 samples 5 per Creek Segment, in vertex order). */
export const SOLVED_SECTIONS = {
  /** Mid-segment section. Its raw Manning depth feeds the junction depths; its position is where the segment's WSE applies. */
  anchorSectionIndex: 2,
} as const;

/**
 * Where the anchor sits along its segment, as a fraction from the start vertex (0) to the end vertex (1). Stage 1 puts section
 * `index` at ((index + 0.5) / sectionsPerSegment) × segment length on the chord, so the anchor (index 2 of 5) is half-way. The
 * Time Series `values` are the smoothed surface there: junction depth at the start + (end − start) × this fraction.
 */
export const ANCHOR_POSITION_ALONG_SEGMENT = (SOLVED_SECTIONS.anchorSectionIndex + 0.5) / CROSS_SECTION.sectionsPerSegment;

/**
 * Stage 1 sections whose beds (not rating curves) give the bed at each junction: the segment's first and last
 * section. The bed at a shared vertex is the mean of the two end-section beds that meet there.
 */
export const JUNCTION_BED_SECTIONS = {
  startEndSectionIndex: 0,
  endEndSectionIndex: 4,
} as const;

/**
 * How the depth at a vertex shared by two Creek Segments is set (one number for both). m2-v1 solved
 * Manning's equation again at each segment's end sections; normal depth depends strongly on each
 * section's shape, so neighbours disagreed and the water surface stepped by metres across flat reaches.
 * From v2 the junction depth comes from the segments' ANCHOR depths only.
 */
export const JUNCTION_DEPTH = {
  /**
   * Length-weighted mean of the anchor depths of the wet segments within this many meters (along the flowline) on
   * each side of the vertex; each segment counts by the length of it inside the window. The window never crosses a
   * dry or missing segment, and a vertex with a dry, missing, or absent neighbour keeps the segment's own anchor depth.
   * 100 m is the widest window that leaves steep reaches no worse than m2-v1 (METHOD.md "Choosing the junction depth rule").
   */
  smoothingHalfWindowM: 100,
} as const;

/**
 * Local bed slope per solved section: the least-squares fit of Stage 1 section bed elevation
 * against network distance over every section of the same TNC flowline within this many meters
 * (network distance) of the section, oriented so positive = bed falls downstream, then floored at
 * m1's `CROSS_SECTION.minimumSlope`. m1 uses ±150 m around the representative section, which
 * smooths a steep drop into a much gentler average.
 */
export const LOCAL_BED_SLOPE = {
  halfWindowM: 30,
  /**
   * A long Creek Segment spaces its sections more than the window apart, so the window can hold
   * only the section itself (no slope). Then the fit uses this many sections nearest in network
   * distance on the same TNC flowline (the section itself included).
   */
  minimumSectionsInFit: 3,
  minimumSlope: CROSS_SECTION.minimumSlope,
} as const;

/**
 * What the Time Series files carry besides m1's `values` and junction WSEs. Kept here so the
 * description in the manifest, the catalog derivation, and METHOD.md say the same thing.
 */
export const MULTI_SECTION_TIME_SERIES_FIELDS = {
  values:
    'WSE of the smoothed continuous surface at the anchor (mid-segment) section, m NAVD88, 3 decimals: anchorBedElevationM + the junction depths interpolated to the anchor position ' +
    '(the mean of the two junction depths, because the anchor sits half-way along the segment); this is the water the browser draws at the anchor point (m2-v3; m2-v1 and v2 held the raw Manning WSE here)',
  rawAnchorWseM:
    'parallel to values: the raw Manning normal-depth WSE at the anchor section (anchorBedElevationM + raw anchor depth), m NAVD88, 3 decimals; diagnostic only (the junction depths are smoothed from its depths)',
  anchorBedElevationM: 'Stage 1 bed (thalweg) elevation of the anchor section, m NAVD88; depth at the anchor = value − anchorBedElevationM',
  junctionDepthUpstreamM:
    `parallel to values: water depth at the upstream vertex, one number shared with the neighbour: the length-weighted mean of the anchor depths of the wet segments within ±${JUNCTION_DEPTH.smoothingHalfWindowM} m along the flowline ` +
    '(this segment’s own anchor depth at a flowline end or next to a dry or null segment; 0 on a dry segment); null where value is null',
  junctionDepthDownstreamM: 'same as junctionDepthUpstreamM at the downstream vertex',
  junctionBedUpstreamM:
    'scalar: bed at the upstream vertex, the mean of this segment’s upstream end-section bed and the upstream neighbour’s downstream end-section bed (own end-section bed at a flowline end)',
  junctionBedDownstreamM: 'same as junctionBedUpstreamM at the downstream vertex',
  junctionWseUpstreamM: 'junctionBedUpstreamM + junctionDepthUpstreamM, for drawing code that expects junction WSEs',
  junctionWseDownstreamM: 'junctionBedDownstreamM + junctionDepthDownstreamM',
} as const;

const PIPELINE_CODE_FOLDER = 'pipelines/creek-visualization-data-production';
const MODELED_WSE_CODE_FOLDER = `${PIPELINE_CODE_FOLDER}/modeled-water-surface-elevation`;

export const M2_MULTI_SECTION_MANNING_DEPTH_METHOD = {
  id: 'm2-multi-section-manning-depth',
  methodNumber: 2,
  version: 3,
  label: "Multi-section Manning's depth",
  description:
    'Same drainage-area-ratio discharge as m1, inverted on a divided-channel Manning rating curve at the mid-segment ' +
    '(anchor) cross-section of each Creek Segment, with its own bed and a local bed slope. The water depth at each junction is ' +
    'one number per vertex, a smoothed mean of the neighbouring anchor depths, so the water surface is continuous and follows the bed; ' +
    'the segment’s WSE is that smoothed surface at the anchor point (the raw Manning WSE is kept as rawAnchorWseM).',
  changeType: 'implementation fix',
  changeNote:
    'Time Series values are now the WSE of the smoothed surface at the anchor point (anchor bed + the junction depths interpolated there), ' +
    'so the chart shows the water that is drawn; the raw Manning anchor WSE moves to rawAnchorWseM.',
  /**
   * Every shared file whose change can change this method's output: its own Stage 3 imports, plus the
   * Stage 0–1 code that produced the saved inputs it reads (terrain, reach crosswalk, discharge,
   * cross-sections). Stage 2 is not used. Left out on purpose: `stage-manifest.ts` (skip logic) and
   * `modeled-wse-version.ts` (folder and refusal rules).
   */
  sharedCodeFiles: [
    ...[
      'stage-00-acquire.ts',
      'stage-01-cross-sections.ts',
      'rating-curve-inversion.ts',
      'drainage-area-ratio.ts',
      'discharge-records.ts',
      'cross-section-geometry.ts',
      'pipeline-configuration.ts',
      'creek-segment-network.ts',
      'national-water-model-zarr.ts',
      'nhdplusv2-reach-crosswalk.ts',
      'nhdplusv2-reach-geometry.ts',
      'water-years.ts',
      'http-download.ts',
      'terrain-acquisition.ts',
      'terrain-tiles.ts',
      'stage-file-formats.ts',
      'readable-json.ts',
      'modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts',
    ].map((fileName) => `${MODELED_WSE_CODE_FOLDER}/${fileName}`),
    ...[
      'constants.ts',
      'json-files.ts',
      'utm-geometry.ts',
      'tnc-flowline-segmentation.ts',
      'creek-segment-adjacency.ts',
    ].map((fileName) => `${PIPELINE_CODE_FOLDER}/${fileName}`),
  ],
  parameters: {
    sharedWithM1: 'Stages 0–2 output and m1 constants: drainage-area ratio, Drainage-Area Ratio Transfer, cross-section sampling, rating curve',
    drainageAreaRatioTransfer: { ...DRAINAGE_AREA_RATIO_TRANSFER, maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M },
    crossSection: CROSS_SECTION,
    ratingCurve: RATING_CURVE,
    manningRoughnessBasis: MANNING_ROUGHNESS_BASIS,
    solvedSections: SOLVED_SECTIONS,
    anchorPositionAlongSegment: ANCHOR_POSITION_ALONG_SEGMENT,
    junctionBedSections: JUNCTION_BED_SECTIONS,
    junctionDepth: JUNCTION_DEPTH,
    localBedSlope: LOCAL_BED_SLOPE,
    sectionProfiles:
      'each solved section is resampled from the Stage 0 USGS 3DEP tiles at the Stage 1 positions (chord point at ' +
      '((index + 0.5) / sectionsPerSegment) × segment length, normal (−unitY, unitX), offsets −halfWidthM..halfWidthM every sampleSpacingM), ' +
      'then trimmed to the saved valley-edge offsets; elevations rounded to 3 decimals as Stage 1 stores them',
    timeSeriesFields: MULTI_SECTION_TIME_SERIES_FIELDS,
    decimals: 3,
  },
} as const satisfies ModeledWseDerivationMethodConfig;
