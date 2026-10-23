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
 * Manning's rating curve at three of each Creek Segment's five Stage 1 cross-sections (both ends and
 * the middle), each with its own bed and a local bed slope. The middle section gives the segment's
 * water-surface elevation (WSE); the end sections give the water depth at each junction, so the water
 * can be drawn parallel to the bed. Read METHOD.md in this folder for the full description.
 *
 * Stages 0–2 are shared with m1 (this method reuses their saved output and m1's constants); only
 * Stage 3 differs, and it runs from `stage-03-multi-section-time-series.ts` in this folder. Every
 * value below changes this method's output, so bump `version` with it (see METHODOLOGY.md
 * "Modeled WSE Derivation Methods").
 */

/** Stage 1 section indexes this method solves, in vertex order (Stage 1 samples 5 per Creek Segment). */
export const SOLVED_SECTIONS = {
  /** Section at the segment's start vertex end. Its depth is the depth at that end. */
  startEndSectionIndex: 0,
  /** Mid-segment section. Its WSE is the segment's Time Series value. */
  anchorSectionIndex: 2,
  /** Section at the segment's end vertex end. */
  endEndSectionIndex: 4,
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
  values: 'WSE at the anchor (mid-segment) section, m NAVD88, 3 decimals',
  anchorBedElevationM: 'Stage 1 bed (thalweg) elevation of the anchor section, m NAVD88; depth at the anchor = value − anchorBedElevationM',
  junctionDepthUpstreamM:
    'parallel to values: water depth at the upstream vertex, the mean of this segment’s upstream-end-section depth and the upstream neighbour’s downstream-end-section depth (own depth at a flowline end or where the neighbour is null); null where value is null',
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
  version: 1,
  label: "Multi-section Manning's depth",
  description:
    'Same drainage-area-ratio discharge as m1, inverted on divided-channel Manning rating curves at the mid-segment ' +
    'and both end cross-sections of each Creek Segment, each with its own bed and a local bed slope. The mid-segment ' +
    'section gives the WSE; the end sections give the water depth at each junction, so water can follow the bed.',
  changeType: 'new method',
  changeNote:
    'First version of method m2: one WSE from one median-area section (m1) flooded whole corridors on steep creeks; ' +
    'm2 models depth at three sections with local slopes so the water surface can run parallel to the bed.',
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
    localBedSlope: LOCAL_BED_SLOPE,
    sectionProfiles:
      'each solved section is resampled from the Stage 0 USGS 3DEP tiles at the Stage 1 positions (chord point at ' +
      '((index + 0.5) / sectionsPerSegment) × segment length, normal (−unitY, unitX), offsets −halfWidthM..halfWidthM every sampleSpacingM), ' +
      'then trimmed to the saved valley-edge offsets; elevations rounded to 3 decimals as Stage 1 stores them',
    timeSeriesFields: MULTI_SECTION_TIME_SERIES_FIELDS,
    decimals: 3,
  },
} as const satisfies ModeledWseDerivationMethodConfig;
