import proj4 from 'proj4';

proj4.defs('EPSG:32610', '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs');
proj4.defs('EPSG:32611', '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs');

export interface UtmPoint {
  x: number;
  y: number;
}

export function roundToDecimals(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

export function utm10nToWgs84(x: number, y: number): [number, number] {
  const projected = proj4('EPSG:32610', 'EPSG:4326', [x, y]);
  const longitude = projected[0];
  const latitude = projected[1];
  if (
    longitude === undefined ||
    latitude === undefined ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude)
  ) {
    throw new Error(`Could not project UTM coordinate ${x}, ${y} to WGS84.`);
  }
  return [longitude, latitude];
}

/** UTM zone 10N (EPSG 32610) to UTM zone 11N (EPSG 32611), both in meters. */
export function utm10nToUtm11n(point: UtmPoint): UtmPoint {
  const [x, y] = proj4('EPSG:32610', 'EPSG:32611', [point.x, point.y]);
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Could not project UTM zone 10N coordinate ${point.x}, ${point.y} to zone 11N.`);
  }
  return { x, y };
}

/** Distance from a point to the finite segment, in the same units as the coordinates. */
export function distancePointToSegment(point: UtmPoint, start: UtmPoint, end: UtmPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const unclamped = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const t = Math.min(1, Math.max(0, unclamped));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}
