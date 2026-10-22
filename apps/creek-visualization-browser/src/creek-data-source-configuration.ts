/**
 * Creek data source configuration.
 *
 * Reads Vite environment variables once and exposes a typed, readonly
 * configuration object that decides where creek water data comes from:
 *
 * - `hosted`: published ArcGIS Enterprise feature services on the
 *   Dangermond Preserve portal (read-only queries).
 * - `local`: pipeline working output served by the local Vite dev plugin.
 *
 * Layer and table ids are discovered at runtime from each service's versions
 * table (`arcgis_table_names`). The constants below are the published ids and
 * serve as the fallback when discovery is unavailable.
 */

export type CreekDataSourceKind = 'hosted' | 'local';

export const DEFAULT_ARCGIS_PORTAL_URL = 'https://dangermondpreserve-spatial.com/portal';

export const DEFAULT_MODELED_WSE_SERVICE_URL =
  'https://dangermondpreserve-spatial.com/server/rest/services/Hosted/creek_water_visualization_modeled_wse/FeatureServer';

export const DEFAULT_WSE_POLYGONS_SERVICE_URL =
  'https://dangermondpreserve-spatial.com/server/rest/services/Hosted/creek_water_visualization_wse_polygons/FeatureServer';

/** Public feature service of the observed USGS gauge readings ("Creek Gauge Data" is layer 2). */
export const DEFAULT_CREEK_GAUGE_SERVICE_URL =
  'https://dangermondpreserve-spatial.com/server/rest/services/Dangermond_Creek_Gauges/FeatureServer';

/** Published layer/table ids in the modeled water surface elevation (WSE) feature service. */
export const FALLBACK_MODELED_WSE_LAYER_IDS = {
  creekSegments: 0,
  californiaNaturalFlowsIntervals: 1,
  californiaNaturalFlowsValues: 2,
  nationalWaterModelIntervals: 3,
  versions: 4,
} as const;

/** Published layer/table ids in the WSE polygons feature service. */
export const FALLBACK_WSE_POLYGONS_LAYER_IDS = {
  wsePolygons: 0,
  versions: 1,
} as const;

export type ModeledWseLayerIds = {
  readonly [Key in keyof typeof FALLBACK_MODELED_WSE_LAYER_IDS]: number;
};

export type WsePolygonsLayerIds = {
  readonly [Key in keyof typeof FALLBACK_WSE_POLYGONS_LAYER_IDS]: number;
};

export interface CreekDataSourceConfiguration {
  readonly dataSource: CreekDataSourceKind;
  readonly arcgisPortalUrl: string;
  readonly modeledWseServiceUrl: string;
  readonly wsePolygonsServiceUrl: string;
  readonly creekGaugeServiceUrl: string;
  readonly showCaliforniaNaturalFlowsMonthly: boolean;
}

/** Subset of `import.meta.env` this module reads; injectable for tests and Node scripts. */
export interface CreekDataSourceEnvironment {
  readonly DEV?: boolean;
  readonly VITE_TEST_MODE?: string;
  readonly VITE_CREEK_DATA_SOURCE?: string;
  readonly VITE_ARCGIS_PORTAL_URL?: string;
  readonly VITE_MODELED_WSE_SERVICE_URL?: string;
  readonly VITE_WSE_POLYGONS_SERVICE_URL?: string;
  readonly VITE_CREEK_GAUGE_SERVICE_URL?: string;
  readonly VITE_SHOW_CALIFORNIA_NATURAL_FLOWS_MONTHLY?: string;
}

function nonEmptyOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isTruthyFlag(value: string | undefined): boolean {
  return ['true', '1', 'yes'].includes((value ?? '').trim().toLowerCase());
}

function resolveDataSourceKind(environment: CreekDataSourceEnvironment): CreekDataSourceKind {
  const requested = environment.VITE_CREEK_DATA_SOURCE?.trim().toLowerCase();
  if (requested === 'hosted' || requested === 'local') {
    return requested;
  }
  if (requested) {
    throw new Error(
      `VITE_CREEK_DATA_SOURCE must be "hosted" or "local"; received "${environment.VITE_CREEK_DATA_SOURCE}".`,
    );
  }
  const isDevelopmentOrTestMode = Boolean(environment.DEV) || isTruthyFlag(environment.VITE_TEST_MODE);
  return isDevelopmentOrTestMode ? 'local' : 'hosted';
}

