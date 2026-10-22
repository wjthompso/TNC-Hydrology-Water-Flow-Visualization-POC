import path from 'node:path';
import process from 'node:process';
import {
  FLOWLINE_SNAPSHOT_FILE,
  SEGMENT_NETWORK_VERSION,
  repositoryRoot,
  sourceInputsDirectory,
} from '../constants.ts';

/**
 * Settings shared by every modeled water-surface elevation (WSE) stage: extents, folders, data
 * source endpoints, caches, and the catalog. Every stage builds one extent, chosen with
 * `--extent=<extentId>`, and writes under `data/pipeline-working-output/<extentId>/` (git-ignored,
 * regenerable scratch; see data/README.md).
 *
 * The method's own values (drainage-area ratio, cross-sections, rating curves, Drainage-Area Ratio
 * Transfer) live in `modeled-wse-derivation-methods/<method-id>/method-config.ts`, next to the
 * METHOD.md that explains them. Each WSE Polygon Generation Method keeps its parameters in
 * `wse-polygon-generation-methods/<method-id>/method-config.ts`.
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
