// Dev tools water click inspector, data side: everything the browser knows about
// one modeled Creek Segment's drawn water at the selected time, gathered into one
// plain object. All heights are meters NAVD88 (North American Vertical Datum of
// 1988) and all depths and widths are meters. The inspector's math and its
// readout rows live in water-click-readout.ts.
//
// Three drawings exist (WSE Polygon Generation Method `browserDrawing`):
// - `channel-ribbon-depth` (flowline-channel-ribbon): a ribbon whose vertices sit at bed profile + depth + lift;
// - `bed-parallel-depth` (height-above-nearest-drainage-fill): ring vertices at bed reference + depth;
// - `sloped-between-junctions` / `flat-at-bucket-minimum` (junction-sloped-terrain-fill): elevation buckets,
//   water drawn at the bucket's elevation with no bed under it.

import type Graphic from '@arcgis/core/Graphic';
import { ribbonDisplayAdjustmentForSlope } from './channel-ribbon-surface';
import type { ElevationBucket, LonLat } from './creek-data-contract';
import { localBedSlope } from './display-depth-floor';
import {
  heldJunctionDepthsAt,
  heldJunctionWaterSurfaceAt,
  heldValueAt,
  type ChannelRibbonSummary,
  type LoadedTimeSeries,
} from './modeled-water-data-store';
import { drawsDepthBuckets, wsePolygonMethodKey, type WsePolygonMethodVersion } from './wse-polygon-generation-methods';

type Rings = number[][][];

/** Where the anchor's longitude and latitude came from. */
export type AnchorPositionSource =
  /** Saved with the ribbon polygon set (`channelRibbon.anchorLonLat`): exact. */
  | 'ribbon-polygon-file'
  /** The midpoint of the segment's chord; m2 puts its anchor section there, but its exact spot is not saved. */
  | 'chord-midpoint-estimate'
  /** The method never saved where its anchor is. */
  | 'not-saved';

/** What the polygon's bottom is for this drawing. */
export type PolygonBottomKind = 'ribbon-bed-profile' | 'bed-reference' | 'bucket-minimum-elevation';

export interface ModeledSegmentInspection {
  segmentId: string;
  selectedTimeUtc: string;
  /** `flowline-channel-ribbon@v1` */
  wsePolygonMethod: string;
  /** `m3-flowline-profile-manning-depth/v1`, or null for hosted data and older manifests. */
  modeledWseVersionPath: string | null;
  browserDrawing: WsePolygonMethodVersion['browserDrawing'];
  /** The Time Series value at the selected time: the number the chart shows. Null when none. */
  timeSeriesWseM: number | null;
  /** Dev tools WSE override in effect for this segment, m; null when none. Replaces the Time Series for drawing. */
  pinnedWseM: number | null;
  anchor: {
    lonLat: LonLat | null;
    positionSource: AnchorPositionSource;
    /** Creek-bed elevation at the anchor. Null for methods that do not save one. */
    bedElevationM: number | null;
  };
  /** Depth above the bed from the Time Series, with no display exaggeration. Null for methods without depths. */
  trueDepth: { anchorM: number; upstreamJunctionM: number | null; downstreamJunctionM: number | null } | null;
  /** Depth the browser draws (after any display floor); null when no water is drawn or the method has no depths. */
  drawnDepth: { anchorM: number; upstreamJunctionM: number | null; downstreamJunctionM: number | null } | null;
  /** Elevation-bucket drawing only: the Time Series' water surface at the segment's two ends. */
  junctionWse: { upstreamM: number; downstreamM: number } | null;
  /** Elevation-bucket drawing only: bucket minimum elevation of the drawn polygon. */
  drawnBucketMinElevationM: number | null;
  /** |upstream bed − downstream bed| ÷ chord length, m/m. Null when either bed or the chord is unknown. */
  bedSlope: number | null;
  junctionBedUpstreamM: number | null;
  junctionBedDownstreamM: number | null;
  /** Ribbon method only. */
  ribbon: {
    /** Display lift added to the ribbon's z at this segment, m (0 for true water). */
    appliedLiftM: number;
    /** The display rule's floor and lift for this segment's bed slope at full ramp-in, m. */
    ruleFloorM: number;
    ruleLiftM: number;
    /** Smoothed lidar flood width at the anchor at the true depth. Null without a ribbon summary (hosted data). */
    trueTopWidthAtAnchorM: number | null;
    /** Width drawn at the anchor at the drawn depth. */
    displayTopWidthAtAnchorM: number | null;
  } | null;
  /** The drawn polygon, z = drawn water surface at each vertex. Null when nothing is drawn. */
  drawnRingsWgs84: Rings | null;
  /** Same shape as the drawn rings; z = polygon bottom. Null when the drawing has no per-vertex bottom. */
  bottomRingsWgs84: Rings | null;
  bottomKind: PolygonBottomKind | null;
  /** Changes whenever the drawn water or any number above changes; lets pollers skip unchanged frames. */
  revisionKey: string;
}

