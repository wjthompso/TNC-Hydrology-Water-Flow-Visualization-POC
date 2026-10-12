import EsriMap from '@arcgis/core/Map';
import Basemap from '@arcgis/core/Basemap';
import Camera from '@arcgis/core/Camera';
import SceneView from '@arcgis/core/views/SceneView';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import TileLayer from '@arcgis/core/layers/TileLayer';
import Extent from '@arcgis/core/geometry/Extent';
import Point from '@arcgis/core/geometry/Point';
import esriConfig from '@arcgis/core/config.js';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import Usgs3DepElevationLayer, { preflightElevationAtPoint } from './usgs-elevation-layer';

export type BasemapMode = 'usgs-imagery' | 'arcgis-imagery';
export type ElevationSource = 'usgs-3dep' | 'world-elevation' | 'none';

export interface StandaloneExperienceShell {
  view: SceneView;
  basemapMode: BasemapMode;
  elevationSource: ElevationSource;
}

const USGS_IMAGERY_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer';
/** Keep the local clip wall far from the segment so zoom-in does not hit a skirt. */
const TERRAIN_BUFFER_M = 25000;
/** USGS Imagery Only actually caches through WM LOD 16 (~2.4 m/px). */
const USGS_IMAGERY_MAX_LOD = 16;
/** Slant range from the segment midpoint, close enough for a ~20 m segment. */
const CAMERA_SLANT_RANGE_M = 180;
/** Degrees from straight down. */
const CAMERA_TILT_DEGREES = 58;

function configureApiKey(): BasemapMode {
  const apiKey = import.meta.env.VITE_ARCGIS_API_KEY?.trim();
  if (apiKey) {
    esriConfig.apiKey = apiKey;
    return 'arcgis-imagery';
  }
  return 'usgs-imagery';
}

async function createBasemap(mode: BasemapMode): Promise<Basemap | string> {
  if (mode === 'arcgis-imagery') return 'arcgis/imagery';
  const imagery = new TileLayer({
    url: USGS_IMAGERY_URL,
    title: 'USGS Imagery',
  });
  await imagery.load();
  // Cap lods instead of maxScale: maxScale hides the layer when zoomed in
  // past LOD 16, which leaves the slate ground. Reusing LOD 16 tiles keeps
  // satellite draped on the creek corridor.
  imagery.tileInfo.lods = imagery.tileInfo.lods.filter(
    (lod) => lod.level <= USGS_IMAGERY_MAX_LOD,
  );
  return new Basemap({
    baseLayers: [imagery],
    title: 'USGS Imagery',
  });
}

function createGround(basemapMode: BasemapMode): __esri.GroundProperties | 'world-elevation' {
  if (basemapMode === 'arcgis-imagery') return 'world-elevation';
  return {
    navigationConstraint: { type: 'none' },
    surfaceColor: [15, 23, 42],
  };
}

function terrainClipExtent(path: readonly (readonly [number, number])[]): Extent {
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (const [lon, lat] of path) {
    xmin = Math.min(xmin, lon);
    ymin = Math.min(ymin, lat);
    xmax = Math.max(xmax, lon);
    ymax = Math.max(ymax, lat);
  }
  const southwest = webMercatorUtils.geographicToWebMercator(
    new Point({ longitude: xmin, latitude: ymin, spatialReference: { wkid: 4326 } }),
  ) as Point;
  const northeast = webMercatorUtils.geographicToWebMercator(
    new Point({ longitude: xmax, latitude: ymax, spatialReference: { wkid: 4326 } }),
  ) as Point;
  return new Extent({
    xmin: southwest.x - TERRAIN_BUFFER_M,
    ymin: southwest.y - TERRAIN_BUFFER_M,
    xmax: northeast.x + TERRAIN_BUFFER_M,
    ymax: northeast.y + TERRAIN_BUFFER_M,
    spatialReference: { wkid: 3857 },
  });
}

export async function createStandaloneExperienceShell(
  container: HTMLDivElement,
  segmentPathWgs84: readonly (readonly [number, number])[],
): Promise<StandaloneExperienceShell> {
  if (segmentPathWgs84.length < 2) {
    throw new Error('The gauge segment needs two vertices to frame the camera.');
  }

  const basemapMode = configureApiKey();
  const map = new EsriMap({
    basemap: await createBasemap(basemapMode),
    ground: createGround(basemapMode),
  });

  const clipExtent = terrainClipExtent(segmentPathWgs84);
  // Local clippingArea cannot grow past the union of layer extents. This
  // empty layer makes the 25 km box real so zoom does not hit a textured wall.
  map.add(
    new GraphicsLayer({
      id: 'local-scene-extent',
      listMode: 'hide',
      fullExtent: clipExtent,
    }),
  );

  const view = new SceneView({
    container,
    map,
    qualityProfile: 'medium',
    // Global globe uses a planet-scale near clip. Local mode is sized for this preserve.
    viewingMode: 'local',
    clippingArea: clipExtent,
    environment: {
      background: { type: 'color', color: [15, 23, 42] },
      starsEnabled: false,
      atmosphereEnabled: true,
    },
    // SceneView constraints in 4.34 have no collision flag.
    // Ground navigationConstraint none keeps the camera free of the terrain.
    constraints: {
      tilt: { max: 179 },
      clipDistance: {
        mode: 'manual',
        near: 1,
        far: 80000,
      },
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

  let elevationSource: ElevationSource = basemapMode === 'arcgis-imagery' ? 'world-elevation' : 'none';
  let groundElevationM: number | null = null;
  const center = pathCenter(segmentPathWgs84);

  if (basemapMode === 'usgs-imagery') {
    const elevationLayer = new Usgs3DepElevationLayer({ fullExtent: clipExtent });
    const origin = new Point({
      longitude: center.lon,
      latitude: center.lat,
      spatialReference: { wkid: 4326 },
    });
    const preflight = await preflightElevationAtPoint(origin, elevationLayer);
    if (preflight) {
      map.ground.layers.add(elevationLayer);
      elevationSource = 'usgs-3dep';
      groundElevationM = preflight.elevationM;
    }
  }

  map.ground.navigationConstraint = { type: 'none' };
  await view.when();

  if (groundElevationM == null && elevationSource === 'world-elevation') {
    groundElevationM = await sampleWorldElevation(map, center);
  }

  await frameSegment(view, segmentPathWgs84, groundElevationM ?? 0);
  return { view, basemapMode, elevationSource };
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
