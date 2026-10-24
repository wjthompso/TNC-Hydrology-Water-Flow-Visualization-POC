import type { ModeledWseDerivationMethodConfig } from '../modeled-wse-derivation-method.ts';
import {
  CROSS_SECTION,
  DRAINAGE_AREA_RATIO_TRANSFER,
  MANNING_ROUGHNESS_BASIS,
  MAXIMUM_TRANSFER_DISTANCE_M,
  RATING_CURVE,
} from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';

/**
 * Modeled WSE Derivation Method `m3-flowline-profile-manning-depth`: the same drainage-area-ratio discharge and
 * Manning's divided-channel rating curve as m1 and m2, but on one continuous CHANNEL per flowline instead of five
 * disconnected chord sections per segment. The channel is the TNC flowline smoothed and moved sideways to the valley bottom of the
 * 1 m lidar; its bed is a smoothed, downstream-monotone profile. The anchor cross-section is cut perpendicular to that
 * centerline at the middle of each Creek Segment, so the cross-section whose rating curve gives the water depth is the
 * very one the m3 channel ribbon is drawn on. Read METHOD.md in this folder for the full description.
 *
 * Stages 0–2 are shared with m1 (this method reuses their saved output and m1's constants); only Stage 3 differs, and it
 * runs from `stage-03-flowline-profile-time-series.ts` in this folder. Every value below changes this method's output,
 * so bump `version` with it (see METHODOLOGY.md "Modeled WSE Derivation Methods").
 */

/**
 * The channel of one run of joined Creek Segments (a run is a chain of segments of one TNC flowline that share vertices),
 * in flow order. Everything here is geometry the WSE Polygon Generation Method `flowline-channel-ribbon` also uses.
 */
export const CHANNEL_PROFILE = {
  /** Spacing of the dense table the channel is kept in (centerline, bed, cross-section edges), meters along the centerline. */
  tableSpacingM: 1,
  /** The run's TNC flowline (its vertex chain) is resampled every table spacing and smoothed with a Gaussian of this standard deviation (odd reflection keeps the ends fixed). */
  planSmoothingSigmaM: 5,
  /**
   * The smoothed flowline is moved sideways to the valley bottom at every station: dynamic programming over offsets −searchHalfWidthM…searchHalfWidthM
   * (lateralStepM apart) minimizing ground elevation + bendPenaltyPerSquareMeter × (offset change between stations)² + offsetPenaltyPerMeter × |offset|,
   * changing by at most maximumLateralStepPerStationM per station and never past innerBendRadiusFraction of the radius on the inside of a bend;
   * the offsets are then smoothed with offsetSmoothingSigmaM. Stage 1 found the thalweg a median 6 m, 90th percentile 19 m, at most 30 m from the flowline.
   */
  valleyBottomFit: {
    searchHalfWidthM: 30,
    lateralStepM: 0.5,
    maximumLateralStepPerStationM: 1.5,
    bendPenaltyPerSquareMeter: 0.15,
    offsetPenaltyPerMeter: 0.02,
    innerBendRadiusFraction: 0.7,
    offsetSmoothingSigmaM: 3,
  },
  /** Distance either side of a station within which its strongest bend limits how far a cross-section edge may reach on the inside of that bend, meters. */
  curvatureWindowM: 8,
  bed: {
    /** The raw bed at a station starts from the lowest bilinear lidar value within this lateral distance of the smoothed centerline. */
    lateralSearchHalfWidthM: 1.5,
    lateralSearchStepM: 0.5,
    /**
     * From that lowest point the floor is followed downhill along the section for at most this far from the centerline. Without it,
     * 27714697-044 measured depth from a bank 0.38 m above a 4 m wide floor and stayed dry all year (the first 2 cm of its rating curve carried 21 m³/s).
     */
    descentLimitM: 10,
    /** Median filter over the raw bed along the centerline (window shrinks toward the ends), meters. Removes single-cell spikes, keeps steps. */
    medianWindowM: 5,
    /**
     * The bed profile is the median-filtered bed smoothed with a Gaussian of this standard deviation, then made monotone
     * (never rises downstream) by pool-adjacent-violators isotonic regression, clamped to within `maximumDeviationM` of the smoothed bed,
     * and smoothed once more. Unclamped, the monotone fit floated pools up to 9 m above the ground upstream of road fills and buried
     * creeks up to 16 m below them (preserve-wide: 2.8% of stations more than 1 m off). Where the ground rises more than that
     * downstream (a road fill over a culvert the lidar cannot see) the profile follows the ground and the surface rises with it.
     */
    profileSmoothingSigmaM: 4,
    maximumDeviationM: 0.3,
    finalSmoothingSigmaM: 2,
  },
  /** Cross-sections cut perpendicular to the smoothed centerline. */
  crossSection: {
    /** Lateral sample spacing out to `fineHalfWidthM`, then `coarseStepM` out to `halfWidthM`. Fine near the channel because steep streams are 1 m wide. */
    fineStepM: 0.5,
    fineHalfWidthM: 12,
    coarseStepM: 1,
    halfWidthM: 100,
  },
  segmentBoundaries: 'the station at the same fraction of the fitted centerline’s length as the shared vertex is of the flowline’s (through the flowline station it was moved sideways from)',
} as const;

/** A raw anchor depth under this is dry (0): the brief's rule that modeled depth under 1 cm is no water. */
export const DRY_BELOW_DEPTH_M = 0.01;

