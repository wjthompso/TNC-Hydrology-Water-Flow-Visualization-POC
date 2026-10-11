import EsriMap from '@arcgis/core/Map';
import Basemap from '@arcgis/core/Basemap';
import SceneView from '@arcgis/core/views/SceneView';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import TileLayer from '@arcgis/core/layers/TileLayer';
import Graphic from '@arcgis/core/Graphic';
import Extent from '@arcgis/core/geometry/Extent';
import Point from '@arcgis/core/geometry/Point';
import Polygon from '@arcgis/core/geometry/Polygon';
import PolygonSymbol3D from '@arcgis/core/symbols/PolygonSymbol3D';
import WaterSymbol3DLayer from '@arcgis/core/symbols/WaterSymbol3DLayer';
import esriConfig from '@arcgis/core/config.js';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import { buildWaterRibbonOutlineRing } from './water-stage';
import { extentFromReaches } from './geo';
import type { SceneBackend } from './scene-backend';
import type { NetworkData, NetworkReach } from './types';
import Usgs3DepElevationLayer, { preflightElevationAtPoint } from './usgs-elevation-layer';

export type BasemapMode = 'usgs-imagery' | 'arcgis-imagery';
export type ElevationSource = 'usgs-3dep' | 'world-elevation' | 'none';

const USGS_IMAGERY_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer';
/** Keep the local clip wall far from the creeks so zoom-in does not hit a skirt. */
const TERRAIN_BUFFER_M = 25000;
/** USGS Imagery Only actually caches through WM LOD 16 (~2.4 m/px). */
const USGS_IMAGERY_MAX_LOD = 16;

function configureApiKey(): BasemapMode {
  const apiKey = import.meta.env.VITE_ARCGIS_API_KEY?.trim();
  if (apiKey) {
    esriConfig.apiKey = apiKey;
    return 'arcgis-imagery';
  }
  return 'usgs-imagery';
}

async function createBasemap(mode: BasemapMode): Promise<Basemap | string> {
  if (mode === 'arcgis-imagery') {
    return 'arcgis/imagery';
  }
  const imagery = new TileLayer({
    url: USGS_IMAGERY_URL,
    title: 'USGS Imagery',
  });
  await imagery.load();
  // Cap lods instead of maxScale: maxScale hides the layer when zoomed in
  // past LOD 16, which leaves the slate ground (that weird blue). Reusing
  // LOD 16 tiles keeps satellite draped on the creek corridor.
  imagery.tileInfo.lods = imagery.tileInfo.lods.filter(
    (lod) => lod.level <= USGS_IMAGERY_MAX_LOD,
  );
  return new Basemap({
    baseLayers: [imagery],
    title: 'USGS Imagery',
  });
}

function createGround(basemapMode: BasemapMode): __esri.GroundProperties | 'world-elevation' {
  if (basemapMode === 'arcgis-imagery') {
    return 'world-elevation';
  }
  return createFlatGround();
}

function createFlatGround(): __esri.GroundProperties {
  return {
    navigationConstraint: { type: 'none' },
    surfaceColor: [15, 23, 42],
  };
}

function inlandFocusPoint(data: NetworkData): { lon: number; lat: number } {
  const escondido = data.reaches.find((reach) => /escondido/i.test(reach.name));
  if (escondido && escondido.centerline.length > 0) {
    const mid = escondido.centerline[Math.floor(escondido.centerline.length / 2)];
    return { lon: mid.lon, lat: mid.lat };
  }
  return data.meta.originWgs84;
}

function createNetworkElevationExtent(reaches: NetworkReach[]): Extent {
  const geo = extentFromReaches(reaches);
  const sw = webMercatorUtils.geographicToWebMercator(
    new Point({
      longitude: geo.xmin,
      latitude: geo.ymin,
      spatialReference: { wkid: 4326 },
    }),
  ) as Point;
  const ne = webMercatorUtils.geographicToWebMercator(
    new Point({
      longitude: geo.xmax,
      latitude: geo.ymax,
      spatialReference: { wkid: 4326 },
    }),
  ) as Point;
  return new Extent({
    xmin: sw.x - TERRAIN_BUFFER_M,
    ymin: sw.y - TERRAIN_BUFFER_M,
    xmax: ne.x + TERRAIN_BUFFER_M,
    ymax: ne.y + TERRAIN_BUFFER_M,
    spatialReference: { wkid: 3857 },
  });
}

const waterSymbol = new PolygonSymbol3D({
  symbolLayers: [
    new WaterSymbol3DLayer({
      color: '#1d9bf0',
      waterbodySize: 'medium',
      waveStrength: 'moderate',
      waveDirection: 260,
    }),
  ],
});

export interface ArcGISTestReferences {
  readonly view: SceneView;
  readonly waterLayer: GraphicsLayer;
  readonly waterGraphics: readonly Graphic[];
}

const testReferences = new WeakMap<ArcGISCreekScene, ArcGISTestReferences>();
const testMode = import.meta.env.VITE_TEST_MODE === 'true';

/** Read-only test-mode seam; production code does not publish these references globally. */
export function readArcGISTestReferences(
  scene: ArcGISCreekScene,
): ArcGISTestReferences {
  const references = testReferences.get(scene);
  if (!references) throw new Error('ArcGIS scene test references are not ready.');
  return references;
}

function elevationInfoForMode(
  groundDraped: boolean,
  offsetM = 0,
): __esri.ElevationInfoProperties {
  if (groundDraped) {
    return { mode: 'relative-to-ground', offset: 0.5 + offsetM };
  }
  return { mode: 'absolute-height' };
}