export interface ModeledSegmentInspectionInput {
  segmentId: string;
  timeUtcMs: number;
  holdMs: number;
  method: WsePolygonMethodVersion;
  series: LoadedTimeSeries | null;
  /** The segment's prepared buckets (depth rungs or elevation buckets). */
  buckets: readonly ElevationBucket[] | null;
  ribbonSummary: ChannelRibbonSummary | null;
  /** The segment's drawn water graphic, when it is on the map. */
  graphic: Graphic | null;
  /** First and last flowline vertex of the segment and the chord's length, m; null without a path. */
  chord: { first: LonLat; last: LonLat; lengthM: number } | null;
  pinnedWseM: number | null;
}

export function buildModeledSegmentInspection(input: ModeledSegmentInspectionInput): ModeledSegmentInspection {
  const { segmentId, timeUtcMs, holdMs, method, series, buckets, ribbonSummary, graphic, chord } = input;
  const methodKey = wsePolygonMethodKey(method);
  const isRibbon = method.browserDrawing === 'channel-ribbon-depth';
  const hasDepths = drawsDepthBuckets(method.browserDrawing);

  const timeSeriesWseM = series ? heldValueAt(series, segmentId, timeUtcMs, holdMs) : null;
  const seriesBedM = series?.anchorBedElevationMBySegmentId.get(segmentId) ?? null;
  const anchorBedM = hasDepths ? (seriesBedM ?? ribbonSummary?.anchorBedElevationM ?? null) : null;
  const junctionBedUpstreamM = series?.junctionBedUpstreamMBySegmentId.get(segmentId) ?? null;
  const junctionBedDownstreamM = series?.junctionBedDownstreamMBySegmentId.get(segmentId) ?? null;
  const bedSlope =
    junctionBedUpstreamM !== null && junctionBedDownstreamM !== null && chord && chord.lengthM > 0
      ? localBedSlope(junctionBedUpstreamM, junctionBedDownstreamM, chord.lengthM)
      : null;

  const heldJunctionDepths = series && hasDepths ? heldJunctionDepthsAt(series, segmentId, timeUtcMs, holdMs) : null;
  const trueDepth =
    hasDepths && timeSeriesWseM !== null && anchorBedM !== null
      ? {
          anchorM: Math.max(0, timeSeriesWseM - anchorBedM),
          upstreamJunctionM: heldJunctionDepths?.upstreamM ?? null,
          downstreamJunctionM: heldJunctionDepths?.downstreamM ?? null,
        }
      : null;

  // The drawn numbers come from the attributes the renderer wrote on the water graphic.
  const drawnGraphic = graphic?.visible && graphic.attributes ? graphic : null;
  const attributes = (drawnGraphic?.attributes ?? {}) as Record<string, unknown>;
  const drawnAnchorDepthM = finiteOrNull(attributes.anchorDepthM);
  const drawnDepth =
    hasDepths && drawnAnchorDepthM !== null
      ? {
          anchorM: drawnAnchorDepthM,
          upstreamJunctionM: finiteOrNull(attributes.junctionDepthUpstreamM),
          downstreamJunctionM: finiteOrNull(attributes.junctionDepthDownstreamM),
        }
      : null;
  const appliedLiftM = finiteOrNull(attributes.displayLiftM) ?? 0;
  const drawnBucketMinElevationM = hasDepths ? null : finiteOrNull(attributes.bucketMinElevationM);
  const junctionWse = !hasDepths && series ? heldJunctionWaterSurfaceAt(series, segmentId, timeUtcMs, holdMs) : null;

  const drawnRings = polygonRingsOf(drawnGraphic);
  const { bottomRings, bottomKind } = bottomOf(
    method,
    buckets,
    finiteOrNull(attributes.bucketMinDepthM),
    drawnBucketMinElevationM,
    drawnRings,
  );

  let anchorLonLat: LonLat | null = null;
  let positionSource: AnchorPositionSource = 'not-saved';
  if (isRibbon && ribbonSummary) {
    anchorLonLat = ribbonSummary.anchorLonLat;
    positionSource = 'ribbon-polygon-file';
  } else if (hasDepths && chord) {
    anchorLonLat = [(chord.first[0] + chord.last[0]) / 2, (chord.first[1] + chord.last[1]) / 2];
    positionSource = 'chord-midpoint-estimate';
  }

  const ribbon = isRibbon
    ? (() => {
        const rule = ribbonDisplayAdjustmentForSlope(bedSlope ?? 0);
        const rungDepthsM = (buckets ?? []).map((bucket) => bucket.minWaterSurfaceElevationM);
        return {
          appliedLiftM,
          ruleFloorM: rule.floorM,
          ruleLiftM: rule.liftM,
          trueTopWidthAtAnchorM:
            ribbonSummary && trueDepth
              ? valueAtDepth(rungDepthsM, ribbonSummary.trueTopWidthAtAnchorM, trueDepth.anchorM)
              : null,
          displayTopWidthAtAnchorM:
            ribbonSummary && drawnDepth
              ? valueAtDepth(rungDepthsM, ribbonSummary.displayTopWidthAtAnchorM, drawnDepth.anchorM)
              : null,
        };
      })()
    : null;

  return {
    segmentId,
    selectedTimeUtc: new Date(timeUtcMs).toISOString(),
    wsePolygonMethod: methodKey,
    modeledWseVersionPath: method.builtFromModeledWsePath ?? null,
    browserDrawing: method.browserDrawing,
    timeSeriesWseM,
    pinnedWseM: input.pinnedWseM,
    anchor: { lonLat: anchorLonLat, positionSource, bedElevationM: anchorBedM },
    trueDepth,
    drawnDepth,
    junctionWse,
    drawnBucketMinElevationM,
    bedSlope,
    junctionBedUpstreamM,
    junctionBedDownstreamM,
    ribbon,
    drawnRingsWgs84: drawnRings,
    bottomRingsWgs84: bottomRings,
    bottomKind,
    revisionKey: [
      methodKey,
      segmentId,
      timeUtcMs,
      input.pinnedWseM ?? '',
      geometryRevision(drawnGraphic),
      timeSeriesWseM ?? '',
      series ? 'series' : 'no-series',
      ribbonSummary ? 'ribbon-file' : 'no-ribbon-file',
    ].join('|'),
  };
}

