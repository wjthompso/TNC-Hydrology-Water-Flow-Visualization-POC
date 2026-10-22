import type { ModeledWseDerivationMethodConfig } from '../modeled-wse-derivation-method.ts';

/**
 * Modeled WSE Derivation Method `m1-drainage-area-ratio-manning-rating-curve`: reach discharge scaled
 * to each Creek Segment by the USGS drainage-area ratio, then converted to WSE on a divided-channel
 * Manning's equation rating curve. Read METHOD.md in this folder for the full description.
 *
 * Every value below changes this method's output, so bump `version` with it (see
 * METHODOLOGY.md "Modeled WSE Derivation Methods"). Stages 0–3 import these constants directly.
 */

// ---- Stage 0 and Stage 1: Drainage-Area Ratio Transfer ---------------------

/**
 * Drainage-Area Ratio Transfer. A Creek Segment on a TNC flowline whose creek has no NHDPlusV2
 * reach of its own keeps the nearest reach of a different creek, and the drainage-area ratio
 * scales that borrowed discharge down to the segment's own catchment. Such a segment is marked
 * with this boolean field in the crosswalk and in every Time Series file (only when true).
 * The name lives here, in one place, so it can be renamed later.
 */
export const DRAINAGE_AREA_RATIO_TRANSFER = {
  fieldName: 'drainageAreaRatioTransfer',
  label: 'Drainage-Area Ratio Transfer',
  note:
    'A Creek Segment marked drainageAreaRatioTransfer sits on a creek that has no NHDPlusV2 reach of its own. ' +
    'Its discharge is transferred from the nearest NHDPlusV2 reach of a neighbouring creek with the USGS drainage-area ratio method ' +
    '(segment drainage area ÷ reach drainage area, capped at 1), which assumes runoff per unit area is uniform across both catchments. ' +
    'A segment whose midpoint lies more than the maximum transfer distance from the borrowed reach gets no discharge (null values).',
} as const;

/**
 * A transfer segment farther than this from the borrowed reach's geometry (segment midpoint to the
 * nearest point of the NHDPlusV2 flowline, meters) gets no discharge: its Time Series values are null.
 */
export const MAXIMUM_TRANSFER_DISTANCE_M = 1000;

// ---- Stage 1: drainage-area ratio -------------------------------------------

/**
 * USGS drainage-area ratio method. Every Creek Segment on one NHDPlusV2 reach would otherwise get
 * the reach's whole discharge, so a small tributary inherits a large creek's flow. Instead each
 * segment gets reach discharge × (segment drainage area ÷ reach drainage area), capped at 1 so
 * flow is never increased. The reach area is NHDPlusV2 TotDASqKm. The segment area is read from
 * the Dangermond Preserve 2018 flow-accumulation raster: the largest upstream cell count within
 * the search radius of the segment's downstream thalweg point, because a flowline can sit off
 * the real channel.
 */
export const DRAINAGE_AREA_RATIO = {
  flowAccumulationImageServerUrl:
    'https://dangermondpreserve-spatial.com/image/rest/services/Hosted/JLDP_Flow_Accumulation_2018/ImageServer',
  /** The raster is in UTM zone 11N; Creek Segment geometry is in zone 10N (EPSG 32610). */
  rasterSpatialReference: 'EPSG:32611',
  rasterWkid: 32611,
  /** Raster cells are 2 m × 2 m, so one upstream cell is 4 m². */
  cellSizeM: 2,
  /** Radius around the downstream thalweg point searched for the largest upstream cell count. */
  searchRadiusM: 15,
  /**
   * Decimals kept on drainageAreaRatio. A headwater segment can drain a few hundred m² of a 40 km²
   * reach (ratio ≈ 0.00001), which 4 decimals would round to exactly 0 and no flow at all.
   */
  ratioDecimals: 6,
  /** Parallel getSamples requests. */
  sampleConcurrency: 8,
  /** Sample results are cached here under `00-acquire/` so reruns do not refetch. */
  sampleCacheFile: 'flow-accumulation-samples.json',
} as const;

// ---- Stage 1: cross-sections -----------------------------------------------

export const CROSS_SECTION = {
  sectionsPerSegment: 5,
  /**
   * Sampled half-width before the valley-edge trim. 100 m reaches past the bank tops so the
   * section includes floodplain; each side is then trimmed at its highest point (valley edge).
   */
  halfWidthM: 100,
  /**
   * Bank top search limit: on each side, the bank top is the highest ground between the thalweg
   * and this distance from the TNC flowline (clipped to the valley edge). 60 m is the former
   * section half-width, so these are the same bank-top points the ±60 m section found.
   */
  bankTopSearchHalfWidthM: 60,
  /**
   * Valley-edge trim fallback. A trimmed side whose valley edge is less than this far above the bed
   * would cap the rating curve at (nearly) the bed, so any flow clamps. That side keeps the untrimmed
   * half-section instead, and Stage 2 caps the ladder on the other side. Stage 2 also flags a
   * rating curve whose cap is still less than this above the bed as `shallow-section`.
   */
  valleyEdgeMinimumBankHeightM: 0.5,
  sampleSpacingM: 1,
  /**
   * The bed (thalweg) is the lowest sample within this distance of the TNC flowline.
   * 30 m: at 20 m, 7 of 305 sections stopped at the search edge; at 30 m none do (max offset 28 m).
   */
  thalwegSearchHalfWidthM: 30,
  /** Representative section = median wetted area at bed + this depth. */
  representativeAreaDepthM: 1,
  /** Along-network window for the least-squares bed slope. */
  slopeSmoothingHalfWindowM: 150,
  minimumSlope: 0.001,
} as const;

