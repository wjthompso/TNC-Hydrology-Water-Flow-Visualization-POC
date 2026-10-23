// Scene renderer for modeled water. Unlike the observed renderer, the segment
// set changes as flowlines load and unload, so graphics are created on demand
// and dropped when their segment leaves the placement list. One layer with the
// same id as the observed layer keeps the dev HUD hit-test path working.
// Drainage-Area Ratio Transfer segments get the lighter outlined water symbol.
//
// Each polygon is drawn sloped between the segment's upstream and downstream
// junction water-surface elevations when the placement carries them and the
// segment's flowline path is known; otherwise flat at the bucket minimum. The
// slope runs between the segment's two junction boundaries, the lines Stage 4
// cut the polygons at, so neighbours meet along the whole boundary.

import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Polygon from '@arcgis/core/geometry/Polygon';
import type SceneView from '@arcgis/core/views/SceneView';
import {
  drainageAreaRatioTransferWaterSymbol,
  polygonForBucket,
  waterSymbol,
  type SegmentPolygonPlacement,
  type WaterGraphicGeometryIdentity,
} from './arcgis-scene-renderer';
import type { ElevationBucket } from './creek-data-contract';
import { segmentSurfaceGeometry, type CreekSegmentPathRecord } from './modeled-water-data-store';
import { slopedRingsWgs84, type JunctionWaterSurface, type SegmentSurfaceGeometry } from './sloped-water-surface';

export interface ModeledWaterSceneRenderer {
  schedule(placements: readonly SegmentPolygonPlacement[]): void;
  flush(): Promise<void>;
  /**
   * Removes every drawn polygon, so the next placements redraw from scratch.
   * Used when the WSE Polygon Generation Method changes: the new method's
   * rings can differ even where the bucket and junction heights match.
   */
  clear(): void;
  /** The layer holding every water graphic; click hit-testing is limited to it. */
  readonly layer: GraphicsLayer;
  /** The drawn water graphic of one Creek Segment, or null when it is not drawn. */
  graphicForSegment(segmentId: string): Graphic | null;
  /** Cancels the pending frame and takes the water layer off the map. The view itself stays. */
  dispose(): void;
}