function waterPolygonForReach(
  reach: NetworkReach,
  offsetM: number,
  groundDraped: boolean,
): Polygon | null {
  const ring = buildWaterRibbonOutlineRing(reach.centerline, offsetM, groundDraped);
  if (!ring) return null;
  return new Polygon({
    rings: [ring],
    hasZ: true,
    spatialReference: { wkid: 4326 },
  });
}

export class ArcGISCreekScene implements SceneBackend {
  private view: SceneView | null = null;
  private waterLayer: GraphicsLayer | null = null;
  private waterGraphics: Graphic[] = [];
  private networkData: NetworkData | null = null;
  private groundDraped = false;
  readonly basemapMode: BasemapMode;
  private _elevationSource: ElevationSource = 'none';

  get elevationSource(): ElevationSource {
    return this._elevationSource;
  }

  constructor(
    private container: HTMLDivElement,
    basemapMode?: BasemapMode,
  ) {
    this.basemapMode = basemapMode ?? configureApiKey();
  }

  async load(data: NetworkData): Promise<void> {
    const map = new EsriMap({
      basemap: await createBasemap(this.basemapMode),
      ground: createGround(this.basemapMode),
    });

    const terrainExtent = createNetworkElevationExtent(data.reaches);
    // Local clippingArea cannot grow past the union of layer extents. This
    // empty layer makes the 25 km box real so zoom does not hit a textured wall.
    map.add(
      new GraphicsLayer({
        id: 'local-scene-extent',
        listMode: 'hide',
        fullExtent: terrainExtent,
      }),
    );

    this.view = new SceneView({
      container: this.container,
      map,
      qualityProfile: 'medium',
      // Global globe uses a planet-scale near clip — creek zoom slices the
      // valley into that white slab. Local mode is sized for this preserve.
      viewingMode: 'local',
      clippingArea: terrainExtent,
      environment: {
        background: { type: 'color', color: [15, 23, 42] },
        starsEnabled: false,
        atmosphereEnabled: true,
      },
      constraints: {
        tilt: { max: 179 },
        collision: { enabled: false },
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

    await this.view.when();

    let groundDraped = this.basemapMode === 'usgs-imagery';
    this._elevationSource = groundDraped ? 'none' : 'world-elevation';

    if (groundDraped) {
      const originPoint = new Point({
        longitude: data.meta.originWgs84.lon,
        latitude: data.meta.originWgs84.lat,
        spatialReference: { wkid: 4326 },
      });
      const elevationLayer = new Usgs3DepElevationLayer({
        fullExtent: terrainExtent,
      });
      const preflight = await preflightElevationAtPoint(originPoint, elevationLayer);

      if (preflight) {
        map.ground.layers.add(elevationLayer);
        groundDraped = false;
        this._elevationSource = 'usgs-3dep';
      }
    }

    map.ground.navigationConstraint = { type: 'none' };

    this.networkData = data;
    this.groundDraped = groundDraped;
    this.waterLayer = new GraphicsLayer({
      id: 'water-dynamic',
      elevationInfo: elevationInfoForMode(groundDraped, 0),
    });
    map.add(this.waterLayer);
    if (testMode) {
      testReferences.set(this, {
        view: this.view,
        waterLayer: this.waterLayer,
        waterGraphics: this.waterGraphics,
      });
    }

    await this.frameCamera(data, !groundDraped);
    this.setStageOffsetM(0);
  }

  setStage(stageId: string): void {
    const stage = this.networkData?.meta.stages.find((item) => item.id === stageId);
    if (stage) this.setStageOffsetM(stage.offsetM);
  }

  setStageOffsetM(offsetM: number): void {
    if (!this.networkData || !this.waterLayer || !this.view) return;

    const polygons = this.networkData.reaches
      .map((reach) => waterPolygonForReach(reach, offsetM, this.groundDraped))
      .filter((polygon): polygon is Polygon => polygon !== null);

    if (this.waterGraphics.length !== polygons.length) {
      this.waterLayer.removeAll();
      this.waterGraphics = polygons.map((geometry) => {
        const graphic = new Graphic({
          geometry,
          symbol: waterSymbol,
        });
        this.waterLayer!.add(graphic);
        return graphic;
      });
    } else {
      for (let i = 0; i < polygons.length; i++) {
        this.waterGraphics[i].geometry = polygons[i];
      }
    }
    if (testMode) {
      testReferences.set(this, {
        view: this.view,
        waterLayer: this.waterLayer,
        waterGraphics: this.waterGraphics,
      });
    }

    if (this.groundDraped) {
      this.waterLayer.elevationInfo = elevationInfoForMode(true, offsetM);
    }
  }

  destroy(): void {
    testReferences.delete(this);
    this.view?.destroy();
    this.view = null;
    this.waterLayer = null;
    this.waterGraphics = [];
    this.networkData = null;
  }

  private async frameCamera(data: NetworkData, has3DTerrain: boolean): Promise<void> {
    if (!this.view) return;

    const { lon, lat } = inlandFocusPoint(data);
    const latPad = 0.012;
    const lonPad = latPad / Math.cos((lat * Math.PI) / 180);

    const extent = new Extent({
      xmin: lon - lonPad,
      ymin: lat - latPad,
      xmax: lon + lonPad,
      ymax: lat + latPad,
      spatialReference: { wkid: 4326 },
    });

    await this.view.goTo(
      {
        target: extent,
        tilt: has3DTerrain ? 66 : 62,
        heading: 48,
      },
      { duration: 0 },
    );
  }
}
