import path from 'node:path';
import process from 'node:process';
import {
  FLOWLINE_SNAPSHOT_FILE,
  SEGMENT_NETWORK_VERSION,
  repositoryRoot,
  sourceInputsDirectory,
} from '../constants.ts';
import type { TimeSeriesDerivation } from './stage-file-formats.ts';

/**
 * Settings shared by every modeled water-surface elevation (WSE) stage.
 * Every stage builds one extent, chosen with `--extent=<extentId>`, and writes under
 * `data/pipeline-working-output/<extentId>/` (git-ignored, regenerable scratch; see data/README.md).
 */

export const pipelineWorkingOutputDirectory = path.join(repositoryRoot, 'data/pipeline-working-output');

export interface ModeledExtentDefinition {
  extentId: string;
  description: string;
  segmentNetworkVersion: string;
  /** TNC flowline response (EPSG 32610) the Creek Segments are cut from. */
  flowlineSnapshotPath: string;
  terrainBufferM: number;
  /** Tracked, reviewable output: which NHDPlusV2 reach each Creek Segment belongs to. */
  nhdplusV2CrosswalkPath: string;
  /**
   * When set, Stage 0 refuses to run this extent and prints this reason. The feasibility
   * estimate exceeded an approved budget, and the developer has not yet chosen an option.
   */
  blockedReason: string | null;
}

function crosswalkPathFor(extentId: string): string {
  return path.join(sourceInputsDirectory, `reviewed-assignments/nhdplusv2-reach-crosswalk-${extentId}.json`);
}

export const MODELED_EXTENTS = {
  'jalama-gauge-reach': {
    extentId: 'jalama-gauge-reach',
    description: 'The 61 Creek Segments of TNC flowline COMID 27714637 around the Jalama Near Lompoc gauge. Fast dev extent.',
    segmentNetworkVersion: SEGMENT_NETWORK_VERSION,
    flowlineSnapshotPath: path.join(sourceInputsDirectory, FLOWLINE_SNAPSHOT_FILE),
    terrainBufferM: 150,
    nhdplusV2CrosswalkPath: crosswalkPathFor('jalama-gauge-reach'),
    blockedReason: null,
  },
  'dangermond-preserve': {
    extentId: 'dangermond-preserve',
    description: 'Every TNC flowline intersecting the Dangermond Preserve boundary (jldp_boundary layer 2): 105 flowlines, 3,338 Creek Segments.',
    segmentNetworkVersion: 'dangermond-preserve-v1',
    // Tracked source input (see retain-dangermond-preserve-flowlines.ts), not pipeline output.
    flowlineSnapshotPath: path.join(sourceInputsDirectory, 'tnc-flowlines-dangermond-preserve.json'),
    terrainBufferM: 150,
    nhdplusV2CrosswalkPath: crosswalkPathFor('dangermond-preserve'),
    // Unblocked: browser-facing files are now split per TNC flowline (see METHODOLOGY.md "File layout").
    blockedReason: null,
  },
} as const satisfies Record<string, ModeledExtentDefinition>;

export type ModeledExtentId = keyof typeof MODELED_EXTENTS;

/** The whole preserve is the approved default. Use --extent=jalama-gauge-reach for a ~15 s development run. */
export const DEFAULT_MODELED_EXTENT_ID: ModeledExtentId = 'dangermond-preserve';

function isModeledExtentId(value: string): value is ModeledExtentId {
  return Object.hasOwn(MODELED_EXTENTS, value);
}

/** `--extent=<extentId>` selects the extent; without it the default extent is used. */
export function requestedModeledExtentId(argv: readonly string[] = process.argv): ModeledExtentId {
  const flag = argv.find((argument) => argument.startsWith('--extent='));
  if (!flag) return DEFAULT_MODELED_EXTENT_ID;
  const extentId = flag.slice('--extent='.length);
  if (!isModeledExtentId(extentId)) {
    throw new Error(`Unknown ${flag}. Use one of: ${Object.keys(MODELED_EXTENTS).join(', ')}.`);
  }
  return extentId;
}