export function resolveCreekDataSourceConfiguration(
  environment: CreekDataSourceEnvironment,
): CreekDataSourceConfiguration {
  return Object.freeze({
    dataSource: resolveDataSourceKind(environment),
    arcgisPortalUrl: withoutTrailingSlash(
      nonEmptyOrDefault(environment.VITE_ARCGIS_PORTAL_URL, DEFAULT_ARCGIS_PORTAL_URL),
    ),
    modeledWseServiceUrl: withoutTrailingSlash(
      nonEmptyOrDefault(environment.VITE_MODELED_WSE_SERVICE_URL, DEFAULT_MODELED_WSE_SERVICE_URL),
    ),
    wsePolygonsServiceUrl: withoutTrailingSlash(
      nonEmptyOrDefault(environment.VITE_WSE_POLYGONS_SERVICE_URL, DEFAULT_WSE_POLYGONS_SERVICE_URL),
    ),
    creekGaugeServiceUrl: withoutTrailingSlash(
      nonEmptyOrDefault(environment.VITE_CREEK_GAUGE_SERVICE_URL, DEFAULT_CREEK_GAUGE_SERVICE_URL),
    ),
    showCaliforniaNaturalFlowsMonthly: isTruthyFlag(environment.VITE_SHOW_CALIFORNIA_NATURAL_FLOWS_MONTHLY),
  });
}

/**
 * Configuration for the running browser app, resolved from `import.meta.env`.
 * Node scripts have no `import.meta.env`; they get the defaults (hosted).
 */
export const creekDataSourceConfiguration: CreekDataSourceConfiguration =
  resolveCreekDataSourceConfiguration(import.meta.env ?? {});

/** Published table names (from `arcgis_table_names`) for each modeled WSE layer role. */
export const MODELED_WSE_M1_V1_TABLE_NAME_BY_ROLE = {
  creekSegments: 'modeled_wse_m1_v1_creek_segments',
  californiaNaturalFlowsIntervals: 'modeled_wse_m1_v1_cnf_monthly_held_intervals',
  californiaNaturalFlowsValues: 'modeled_wse_m1_v1_cnf_monthly_values',
  nationalWaterModelIntervals: 'modeled_wse_m1_v1_nwm_hourly_held_intervals',
  versions: 'modeled_wse_versions',
} as const satisfies Record<keyof ModeledWseLayerIds, string>;

/** Published table names (from `arcgis_table_names`) for each WSE polygons layer role. */
export const WSE_POLYGONS_M1_V1_TABLE_NAME_BY_ROLE = {
  wsePolygons: 'wse_polygons_m1_v1',
  versions: 'wse_polygon_versions',
} as const satisfies Record<keyof WsePolygonsLayerIds, string>;

/**
 * Maps a versions-table `arcgis_table_names` value to layer ids.
 *
 * Accepts a JSON object of table name → layer id (`{"modeled_wse_versions": 4, ...}`),
 * as the publishing script writes after publishing. Any role not found keeps its fallback id.
 */
export function resolveLayerIdsFromArcgisTableNames<LayerIds extends Record<string, number>>(
  arcgisTableNames: unknown,
  fallbackLayerIds: LayerIds,
  tableNameByRole: { readonly [Role in keyof LayerIds]: string },
): LayerIds {
  const layerIdByTableName = parseArcgisTableNames(arcgisTableNames);
  const resolved = { ...fallbackLayerIds };
  for (const role of Object.keys(fallbackLayerIds) as Array<keyof LayerIds>) {
    const discoveredId = layerIdByTableName.get(tableNameByRole[role]);
    if (discoveredId !== undefined) {
      resolved[role] = discoveredId as LayerIds[keyof LayerIds];
    }
  }
  return Object.freeze(resolved);
}

function parseArcgisTableNames(arcgisTableNames: unknown): Map<string, number> {
  let parsed: unknown = arcgisTableNames;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return new Map();
    }
  }
  // A plain list of names (the frozen upload writes "a, b, c") carries no layer ids; list
  // order is not layer-id order, so only a name → id object counts.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return new Map(
      Object.entries(parsed).flatMap(([name, id]) =>
        typeof id === 'number' && Number.isInteger(id) ? [[name, id] as const] : [],
      ),
    );
  }
  return new Map();
}
