import type { MeshData } from './types';

export interface Wgs84Origin {
  lon: number;
  lat: number;
}

/** Convert local east-north meters to WGS84 lon/lat using reach origin. */
export function localToWgs84(
  x: number,
  y: number,
  origin: Wgs84Origin,
): [lon: number, lat: number] {
  const latRad = (origin.lat * Math.PI) / 180;
  const lon = origin.lon + x / (111320 * Math.cos(latRad));
  const lat = origin.lat + y / 111320;
  return [lon, lat];
}

/** Convert local (x, y, z) vertex to [lon, lat, elevationM]. */
export function localVertexToGeo(
  x: number,
  y: number,
  elevationM: number,
  origin: Wgs84Origin,
): [lon: number, lat: number, z: number] {
  const [lon, lat] = localToWgs84(x, y, origin);
  return [lon, lat, elevationM];
}

/** Copy mesh with all z values set to 0 for relative-to-ground draping. */
export function flattenMeshZ(mesh: MeshData): MeshData {
  const positions = mesh.positions.slice();
  for (let i = 2; i < positions.length; i += 3) {
    positions[i] = 0;
  }
  return { positions, indices: mesh.indices };
}

/** Triangle mesh → GeoJSON MultiPolygon rings (each triangle is its own polygon). */
export function meshToMultiPolygonCoordinates(
  mesh: MeshData,
  origin: Wgs84Origin,
  zOverride?: number,
): number[][][][] {
  const { positions, indices } = mesh;
  const polygons: number[][][][] = [];

  for (let i = 0; i < indices.length; i += 3) {
    const ring: number[][] = [];
    for (let j = 0; j < 3; j += 1) {
      const vi = indices[i + j] * 3;
      ring.push(
        localVertexToGeo(
          positions[vi],
          positions[vi + 1],
          zOverride ?? positions[vi + 2],
          origin,
        ),
      );
    }
    ring.push(ring[0]);
    polygons.push([ring]);
  }

  return polygons;
}

/** Centerline lon/lat pairs for GeoJSON LineString / ArcGIS Polyline paths. */
export function centerlineToPath(
  centerline: Array<{ lon: number; lat: number }>,
  elevationM: number,
): number[][] {
  return centerline.map((pt) => [pt.lon, pt.lat, elevationM]);
}

export function extentFromCenterline(
  centerline: Array<{ lon: number; lat: number }>,
): { xmin: number; ymin: number; xmax: number; ymax: number } {
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;

  for (const pt of centerline) {
    xmin = Math.min(xmin, pt.lon);
    ymin = Math.min(ymin, pt.lat);
    xmax = Math.max(xmax, pt.lon);
    ymax = Math.max(ymax, pt.lat);
  }

  return { xmin, ymin, xmax, ymax };
}
