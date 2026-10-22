import {
  assembleLoadedCreekVisualization,
  PublishedCreekDataError,
  type LoadedCreekVisualization,
} from './creek-data-contract';
import { creekDataSourceConfiguration } from './creek-data-source-configuration';
import { HostedFeatureServiceAuthenticationError } from './hosted-feature-service-query';

/** `BASE_URL` keeps the shipped files reachable when the app is built under a sub-path, e.g. inside the Digital Twin. */
const DATA_ROOT = `${import.meta.env.BASE_URL}published-creek-visualization-data`;
const JALAMA_STATION_ID = 'USGS-11120600';
const OBSERVED_SERIES_PATH = `${DATA_ROOT}/creek-segment-time-series/usgs-11120600-observed-wse.json`;
/** Creek Segment Observed WSE Propagation (UCS-300): beds and neighbours of the gauge segment. Ships with the app in both data modes. */
const OBSERVED_WSE_PROPAGATION_PATH = `${DATA_ROOT}/observed-wse-propagation.json`;

/** Observed gauge data: hosted ArcGIS services in production builds, shipped local files in dev and tests. */
export async function loadPublishedCreekVisualizationData(): Promise<LoadedCreekVisualization> {
  return creekDataSourceConfiguration.dataSource === 'hosted'
    ? loadHostedCreekVisualizationData()
    : loadLocalCreekVisualizationData();
}

async function loadHostedCreekVisualizationData(): Promise<LoadedCreekVisualization> {
  try {
    const [{ configureArcgisRequestAuthentication }, { loadHostedObservedGauge }] = await Promise.all([
      import('./arcgis-request-authentication'),
      import('./hosted-observed-gauge'),
    ]);
    await configureArcgisRequestAuthentication({ arcgisPortalUrl: creekDataSourceConfiguration.arcgisPortalUrl });
    const observedWsePropagation = await fetchJson(OBSERVED_WSE_PROPAGATION_PATH);
    const { files } = await loadHostedObservedGauge({ ...creekDataSourceConfiguration, observedWsePropagation });
    return assembleLoadedCreekVisualization(files, JALAMA_STATION_ID);
  } catch (error) {
    console.error(error);
    throw new PublishedCreekDataError(readableHostedObservedErrorMessage(error));
  }
}

/** One sentence a person can act on; the startup error panel shows it. */
function readableHostedObservedErrorMessage(error: unknown): string {
  if (error instanceof HostedFeatureServiceAuthenticationError) {
    return 'Sign-in to the Dangermond Preserve ArcGIS portal was cancelled or not accepted. Reload the page to sign in again.';
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not load observed creek water data from the Dangermond Preserve ArcGIS portal. ${detail}`;
}

async function loadLocalCreekVisualizationData(): Promise<LoadedCreekVisualization> {
  const [
    creekSegments,
    waterSurfacePolygonSets,
    monitoringStations,
    dataSourceMetadata,
    observedTimeSeries,
    observedWsePropagation,
  ] = await Promise.all([
    fetchJson(`${DATA_ROOT}/creek-segments.json`),
    fetchJson(`${DATA_ROOT}/water-surface-polygon-sets.json`),
    fetchJson(`${DATA_ROOT}/monitoring-stations.json`),
    fetchJson(`${DATA_ROOT}/data-source-metadata.json`),
    fetchJson(OBSERVED_SERIES_PATH),
    fetchJson(OBSERVED_WSE_PROPAGATION_PATH),
  ]);

  return assembleLoadedCreekVisualization(
    {
      creekSegments,
      waterSurfacePolygonSets,
      monitoringStations,
      dataSourceMetadata,
      observedTimeSeries,
      observedWsePropagation,
    },
    JALAMA_STATION_ID,
  );
}

async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new PublishedCreekDataError(`Could not reach ${url}.`);
  }
  if (!response.ok) {
    throw new PublishedCreekDataError(`Could not load ${url} (${response.status}).`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new PublishedCreekDataError(`${url} is not valid JSON.`);
  }
}