export function createModeledWaterSceneRenderer(
  view: SceneView,
  /** Flowline path and neighbour ids per Creek Segment; segments missing here draw flat. */
  segmentPathsById: ReadonlyMap<string, CreekSegmentPathRecord>,
  onApplied: (identity: readonly WaterGraphicGeometryIdentity[]) => void,
): ModeledWaterSceneRenderer {
  if (!view.map) throw new Error('SceneView has no map.');
  const layer = new GraphicsLayer({
    id: 'water-surface-elevation-polygons',
    listMode: 'hide',
    elevationInfo: { mode: 'absolute-height' },
  });
  view.map.add(layer);

  const graphicsBySegmentId = new Map<string, Graphic>();
  /** Bucket minimum of the drawn polygon; reported as the segment's identity. */
  const writtenElevationM = new Map<string, number>();
  /** Bucket minimum plus junction heights, so a slope change within one bucket redraws. */
  const writtenSurfaceKey = new Map<string, string>();
  let pending: readonly SegmentPolygonPlacement[] | null = null;
  let frameHandle: number | null = null;
  let disposed = false;

  const apply = (placements: readonly SegmentPolygonPlacement[]): void => {
    const seen = new Set<string>();
    const added: Graphic[] = [];
    for (const { segmentId, bucket, drainageAreaRatioTransfer, junctionWaterSurface } of placements) {
      seen.add(segmentId);
      let graphic = graphicsBySegmentId.get(segmentId);
      if (!bucket) {
        if (graphic) {
          graphic.visible = false;
          graphic.attributes = null;
        }
        writtenElevationM.delete(segmentId);
        writtenSurfaceKey.delete(segmentId);
        continue;
      }
      const symbol = drainageAreaRatioTransfer ? drainageAreaRatioTransferWaterSymbol : waterSymbol;
      const elevationM = bucket.minWaterSurfaceElevationM;
      const geometry = segmentSurfaceGeometry(segmentPathsById, segmentId);
      const surface = geometry && junctionWaterSurface ? junctionWaterSurface : null;
      const surfaceKey = `${elevationM}|${surface?.upstreamM ?? ''}|${surface?.downstreamM ?? ''}`;
      if (
        graphic &&
        writtenSurfaceKey.get(segmentId) === surfaceKey &&
        graphic.visible &&
        graphic.symbol === symbol
      ) {
        continue;
      }
      if (!graphic) {
        graphic = new Graphic({ symbol, visible: false });
        graphicsBySegmentId.set(segmentId, graphic);
      }
      if (graphic.symbol !== symbol) graphic.symbol = symbol;
      graphic.geometry = surface && geometry ? slopedPolygonForBucket(bucket, geometry, surface) : polygonForBucket(bucket);
      graphic.attributes = {
        segmentId,
        bucketMinElevationM: elevationM,
        bucketMaxElevationM: bucket.maxWaterSurfaceElevationM,
        drainageAreaRatioTransfer: drainageAreaRatioTransfer === true,
        junctionWseUpstreamM: surface?.upstreamM ?? null,
        junctionWseDownstreamM: surface?.downstreamM ?? null,
      };
      graphic.visible = true;
      if (!graphic.layer) added.push(graphic);
      writtenElevationM.set(segmentId, elevationM);
      writtenSurfaceKey.set(segmentId, surfaceKey);
    }
    if (added.length > 0) layer.addMany(added);
    const removed: Graphic[] = [];
    for (const [segmentId, graphic] of graphicsBySegmentId) {
      if (seen.has(segmentId)) continue;
      graphicsBySegmentId.delete(segmentId);
      writtenElevationM.delete(segmentId);
      writtenSurfaceKey.delete(segmentId);
      if (graphic.layer) removed.push(graphic);
    }
    if (removed.length > 0) layer.removeMany(removed);
    onApplied(readIdentity());
  };

  const readIdentity = (): WaterGraphicGeometryIdentity[] => {
    const identity: WaterGraphicGeometryIdentity[] = [];
    for (const [segmentId, graphic] of graphicsBySegmentId) {
      identity.push({
        segmentId,
        bucketMinElevationM: graphic.visible ? (writtenElevationM.get(segmentId) ?? null) : null,
      });
    }
    return identity;
  };

  return {
    schedule(placements) {
      if (disposed) return;
      pending = placements;
      if (frameHandle != null) return;
      frameHandle = requestAnimationFrame(() => {
        frameHandle = null;
        const next = pending;
        pending = null;
        if (next) apply(next);
      });
    },
    flush() {
      if (frameHandle == null) return Promise.resolve();
      return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    },
    clear() {
      layer.removeAll();
      graphicsBySegmentId.clear();
      writtenElevationM.clear();
      writtenSurfaceKey.clear();
      onApplied([]);
    },
    layer,
    graphicForSegment(segmentId) {
      const graphic = graphicsBySegmentId.get(segmentId);
      return graphic?.layer ? graphic : null;
    },
    dispose() {
      disposed = true;
      if (frameHandle != null) cancelAnimationFrame(frameHandle);
      frameHandle = null;
      pending = null;
      view.map?.remove(layer);
      layer.destroy();
    },
  };
}

/** The bucket's rings lifted to a surface sloping from the upstream to the downstream junction height. */
function slopedPolygonForBucket(
  bucket: ElevationBucket,
  geometry: SegmentSurfaceGeometry,
  surface: JunctionWaterSurface,
): Polygon {
  return new Polygon({
    hasZ: true,
    rings: slopedRingsWgs84(bucket.ringsWgs84, geometry, surface),
    spatialReference: { wkid: 4326 },
  });
}
