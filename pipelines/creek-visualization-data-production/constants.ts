import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pipelineDirectory = path.dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = path.resolve(pipelineDirectory, '../..');

export const retainedSourceDirectory = path.join(repositoryRoot, 'data/retained-backend-source-data');
export const publishedDirectory = path.join(
  repositoryRoot,
  'apps/creek-visualization-browser/public/published-creek-visualization-data',
);

export const FLOWLINE_SNAPSHOT_FILE = 'tnc-flowline-27714637.json';
export const STATION_SNAPSHOT_FILE = 'usgs-11120600-station.json';
export const OBSERVATIONS_SNAPSHOT_FILE = 'usgs-11120600-observations.json';
export const ELEVATION_SNAPSHOT_FILE = 'usgs-3dep-1m-window-jalama-27714637.tif';
export const RETENTION_MANIFEST_FILE = 'retention-manifest.json';
export const ASSIGNMENT_FILE = 'reviewed-assignments/monitoring-station-assignment-usgs-11120600.json';
/**
 * Reviewed copy of Stage 4's prepared water-surface polygon set for the gauge's Creek Segment,
 * WSE Polygon Generation Method junction-sloped-terrain-fill v1. Publish copies it byte for byte,
 * so observed and modeled water draw the same polygons. Its provenance file records the Stage 4
 * source path, method version, and source-file SHA-256.
 */
export const OBSERVED_POLYGON_SET_SNAPSHOT_FILE = 'stage-04-junction-sloped-terrain-fill-v1-27714637-026-polygon-set.json';
export const OBSERVED_POLYGON_SET_PROVENANCE_FILE =
  'stage-04-junction-sloped-terrain-fill-v1-27714637-026-polygon-set.provenance.json';

export const TNC_FLOWLINE_QUERY =
  'https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_nhd24kflowlines_streams/FeatureServer/7/query';
export const USGS_STATION_QUERY =
  'https://dangermondpreserve-spatial.com/server/rest/services/Dangermond_Creek_Gauges/MapServer/1/query';
export const USGS_OBSERVATION_QUERY =
  'https://dangermondpreserve-spatial.com/server/rest/services/Dangermond_Creek_Gauges/MapServer/2/query';
export const USGS_3DEP_EXPORT =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';

export const COMID = 27714637;
export const MONITORING_LOCATION_ID = 'USGS-11120600';
export const OBSERVATION_STATION_ID = 1;
export const PUBLISHED_STATION_NAME = 'Jalama Creek near Lompoc';
export const OBSERVED_SOURCE_ID = 'usgs-11120600-observed-wse';
export const OBSERVED_SOURCE_NAME = 'USGS 11120600 Jalama Creek near Lompoc gauge height';
export const SEGMENT_NETWORK_VERSION = 'jalama-27714637-v1';
export const ASSIGNMENT_METHOD = 'nearest original-vertex Creek Segment in EPSG 32610';

/** Gauge datum for Jalama Near Lompoc, feet NAVD88. Treated as constant. */
export const GAUGE_DATUM_FT = 83.34;
export const FEET_TO_METERS = 0.3048;

export const BUCKET_STEP_M = 0.05;
export const CORRIDOR_HALF_WIDTH_M = 100;
/**
 * Outward horizontal distance (meters) by which the wet mask is dilated before
 * the prepared water-surface polygon is traced. The margin lets the surrounding
 * bank terrain depth-occlude the jagged 1 m rim. The dilation is bounded by the
 * Creek Segment corridor, so it cannot bleed into a neighbouring creek.
 */
export const BANK_OVERLAP_MARGIN_M = 2;
export const ELEVATION_WINDOW_SIZE_M = 400;
export const ELEVATION_WINDOW_PIXELS = 400;
export const CENTERLINE_SAMPLE_SPACING_M = 0.5;
export const OBSERVATION_PAGE_SIZE = 2000;

export const OBSERVATION_FIELDS = [
  'id',
  'station_id',
  'timestamp_utc',
  'gauge_height',
  'gauge_height_units',
  'approval_status',
] as const;

export const OBSERVATION_ORDER = 'timestamp_utc ASC,id ASC';
