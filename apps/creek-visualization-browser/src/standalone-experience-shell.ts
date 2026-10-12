import EsriMap from '@arcgis/core/Map';
import Camera from '@arcgis/core/Camera';
import SceneView from '@arcgis/core/views/SceneView';
import Point from '@arcgis/core/geometry/Point';
import esriConfig from '@arcgis/core/config.js';

/** Slant range from the segment midpoint, close enough for a ~20 m segment. */
const CAMERA_SLANT_RANGE_M = 180;
/** Degrees from straight down. */
const CAMERA_TILT_DEGREES = 58;

/** A developer key raises tile quota. World Imagery and World Elevation load without one. */
function configureApiKey(): void {
  const apiKey = import.meta.env.VITE_ARCGIS_API_KEY?.trim();
  if (apiKey) esriConfig.apiKey = apiKey;
}

export async function createStandaloneExperienceShell(
  container: HTMLDivElement,
  segmentPathWgs84: readonly (readonly [number, number])[],
): Promise<SceneView> {
  if (segmentPathWgs84.length < 2) {
    throw new Error('The gauge segment needs two vertices to frame the camera.');
  }

  configureApiKey();
  const map = new EsriMap({
    // Esri basemap id "satellite" is World Imagery and does not require an API key.
    basemap: 'satellite',
    // world-elevation is the Terrain3D surface. A second ElevationLayer would duplicate it.
    ground: 'world-elevation',
  });

  const view = new SceneView({
    container,
    map,
    qualityProfile: 'medium',
    // Global mode has no local clipping area, so zoom-out is not cut to a flat clear color.
    viewingMode: 'global',
    environment: {
      starsEnabled: false,
      atmosphereEnabled: true,
    },
    // SceneView constraints in 4.34 have no collision flag.
    // Ground navigationConstraint none keeps the camera free of the terrain.
    // Automatic clip distance scales with the camera, so far zoom stays drawn.
    constraints: {
      tilt: { max: 179 },
    },
    navigation: {
      actionMap: {
        dragPrimary: 'pan',
        dragSecondary: 'rotate',
        mouseWheel: 'zoom',
      },
    },
    ui: { components: ['zoom', 'compass'] },
  });

  map.ground.navigationConstraint = { type: 'none' };
  await view.when();

  const groundElevationM = await sampleWorldElevation(map, pathCenter(segmentPathWgs84));
  await frameSegment(view, segmentPathWgs84, groundElevationM ?? 0);
  return view;
}

async function sampleWorldElevation(
  map: EsriMap,
  center: { lon: number; lat: number },
): Promise<number | null> {
  try {
    const result = await map.ground.queryElevation(
      new Point({
        longitude: center.lon,
        latitude: center.lat,
        spatialReference: { wkid: 4326 },
      }),
    );
    if (result.geometry.type !== 'point') return null;
    const elevationM = result.geometry.z;
    return typeof elevationM === 'number' && Number.isFinite(elevationM) ? elevationM : null;
  } catch {
    return null;
  }
}

async function frameSegment(
  view: SceneView,
  path: readonly (readonly [number, number])[],
  groundElevationM: number,
): Promise<void> {
  const center = pathCenter(path);
  const heading = bearingDegrees(path[0][0], path[0][1], path[path.length - 1][0], path[path.length - 1][1]);
  const tiltRadians = (CAMERA_TILT_DEGREES * Math.PI) / 180;
  const horizontalM = CAMERA_SLANT_RANGE_M * Math.sin(tiltRadians);
  const heightM = CAMERA_SLANT_RANGE_M * Math.cos(tiltRadians);
  const [cameraLon, cameraLat] = destination(center.lon, center.lat, heading + 180, horizontalM);

  await view.goTo(
    new Camera({
      position: {
        longitude: cameraLon,
        latitude: cameraLat,
        z: groundElevationM + heightM,
        spatialReference: { wkid: 4326 },
      },
      heading,
      tilt: CAMERA_TILT_DEGREES,
    }),
    { duration: 0 },
  );
}

function pathCenter(path: readonly (readonly [number, number])[]): { lon: number; lat: number } {
  let lon = 0;
  let lat = 0;
  for (const [vertexLon, vertexLat] of path) {
    lon += vertexLon;
    lat += vertexLat;
  }
  return { lon: lon / path.length, lat: lat / path.length };
}

function bearingDegrees(fromLon: number, fromLat: number, toLon: number, toLat: number): number {
  const fromLatRadians = (fromLat * Math.PI) / 180;
  const toLatRadians = (toLat * Math.PI) / 180;
  const deltaLon = ((toLon - fromLon) * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(toLatRadians);
  const x =
    Math.cos(fromLatRadians) * Math.sin(toLatRadians) -
    Math.sin(fromLatRadians) * Math.cos(toLatRadians) * Math.cos(deltaLon);
  return normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

function destination(
  lon: number,
  lat: number,
  bearing: number,
  distanceM: number,
): [number, number] {
  const earthRadiusM = 6378137;
  const angular = distanceM / earthRadiusM;
  const bearingRadians = (normalizeDegrees(bearing) * Math.PI) / 180;
  const latRadians = (lat * Math.PI) / 180;
  const lonRadians = (lon * Math.PI) / 180;
  const nextLat = Math.asin(
    Math.sin(latRadians) * Math.cos(angular) +
      Math.cos(latRadians) * Math.sin(angular) * Math.cos(bearingRadians),
  );
  const nextLon =
    lonRadians +
    Math.atan2(
      Math.sin(bearingRadians) * Math.sin(angular) * Math.cos(latRadians),
      Math.cos(angular) - Math.sin(latRadians) * Math.sin(nextLat),
    );
  return [(nextLon * 180) / Math.PI, (nextLat * 180) / Math.PI];
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