/** The polygon's rings (lon, lat, z), or null when the graphic has none. */
function polygonRingsOf(graphic: Graphic | null): Rings | null {
  const geometry = graphic?.geometry;
  if (!geometry || geometry.type !== 'polygon') return null;
  const rings = (geometry as __esri.Polygon).rings;
  return rings.length > 0 ? rings : null;
}

/**
 * The per-vertex bottom of the drawn polygon, vertex for vertex with the drawn rings:
 * - ribbon: the bed profile, which every depth rung carries as z (the first rung is the bed profile at depth 0.01 m);
 * - bed-parallel: the picked depth bucket's rings, whose z is the bed reference the drawing lifts by the depth;
 * - elevation buckets: no per-vertex bottom; the bucket minimum elevation stands in (`bottomKind` says so).
 * A ring whose vertex count differs from the drawn one cannot be paired, so the bottom is then left out.
 */
function bottomOf(
  method: WsePolygonMethodVersion,
  buckets: readonly ElevationBucket[] | null,
  drawnBucketMinDepthM: number | null,
  drawnBucketMinElevationM: number | null,
  drawnRings: Rings | null,
): { bottomRings: Rings | null; bottomKind: PolygonBottomKind | null } {
  if (!drawnRings) return { bottomRings: null, bottomKind: null };
  if (!drawsDepthBuckets(method.browserDrawing)) {
    return { bottomRings: null, bottomKind: drawnBucketMinElevationM === null ? null : 'bucket-minimum-elevation' };
  }
  const isRibbon = method.browserDrawing === 'channel-ribbon-depth';
  const source = isRibbon
    ? buckets?.[0]
    : buckets?.find((bucket) => bucket.minWaterSurfaceElevationM === drawnBucketMinDepthM);
  const kind: PolygonBottomKind = isRibbon ? 'ribbon-bed-profile' : 'bed-reference';
  if (!source) return { bottomRings: null, bottomKind: kind };
  const bottomRings = source.ringsWgs84 as unknown as Rings;
  // A closed drawn ring repeats its first vertex, so it may be one longer than the rung's ring.
  const pairs = drawnRings.length === bottomRings.length && drawnRings.every((ring, index) => {
    const bottomLength = (bottomRings[index] ?? []).length;
    return ring.length === bottomLength || ring.length === bottomLength + 1;
  });
  return { bottomRings: pairs ? bottomRings : null, bottomKind: kind };
}

/** Linear value between the two depth rungs around a depth; the end rung's value beyond the ladder. Null on a length mismatch. */
function valueAtDepth(rungDepthsM: readonly number[], values: readonly number[], depthM: number): number | null {
  if (rungDepthsM.length === 0 || rungDepthsM.length !== values.length) return null;
  if (depthM <= rungDepthsM[0]) return values[0];
  for (let rung = 0; rung + 1 < rungDepthsM.length; rung += 1) {
    const lower = rungDepthsM[rung];
    const upper = rungDepthsM[rung + 1];
    if (depthM <= upper) {
      const t = upper > lower ? (depthM - lower) / (upper - lower) : 0;
      return values[rung] + t * (values[rung + 1] - values[rung]);
    }
  }
  return values[values.length - 1];
}

const geometryIds = new WeakMap<object, number>();
let nextGeometryId = 1;
/** A stable id per drawn geometry object: the renderer replaces it whenever it redraws the segment. */
function geometryRevision(graphic: Graphic | null): number | string {
  const geometry = graphic?.geometry;
  if (!geometry) return 'none';
  let id = geometryIds.get(geometry);
  if (id === undefined) {
    id = nextGeometryId;
    nextGeometryId += 1;
    geometryIds.set(geometry, id);
  }
  return id;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
