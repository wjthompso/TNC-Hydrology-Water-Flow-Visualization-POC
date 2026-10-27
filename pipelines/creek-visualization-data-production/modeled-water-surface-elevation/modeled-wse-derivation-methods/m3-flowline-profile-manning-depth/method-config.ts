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
 * 1 m lidar; its bed is the raw lidar at the creek's lowest point across every station (no smoothing). The anchor cross-section is cut
 * through that lowest point at the middle of each Creek Segment, so the cross-section whose rating curve gives the water depth is the
 * very one the m3 channel ribbon is drawn on, and the water surface is smoothed over a window scaled by its depth and pool-filled along the run. Read METHOD.md in this folder for the full description.
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
    /**
     * The bed at a station is the bilinear lidar at the creek's lowest point across that station: start from the lowest value within this
     * lateral distance of the smoothed centerline, then follow the ground downhill along the section. The station's position is that point,
     * so its longitude/latitude and its bed describe the same spot. No smoothing, median, monotone step, or clamp: steps and pools stay.
     */
    lateralSearchHalfWidthM: 1.5,
    lateralSearchStepM: 0.5,
    /**
     * From that lowest point the floor is followed downhill along the section for at most this far from the centerline. Without it,
     * 27714697-044 measured depth from a bank 0.38 m above a 4 m wide floor and stayed dry all year (the first 2 cm of its rating curve carried 21 m³/s).
     * The limit also keeps the lowest point in this creek: a neighbouring gully is reached only across higher ground, which the descent never climbs.
     */
    descentLimitM: 10,
  },
  /**
   * Bare-earth lidar keeps road and railroad embankments but not their culverts, so a pool fill of the raw bed would make lakes behind
   * every crossing (preserve-wide the raw bed has 82 such depressions 1.5–24 m deep). Before the pool fill, a barrier is breached along the
   * channel when the pool it would hold is at least `minimumPoolDepthM` deep and the barrier is at most `maximumLengthAtHalfHeightM` long
   * where it stands half that depth above the pool bottom (hybrid breaching–filling as in Lindsay 2016, Hydrological Processes 30:846).
   * The breach lowers the bed from the pool bottom along a straight line to the first station downstream that is no higher than it, so the
   * water passes through the fill (as through its culvert) instead of ponding behind it. Shallower pools, step pools among them, fill.
   */
  barrierCarving: {
    minimumPoolDepthM: 1,
    maximumLengthAtHalfHeightM: 100,
    rule: 'deepest qualifying depression first, repeated until none qualifies; a barrier at the run end with no lower station downstream is breached level with the pool bottom',
  },
  /**
   * The stations the water surface is solved and drawn on (the ribbon's stations): table stations of the segment, the anchor station
   * among them, each half of the segment (boundary to anchor, anchor to boundary) split into ceil(half length ÷ targetSpacingM) steps.
   * Neighbours share their boundary station. Each station's distance from the segment's upstream boundary along the centerline (cm) places
   * it in the depth-scaled smoothing window (`POOL_FILLED_WATER_SURFACE`); the ribbon saves it as `channelRibbon.stationDistancesM`.
   */
  waterSurfaceStations: {
    targetSpacingM: 2,
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

/**
 * The water surface drawn and charted along a run (`pool-filled-water-surface.ts`, shared with the browser). Before the pool fill, the
 * flowing surface (bed + flowing depth) at each station is averaged over the stations within ±`smoothingHalfWindowDepthMultiple` × its
 * flowing depth along the run, so deep flat water drowns the 0.1–0.5 m bumps of the raw lidar bed while thin steep water (a window shorter
 * than the station spacing) keeps its step pools. The bed is not smoothed. Will chose 5 from the phase 2 comparison of 0, 5 and 10:
 * at 10, five times as many stations get less than half their flowing depth over bumps and twice as many steep stations sit in pools.
 * Averaging across a sharp drop can put the mean below the lip (at the January 2023 peak 69 stations, down to 2.9 m under their bed),
 * so a smoothed station keeps at least `minimumSmoothedDepthM` (the dry threshold), or its own flowing depth where that is less.
 */
export const POOL_FILLED_WATER_SURFACE = {
  smoothingHalfWindowDepthMultiple: 5,
  minimumSmoothedDepthM: DRY_BELOW_DEPTH_M,
  rule:
    'per wet stretch of a run (consecutive wet segments; a boundary station shared by two neighbours is one station), in flow order: ' +
    'smoothed = max(mean of bed + flowing depth over the stations within ±smoothingHalfWindowDepthMultiple × the station’s flowing depth along the centerline, bed + min(minimumSmoothedDepthM, flowing depth)), ' +
    'the window shrunk to the same distance on both sides near the stretch ends; then from the downstream end upstream, surface = max(smoothed, surface at the next station downstream); ' +
    'flowing depth linear between the segment’s junction depths by station count; a dry (junction depth 0) or null segment has no surface and ends the stretch; breached stations are ordinary stations',
} as const;

/**
 * Where the anchor sits along its segment, as a fraction of the centerline arc length from the upstream end: the table station nearest the
 * middle. Across the channel it sits on that station's lowest point (the bed). A middle station on a breached barrier (whose bed is the breach
 * line, not the lidar) moves to the nearest table station of the segment that is not breached.
 */
export const ANCHOR_POSITION_ALONG_SEGMENT = 0.5;

/** How the depth at a vertex shared by two Creek Segments is set (one number for both): m2's rule, copied. */
export const JUNCTION_DEPTH = {
  /** Length-weighted mean of the wet anchor depths within this many meters along the flowline on each side; never crosses a dry or missing segment. */
  smoothingHalfWindowM: 100,
} as const;

/** Slope of the anchor cross-section: least-squares fit of the bed (breached where a barrier is breached, never smoothed) over this window around the anchor, floored at m1's minimum. */
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
    `WSE of the pool-filled water surface at the anchor station, m NAVD88, 3 decimals: bed + flowing depth averaged over ±${POOL_FILLED_WATER_SURFACE.smoothingHalfWindowDepthMultiple} × the flowing depth along the run, then walking the run upstream, max(smoothed, surface just downstream), ` +
    'with the flowing depth interpolated between the junction depths (pool-filled-water-surface.ts, the same function the browser draws with); this is the true water the browser draws at the anchor point. ' +
    'A dry segment holds anchorBedElevationM',
  anchorBedElevationM: 'bed at the WSE Anchor Point, m NAVD88: the bilinear 1 m lidar at the creek’s lowest point across the anchor station (channelRibbon.anchorLonLat of flowline-channel-ribbon v2); depth at the anchor = value − anchorBedElevationM',
  junctionDepthUpstreamM:
    `parallel to values: TRUE flowing water depth (before pool filling) at the upstream vertex of the segment’s ribbon, one number shared with the neighbour: the length-weighted mean of the anchor depths of the wet segments within ±${JUNCTION_DEPTH.smoothingHalfWindowM} m along the flowline ` +
    '(own anchor depth at a flowline end or next to a dry or null segment; 0 on a dry segment); null where value is null. Display exaggeration is never stored here',
  junctionDepthDownstreamM: 'same as junctionDepthUpstreamM at the downstream vertex',
  junctionBedUpstreamM: 'bed at the upstream boundary station of the segment’s ribbon, m NAVD88 (the lidar at the lowest point there, or the breach line on a breached barrier)',
  junctionBedDownstreamM: 'bed at the downstream boundary station of the segment’s ribbon, m NAVD88',
  anchorTopWidthM: 'not stored; see the polygon set of flowline-channel-ribbon (`channelRibbon.trueTopWidthAtAnchorM`)',
} as const;

