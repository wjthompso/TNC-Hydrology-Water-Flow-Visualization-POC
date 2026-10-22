// Modeled data source: where the modeled creek experience gets its JSON.
//
// One interface, two implementations, chosen once at startup from
// `creekDataSourceConfiguration.dataSource`:
//
// - local:  the dev middleware's files under /modeled-water-surface-elevation-data/<extent>/
//           (exactly the URLs the app fetched before this interface existed);
// - hosted: the published ArcGIS Enterprise feature services, rebuilt into the
//           same JSON shapes by the hosted adapters (`hosted-*.ts`).
//
// Every method returns raw JSON (`unknown`), so the existing readers
// (`readModeledCatalog`, `readWsePolygonMethodList`, `readReachCrosswalk`,
// `readCreekSegmentPaths`, `readFlowlineIndex`, the store's file readers)
// validate both sources the same way.

import { configureArcgisRequestAuthentication } from './arcgis-request-authentication';
import { creekDataSourceConfiguration } from './creek-data-source-configuration';
import { HostedFeatureServiceAuthenticationError } from './hosted-feature-service-query';
import { modeledDataUrl } from './modeled-water-catalog';
import { fetchJson } from './modeled-water-data-store';
import {
  buildCreekSegmentPathsFile,
  buildFlowlineIndexFile,
  buildReachCrosswalkFile,
  loadHostedCreekSegmentNetwork,
  type HostedCreekSegmentNetwork,
} from './hosted-creek-segment-network';
import {
  buildHostedModeledCatalog,
  loadHostedModeledWseVersion,
  loadHostedWsePolygonMethods,
  type HostedModeledDatasetId,
  type HostedModeledWseVersion,
  type HostedWsePolygonMethods,
} from './hosted-modeled-catalog';
import { loadHostedTimeSeriesForFlowline } from './hosted-modeled-water-surface-elevation';
import { loadHostedWaterSurfacePolygonsForFlowline } from './hosted-water-surface-polygons';

/** Extent-relative paths of the local files (dev middleware). */
export const LOCAL_MODELED_FILE_PATHS = {
  catalog: '05-catalog/catalog.json',
  wsePolygonMethods: 'wse-polygon-methods.json',
  reachCrosswalk: 'reach-crosswalk.json',
  creekSegmentPaths: 'creek-segment-paths.json',
  flowlineIndexFileName: 'flowline-index.json',
  polygonSetsFolderName: 'water-surface-polygon-sets',
  timeSeriesRoot: '03-time-series',
} as const;

/** The only extent published to the hosted services. */
export const HOSTED_MODELED_EXTENT_ID = 'dangermond-preserve';