/** The Creek Segment network this process builds. */
export const MODELED_EXTENT: ModeledExtentDefinition = MODELED_EXTENTS[requestedModeledExtentId()];

export const extentOutputDirectory = path.join(pipelineWorkingOutputDirectory, MODELED_EXTENT.extentId);

export const STAGE_DIRECTORY_NAMES = {
  acquire: '00-acquire',
  crossSections: '01-cross-sections',
  ratingCurves: '02-rating-curves',
  timeSeries: '03-time-series',
  waterSurfacePolygons: '04-water-surface-polygons',
  catalog: '05-catalog',
} as const;

export function stageDirectory(stage: keyof typeof STAGE_DIRECTORY_NAMES): string {
  return path.join(extentOutputDirectory, STAGE_DIRECTORY_NAMES[stage]);
}

/** Inspection SVGs are drawn for the Creek Segment assigned to the Jalama Near Lompoc gauge (in both extents). */
export const INSPECTION_SEGMENT_ID = '27714637-026';

/**
 * Tracked, reviewable output for the selected extent: which NHDPlusV2 reach each Creek Segment
 * belongs to and what share of that reach's discharge it gets (the drainage-area ratio).
 * Stage 0 builds the reach assignment in `00-acquire/`; Stage 1 adds the ratio and writes this file.
 */
export const NHDPLUSV2_CROSSWALK_PATH = MODELED_EXTENT.nhdplusV2CrosswalkPath;

// ---- Stage 0: acquire -------------------------------------------------------

/**
 * USGS 3DEP export tile edge in pixels (= meters at 1 m). 4000 px returns HTTP 500 from the
 * service; 2000 px works.
 */
export const TERRAIN_TILE_MAX_PIXELS = 2000;
/**
 * Distance between tile origins. The 500 m overlap is larger than any Creek Segment corridor
 * box in the preserve (longest segment ≈ 247 m plus the buffer), so every corridor fits in one tile.
 */
export const TERRAIN_TILE_STEP_M = 1500;

export const NLDI_POSITION_URL = 'https://api.water.usgs.gov/nldi/linked-data/comid/position';
/**
 * NLDI answers are cached here under `00-acquire/`, keyed by Creek Segment id and midpoint, because
 * NLDI allows 3,600 requests per hour and the preserve alone needs 3,338. The cache is saved every
 * few lookups so a rate-limit error keeps the progress so far, and it is seeded from the extent's
 * tracked crosswalk before any request, so a rerun refetches only segments whose midpoint moved.
 */
export const NLDI_POSITION_CACHE_FILE = 'nldi-position-lookups.json';
/**
 * EPA (Environmental Protection Agency) NHDPlusV2 network flowlines, used to read each reach's
 * REACHCODE, GNIS name, and total upstream drainage area (TotDASqKm).
 */
export const EPA_NHDPLUSV2_FLOWLINE_QUERY =
  'https://watersgeo.epa.gov/arcgis/rest/services/NHDPlus/NHDPlus/MapServer/2/query';
/** Stage 0 caches each NLDI reach's REACHCODE, GNIS name, and TotDASqKm here under `00-acquire/`. */
export const NHDPLUSV2_REACH_ATTRIBUTES_CACHE_FILE = 'nhdplusv2-reach-attributes.json';
/** The NHDPlusV2 reach containing the Jalama Near Lompoc gauge. Used as a sanity check. */
export const EXPECTED_GAUGE_REACH_NHDPLUSV2_COMID = 17593507;

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

/** Stage 0 caches each borrowed reach's NHDPlusV2 flowline geometry here under `00-acquire/`. */
export const NHDPLUSV2_REACH_GEOMETRY_CACHE_FILE = 'nhdplusv2-reach-geometries.json';

export const CALIFORNIA_NATURAL_FLOWS = {
  publisherId: 'california-natural-flows',
  datasetId: 'california-natural-flows-monthly',
  streamUrl: 'https://flow-api.codefornature.org/v2/stream/',
  statistic: 'mean',
  variable: 'estimated',
} as const;

