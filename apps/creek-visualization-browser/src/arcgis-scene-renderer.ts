import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Polygon from '@arcgis/core/geometry/Polygon';
import PolygonSymbol3D from '@arcgis/core/symbols/PolygonSymbol3D';
import WaterSymbol3DLayer from '@arcgis/core/symbols/WaterSymbol3DLayer';
import type SceneView from '@arcgis/core/views/SceneView';
import type { ElevationBucket } from './creek-data-contract';

export interface WaterGraphicGeometryIdentity {
  segmentId: string;
  /** Z written on the graphic. Null when that segment is hidden. */
  bucketMinElevationM: number | null;
}

export interface SegmentPolygonPlacement {
  segmentId: string;
  bucket: ElevationBucket | null;
}

export interface ArcGISSceneRenderer {
  schedule(placements: readonly SegmentPolygonPlacement[]): void;
  flush(): Promise<void>;
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

/**
 * One reused graphic per prepared polygon set. Neighbouring segments never
 * receive a graphic. Geometry is replaced, or the graphic is hidden, once per frame.
 */
export function createArcGISSceneRenderer(
  view: SceneView,
  polygonSetSegmentIds: readonly string[],
  onApplied: (identity: readonly WaterGraphicGeometryIdentity[]) => void,
): ArcGISSceneRenderer {
  if (!view.map) throw new Error('SceneView has no map.');

  const layer = new GraphicsLayer({
    id: 'water-surface-elevation-polygons',
    listMode: 'hide',
    elevationInfo: { mode: 'absolute-height' },
  });
  const graphicsBySegmentId = new Map<string, Graphic>();
  const writtenElevationM = new Map<string, number>();
  for (const segmentId of polygonSetSegmentIds) {
    const graphic = new Graphic({
      symbol: waterSymbol,
      visible: false,
    });
    graphicsBySegmentId.set(segmentId, graphic);
  }
  view.map.add(layer);

  let pending: readonly SegmentPolygonPlacement[] | null = null;
  let frameHandle: number | null = null;
  let appliedKey: string | null = null;

  const apply = (placements: readonly SegmentPolygonPlacement[]): void => {
    const bucketBySegmentId = new Map(
      placements.map((placement) => [placement.segmentId, placement.bucket]),
    );
    for (const [segmentId, graphic] of graphicsBySegmentId) {
      const bucket = bucketBySegmentId.get(segmentId) ?? null;
      if (bucket) {
        graphic.geometry = polygonForBucket(bucket);
        graphic.visible = true;
        // Dev HUD and feature-behavior tests read these through view.hitTest.
        graphic.attributes = {
          segmentId,
          bucketMinElevationM: bucket.minWaterSurfaceElevationM,
          bucketMaxElevationM: bucket.maxWaterSurfaceElevationM,
        };
        // A graphic with no geometry logs a SceneView warning, so it joins the layer only once it has a polygon.
        if (!graphic.layer) layer.add(graphic);
        writtenElevationM.set(segmentId, bucket.minWaterSurfaceElevationM);
      } else {
        graphic.visible = false;
        graphic.attributes = null;
        writtenElevationM.delete(segmentId);
      }
    }
    onApplied(readIdentity(graphicsBySegmentId, writtenElevationM));
  };

  return {
    schedule(placements) {
      const key = placementKey(placements);
      if (frameHandle == null && key === appliedKey) return;
      pending = placements;
      if (frameHandle != null) return;
      frameHandle = requestAnimationFrame(() => {
        frameHandle = null;
        const next = pending;
        pending = null;
        if (!next) return;
        const nextKey = placementKey(next);
        if (nextKey === appliedKey) return;
        appliedKey = nextKey;
        apply(next);
      });
    },
    flush() {
      if (frameHandle == null) return Promise.resolve();
      return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    },
  };
}

function placementKey(placements: readonly SegmentPolygonPlacement[]): string {
  return placements
    .map((placement) => {
      const minimum = placement.bucket?.minWaterSurfaceElevationM;
      if (typeof minimum !== 'number') return `${placement.segmentId}:`;
      return `${placement.segmentId}:${minimum}`;
    })
    .join('|');
}

function readIdentity(
  graphicsBySegmentId: ReadonlyMap<string, Graphic>,
  writtenElevationM: ReadonlyMap<string, number>,
): WaterGraphicGeometryIdentity[] {
  const identity: WaterGraphicGeometryIdentity[] = [];
  for (const [segmentId, graphic] of graphicsBySegmentId) {
    identity.push({
      segmentId,
      bucketMinElevationM: graphic.visible ? elevationOnGraphic(graphic, writtenElevationM.get(segmentId)) : null,
    });
  }
  return identity;
}

/** Prefer the z stored on the graphic. Fall back to the z just written if the view has not echoed it yet. */
function elevationOnGraphic(graphic: Graphic, writtenElevationM: number | undefined): number | null {
  const geometry = graphic.geometry;
  if (!geometry || geometry.type !== 'polygon') return null;
  const elevationM = geometry.rings[0]?.[0]?.[2];
  if (typeof elevationM === 'number') return elevationM;
  return writtenElevationM ?? null;
}

/** Rings stay the prepared polygon. Z is the bucket minimum on every vertex. */
function polygonForBucket(bucket: ElevationBucket): Polygon {
  const elevationM = bucket.minWaterSurfaceElevationM;
  return new Polygon({
    hasZ: true,
    rings: bucket.ringsWgs84.map((ring) => ring.map(([lon, lat]) => [lon, lat, elevationM])),
    spatialReference: { wkid: 4326 },
  });
}