/** Where the anchor sits along its segment, as a fraction of the centerline arc length from the upstream end: the middle station. */
export const ANCHOR_POSITION_ALONG_SEGMENT = 0.5;

/** How the depth at a vertex shared by two Creek Segments is set (one number for both): m2's rule, copied. */
export const JUNCTION_DEPTH = {
  /** Length-weighted mean of the wet anchor depths within this many meters along the flowline on each side; never crosses a dry or missing segment. */
  smoothingHalfWindowM: 100,
} as const;

/** Slope of the anchor cross-section: least-squares fit of the bed profile over this window around the anchor, floored at m1's minimum. */
export const ANCHOR_SLOPE = {
  halfWindowM: 30,
  minimumSlope: CROSS_SECTION.minimumSlope,
} as const;

/**
 * Valley-edge trim of the anchor cross-section, copied from Stage 1: each side is cut at its highest ground so the section never
 * reaches into a neighbouring valley; a side whose valley edge is less than `valleyEdgeMinimumBankHeightM` above the bed keeps the untrimmed half-section.
 */
export const ANCHOR_SECTION = {
  valleyEdgeMinimumBankHeightM: CROSS_SECTION.valleyEdgeMinimumBankHeightM,
  profileSpacingM: CROSS_SECTION.sampleSpacingM,
  halfWidthM: CROSS_SECTION.halfWidthM,
} as const;

/** What the Time Series files carry, so the description in the manifest, the catalog, and METHOD.md say the same thing. */
export const FLOWLINE_PROFILE_TIME_SERIES_FIELDS = {
  values:
    'WSE of the smoothed continuous surface at the anchor point (the middle station of the segment’s centerline), m NAVD88, 3 decimals: ' +
    'anchorBedElevationM + the junction depths interpolated to the middle (their mean); this is the true water the browser draws at the anchor point',
  anchorBedElevationM: 'bed profile elevation at the anchor point, m NAVD88; depth at the anchor = value − anchorBedElevationM. A smoothed, downstream-monotone fit of the lidar thalweg, not the raw lidar value',
  junctionDepthUpstreamM:
    `parallel to values: TRUE water depth at the upstream vertex of the segment’s ribbon, one number shared with the neighbour: the length-weighted mean of the anchor depths of the wet segments within ±${JUNCTION_DEPTH.smoothingHalfWindowM} m along the flowline ` +
    '(own anchor depth at a flowline end or next to a dry or null segment; 0 on a dry segment); null where value is null. Display exaggeration is never stored here',
  junctionDepthDownstreamM: 'same as junctionDepthUpstreamM at the downstream vertex',
  junctionBedUpstreamM: 'bed profile elevation at the upstream end of the segment’s ribbon, m NAVD88',
  junctionBedDownstreamM: 'bed profile elevation at the downstream end of the segment’s ribbon, m NAVD88',
  anchorTopWidthM: 'not stored; see the polygon set of flowline-channel-ribbon (`channelRibbon.trueTopWidthAtAnchorM`)',
} as const;

const PIPELINE_CODE_FOLDER = 'pipelines/creek-visualization-data-production';
const MODELED_WSE_CODE_FOLDER = `${PIPELINE_CODE_FOLDER}/modeled-water-surface-elevation`;

export const M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD = {
  id: 'm3-flowline-profile-manning-depth',
  methodNumber: 3,
  version: 1,
  label: 'Flowline channel profile (Manning depth)',
  description:
    'Same drainage-area-ratio discharge as m1 and m2, inverted on a divided-channel Manning rating curve cut across a continuous, ' +
    'continuous channel centerline (the TNC flowline smoothed and moved sideways to the lidar valley bottom) at the middle of each Creek Segment. The bed is a smooth, downstream-monotone profile of the flowline; ' +
    'the water depth at each junction is one number per vertex (smoothed mean of the neighbouring anchor depths), so the surface is continuous. ' +
    'The Time Series store true depths only; the segment’s WSE is the surface at the anchor point.',
  changeType: 'new method',
  changeNote:
    'New method: the cross-section is cut on a continuous smoothed centerline, the bed is one smooth monotone profile per run, and the depth is the true depth (display exaggeration is never stored).',
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
    ...['constants.ts', 'json-files.ts', 'utm-geometry.ts', 'tnc-flowline-segmentation.ts', 'creek-segment-adjacency.ts'].map(
      (fileName) => `${PIPELINE_CODE_FOLDER}/${fileName}`,
    ),
  ],
  parameters: {
    sharedWithM1: 'Stages 0–2 output and m1 constants: drainage-area ratio, Drainage-Area Ratio Transfer, Manning roughness, rating-curve ladder',
    drainageAreaRatioTransfer: { ...DRAINAGE_AREA_RATIO_TRANSFER, maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M },
    crossSection: CROSS_SECTION,
    ratingCurve: RATING_CURVE,
    manningRoughnessBasis: MANNING_ROUGHNESS_BASIS,
    channelProfile: CHANNEL_PROFILE,
    anchorPositionAlongSegment: ANCHOR_POSITION_ALONG_SEGMENT,
    anchorSlope: ANCHOR_SLOPE,
    anchorSection: ANCHOR_SECTION,
    junctionDepth: JUNCTION_DEPTH,
    dryBelowDepthM: DRY_BELOW_DEPTH_M,
    timeSeriesFields: FLOWLINE_PROFILE_TIME_SERIES_FIELDS,
    decimals: 3,
  },
} as const satisfies ModeledWseDerivationMethodConfig;