export interface ModeledDataSource {
  readonly kind: 'local' | 'hosted';
  /** `05-catalog/catalog.json` shape. */
  loadCatalog(extentId: string): Promise<unknown>;
  /** `wse-polygon-methods.json` shape. */
  loadWsePolygonMethodList(extentId: string): Promise<unknown>;
  /** `reach-crosswalk.json` shape. */
  loadReachCrosswalk(extentId: string): Promise<unknown>;
  /** `creek-segment-paths.json` shape. */
  loadCreekSegmentPaths(extentId: string): Promise<unknown>;
  /** `flowline-index.json` shape for one WSE Polygon Generation Method version folder. */
  loadFlowlineIndex(extentId: string, wsePolygonMethodPath: string): Promise<unknown>;
  /** One TNC flowline's water-surface polygon set file for one method version folder. */
  loadPolygonSets(extentId: string, wsePolygonMethodPath: string, tncComid: string): Promise<unknown>;
  /** One Time Series file; `catalogPath` is a catalog `timeSeries[].paths` entry (relative to 03-time-series/). */
  loadTimeSeries(extentId: string, catalogPath: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Local (dev middleware)

export function createLocalModeledDataSource(): ModeledDataSource {
  const load = (extentId: string, relativePath: string): Promise<unknown> =>
    fetchJson(modeledDataUrl(extentId, relativePath));
  return {
    kind: 'local',
    loadCatalog: (extentId) => load(extentId, LOCAL_MODELED_FILE_PATHS.catalog),
    loadWsePolygonMethodList: (extentId) => load(extentId, LOCAL_MODELED_FILE_PATHS.wsePolygonMethods),
    loadReachCrosswalk: (extentId) => load(extentId, LOCAL_MODELED_FILE_PATHS.reachCrosswalk),
    loadCreekSegmentPaths: (extentId) => load(extentId, LOCAL_MODELED_FILE_PATHS.creekSegmentPaths),
    loadFlowlineIndex: (extentId, methodPath) =>
      load(extentId, `${methodPath}/${LOCAL_MODELED_FILE_PATHS.flowlineIndexFileName}`),
    loadPolygonSets: (extentId, methodPath, tncComid) =>
      load(extentId, `${methodPath}/${LOCAL_MODELED_FILE_PATHS.polygonSetsFolderName}/${tncComid}.json`),
    loadTimeSeries: (extentId, catalogPath) =>
      load(extentId, `${LOCAL_MODELED_FILE_PATHS.timeSeriesRoot}/${catalogPath}`),
  };
}

// ---------------------------------------------------------------------------
// Hosted (ArcGIS Enterprise feature services)

interface HostedContext {
  readonly version: HostedModeledWseVersion;
  readonly network: HostedCreekSegmentNetwork;
  readonly polygonMethods: HostedWsePolygonMethods;
}

export interface HostedModeledDataSourceOptions {
  readonly arcgisPortalUrl: string;
  readonly modeledWseServiceUrl: string;
  readonly wsePolygonsServiceUrl: string;
  readonly showCaliforniaNaturalFlowsMonthly: boolean;
}

export function createHostedModeledDataSource(options: HostedModeledDataSourceOptions): ModeledDataSource {
  // Versions tables and the Creek Segment network load once and are shared by every call.
  let context: Promise<HostedContext> | null = null;
  const loadContext = (extentId: string): Promise<HostedContext> => {
    if (extentId !== HOSTED_MODELED_EXTENT_ID) {
      return Promise.reject(
        new Error(`Hosted modeled data covers only the ${HOSTED_MODELED_EXTENT_ID} extent, not ${extentId}.`),
      );
    }
    context ??= buildHostedContext(options).catch((error: unknown) => {
      context = null; // Let a later call retry, e.g. after the person signs in.
      throw error;
    });
    return context;
  };

  const source: ModeledDataSource = {
    kind: 'hosted',
    async loadCatalog(extentId) {
      const { version, network } = await loadContext(extentId);
      return buildHostedModeledCatalog(version, network, {
        showCaliforniaNaturalFlowsMonthly: options.showCaliforniaNaturalFlowsMonthly,
      });
    },
    async loadWsePolygonMethodList(extentId) {
      return (await loadContext(extentId)).polygonMethods.methodList;
    },
    async loadReachCrosswalk(extentId) {
      return buildReachCrosswalkFile((await loadContext(extentId)).network);
    },
    async loadCreekSegmentPaths(extentId) {
      return buildCreekSegmentPathsFile((await loadContext(extentId)).network);
    },
    async loadFlowlineIndex(extentId) {
      // Hosted bounding boxes come from flowline paths, the same for every method version.
      return buildFlowlineIndexFile((await loadContext(extentId)).network);
    },
    async loadPolygonSets(extentId, methodPath, tncComid) {
      const { network, polygonMethods } = await loadContext(extentId);
      const polygonLayerId = polygonMethods.polygonLayerIdByMethodKey.get(methodKeyOfPath(methodPath));
      if (polygonLayerId === undefined) {
        throw new Error(`No hosted WSE polygon layer for ${methodPath}.`);
      }
      return loadHostedWaterSurfacePolygonsForFlowline({
        wsePolygonsServiceUrl: options.wsePolygonsServiceUrl,
        polygonLayerId,
        network,
        tncComid,
      });
    },
    async loadTimeSeries(extentId, catalogPath) {
      const { version, network } = await loadContext(extentId);
      const request = timeSeriesRequestOfPath(catalogPath);
      return loadHostedTimeSeriesForFlowline({ version, network, ...request });
    },
  };
  return withReadableHostedErrors(source);
}

/**
 * Rewrites hosted failures into one sentence a person can act on; the store
 * shows it in the timeline status line and startup shows it in the error panel.
 */
function withReadableHostedErrors(source: ModeledDataSource): ModeledDataSource {
  const wrap =
    <Arguments extends unknown[]>(load: (...args: Arguments) => Promise<unknown>) =>
    async (...args: Arguments): Promise<unknown> => {
      try {
        return await load(...args);
      } catch (error) {
        console.error(error);
        throw new Error(readableHostedErrorMessage(error), { cause: error });
      }
    };
  return {
    kind: source.kind,
    loadCatalog: wrap(source.loadCatalog),
    loadWsePolygonMethodList: wrap(source.loadWsePolygonMethodList),
    loadReachCrosswalk: wrap(source.loadReachCrosswalk),
    loadCreekSegmentPaths: wrap(source.loadCreekSegmentPaths),
    loadFlowlineIndex: wrap(source.loadFlowlineIndex),
    loadPolygonSets: wrap(source.loadPolygonSets),
    loadTimeSeries: wrap(source.loadTimeSeries),
  };
}

export function readableHostedErrorMessage(error: unknown): string {
  if (error instanceof HostedFeatureServiceAuthenticationError) {
    return 'Sign-in to the Dangermond Preserve ArcGIS portal was cancelled or not accepted. Reload the page to sign in again.';
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not load hosted creek water data from the Dangermond Preserve ArcGIS portal. ${detail}`;
}

async function buildHostedContext(options: HostedModeledDataSourceOptions): Promise<HostedContext> {
  await configureArcgisRequestAuthentication({ arcgisPortalUrl: options.arcgisPortalUrl });
  const [version, polygonMethods] = await Promise.all([
    loadHostedModeledWseVersion({ modeledWseServiceUrl: options.modeledWseServiceUrl }),
    loadHostedWsePolygonMethods({ wsePolygonsServiceUrl: options.wsePolygonsServiceUrl }),
  ]);
  const network = await loadHostedCreekSegmentNetwork({
    modeledWseServiceUrl: options.modeledWseServiceUrl,
    creekSegmentsLayerId: version.layerIds.creekSegments,
    segmentNetworkVersion: version.segmentNetworkVersion,
  });
  return { version, network, polygonMethods };
}

/** `04-water-surface-polygons/<method-id>/v<version>` → `<method-id>@v<version>`. */
function methodKeyOfPath(methodPath: string): string {
  const match = /([^/]+)\/v(\d+)\/?$/.exec(methodPath);
  return match ? `${match[1]}@v${Number(match[2])}` : methodPath;
}

/**
 * Catalog Time Series path → hosted request:
 * `time-series/<dataset>/<variable>/<comid>/WY<year>.json` (hourly) or `…/<comid>.json` (monthly).
 */
function timeSeriesRequestOfPath(catalogPath: string): {
  datasetId: HostedModeledDatasetId;
  tncComid: string;
  waterYear?: number;
} {
  const match = /time-series\/([^/]+)\/[^/]+\/(\d+)(?:\/WY(\d{4}))?\.json$/.exec(catalogPath);
  if (!match) throw new Error(`Not a hosted Time Series path: ${catalogPath}`);
  return {
    datasetId: match[1] as HostedModeledDatasetId,
    tncComid: match[2],
    waterYear: match[3] ? Number(match[3]) : undefined,
  };
}

// ---------------------------------------------------------------------------
// The source this page uses

let activeSource: ModeledDataSource | null = null;

/** Chosen once per page from `VITE_CREEK_DATA_SOURCE` (default local in dev/test, hosted in builds). */
export function modeledDataSource(): ModeledDataSource {
  activeSource ??=
    creekDataSourceConfiguration.dataSource === 'hosted'
      ? createHostedModeledDataSource(creekDataSourceConfiguration)
      : createLocalModeledDataSource();
  return activeSource;
}
