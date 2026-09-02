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
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol';
import esriConfig from '@arcgis/core/config.js';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import {
  centerlineToPath,
  flattenMeshZ,
  meshToMultiPolygonCoordinates,
} from './geo';
import type { SceneBackend } from './scene-backend';
import type { ReachData } from './types';
import Usgs3DepElevationLayer, {
  preflightElevationAtPoint,
} from './usgs-elevation-layer';

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

function createCreekElevationExtent(
  origin: ReachData['meta']['originWgs84'],
): Extent {
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

const terrainSymbol = new PolygonSymbol3D({
  symbolLayers: [
    {
      type: 'fill',
      material: { color: [107, 91, 74, 0.85] },
    },
  ],
});

function centerlineGraphic(path: number[][]): Graphic {
  return new Graphic({
    geometry: new Polyline({
      paths: [path],
      hasZ: true,
      spatialReference: { wkid: 4326 },
    }),
    symbol: new SimpleLineSymbol({
      color: [251, 191, 36],
      width: 3,
    }),
  });
}

function graphicsFromMesh(
  mesh: ReachData['terrain'],
  origin: ReachData['meta']['originWgs84'],
  symbol: PolygonSymbol3D,
  groundDraped: boolean,
  absoluteElevationOffset = 0,
): Graphic[] {
  const renderMesh = groundDraped ? flattenMeshZ(mesh) : mesh;
  return meshToMultiPolygonCoordinates(renderMesh, origin, groundDraped ? 0 : undefined).map(
    (polygonCoords) => {
      const coordinates = groundDraped
        ? polygonCoords
        : polygonCoords.map((ring) =>
            ring.map(([lon, lat, z]) => [lon, lat, z + absoluteElevationOffset]),
          );
      return new Graphic({
        geometry: new Polygon({
          rings: coordinates,
          hasZ: true,
          spatialReference: { wkid: 4326 },
        }),
        symbol,
      });
    },
  );
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

export class ArcGISCreekScene implements SceneBackend {
  private view: SceneView | null = null;
  private waterStageLayers = new globalThis.Map<string, GraphicsLayer>();
  private activeStageId: string | null = null;
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
    let absoluteElevationOffset = 0;
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
      const preflight = await preflightElevationAtPoint(originPoint, {
        fullExtent: elevationLayer.fullExtent,
      });

      if (preflight) {
        map.ground.layers.add(elevationLayer);
        groundDraped = false;
        this._elevationSource = 'usgs-3dep';
        // Synthetic meshes use a nominal ~42 m baseline. Shift them to the
        // sampled 3DEP height so their absolute elevations remain visible.
        absoluteElevationOffset =
          preflight.elevationM - data.waterStages.baseline.positions[2] + 0.5;
      }
    }

    const baselineMesh = data.waterStages.baseline;
    const centerlineZ =
      baselineMesh.positions.length >= 3
        ? baselineMesh.positions[2] + absoluteElevationOffset - 0.35
        : 42;

    const centerlinePath = centerlineToPath(
      data.centerline,
      groundDraped ? 0 : centerlineZ,
    );

    const centerlineLayer = new GraphicsLayer({
      id: 'centerline-layer',
      elevationInfo: elevationInfoForMode(groundDraped),
    });
    const terrainLayer = new GraphicsLayer({
      id: 'terrain-layer',
      elevationInfo: groundDraped
        ? { mode: 'relative-to-ground', offset: 0.15 }
        : { mode: 'absolute-height' },
    });

    centerlineLayer.add(centerlineGraphic(centerlinePath));
    terrainLayer.addMany(
      graphicsFromMesh(
        data.terrain,
        data.meta.originWgs84,
        terrainSymbol,
        groundDraped,
        absoluteElevationOffset,
      ),
    );

    map.addMany([terrainLayer, centerlineLayer]);

    for (const stage of data.meta.stages) {
      const layer = new GraphicsLayer({
        id: `water-${stage.id}`,
        visible: false,
        elevationInfo: elevationInfoForMode(groundDraped, stage.offsetM),
      });
      layer.addMany(
        graphicsFromMesh(
          data.waterStages[stage.id],
          data.meta.originWgs84,
          waterSymbol,
          groundDraped,
          absoluteElevationOffset,
        ),
      );
      this.waterStageLayers.set(stage.id, layer);
      map.add(layer);
    }

    await this.frameCamera(centerlinePath, !groundDraped);
    this.setStage(data.meta.stages[0].id);
  }

  setStage(stageId: string): void {
    if (this.activeStageId === stageId) return;

    for (const [id, layer] of this.waterStageLayers) {
      layer.visible = id === stageId;
    }
    this.activeStageId = stageId;
  }

  destroy(): void {
    this.view?.destroy();
    this.view = null;
    this.waterStageLayers.clear();
    this.activeStageId = null;
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