// ---- Stage 2: rating curves ------------------------------------------------

export const RATING_CURVE = {
  /** Main channel (between the two bank tops). */
  manningRoughnessN: 0.04,
  /** Left and right floodplain (outside the bank tops, inside the valley edges). */
  floodplainManningRoughnessN: 0.07,
  wseStepM: 0.02,
  /**
   * The ladder rises to the trimmed section's lower valley edge. This depth is only a safety cap
   * that bounds ladder length where valley edges are very high (Jalama valley edges sit a median
   * 15.9 m, max 37.5 m above the bed). 15 m is about twice the deepest depth any Jalama segment
   * needs for the WY2018–WY2023 peak (7.1 m at 608 m³/s), so no modeled value reaches it there.
   */
  maximumDepthAboveBedM: 15,
  /** Raw Manning's discharge can dip at bench spills; the curve keeps the running maximum instead. */
  monotonicDischargeRule: 'running-maximum',
} as const;

/** Where a published value or range came from, so a reader can check it. */
export interface ParameterBasis {
  /** Plain-language source: table row, class, or rule the value was taken from. */
  basis: string;
  /** Published minimum and maximum for that row or class. */
  publishedRange: readonly [number, number];
  citations: readonly string[];
}

const CHOW_1959_TABLE_5_6_URLS = [
  'https://ponce.sdsu.edu/openchannel/open_channel_hydraulics_05_manningsntable.html',
  'https://www.txdot.gov/manuals/des/hyd/chapter-4--hydrology/section-11--time-of-concentration/manning-s-roughness-coefficient-values.html',
];

/**
 * Provenance of the two Manning's n values in RATING_CURVE. Both are Chow's "normal" value for
 * the matching Table 5-6 row. The floodplain row is the winter (wet-season) one, because that is
 * when overbank flow happens here; 0.07 is also the HEC-RAS 2D minimum for NLCD shrub/scrub.
 */
export const MANNING_ROUGHNESS_BASIS = {
  mainChannel: {
    basis: 'Chow (1959) Open-Channel Hydraulics, Table 5-6, minor streams: clean, winding, some pools and shoals (normal value)',
    publishedRange: [0.033, 0.045],
    citations: CHOW_1959_TABLE_5_6_URLS,
  },
  floodplain: {
    basis:
      'Chow (1959) Open-Channel Hydraulics, Table 5-6, floodplains: medium to dense brush, winter (normal value); ' +
      'also the HEC-RAS 2D User Manual minimum for NLCD shrub/scrub (0.07–0.16)',
    publishedRange: [0.045, 0.11],
    citations: [
      ...CHOW_1959_TABLE_5_6_URLS,
      'https://www.hec.usace.army.mil/confluence/rasdocs/r2dum/latest/developing-a-terrain-model-and-geospatial-layers/creating-land-cover-mannings-n-values-and-impervious-layers',
    ],
  },
} as const satisfies Record<string, ParameterBasis>;

// ---- The method --------------------------------------------------------------

const MODELED_WSE_CODE_FOLDER = 'pipelines/creek-visualization-data-production/modeled-water-surface-elevation';

export const M1_DRAINAGE_AREA_RATIO_MANNING_RATING_CURVE_METHOD = {
  id: 'm1-drainage-area-ratio-manning-rating-curve',
  methodNumber: 1,
  version: 1,
  label: "Drainage-area ratio + Manning's rating curve",
  description:
    'Scales each NHDPlusV2 reach discharge to a Creek Segment by the USGS drainage-area ratio, then reads the ' +
    "water-surface elevation that carries it off a divided-channel Manning's equation rating curve built on " +
    'USGS 3DEP 1 m cross-sections.',
  changeType: 'new method',
  changeNote: 'First version of method m1: the Stage 0–3 method as of commit 54618bbb, frozen as m1-v1 from ed267d61.',
  sharedCodeFiles: [
    ...[
      'stage-00-acquire.ts',
      'stage-01-cross-sections.ts',
      'stage-02-rating-curves.ts',
      'stage-03-time-series.ts',
      'rating-curve-inversion.ts',
      'drainage-area-ratio.ts',
      'discharge-records.ts',
      'cross-section-geometry.ts',
      'pipeline-configuration.ts',
      'creek-segment-network.ts',
      'national-water-model-zarr.ts',
      'nhdplusv2-reach-crosswalk.ts',
      'water-years.ts',
    ].map((fileName) => `${MODELED_WSE_CODE_FOLDER}/${fileName}`),
    'pipelines/creek-visualization-data-production/tnc-flowline-segmentation.ts',
    'pipelines/creek-visualization-data-production/creek-segment-adjacency.ts',
  ],
  parameters: {
    drainageAreaRatioTransfer: { ...DRAINAGE_AREA_RATIO_TRANSFER, maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M },
    drainageAreaRatio: DRAINAGE_AREA_RATIO,
    crossSection: CROSS_SECTION,
    ratingCurve: RATING_CURVE,
    manningRoughnessBasis: MANNING_ROUGHNESS_BASIS,
  },
} as const satisfies ModeledWseDerivationMethodConfig;
