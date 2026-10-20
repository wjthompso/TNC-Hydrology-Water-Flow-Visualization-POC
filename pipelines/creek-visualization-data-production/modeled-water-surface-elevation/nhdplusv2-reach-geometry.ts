import path from 'node:path';
import { expectRecord, isRecord, readJson, writePrettyJson } from '../json-files.ts';
import { distancePointToSegment, roundToDecimals, type UtmPoint } from '../utm-geometry.ts';
import { fetchJson, mapWithConcurrency, urlWithParams } from './http-download.ts';
import { EPA_NHDPLUSV2_FLOWLINE_QUERY, NHDPLUSV2_REACH_GEOMETRY_CACHE_FILE } from './pipeline-configuration.ts';

/**
 * NHDPlusV2 reach flowline geometry from the EPA NHDPlus flowline service, in EPSG 32610 meters,
 * for the distance check on Drainage-Area Ratio Transfer segments. Each reach is fetched once and
 * cached in `00-acquire/`; a rerun fetches only reaches not yet in the cache.
 */

/** One reach's polyline paths: each path is a list of [x, y] in EPSG 32610 meters. */
type ReachPaths = [number, number][][];

interface ReachGeometryCache {
  description: string;
  source: string;
  spatialReference: 'EPSG:32610';
  pathsByComid: Record<string, ReachPaths>;
}

const EPSG_32610_WKID = 32610;
const FETCH_CONCURRENCY = 4;

async function fetchReachPaths(nhdplusV2Comid: number): Promise<ReachPaths | null> {
  const url = urlWithParams(EPA_NHDPLUSV2_FLOWLINE_QUERY, {
    where: `COMID=${nhdplusV2Comid}`,
    outFields: 'COMID',
    returnGeometry: 'true',
    outSR: String(EPSG_32610_WKID),
    f: 'json',
  });
  const response = expectRecord(await fetchJson(url), 'EPA NHDPlusV2 flowline geometry response');
  if (isRecord(response.error)) throw new Error(`EPA NHDPlusV2 flowline geometry query failed: ${JSON.stringify(response.error)}`);
  const features = Array.isArray(response.features) ? response.features : [];
  const first = features[0];
  if (!isRecord(first) || !isRecord(first.geometry) || !Array.isArray(first.geometry.paths)) return null;
  const paths: ReachPaths = [];
  for (const rawPath of first.geometry.paths) {
    if (!Array.isArray(rawPath)) continue;
    const vertices: [number, number][] = [];
    for (const vertex of rawPath) {
      if (Array.isArray(vertex) && typeof vertex[0] === 'number' && typeof vertex[1] === 'number') {
        vertices.push([roundToDecimals(vertex[0], 3), roundToDecimals(vertex[1], 3)]);
      }
    }
    if (vertices.length > 0) paths.push(vertices);
  }
  return paths.length === 0 ? null : paths;
}

async function readGeometryCache(cachePath: string): Promise<ReachGeometryCache> {
  try {
    const record = expectRecord(await readJson(cachePath), cachePath);
    if (record.source === EPA_NHDPLUSV2_FLOWLINE_QUERY && isRecord(record.pathsByComid)) {
      return record as unknown as ReachGeometryCache;
    }
  } catch {
    // No usable cache yet.
  }
  return {
    description:
      'NHDPlusV2 reach flowline geometry (EPSG 32610 meters) per NHDPlusV2 COMID, for the distance from each ' +
      'Drainage-Area Ratio Transfer segment to the reach it borrows discharge from. Reused on reruns.',
    source: EPA_NHDPLUSV2_FLOWLINE_QUERY,
    spatialReference: 'EPSG:32610',
    pathsByComid: {},
  };
}

/**
 * Flowline paths for every requested reach, reading the cache in `cacheDirectory` and fetching
 * only the reaches it lacks. A reach the service returns no geometry for maps to null.
 */
export async function loadReachGeometries(input: {
  nhdplusV2Comids: readonly number[];
  cacheDirectory: string;
}): Promise<{ pathsByComid: Map<number, ReachPaths | null>; cachePath: string; fetched: number; reused: number }> {
  const cachePath = path.join(input.cacheDirectory, NHDPLUSV2_REACH_GEOMETRY_CACHE_FILE);
  const cache = await readGeometryCache(cachePath);
  const pathsByComid = new Map<number, ReachPaths | null>();
  let fetched = 0;
  let reused = 0;
  try {
    await mapWithConcurrency([...new Set(input.nhdplusV2Comids)], FETCH_CONCURRENCY, async (comid) => {
      const cached = cache.pathsByComid[String(comid)];
      if (cached !== undefined) {
        pathsByComid.set(comid, cached);
        reused += 1;
        return;
      }
      const paths = await fetchReachPaths(comid);
      if (paths !== null) cache.pathsByComid[String(comid)] = paths;
      pathsByComid.set(comid, paths);
      fetched += 1;
    });
  } finally {
    // Saved even after an error, so the reaches fetched so far survive.
    if (fetched > 0) await writePrettyJson(cachePath, cache);
  }
  return { pathsByComid, cachePath, fetched, reused };
}

/** Distance from `point` to the nearest point on any of the reach's paths, meters. */
export function distanceToReachM(point: UtmPoint, paths: ReachPaths): number {
  let nearest = Infinity;
  for (const vertices of paths) {
    if (vertices.length === 1) {
      const [x, y] = vertices[0] as [number, number];
      nearest = Math.min(nearest, Math.hypot(point.x - x, point.y - y));
    }
    for (let index = 1; index < vertices.length; index += 1) {
      const [startX, startY] = vertices[index - 1] as [number, number];
      const [endX, endY] = vertices[index] as [number, number];
      nearest = Math.min(nearest, distancePointToSegment(point, { x: startX, y: startY }, { x: endX, y: endY }));
    }
  }
  return nearest;
}

/** Count, min, median, p90, max, and coarse bins of the transfer distances, for the stage manifest. */
export function summarizeTransferDistances(distancesM: readonly number[]): {
  count: number;
  minM: number | null;
  medianM: number | null;
  p90M: number | null;
  maxM: number | null;
  countByBin: Record<string, number>;
} {
  const sorted = [...distancesM].sort((a, b) => a - b);
  const at = (fraction: number): number | null =>
    sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] as number);
  const binEdgesM = [50, 100, 250, 500, 1000];
  const countByBin: Record<string, number> = {};
  let lowerEdge = 0;
  for (const upperEdge of binEdgesM) {
    countByBin[`${lowerEdge}-${upperEdge} m`] = sorted.filter((distance) => distance >= lowerEdge && distance < upperEdge).length;
    lowerEdge = upperEdge;
  }
  countByBin[`${lowerEdge}+ m`] = sorted.filter((distance) => distance >= lowerEdge).length;
  return {
    count: sorted.length,
    minM: at(0),
    medianM: at(0.5),
    p90M: at(0.9),
    maxM: sorted.length === 0 ? null : (sorted[sorted.length - 1] as number),
    countByBin,
  };
}
