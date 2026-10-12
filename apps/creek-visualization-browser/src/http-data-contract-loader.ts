import {
  assembleLoadedCreekVisualization,
  PublishedCreekDataError,
  type LoadedCreekVisualization,
} from './creek-data-contract';

const DATA_ROOT = '/published-creek-visualization-data';
const JALAMA_STATION_ID = 'USGS-11120600';
const OBSERVED_SERIES_PATH = `${DATA_ROOT}/creek-segment-time-series/usgs-11120600-observed-wse.json`;

export async function loadPublishedCreekVisualizationData(): Promise<LoadedCreekVisualization> {
  const [
    creekSegments,
    waterSurfacePolygonSets,
    monitoringStations,
    dataSourceMetadata,
    observedTimeSeries,
  ] = await Promise.all([
    fetchJson(`${DATA_ROOT}/creek-segments.json`),
    fetchJson(`${DATA_ROOT}/water-surface-polygon-sets.json`),
    fetchJson(`${DATA_ROOT}/monitoring-stations.json`),
    fetchJson(`${DATA_ROOT}/data-source-metadata.json`),
    fetchJson(OBSERVED_SERIES_PATH),
  ]);

  return assembleLoadedCreekVisualization(
    {
      creekSegments,
      waterSurfacePolygonSets,
      monitoringStations,
      dataSourceMetadata,
      observedTimeSeries,
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