export const NATIONAL_WATER_MODEL = {
  publisherId: 'noaa-national-water-model',
  datasetId: 'national-water-model-hourly',
  zarrStoreUrl: 'https://noaa-nwm-retrospective-3-0-pds.s3.amazonaws.com/CONUS/zarr/chrtout.zarr',
  /**
   * Inclusive water years; WY2018 runs Oct 1 2017 through Sep 30 2018 (UTC). Override with --water-years=2020-2022.
   * The v3.0 retrospective record ends Feb 1 2023 00:00 UTC, so WY2023 is partial (Oct 1 2022 – Feb 1 2023)
   * and is kept without padding.
   */
  defaultFirstWaterYear: 2018,
  defaultLastWaterYear: 2023,
  chunkDownloadConcurrency: 4,
} as const;

/**
 * Compressed Zarr chunks are cached here, shared by every extent, so a wider window or a
 * second extent downloads only chunks not yet seen. The retrospective store never changes.
 */
export const NATIONAL_WATER_MODEL_CHUNK_CACHE_DIRECTORY = path.join(
  pipelineWorkingOutputDirectory,
  'national-water-model-zarr-chunk-cache',
);

export const CUBIC_FEET_TO_CUBIC_METERS = 0.0283168;

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

// ---- Stage 3: time series --------------------------------------------------

export const WATER_SURFACE_ELEVATION_VARIABLE_ID = 'water-surface-elevation';

// ---- Stage 4: water-surface polygons ----------------------------------------
// Each WSE Polygon Generation Method keeps its own parameters in
// `wse-polygon-generation-methods/<method-id>/method-config.ts`, so changing one bumps only that method's version.

// ---- Stage 5: catalog and validation ---------------------------------------

/** Shared by every modeled WSE Dataset because both use the same Stage 1–3 method. */
const MODELED_WSE_ACCURACY_NOTE =
  "Water-surface elevation assumes steady, uniform flow (Manning's equation) on bare-earth terrain that cannot see the underwater channel bed.";

export const CATALOG = {
  publishers: [
    { publisherId: CALIFORNIA_NATURAL_FLOWS.publisherId, name: 'California Natural Flows' },
    { publisherId: NATIONAL_WATER_MODEL.publisherId, name: 'NOAA National Water Model' },
  ],
  datasets: [
    {
      datasetId: CALIFORNIA_NATURAL_FLOWS.datasetId,
      publisherId: CALIFORNIA_NATURAL_FLOWS.publisherId,
      kind: 'modeled',
      timeStep: 'monthly',
      accuracyNote: `Monthly mean of modeled natural (unimpaired) flow, not validated at this creek. ${MODELED_WSE_ACCURACY_NOTE}`,
    },
    {
      datasetId: NATIONAL_WATER_MODEL.datasetId,
      publisherId: NATIONAL_WATER_MODEL.publisherId,
      kind: 'modeled',
      timeStep: 'hourly',
      accuracyNote:
        'Modeled hourly flow without gauge correction; flow sizes may be off by 2–5×, so the timing of rises and falls is more reliable than the values. ' +
        MODELED_WSE_ACCURACY_NOTE,
    },
  ],
  variables: [{ variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID, name: 'Water-surface elevation', unit: 'm NAVD88' }],
  derivedBy: 'UCSB Spatial Center',
} as const;

const DRAINAGE_AREA_RATIO_CITATIONS = [
  'https://pubs.usgs.gov/tm/2006/tm4a6/', // Ries (2007), The National Streamflow Statistics Program, USGS TM 4-A6
  'https://pubs.usgs.gov/sir/2005/5017/', // Emerson, Vecchia, and Dahl (2005), USGS SIR 2005-5017
];

/**
 * The self-describing derivation record Stage 5 writes for one modeled WSE Time Series.
 * Every Dataset shares the Stage 1–3 method; only the discharge Publisher differs.
 */
