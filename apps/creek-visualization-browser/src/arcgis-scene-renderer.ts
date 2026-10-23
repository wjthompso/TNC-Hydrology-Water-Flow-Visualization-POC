import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Polygon from '@arcgis/core/geometry/Polygon';
import FillSymbol3DLayer from '@arcgis/core/symbols/FillSymbol3DLayer';
import PolygonSymbol3D from '@arcgis/core/symbols/PolygonSymbol3D';
import WaterSymbol3DLayer from '@arcgis/core/symbols/WaterSymbol3DLayer';
import type SceneView from '@arcgis/core/views/SceneView';
import type { ElevationBucket } from './creek-data-contract';
import {
  slopedRingsWgs84,
  type BedParallelWaterDepth,
  type JunctionWaterSurface,
  type SegmentSurfaceGeometry,
} from './sloped-water-surface';

export interface WaterGraphicGeometryIdentity {
  segmentId: string;
  /**
   * Z written on the graphic. Null when that segment is hidden. For a
   * `bed-parallel-depth` method the drawn water follows the bed, so this is the
   * modeled water-surface elevation at the anchor instead, never a depth.
   */
  bucketMinElevationM: number | null;
  /** `bed-parallel-depth` methods only: the drawn bucket's minimum water depth, m. */
  bucketMinDepthM?: number | null;
  /** True when the drawn water is inferred by Creek Segment Observed WSE Propagation, false when observed or modeled. */
  inferred?: boolean;
}

export interface SegmentPolygonPlacement {
  segmentId: string;
  bucket: ElevationBucket | null;
  /**
   * True when the segment's discharge is a Drainage-Area Ratio Transfer from a
   * neighbouring creek's Reach. Modeled water only; the observed renderer ignores it.
   */
  drainageAreaRatioTransfer?: boolean;
  /**
   * Water-surface elevation at the segment's two junctions, when the modeled
   * Time Series carries them. The modeled renderer slopes the polygon between
   * them; null or absent draws it flat at the bucket minimum. The observed
   * renderer ignores it.
   */
  junctionWaterSurface?: JunctionWaterSurface | null;
  /**
   * Modeled water only, for a method drawn `bed-parallel-depth`: the bucket's
   * bounds are water depths, and the modeled renderer lifts each ring vertex to
   * its bed reference plus this depth. The observed renderer ignores it.
   */
  bedParallelWaterDepth?: BedParallelWaterDepth | null;
  /**
   * True for water inferred from the gauge by Creek Segment Observed WSE Propagation. The observed
   * renderer draws it with the inferred shading, sloped between `junctionWaterSurface` when the
   * segment's geometry is known; the modeled renderer ignores it.
   */
  inferred?: boolean;
}

/** Teal for inferred water, clearly apart from observed blue and the lighter blue of Drainage-Area Ratio Transfer water; matches the legend swatch. */
export const INFERRED_WATER_COLOR = '#5eead4';
export const INFERRED_WATER_OUTLINE_COLOR = '#0f766e';

/** Lighter blue for Drainage-Area Ratio Transfer water; matches the legend swatch. */
export const DRAINAGE_AREA_RATIO_TRANSFER_WATER_COLOR = '#7dd3fc';
export const DRAINAGE_AREA_RATIO_TRANSFER_WATER_OUTLINE_COLOR = '#0369a1';

export interface ArcGISSceneRenderer {
  schedule(placements: readonly SegmentPolygonPlacement[]): void;
  flush(): Promise<void>;
  /** The layer holding every water graphic; click hit-testing is limited to it. */
  readonly layer: GraphicsLayer;
  /** The drawn water graphic of one Creek Segment, or null when it has never been drawn. */
  graphicForSegment(segmentId: string): Graphic | null;
  /** Cancels the pending frame and takes the water layer off the map. The view itself stays. */
  dispose(): void;
}

