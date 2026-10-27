// Asks the dev server for the 1 m lidar ground height under a longitude and latitude (Dev tools water
// click inspector). The answer comes from vite-plugins/dev-lidar-ground-plugin.ts, which reads the
// pipeline's local lidar tiles. Hosted builds and `vite build` have no such endpoint, so every lookup
// there ends as `endpoint-absent`. Heights are meters NAVD88.

export interface LidarGroundHeights {
  /** The 1 m cell the point lies in. */
  nearestCellM: number;
  /** Blend of the four cell centers around the point; null when one of them is NoData. */
  bilinearM: number | null;
  /** Lowest and highest of the 5 × 5 cells around the nearest cell. */
  cellSpreadM: [number, number];
}

export type LidarGroundLookup =
  | { status: 'pending' }
  | { status: 'found'; heights: LidarGroundHeights }
  /** The dev server answered, but the point is outside every tile, on NoData, or the extent has no tiles on disk. */
  | { status: 'no-lidar-here' }
  /** No dev endpoint answered: hosted data, a production build, or a stopped dev server. */
  | { status: 'endpoint-absent' };

const LIDAR_GROUND_URL = '/dev-lidar-ground';
/**
 * Nine decimals of longitude and latitude is about 0.1 mm. The bilinear height moves with the exact point (on a 60% slope, 0.1 m
 * of rounding moves it 6 cm), and anchors saved 8 decimals apart must not share one answer.
 */
const KEY_DECIMALS = 9;

const lookups = new Map<string, Promise<LidarGroundLookup>>();

export function lidarGroundKey(extentId: string, longitude: number, latitude: number): string {
  return `${extentId}|${longitude.toFixed(KEY_DECIMALS)}|${latitude.toFixed(KEY_DECIMALS)}`;
}

/** One request per position (to 0.1 mm) and extent; later calls reuse the first answer. */
export function lookUpLidarGround(extentId: string, longitude: number, latitude: number): Promise<LidarGroundLookup> {
  if (!import.meta.env.DEV) return Promise.resolve({ status: 'endpoint-absent' });
  const key = lidarGroundKey(extentId, longitude, latitude);
  const cached = lookups.get(key);
  if (cached) return cached;
  const request = fetchLidarGround(extentId, longitude, latitude);
  lookups.set(key, request);
  return request;
}

async function fetchLidarGround(extentId: string, longitude: number, latitude: number): Promise<LidarGroundLookup> {
  const query = new URLSearchParams({
    extent: extentId,
    lon: longitude.toFixed(KEY_DECIMALS),
    lat: latitude.toFixed(KEY_DECIMALS),
  });
  try {
    const response = await fetch(`${LIDAR_GROUND_URL}?${query}`);
    // A static host answers an unknown path with its index page, which is not JSON.
    if (!response.headers.get('content-type')?.includes('application/json')) return { status: 'endpoint-absent' };
    if (!response.ok) return { status: 'no-lidar-here' };
    const body: unknown = await response.json();
    return isHeights(body) ? { status: 'found', heights: body } : { status: 'no-lidar-here' };
  } catch {
    return { status: 'endpoint-absent' };
  }
}

function isHeights(value: unknown): value is LidarGroundHeights {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.nearestCellM === 'number' &&
    (record.bilinearM === null || typeof record.bilinearM === 'number') &&
    Array.isArray(record.cellSpreadM) &&
    record.cellSpreadM.length === 2
  );
}