export function timeSeriesDerivation(dischargePublisherName: string): TimeSeriesDerivation {
  return {
    derivedFrom: 'discharge',
    method:
      `Manning's equation (normal depth, divided channel) on USGS 3DEP 1 m cross-sections, ` +
      `n = ${RATING_CURVE.manningRoughnessN} main channel, ${RATING_CURVE.floodplainManningRoughnessN} floodplain; ` +
      'reach discharge scaled to each Creek Segment by the USGS drainage-area ratio method ' +
      '(segment drainage area ÷ NHDPlusV2 reach drainage area, capped at 1)',
    derivedBy: CATALOG.derivedBy,
    inputs: [
      { role: 'discharge', source: `${dischargePublisherName} modeled discharge per NHDPlusV2 reach` },
      { role: 'terrain', source: 'USGS 3DEP 1 m bare-earth lidar terrain' },
      { role: 'segment drainage area', source: 'Dangermond Preserve 2018 flow-accumulation raster (JLDP_Flow_Accumulation_2018, 2 m cells)' },
      { role: 'reach drainage area', source: 'NHDPlusV2 TotDASqKm from the EPA NHDPlus flowline service' },
    ],
    steps: [
      'Map each Creek Segment to the NHDPlusV2 reach whose catchment contains it (reviewed crosswalk).',
      `Mark a segment on a creek with no NHDPlusV2 reach of its own as ${DRAINAGE_AREA_RATIO_TRANSFER.fieldName}: it borrows the nearest ` +
        `reach of a neighbouring creek, or gets no discharge when that reach is more than ${MAXIMUM_TRANSFER_DISTANCE_M} m away.`,
      'Scale the reach discharge by the drainage-area ratio, segment area ÷ reach area, capped at 1.',
      'Build a divided-channel Manning rating curve (main channel plus left and right floodplain) from 3DEP cross-sections.',
      'Look up the water-surface elevation that carries each discharge on that rating curve.',
      'Clamp any discharge above the rating-curve top to the top water-surface elevation.',
    ],
    parameters: [
      {
        name: "main-channel Manning's n",
        value: RATING_CURVE.manningRoughnessN,
        unit: '',
        ...MANNING_ROUGHNESS_BASIS.mainChannel,
      },
      {
        name: "floodplain Manning's n",
        value: RATING_CURVE.floodplainManningRoughnessN,
        unit: '',
        ...MANNING_ROUGHNESS_BASIS.floodplain,
      },
      {
        name: 'cross-section half-width',
        value: CROSS_SECTION.halfWidthM,
        unit: 'm',
        basis: 'Sampled each side of the TNC flowline, far enough to include floodplain; each side is then trimmed at its valley edge.',
        citations: [],
      },
      {
        name: 'minimum bed slope',
        value: CROSS_SECTION.minimumSlope,
        unit: 'm/m',
        basis: 'Floor for the least-squares bed slope, so a flat or noisy reach still has a finite rating curve.',
        citations: [],
      },
      {
        name: 'drainage-area ratio cap',
        value: 1,
        unit: '',
        basis: 'USGS drainage-area ratio method; the cap means a Creek Segment never gets more flow than its reach.',
        citations: DRAINAGE_AREA_RATIO_CITATIONS,
      },
      {
        name: 'maximum transfer distance',
        value: MAXIMUM_TRANSFER_DISTANCE_M,
        unit: 'm',
        basis:
          `A ${DRAINAGE_AREA_RATIO_TRANSFER.label} segment whose midpoint is farther than this from the borrowed NHDPlusV2 reach ` +
          'gets no discharge, because a reach that far away is not a credible stand-in for the creek.',
        citations: DRAINAGE_AREA_RATIO_CITATIONS,
      },
    ],
    assumptions: [
      'Steady, uniform flow (normal depth) on one representative cross-section per Creek Segment.',
      'Bare-earth lidar cannot see the underwater bed, so the modeled bed is the water surface on the survey date and true depths are larger.',
      "Runoff per unit area is the same across a reach's catchment (the drainage-area ratio assumption), " +
        `and for a ${DRAINAGE_AREA_RATIO_TRANSFER.label} segment also across the neighbouring creek's catchment it borrows from.`,
      'The divided channel ignores momentum exchange between the main channel and the floodplains.',
    ],
    sensitivity:
      'Depth scales with n^(3/5), so ±25% roughness changes depth by about ±15%, smaller than the 2–5× discharge uncertainty.',
  };
}
