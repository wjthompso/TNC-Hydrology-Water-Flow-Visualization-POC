import EsriMap from '@arcgis/core/Map';
import Basemap from '@arcgis/core/Basemap';
import SceneView from '@arcgis/core/views/SceneView';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import TileLayer from '@arcgis/core/layers/TileLayer';
import Graphic from '@arcgis/core/Graphic';
import Extent from '@arcgis/core/geometry/Extent';
import Point from '@arcgis/core/geometry/Point';
import Polygon from '@arcgis/core/geometry/Polygon';
import Polyline from '@arcgis/core/geometry/Polyline';
import PolygonSymbol3D from '@arcgis/core/symbols/PolygonSymbol3D';
import WaterSymbol3DLayer from '@arcgis/core/symbols/WaterSymbol3DLayer';
import esriConfig from '@arcgis/core/config.js';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import { buildWaterRibbonSegmentRings } from './water-stage';
import type { SceneBackend } from './scene-backend';
import type { ReachData } from './types';
import Usgs3DepElevationLayer, { preflightElevationAtPoint } from './usgs-elevation-layer';

export type BasemapMode = 'usgs-imagery' | 'arcgis-imagery';
export type ElevationSource = 'usgs-3dep' | 'world-elevation' | 'none';

const USGS_IMAGERY_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer';

function configureApiKey(): BasemapMode {
  const apiKey = import.meta.env.VITE_ARCGIS_API_KEY?.trim();
  if (apiKey) {
    esriConfig.apiKey = apiKey;
    return 'arcgis-imagery';
  }
  return 'usgs-imagery';
}

function createBasemap(mode: BasemapMode): Basemap | string {
  if (mode === 'arcgis-imagery') {
    return 'arcgis/imagery';
  }
  return new Basemap({
    baseLayers: [
      new TileLayer({
        url: USGS_IMAGERY_URL,
        title: 'USGS Imagery',
      }),
    ],
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
  return { navigationConstraint: { type: 'none' } };
}

function createCreekElevationExtent(origin: ReachData['meta']['originWgs84']): Extent {
  const point = webMercatorUtils.geographicToWebMercator(
    new Point({ longitude: origin.lon, latitude: origin.lat, spatialReference: { wkid: 4326 } }),
  ) as Point;
  const paddingM = 2_000;
  return new Extent({
    xmin: point.x - paddingM,
    ymin: point.y - paddingM,
    xmax: point.x + paddingM,
    ymax: point.y + paddingM,
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


function elevationInfoForMode(
  groundDraped: boolean,
  offsetM = 0,
): __esri.ElevationInfoProperties {
  if (groundDraped) {
    return { mode: 'relative-to-ground', offset: 0.5 + offsetM };
  }
  return { mode: 'absolute-height' };
}

export class ArcGISCreekScene implements SceneBackend {
  private view: SceneView | null = null;
  private waterLayer: GraphicsLayer | null = null;
  private waterGraphics: Graphic[] = [];
  private reachData: ReachData | null = null;
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

  async load(data: ReachData): Promise<void> {
    const map = new EsriMap({
      basemap: createBasemap(this.basemapMode),
      ground: createGround(this.basemapMode),
    });

    this.view = new SceneView({
      container: this.container,
      map,
      qualityProfile: 'medium',
      viewingMode: 'global',
      environment: {
        background: { type: 'color', color: [15, 23, 42] },
        starsEnabled: false,
        atmosphereEnabled: true,
      },
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
        fullExtent: createCreekElevationExtent(data.meta.originWgs84),
      });
      const preflight = await preflightElevationAtPoint(originPoint, elevationLayer);

      if (preflight) {
        map.ground.layers.add(elevationLayer);
        groundDraped = false;
        this._elevationSource = 'usgs-3dep';
      }
    }

    const centerlinePath = data.centerline.map((pt) => [
      pt.lon,
      pt.lat,
      pt.valleyMinElevationM,
    ]);

    this.reachData = data;
    this.groundDraped = groundDraped;
    this.waterLayer = new GraphicsLayer({
      id: 'water-dynamic',
      elevationInfo: elevationInfoForMode(groundDraped, 0),
    });
    map.add(this.waterLayer);

    await this.frameCamera(centerlinePath, !groundDraped);
    this.setStageOffsetM(0);
  }

  setStage(stageId: string): void {
    const stage = this.reachData?.meta.stages.find((item) => item.id === stageId);
    if (stage) this.setStageOffsetM(stage.offsetM);
  }

  setStageOffsetM(offsetM: number): void {
    if (!this.reachData || !this.waterLayer) return;

    const segmentRings = buildWaterRibbonSegmentRings(
      this.reachData.centerline,
      offsetM,
      this.groundDraped,
    );

    if (this.waterGraphics.length !== segmentRings.length) {
      this.waterLayer.removeAll();
      this.waterGraphics = segmentRings.map((ring) => {
        const graphic = new Graphic({
          geometry: new Polygon({
            rings: [ring],
            hasZ: true,
            spatialReference: { wkid: 4326 },
          }),
          symbol: waterSymbol,
        });
        this.waterLayer!.add(graphic);
        return graphic;
      });
    } else {
      for (let i = 0; i < segmentRings.length; i++) {
        this.waterGraphics[i].geometry = new Polygon({
          rings: [segmentRings[i]],
          hasZ: true,
          spatialReference: { wkid: 4326 },
        });
      }
    }

    if (this.groundDraped) {
      this.waterLayer.elevationInfo = elevationInfoForMode(true, offsetM);
    }
  }

  destroy(): void {
    this.view?.destroy();
    this.view = null;
    this.waterLayer = null;
    this.waterGraphics = [];
    this.reachData = null;
  }

  private async frameCamera(
    centerlinePath: number[][],
    has3DTerrain: boolean,
  ): Promise<void> {
    if (!this.view) return;

    const centerlinePolyline = new Polyline({
      paths: [centerlinePath],
      hasZ: true,
      spatialReference: { wkid: 4326 },
    });

    await this.view.goTo(
      {
        target: centerlinePolyline,
        tilt: has3DTerrain ? 78 : 72,
        heading: 25,
      },
      { duration: 0 },
    );
  }
}