const PIPELINE_CODE_FOLDER = 'pipelines/creek-visualization-data-production';
const MODELED_WSE_CODE_FOLDER = `${PIPELINE_CODE_FOLDER}/modeled-water-surface-elevation`;

export const M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD = {
  id: 'm3-flowline-profile-manning-depth',
  methodNumber: 3,
  version: 2,
  label: 'Flowline channel profile (Manning depth)',
  description:
    'Same drainage-area-ratio discharge as m1 and m2, inverted on a divided-channel Manning rating curve cut across a continuous, ' +
    'channel centerline (the TNC flowline smoothed and moved sideways to the lidar valley bottom) through the creek’s lowest point at the middle of each Creek Segment. The bed is the raw 1 m lidar at the lowest point of every station (no smoothing), ' +
    'breached through road and railroad fills; the flowing depth at each junction is one number per vertex (smoothed mean of the neighbouring anchor depths), and the water surface (bed + flowing depth averaged over ±5 × the flowing depth) is pool-filled along the run, ' +
    'so pools behind steps stand level and deep water drowns the bumps of the raw bed. The Time Series store true depths only; the segment’s WSE is the pool-filled surface at the anchor point.',
  changeType: 'implementation fix',
  changeNote:
    'Raw 1 m lidar bed at the lowest point of every station (no Gaussian, isotonic, clamp, or median), the anchor and its cross-section on that lowest point, tall short barriers breached, and values = the pool-filled surface at the anchor, after a depth-scaled smoothing of the water (±5 × the flowing depth); hydraulics unchanged.',
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
    poolFilledWaterSurface: POOL_FILLED_WATER_SURFACE,
    anchorPositionAlongSegment: ANCHOR_POSITION_ALONG_SEGMENT,
    anchorSlope: ANCHOR_SLOPE,
    anchorSection: ANCHOR_SECTION,
    junctionDepth: JUNCTION_DEPTH,
    dryBelowDepthM: DRY_BELOW_DEPTH_M,
    timeSeriesFields: FLOWLINE_PROFILE_TIME_SERIES_FIELDS,
    decimals: 3,
  },
} as const satisfies ModeledWseDerivationMethodConfig;
