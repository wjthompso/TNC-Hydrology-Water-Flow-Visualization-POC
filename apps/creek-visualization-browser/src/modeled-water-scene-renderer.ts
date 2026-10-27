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
//
// A `bed-parallel-depth` placement (its bucket bounds are water depths) is
// drawn at each ring vertex's bed reference plus the depth there instead.

import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Polygon from '@arcgis/core/geometry/Polygon';
import type SceneView from '@arcgis/core/views/SceneView';
import {
  drainageAreaRatioTransferWaterSymbol,
  polygonForBucket,
  troutConditionWaterSymbol,
  waterSymbol,
  type SegmentPolygonPlacement,
  type WaterGraphicGeometryIdentity,
} from './arcgis-scene-renderer';
import { channelRibbonRingsWgs84 } from './channel-ribbon-surface';
import type { ElevationBucket } from './creek-data-contract';
import { segmentSurfaceGeometry, type CreekSegmentPathRecord } from './modeled-water-data-store';
import {
  bedParallelRingsWgs84,
  slopedRingsWgs84,
  type BedParallelWaterDepth,
  type JunctionWaterSurface,
  type SegmentSurfaceGeometry,
} from './sloped-water-surface';

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
  /**
   * Bucket minimum of the drawn polygon; reported as the segment's identity.
   * For `bed-parallel-depth` water, the anchor water-surface elevation instead,
   * because that method's bucket bounds are depths.
   */
  const writtenElevationM = new Map<string, number>();
  /** `bed-parallel-depth` water only: bucket minimum depth, reported next to the elevation. */
  const writtenBucketMinDepthM = new Map<string, number>();
  /** Bucket minimum plus junction heights, so a slope change within one bucket redraws. */
  const writtenSurfaceKey = new Map<string, string>();
  let pending: readonly SegmentPolygonPlacement[] | null = null;
  let frameHandle: number | null = null;
  let disposed = false;

  /**
   * `bed-parallel-depth` water: rings lifted to their bed reference plus the
   * depth, interpolated between the junction depths. Returns the graphic when
   * it was (re)drawn, or null when the drawn water already matches.
   */
  const applyBedParallelPlacement = (
    placement: SegmentPolygonPlacement,
    bucket: ElevationBucket,
    depth: BedParallelWaterDepth,
    existing: Graphic | undefined,
  ): Graphic | null => {
    const { segmentId, drainageAreaRatioTransfer } = placement;
    const symbol = symbolFor(placement);
    const geometry = segmentSurfaceGeometry(segmentPathsById, segmentId);
    const junctionDepth = depth.junctionDepth;
    // The depths are in the key so a depth change inside one bucket redraws.
    const surfaceKey = [
      'bed-parallel-depth',
      bucket.minWaterSurfaceElevationM,
      depth.anchorDepthM,
      placement.channelRibbonLiftM ?? '',
      junctionDepth?.upstreamM ?? '',
      junctionDepth?.downstreamM ?? '',
      geometry ? 'geometry' : 'no-geometry',
    ].join('|');
    if (
      existing &&
      writtenSurfaceKey.get(segmentId) === surfaceKey &&
      existing.visible &&
      existing.symbol === symbol
    ) {
      return null;
    }
    const graphic = existing ?? new Graphic({ symbol, visible: false });
    graphicsBySegmentId.set(segmentId, graphic);
    if (graphic.symbol !== symbol) graphic.symbol = symbol;
    // `channel-ribbon-depth` water morphs between all the segment's depth rungs at each station's own depth; anything
    // that is not a usable ribbon (or any other method) draws the picked bucket parallel to the bed.
    const ribbonRings = placement.channelRibbonBuckets ? channelRibbonRingsWgs84(placement.channelRibbonBuckets, depth, placement.channelRibbonLiftM ?? 0) : null;
    graphic.geometry = new Polygon({
      hasZ: true,
      rings: ribbonRings ?? bedParallelRingsWgs84(bucket.ringsWgs84, geometry, depth),
      spatialReference: { wkid: 4326 },
    });
    // Bucket bounds are depths for this method, so they are named as depths; the elevation is the anchor WSE.
    graphic.attributes = {
      segmentId,
      waterSurfaceElevationM: depth.waterSurfaceElevationM,
      anchorBedElevationM: depth.anchorBedElevationM,
      anchorDepthM: depth.anchorDepthM,
      bucketMinDepthM: bucket.minWaterSurfaceElevationM,
      bucketMaxDepthM: bucket.maxWaterSurfaceElevationM,
      drainageAreaRatioTransfer: drainageAreaRatioTransfer === true,
      junctionDepthUpstreamM: junctionDepth?.upstreamM ?? null,
      junctionDepthDownstreamM: junctionDepth?.downstreamM ?? null,
    };
    graphic.visible = true;
    writtenElevationM.set(segmentId, depth.waterSurfaceElevationM);
    writtenBucketMinDepthM.set(segmentId, bucket.minWaterSurfaceElevationM);
    writtenSurfaceKey.set(segmentId, surfaceKey);
    return graphic;
  };

  const apply = (placements: readonly SegmentPolygonPlacement[]): void => {
    const seen = new Set<string>();
    const added: Graphic[] = [];
    for (const placement of placements) {
      const { segmentId, bucket, drainageAreaRatioTransfer, junctionWaterSurface, bedParallelWaterDepth } = placement;
      seen.add(segmentId);
      let graphic = graphicsBySegmentId.get(segmentId);
      if (!bucket) {
        if (graphic) {
          graphic.visible = false;
          graphic.attributes = null;
        }
        writtenElevationM.delete(segmentId);
        writtenBucketMinDepthM.delete(segmentId);
        writtenSurfaceKey.delete(segmentId);
        continue;
      }
      if (bedParallelWaterDepth) {
        const redrawn = applyBedParallelPlacement(placement, bucket, bedParallelWaterDepth, graphic);
        if (redrawn && !redrawn.layer) added.push(redrawn);
        continue;
      }
      writtenBucketMinDepthM.delete(segmentId);
      const symbol = symbolFor(placement);
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
      writtenBucketMinDepthM.delete(segmentId);
      writtenSurfaceKey.delete(segmentId);
      if (graphic.layer) removed.push(graphic);
    }
    if (removed.length > 0) layer.removeMany(removed);
    onApplied(readIdentity());
  };

  const readIdentity = (): WaterGraphicGeometryIdentity[] => {
    const identity: WaterGraphicGeometryIdentity[] = [];
    for (const [segmentId, graphic] of graphicsBySegmentId) {
      const bucketMinDepthM = writtenBucketMinDepthM.get(segmentId);
      identity.push({
        segmentId,
        bucketMinElevationM: graphic.visible ? (writtenElevationM.get(segmentId) ?? null) : null,
        // Only `bed-parallel-depth` water adds the field, so other methods' identity stays the same shape.
        ...(bucketMinDepthM !== undefined ? { bucketMinDepthM: graphic.visible ? bucketMinDepthM : null } : {}),
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
      writtenBucketMinDepthM.clear();
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

/** The trout condition color when the placement carries one, else the transfer or regular modeled water look. */
function symbolFor(placement: SegmentPolygonPlacement) {
  return (
    troutConditionWaterSymbol(placement.troutCondition) ??
    (placement.drainageAreaRatioTransfer ? drainageAreaRatioTransferWaterSymbol : waterSymbol)
  );
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