/** Shared by the observed renderer and the modeled renderer so both waters look the same. */
export const waterSymbol = new PolygonSymbol3D({
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
 * Drainage-Area Ratio Transfer water: a clearly lighter blue (sky-300) with a
 * thin outline, so borrowed-discharge segments read apart from modeled water
 * on the creek's own Reach. A transparent fill layer carries the outline, which
 * the water layer cannot draw itself.
 */
export const drainageAreaRatioTransferWaterSymbol = new PolygonSymbol3D({
  symbolLayers: [
    new WaterSymbol3DLayer({
      color: DRAINAGE_AREA_RATIO_TRANSFER_WATER_COLOR,
      waterbodySize: 'small',
      waveStrength: 'slight',
      waveDirection: 260,
    }),
    new FillSymbol3DLayer({
      material: { color: [125, 211, 252, 0] },
      outline: { color: DRAINAGE_AREA_RATIO_TRANSFER_WATER_OUTLINE_COLOR, size: 1 },
    }),
  ],
});

/**
 * Inferred water (Creek Segment Observed WSE Propagation): teal with a thin outline, so a guess
 * made from the gauge never reads as the measured blue. A transparent fill layer carries the
 * outline, which the water layer cannot draw itself.
 */
export const inferredWaterSymbol = new PolygonSymbol3D({
  symbolLayers: [
    new WaterSymbol3DLayer({
      color: INFERRED_WATER_COLOR,
      waterbodySize: 'small',
      waveStrength: 'slight',
      waveDirection: 260,
    }),
    new FillSymbol3DLayer({
      material: { color: [94, 234, 212, 0] },
      outline: { color: INFERRED_WATER_OUTLINE_COLOR, size: 1 },
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
  /** Flowline geometry of the segments that draw inferred water; an inferred segment missing here draws flat. */
  inferredSegmentGeometryById: ReadonlyMap<string, SegmentSurfaceGeometry> = new Map(),
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
  let disposed = false;
  let appliedKey: string | null = null;

  const apply = (placements: readonly SegmentPolygonPlacement[]): void => {
    const placementBySegmentId = new Map(
      placements.map((placement) => [placement.segmentId, placement]),
    );
    for (const [segmentId, graphic] of graphicsBySegmentId) {
      const placement = placementBySegmentId.get(segmentId);
      const bucket = placement?.bucket ?? null;
      if (placement && bucket) {
        const inferred = placement.inferred === true;
        const geometry = inferredSegmentGeometryById.get(segmentId);
        const surface = inferred && geometry ? placement.junctionWaterSurface ?? null : null;
        graphic.symbol = inferred ? inferredWaterSymbol : waterSymbol;
        graphic.geometry =
          surface && geometry
            ? new Polygon({
                hasZ: true,
                rings: slopedRingsWgs84(bucket.ringsWgs84, geometry, surface),
                spatialReference: { wkid: 4326 },
              })
            : polygonForBucket(bucket);
        graphic.visible = true;
        // Dev HUD and feature-behavior tests read these through view.hitTest.
        graphic.attributes = {
          segmentId,
          bucketMinElevationM: bucket.minWaterSurfaceElevationM,
          bucketMaxElevationM: bucket.maxWaterSurfaceElevationM,
          inferred,
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
      if (disposed) return;
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

function placementKey(placements: readonly SegmentPolygonPlacement[]): string {
  return placements
    .map((placement) => {
      const minimum = placement.bucket?.minWaterSurfaceElevationM;
      if (typeof minimum !== 'number') return `${placement.segmentId}:`;
      const surface = placement.junctionWaterSurface;
      const inferredKey = placement.inferred ? `|i${surface?.upstreamM ?? ''}/${surface?.downstreamM ?? ''}` : '';
      return `${placement.segmentId}:${minimum}${inferredKey}`;
    })
    .join('|');
}

function readIdentity(
  graphicsBySegmentId: ReadonlyMap<string, Graphic>,
  writtenElevationM: ReadonlyMap<string, number>,
): WaterGraphicGeometryIdentity[] {
  const identity: WaterGraphicGeometryIdentity[] = [];
  for (const [segmentId, graphic] of graphicsBySegmentId) {
    const inferred = graphic.visible && graphic.attributes?.inferred === true;
    identity.push({
      segmentId,
      // Inferred water slopes, so its first vertex is not at the bucket minimum; report the bucket minimum.
      bucketMinElevationM: !graphic.visible
        ? null
        : inferred
          ? (writtenElevationM.get(segmentId) ?? null)
          : elevationOnGraphic(graphic, writtenElevationM.get(segmentId)),
      inferred,
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
export function polygonForBucket(bucket: ElevationBucket): Polygon {
  const elevationM = bucket.minWaterSurfaceElevationM;
  return new Polygon({
    hasZ: true,
    rings: bucket.ringsWgs84.map((ring) => ring.map(([lon, lat]) => [lon, lat, elevationM])),
    spatialReference: { wkid: 4326 },
  });
}
