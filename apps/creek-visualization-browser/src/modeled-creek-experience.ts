// Modeled water experience (UCS-271, minimal). Loads the pipeline catalog for
// one extent, frames the Jalama gauge Creek Segment, and shows the selected
// modeled Dataset's water on the Creek Segments near the camera. Per-flowline
// polygon and Time Series files load lazily through the data store.
//
// Drainage-Area Ratio Transfer segments come from two sources, either of which
// may be absent: the `drainageAreaRatioTransfer` flag on Time Series segments,
// and the extent's reviewed reach crosswalk (dev server only), which also
// carries each segment's drainage-area ratio for the dev tools.

import { watch } from '@arcgis/core/core/reactiveUtils';
import type SceneView from '@arcgis/core/views/SceneView';
import { createAnchorGroundCache } from './anchor-ground-cache';
import type { SegmentPolygonPlacement, WaterGraphicGeometryIdentity } from './arcgis-scene-renderer';
import {
  anchorClearanceMarginM,
  anchorClearanceStationLiftsBySegmentId,
  channelRibbonStationBedsM,
  channelRibbonStationMidpointsLonLat,
  poolFilledStationSurfacesBySegmentId,
  ribbonDisplayAdjustmentForSlope,
  ribbonDrawnByStationInterval,
  stationDrapeSettings,
  type PoolFillRibbonSegment,
  type StationDrape,
} from './channel-ribbon-surface';
import { localBedSlope, withDisplayDepthFloor } from './display-depth-floor';
import type { ElevationBucket, LonLat, ObservationClock } from './creek-data-contract';
import type { CreekVisualizationAttachment } from './creek-visualization-library-interface';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';
import {
  bindObservationTimelineControls,
  type PlaybackSpeedControl,
  type TimeRangeControls,
} from './observation-timeline-controls';
import {
  DRAINAGE_AREA_RATIO_TRANSFER_LEGEND_LABEL,
  DRAINAGE_AREA_RATIO_TRANSFER_TOGGLE_LABEL,
} from './drainage-area-ratio-transfer-labels';
import { CREEK_CENTERLINE_TOGGLE_LABEL, createCreekCenterlineOverlay } from './creek-centerline-overlay';
import { renderModeledDatasetAbout } from './modeled-dataset-info-panel';
import { bindDatasetAboutDialog } from './dataset-about-dialog';
import {
  DATASET_PICKER_OPTIONS,
  datasetHoldMs,
  readModeledCatalog,
  selectModeledDataset,
  timelineGridStepMs,
  waterYearOf,
  type DatasetSelection,
} from './modeled-water-catalog';
import {
  createModeledWaterDataStore,
  heldJunctionDepthsAt,
  heldJunctionWaterSurfaceAt,
  heldValueAt,
  heldWaterDepthAt,
  readCreekSegmentPaths,
  readFlowlineIndex,
  type CreekSegmentPathRecord,
  type FlowlineIndex,
  type LoadedFlowline,
  type LoadedTimeSeries,
} from './modeled-water-data-store';
import { createModeledWaterSceneRenderer } from './modeled-water-scene-renderer';
import { buildModeledSegmentInspection, type ModeledSegmentInspection } from './modeled-segment-inspection';
import { modeledDataSource } from './modeled-data-source';
import { loadReachCrosswalk } from './reach-crosswalk';
import {
  bindSelectedCreekSegmentChart,
  readWaterSurfaceElevationChartElements,
  type SegmentChartContent,
  type SelectedCreekSegmentChart,
} from './selected-creek-segment-chart';
import { bucketForWaterSurfaceElevation } from './selected-time-creek-state-resolver';
import type { BedParallelWaterDepth, JunctionWaterSurface } from './sloped-water-surface';
import { showLoadingMessage } from './loading-spinner';
import { createStandaloneExperienceShell } from './standalone-experience-shell';
import {
  MAX_FLOWLINES_IN_VIEW,
  selectVisibleFlowlines,
  type VisibleFlowlineSelection,
} from './visible-flowlines';
import {
  MODELED_WSE_QUERY_PARAM,
  WSE_POLYGON_METHOD_QUERY_PARAM,
  derivedDataSelectionKey,
  drawnModeledWsePathOf,
  drawsDepthBuckets,
  groupDerivedData,
  modeledWseKeyOfPath,
  readWsePolygonMethodList,
  resolveWsePolygonMethod,
  wsePolygonMethodKey,
  type DerivedDataGroup,
  type NotGeneratedDerivedData,
  type WsePolygonMethodList,
  type WsePolygonMethodVersion,
} from './wse-polygon-generation-methods';

/** Jalama Near Lompoc gauge Creek Segment; both extents include its flowline. */
const OPENING_SEGMENT_ID = '27714637-026';
/**
 * The selected WSE Polygon Generation Method's `browserDrawing` decides the
 * drawing: `sloped-between-junctions` slopes water between the pipeline's
 * junction water-surface elevations, which is the UCS-271 fix for the
 * stair-stepping and seam Bug Checks (FBT-011, FBT-012).
 * `flat-at-bucket-minimum` draws every Creek Segment's water as a flat terrace
 * at its bucket minimum, which reproduces those bugs for the default method.
 */
function drawsSlopedWaterSurfaces(method: WsePolygonMethodVersion): boolean {
  return method.browserDrawing === 'sloped-between-junctions';
}

/**
 * `bed-parallel-depth`: the method's buckets are water depths, picked by the
 * held value minus the segment's anchor bed elevation, and each ring vertex is
 * lifted to its own bed reference plus the depth there.
 */
function drawsBedParallelDepth(method: WsePolygonMethodVersion): boolean {
  return drawsDepthBuckets(method.browserDrawing);
}

/**
 * `channel-ribbon-depth` is `bed-parallel-depth` whose buckets are morph targets: the renderer also gets every
 * rung of the segment and draws the ribbon at each station's own depth (channel-ribbon-surface.ts).
 */
function drawsChannelRibbon(method: WsePolygonMethodVersion): boolean {
  return method.browserDrawing === 'channel-ribbon-depth';
}

/**
 * `channel-ribbon-pool-filled` (ribbon v2): the same rungs drawn on the water surface pool-filled along each run, the rule
 * the m3 v2 Time Series values follow, so the chart equals the drawing at the anchor (channel-ribbon-surface.ts).
 */
function drawsPoolFilledChannelRibbon(method: WsePolygonMethodVersion): boolean {
  return method.browserDrawing === 'channel-ribbon-pool-filled';
}

/** A flowline's ribbon segments for the run walk: those with rungs and a `channelRibbon` summary. */
function poolFillRibbonSegments(flowline: LoadedFlowline): Map<string, PoolFillRibbonSegment> {
  const segments = new Map<string, PoolFillRibbonSegment>();
  for (const [segmentId, summary] of flowline.channelRibbonBySegmentId) {
    const buckets = flowline.polygonBucketsBySegmentId.get(segmentId);
    if (buckets) segments.set(segmentId, { buckets, downstreamSegmentId: summary.downstreamSegmentId, stationDistancesM: summary.stationDistancesM ?? [] });
  }
  return segments;
}

/**
 * Dev tools WSE override for `bed-parallel-depth`: the pinned value is the WSE at the anchor
 * point (m NAVD88), so the depth is pinned − anchor bed, clamped at 0, the same at both ends.
 * Null at depth 0, which draws nothing. No display depth floor applies to a pin.
 */
function pinnedWaterDepth(pinnedWseM: number, anchorBedElevationM: number): BedParallelWaterDepth | null {
  const depthM = Math.max(0, pinnedWseM - anchorBedElevationM);
  if (depthM <= 0) return null;
  return {
    waterSurfaceElevationM: pinnedWseM,
    anchorBedElevationM,
    anchorDepthM: depthM,
    junctionDepth: { upstreamM: depthM, downstreamM: depthM },
  };
}

/** The bucket holding a depth; a depth above the ladder's top bucket takes the top bucket (drawn at the pinned depth anyway). */
function bucketForPinnedDepth(buckets: readonly ElevationBucket[], depthM: number): ElevationBucket | null {
  const matched = bucketForWaterSurfaceElevation(buckets, depthM);
  if (matched) return matched;
  const top = buckets[buckets.length - 1];
  const hasSurface = top?.ringsWgs84.some((ring) => ring.length >= 3) ?? false;
  return top && hasSurface && depthM >= top.maxWaterSurfaceElevationM ? top : null;
}

export interface ModeledExperienceElements {
  container: HTMLDivElement;
  playButton: HTMLButtonElement;
  slider: HTMLInputElement;
  timeReadout: HTMLElement;
  status: HTMLElement;
  speedButtons: readonly PlaybackSpeedControl[];
    timeRangeControls: TimeRangeControls | null;
  modeledPanel: HTMLElement;
  transferToggle: HTMLInputElement;
  transferToggleLabel: HTMLElement;
  /** Shows the TNC flowline centerlines and vertex dots; unchecked when the experience starts. */
  centerlineToggle: HTMLInputElement;
  centerlineToggleLabel: HTMLElement;
  title: HTMLElement | null;
  subtitle: HTMLElement | null;
  legendLabel: HTMLElement | null;
  /** Legend row for Drainage-Area Ratio Transfer water; hidden in the observed experience. */
  legendTransferRow: HTMLElement | null;
  /** Text span inside that row; filled from drainage-area-ratio-transfer-labels.ts. */
  legendTransferLabel: HTMLElement | null;
}

/** One Creek Segment's modeled water at the selected time, for the dev tools. */
export interface ModeledSegmentReading {
  segmentId: string;
  tncComid: string;
  /** Modeled water-surface elevation at the selected time, m NAVD88. Null when none or beyond the hold. */
  elevationM: number | null;
  /** False until the flowline's Time Series file covering the selected time has loaded. */
  isLoaded: boolean;
  drainageAreaRatioTransfer: boolean;
}

/** One Drainage-Area Ratio Transfer segment known to the experience, for the dev tools. */
export interface DrainageAreaRatioTransferSegment {
  segmentId: string;
  tncComid: string;
  /** Center of the segment's prepared polygons, or null when it has none to frame. */
  centerWgs84: LonLat | null;
  /** Segment drainage area ÷ borrowed Reach drainage area, when known. */
  drainageAreaRatio: number | null;
  /** NHDPlusV2 COMID of the borrowed Reach, when the crosswalk is available. */
  borrowedReachComid: string | null;
  /** Where the flag came from: a loaded Time Series file, the crosswalk, or both. */
  sources: readonly ('time-series' | 'crosswalk')[];
}

export interface ModeledExperienceSeam {
  readonly datasetId: string;
  /** Picker label of the Dataset, e.g. "Modeled Creek Water Levels — monthly (from California Natural Flows)". */
  readonly datasetLabel: string;
  readonly extentId: string;
  readonly selectedTimeUtcMs: number;
  readonly visibleFlowlineComids: readonly string[];
  readonly loadedFlowlineComids: readonly string[];
  readonly waterSegmentCount: number;
  readonly transferSegmentIds: readonly string[];
  readonly isLoading: boolean;
  /** True when the reviewed reach crosswalk loaded and carries transfer flags. */
  readonly crosswalkHasTransferFlags: boolean;
  /** Resolves once every pending fetch landed and the renderer drew the result. */
  whenIdle(): Promise<void>;
  setShowTransferWater(show: boolean): Promise<void>;
  /**
   * Every Drainage-Area Ratio Transfer segment in the extent that the browser
   * knows about: all crosswalk-flagged segments plus any flagged in a Time
   * Series file loaded so far. Sorted by segment id.
   */
  listDrainageAreaRatioTransferSegments(): readonly DrainageAreaRatioTransferSegment[];
  /** Re-picks the flowlines near the camera and starts loading the missing ones. */
  refreshVisibleFlowlines(): void;
  /**
   * Dev tools: flowlines to load ahead of the distance ranking on every refresh,
   * so a framed Drainage-Area Ratio Transfer segment shows its water even when
   * the camera is far enough that the per-view cap would skip its flowline.
   * Pass an empty list to clear.
   */
  setPriorityFlowlines(tncComids: readonly string[]): void;
  /**
   * Dev tools: the modeled water on one Creek Segment at the selected time,
   * whether or not that water is drawn. Null when the segment is not in the extent.
   */
  readSegment(segmentId: string): ModeledSegmentReading | null;
  /** Dev tools: the Creek Segment whose prepared polygons center nearest the point, within the distance. */
  nearestSegment(lonLat: LonLat, maxDistanceM: number): { segmentId: string; distanceM: number } | null;
  /**
   * Dev tools water click inspector: one Creek Segment's Time Series values, drawn water, anchor, and
   * polygon vertices at the selected time. Null when the segment is not in the extent. Cheap enough to poll.
   */
  inspectSegment(segmentId: string): ModeledSegmentInspection | null;
  /** Every saved WSE Polygon Generation Method version of this extent, sorted by method id, then version. */
  readonly wsePolygonMethods: readonly WsePolygonMethodVersion[];
  /**
   * Dev tools: the extent's derived data products grouped by modeled WSE
   * version (Time Series), each with the polygon versions that can draw it.
   */
  readonly derivedDataGroups: readonly DerivedDataGroup[];
  /** Dev tools: registered methods with no saved output in this extent. */
  readonly notGeneratedDerivedData: NotGeneratedDerivedData;
  /** Dev tools: ribbon v2's anchor clearance lift, its margin, and what keeping it current costs. */
  readonly anchorClearance: AnchorClearanceStatus;
  /** The method name the page opens with when no `wsePolygonMethod` is requested. */
  readonly defaultWsePolygonMethodId: string;
  /** The method version whose polygons are drawn now. */
  readonly wsePolygonMethod: WsePolygonMethodVersion;
  /**
   * Dev tools: draws another saved method version (`<method-id>@v<version>`,
   * or a channel pairing `<method-id>@v<version>+<modeled-wse-id>@v<version>`)
   * without a page reload, keeping the camera and the selected time, and
   * writes it to the `wsePolygonMethod` (and `modeledWse`) URL parameters.
   * Resolves once its polygons are drawn.
   */
  setWsePolygonMethod(key: string): Promise<void>;
}

type ModeledSeamWindow = Window & { __TNC_MODELED__?: ModeledExperienceSeam };

export interface AnchorClearanceStatus {
  /** `?ribbonAnchorClearanceM=` in meters; null when the lift is off. */
  readonly marginM: number | null;
  /** `?ribbonDrapeDepthCapM=` and `?ribbonDrapeTaperM=` in meters; null when the station drape is off. */
  readonly drape: { depthCapM: number; taperM: number } | null;
  /** False when `?ribbonStationIntervals=off` draws ribbon v2 as one ring. */
  readonly byStationInterval: boolean;
  /** Browser ground samples taken at anchors and draped stations since the page opened (each cached until the drawn terrain changes). */
  readonly groundSampleCount: number;
  /** Redraws caused by the drawn terrain changing (not by the selected time). */
  readonly terrainRecomputeCount: number;
  /** The last of those: placements worked out (ms), and until the water was redrawn (ms, includes the wait for the next frame). */
  readonly lastTerrainRecompute: { resolveMs: number; drawnMs: number } | null;
}

export interface ModeledExperienceScene {
  /**
   * The SceneView a previous experience left open. When given, nothing is
   * created for the scene: the imagery, terrain, and camera stay as they are.
   */
  view?: SceneView;
  /** Ending it takes this experience's water, controls, chart, and seam off the page. The view stays. */
  lifetime?: ExperienceLifetime;
}

export async function startModeledCreekExperience(
  selection: Extract<DatasetSelection, { kind: 'modeled' }>,
  elements: ModeledExperienceElements,
  scene: ModeledExperienceScene = {},
): Promise<{ view: SceneView; attachment: CreekVisualizationAttachment }> {
  const lifetime = scene.lifetime ?? createExperienceLifetime();
  const { datasetId, extentId } = selection;
  const [catalogFile, methodListFile, crosswalk, segmentPaths] = await Promise.all([
    modeledDataSource().loadCatalog(extentId),
    modeledDataSource().loadWsePolygonMethodList(extentId),
    loadReachCrosswalk(extentId),
    loadSegmentPaths(extentId),
  ]);
  const catalog = readModeledCatalog(catalogFile);
  const methodList = readWsePolygonMethodList(methodListFile);
  const query = new URLSearchParams(window.location.search);
  const resolvedMethod = resolveWsePolygonMethod(
    methodList,
    query.get(WSE_POLYGON_METHOD_QUERY_PARAM),
    query.get(MODELED_WSE_QUERY_PARAM),
  );
  if (resolvedMethod.unmatchedRequest) {
    console.warn(
      `No saved WSE Polygon Generation Method ${resolvedMethod.unmatchedRequest} for ${extentId}; ` +
        `drawing ${derivedDataSelectionKey(resolvedMethod.selected)}.`,
    );
  }
  let wsePolygonMethod = resolvedMethod.selected;
  // Each method version has its own flowline index: segment centers and boxes follow its polygons.
  let index = await loadFlowlineIndex(extentId, wsePolygonMethod);
  const selected = selectModeledDataset(catalog, datasetId);
  const holdMs = datasetHoldMs(selected.dataset.timeStep);
  let segmentCenters = segmentCentersById(index);

  const datasetLabel = datasetLabelFor(selection);
  labelPage(elements, selection, datasetLabel);
  bindDatasetAboutDialog(`About ${datasetLabel}`, (body) => renderModeledDatasetAbout(body, selected));
  elements.transferToggleLabel.textContent = DRAINAGE_AREA_RATIO_TRANSFER_TOGGLE_LABEL;
  elements.transferToggle.checked = true;
  elements.centerlineToggleLabel.textContent = CREEK_CENTERLINE_TOGGLE_LABEL;
  elements.centerlineToggle.checked = false;
  elements.modeledPanel.classList.remove('hidden');
  if (elements.legendTransferRow) {
    elements.legendTransferRow.classList.remove('hidden');
    elements.legendTransferRow.classList.add('flex');
  }
  if (elements.legendTransferLabel) {
    elements.legendTransferLabel.textContent = DRAINAGE_AREA_RATIO_TRANSFER_LEGEND_LABEL;
  }

  const view = scene.view ?? (await createStandaloneExperienceShell(elements.container, openingPath(index)));

  const state = {
    selectedTimeUtcMs: selected.dataset.timeRangeUtcMs[0],
    visible: { tncComids: [], inRadiusCount: 0, centerWgs84: null, radiusM: 0 } as VisibleFlowlineSelection,
    showTransferWater: true,
    waterSegmentIds: [] as readonly string[],
    identity: [] as readonly WaterGraphicGeometryIdentity[],
    transferSegmentIds: new Set<string>(),
    priorityComids: [] as readonly string[],
  };
  let knownComids = new Set(index.flowlines.map((flowline) => flowline.tncComid));
  const pinnedBySegmentId = new Map<string, number>();
  /** Crosswalk flags are the fallback until every Time Series file carries its own. */
  const crosswalkTransferIds: ReadonlySet<string> = crosswalk?.transferSegmentIds ?? new Set();
  let selectedCreekSegmentChart: SelectedCreekSegmentChart | null = null;

  const renderer = createModeledWaterSceneRenderer(view, segmentPaths, (identity) => {
    state.identity = Object.freeze(identity.map((item) => Object.freeze(item)));
    state.waterSegmentIds = Object.freeze(
      identity.filter((item) => item.bucketMinElevationM != null).map((item) => item.segmentId),
    );
    updateStatus();
    selectedCreekSegmentChart?.refresh();
  });
  lifetime.onEnd(() => renderer.dispose());

  // Added after the water layer so the lines draw over it. Hidden until the checkbox is ticked.
  const centerlines = createCreekCenterlineOverlay(view, segmentPaths);
  lifetime.onEnd(() => centerlines.dispose());
  elements.centerlineToggle.addEventListener(
    'change',
    () => centerlines.setVisible(elements.centerlineToggle.checked),
    { signal: lifetime.signal },
  );

  const anchorClearanceStats = { terrainRecomputeCount: 0, lastTerrainRecompute: null as AnchorClearanceStatus['lastTerrainRecompute'] };
  // Ribbon v2's anchor clearance follows the drawn terrain: when finer (or coarser) tiles replace it, the lifts are worked out again.
  const anchorGround = createAnchorGroundCache(view, () => {
    if (lifetime.signal.aborted || !drawsPoolFilledChannelRibbon(wsePolygonMethod) || anchorClearanceMarginM() === null) return;
    const startedMs = performance.now();
    renderer.schedule(resolvePlacements(state.selectedTimeUtcMs));
    const resolvedMs = performance.now();
    void renderer.flush().then(() => {
      anchorClearanceStats.terrainRecomputeCount += 1;
      anchorClearanceStats.lastTerrainRecompute = { resolveMs: resolvedMs - startedMs, drawnMs: performance.now() - startedMs };
    });
  });
  lifetime.onEnd(() => anchorGround.dispose());

  const store = createModeledWaterDataStore({
    extentId,
    dataSource: modeledDataSource(),
    wsePolygonMethodPath: wsePolygonMethod.path,
    modeledWseVersionPath: drawnModeledWsePathOf(wsePolygonMethod) ?? null,
    timeSeries: selected.timeSeries,
    timeStep: selected.dataset.timeStep,
    // A fetch that lands after the experience ended must not redraw or write status text.
    onChange: () => {
      if (!lifetime.signal.aborted) applySelectedTime(state.selectedTimeUtcMs);
    },
  });

  /** Straight-line length from the segment path's first to last vertex (its chord), or null without a path. */
  const segmentChordLengthM = (segmentId: string): number | null => {
    const path = segmentPaths.get(segmentId)?.path;
    return path && path.length >= 2 ? equirectangularDistanceM(path[0], path[path.length - 1]) : null;
  };

  /** Ribbon v2's display rule for one segment, by its bed slope; off (0, 0) unless a URL parameter turns it on. */
  const poolFilledDisplayAdjustment = (series: LoadedTimeSeries, segmentId: string): { floorM: number; liftM: number } =>
    ribbonDisplayAdjustmentForSlope(
      localBedSlope(series.junctionBedUpstreamMBySegmentId.get(segmentId), series.junctionBedDownstreamMBySegmentId.get(segmentId), segmentChordLengthM(segmentId)),
      false,
    );

  /**
   * Ribbon v2's clearance lift for one flowline at the selected time: each wet segment's own lift at its anchor, from the browser
   * ground there and the water drawn there before the lift, then the lift at every station between anchors, raised by the station
   * drape (`drape` non-null) where thin water would sit below the browser ground at the station's midline.
   */
  const anchorClearanceForFlowline = (
    flowline: LoadedFlowline,
    series: LoadedTimeSeries,
    ribbonSegments: ReadonlyMap<string, PoolFillRibbonSegment>,
    surfacesBySegmentId: ReadonlyMap<string, readonly number[]>,
    marginM: number,
    drape: { depthCapM: number; taperM: number } | null,
  ): Map<string, NonNullable<SegmentPolygonPlacement['channelRibbonAnchorClearance']>> => {
    // The height the ring gives a station before the lift (poolFilledChannelRibbonRingsWgs84).
    const drawnBeforeLiftM = (display: { floorM: number; liftM: number }, surfaceM: number, bedM: number): number =>
      bedM + Math.max(surfaceM - bedM, display.floorM, 0) + display.liftM;
    const anchorsBySegmentId = new Map<string, { anchorStation: number; liftM: number; groundM: number | null }>();
    for (const [segmentId, surfacesM] of surfacesBySegmentId) {
      const summary = flowline.channelRibbonBySegmentId.get(segmentId);
      const anchorStation = summary?.anchorStation ?? null;
      const bedsM = channelRibbonStationBedsM((ribbonSegments.get(segmentId) as PoolFillRibbonSegment).buckets);
      const surfaceM = anchorStation === null ? undefined : surfacesM[anchorStation];
      const bedM = anchorStation === null ? undefined : bedsM?.[anchorStation];
      if (!summary || anchorStation === null || surfaceM === undefined || bedM === undefined) continue;
      const drawnM = drawnBeforeLiftM(poolFilledDisplayAdjustment(series, segmentId), surfaceM, bedM);
      const groundM = anchorGround.groundAt(summary.anchorLonLat);
      anchorsBySegmentId.set(segmentId, { anchorStation, liftM: groundM === null ? 0 : Math.max(0, groundM + marginM - drawnM), groundM });
    }
    const stationDrape: StationDrape | null = drape && {
      ...drape,
      stationsOf: (segmentId) => {
        const surfacesM = surfacesBySegmentId.get(segmentId);
        const buckets = (ribbonSegments.get(segmentId) as PoolFillRibbonSegment).buckets;
        const bedsM = channelRibbonStationBedsM(buckets);
        const midpoints = channelRibbonStationMidpointsLonLat(buckets);
        if (!surfacesM || !bedsM || !midpoints) return null;
        const display = poolFilledDisplayAdjustment(series, segmentId);
        const trueDepthsM = surfacesM.map((surfaceM, station) => surfaceM - (bedsM[station] as number));
        // Deep water is not draped, so the map is only sampled under thin water.
        const neededLiftsM = trueDepthsM.map((depthM, station) => {
          if (!(depthM < drape.depthCapM)) return null;
          const groundM = anchorGround.groundAt(midpoints[station] as LonLat);
          const bedM = bedsM[station] as number;
          return groundM === null ? null : Math.max(0, groundM + marginM - drawnBeforeLiftM(display, bedM + depthM, bedM));
        });
        return { trueDepthsM, neededLiftsM };
      },
    };
    const stationLifts = anchorClearanceStationLiftsBySegmentId(
      ribbonSegments,
      surfacesBySegmentId,
      (segmentId) => anchorsBySegmentId.get(segmentId) ?? null,
      stationDrape,
    );
    const clearanceBySegmentId = new Map<string, NonNullable<SegmentPolygonPlacement['channelRibbonAnchorClearance']>>();
    for (const [segmentId, lifts] of stationLifts) {
      const anchor = anchorsBySegmentId.get(segmentId);
      clearanceBySegmentId.set(segmentId, {
        stationLiftsM: lifts.stationLiftsM,
        anchorStation: anchor?.anchorStation ?? null,
        anchorLiftM: anchor?.liftM ?? 0,
        marginM,
        anchorGroundM: anchor?.groundM ?? null,
        drape: drape && { ...drape, drapedStationCount: lifts.drapedStationCount, cappedStationCount: lifts.cappedStationCount },
      });
    }
    return clearanceBySegmentId;
  };

  const resolvePlacements = (timeUtcMs: number): SegmentPolygonPlacement[] => {
    const placements: SegmentPolygonPlacement[] = [];
    state.transferSegmentIds = new Set();
    const clearanceMarginM = anchorClearanceMarginM();
    const drape = stationDrapeSettings();
    const byStationInterval = ribbonDrawnByStationInterval();
    for (const comid of state.visible.tncComids) {
      const flowline = store.loadedFlowline(comid);
      if (!flowline) continue;
      const series = store.seriesAt(comid, timeUtcMs);
      // Ribbon v2: one walk per flowline at the selected time gives every station of every wet segment its pool-filled surface.
      const ribbonSegments = drawsPoolFilledChannelRibbon(wsePolygonMethod) ? poolFillRibbonSegments(flowline) : null;
      const poolFilledSurfaces =
        ribbonSegments && series
          ? poolFilledStationSurfacesBySegmentId(ribbonSegments, (segmentId) => heldJunctionDepthsAt(series, segmentId, timeUtcMs, holdMs))
          : null;
      const anchorClearances =
        ribbonSegments && series && poolFilledSurfaces && clearanceMarginM !== null
          ? anchorClearanceForFlowline(flowline, series, ribbonSegments, poolFilledSurfaces, clearanceMarginM, drape)
          : null;
      for (const [segmentId, buckets] of flowline.polygonBucketsBySegmentId) {
        const isTransfer =
          (series?.transferSegmentIds.has(segmentId) ?? false) || crosswalkTransferIds.has(segmentId);
        if (isTransfer) state.transferSegmentIds.add(segmentId);
        const pinned = pinnedBySegmentId.get(segmentId);
        let bucket: ElevationBucket | null = null;
        let junctionWaterSurface: JunctionWaterSurface | null = null;
        let bedParallelWaterDepth: BedParallelWaterDepth | null = null;
        let channelRibbonLiftM = 0;
        let channelRibbonFloorM = 0;
        let channelRibbonStationSurfacesM: readonly number[] | null = null;
        let channelRibbonAnchorClearance: SegmentPolygonPlacement['channelRibbonAnchorClearance'] | null = null;
        if (pinned !== undefined && drawsBedParallelDepth(wsePolygonMethod)) {
          // The pin is the WSE at the anchor point; buckets are depths. Without an anchor bed, nothing is drawn.
          const anchorBedElevationM = series?.anchorBedElevationMBySegmentId.get(segmentId);
          const depth = anchorBedElevationM === undefined ? null : pinnedWaterDepth(pinned, anchorBedElevationM);
          bucket = depth ? bucketForPinnedDepth(buckets, depth.anchorDepthM) : null;
          if (bucket) bedParallelWaterDepth = depth;
          const pinnedRibbon = ribbonSegments?.get(segmentId);
          if (bucket && depth && pinnedRibbon) {
            // A pinned ribbon v2 segment is pool-filled on its own at the pinned depth, with no display rule.
            channelRibbonStationSurfacesM =
              poolFilledStationSurfacesBySegmentId(new Map([[segmentId, { ...pinnedRibbon, downstreamSegmentId: null }]]), () => depth.junctionDepth).get(segmentId) ?? null;
          }
        } else if (pinned !== undefined) {
          // A test pin asks for one flat height, so no slope.
          bucket = bucketForWaterSurfaceElevation(buckets, pinned);
        } else if (series && (state.showTransferWater || !isTransfer) && drawsBedParallelDepth(wsePolygonMethod)) {
          // Buckets are depths: no held value, no anchor bed, or zero depth draws nothing.
          let depth = heldWaterDepthAt(series, segmentId, timeUtcMs, holdMs, segmentChordLengthM(segmentId));
          if (depth && drawsChannelRibbon(wsePolygonMethod)) {
            // The ribbon method's own labeled display exaggeration for steep segments (channel-ribbon-surface.ts); true depth stays in the data.
            const bedSlope = localBedSlope(
              series.junctionBedUpstreamMBySegmentId.get(segmentId),
              series.junctionBedDownstreamMBySegmentId.get(segmentId),
              segmentChordLengthM(segmentId),
            );
            const display = ribbonDisplayAdjustmentForSlope(bedSlope);
            depth = withDisplayDepthFloor(depth, display.floorM);
            channelRibbonLiftM = display.liftM;
          } else if (depth && poolFilledSurfaces) {
            // Ribbon v2: drawn on the pool-filled surface; its display rule is off unless a URL parameter turns it on.
            const surfaces = poolFilledSurfaces.get(segmentId) ?? null;
            const anchorStation = flowline.channelRibbonBySegmentId.get(segmentId)?.anchorStation ?? null;
            const anchorSurfaceM = surfaces && anchorStation !== null ? surfaces[anchorStation] : undefined;
            if (surfaces && anchorSurfaceM !== undefined) {
              const display = poolFilledDisplayAdjustment(series, segmentId);
              channelRibbonStationSurfacesM = surfaces;
              channelRibbonFloorM = display.floorM;
              channelRibbonLiftM = display.liftM;
              channelRibbonAnchorClearance = anchorClearances?.get(segmentId) ?? null;
              depth = { ...depth, anchorDepthM: Math.max(anchorSurfaceM - depth.anchorBedElevationM, display.floorM) };
            } else {
              depth = null;
            }
          }
          bucket = depth && depth.anchorDepthM > 0 ? bucketForWaterSurfaceElevation(buckets, depth.anchorDepthM) : null;
          if (bucket) bedParallelWaterDepth = depth;
        } else if (series && (state.showTransferWater || !isTransfer)) {
          const elevationM = heldValueAt(series, segmentId, timeUtcMs, holdMs);
          bucket = elevationM === null ? null : bucketForWaterSurfaceElevation(buckets, elevationM);
          if (bucket && drawsSlopedWaterSurfaces(wsePolygonMethod)) {
            junctionWaterSurface = heldJunctionWaterSurfaceAt(series, segmentId, timeUtcMs, holdMs);
          }
        }
        placements.push({
          segmentId,
          bucket,
          drainageAreaRatioTransfer: isTransfer,
          junctionWaterSurface,
          ...(bedParallelWaterDepth ? { bedParallelWaterDepth } : {}),
          ...(bedParallelWaterDepth && drawsChannelRibbon(wsePolygonMethod) ? { channelRibbonBuckets: buckets, channelRibbonLiftM } : {}),
          ...(bedParallelWaterDepth && channelRibbonStationSurfacesM
            ? { channelRibbonBuckets: buckets, channelRibbonStationSurfacesM, channelRibbonFloorM, channelRibbonLiftM, channelRibbonByStationInterval: byStationInterval }
            : {}),
          ...(bedParallelWaterDepth && channelRibbonStationSurfacesM && channelRibbonAnchorClearance ? { channelRibbonAnchorClearance } : {}),
        });
      }
    }
    return placements;
  };

  const listDrainageAreaRatioTransferSegments = (): DrainageAreaRatioTransferSegment[] => {
    const sourcesById = new Map<string, Set<'time-series' | 'crosswalk'>>();
    const ratioFromSeries = new Map<string, number>();
    const note = (segmentId: string, source: 'time-series' | 'crosswalk'): void => {
      const sources = sourcesById.get(segmentId) ?? new Set();
      sources.add(source);
      sourcesById.set(segmentId, sources);
    };
    for (const segmentId of crosswalkTransferIds) note(segmentId, 'crosswalk');
    for (const comid of store.loadedFlowlineComids) {
      const flowline = store.loadedFlowline(comid);
      if (!flowline) continue;
      for (const series of flowline.seriesByKey.values()) {
        for (const segmentId of series.transferSegmentIds) note(segmentId, 'time-series');
        for (const [segmentId, ratio] of series.drainageAreaRatioBySegmentId) {
          ratioFromSeries.set(segmentId, ratio);
        }
      }
    }
    return [...sourcesById.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([segmentId, sources]) => {
        const entry = crosswalk?.segmentsById.get(segmentId) ?? null;
        return {
          segmentId,
          tncComid: segmentId.split('-')[0],
          centerWgs84: segmentCenters.get(segmentId) ?? null,
          drainageAreaRatio: entry?.drainageAreaRatio ?? ratioFromSeries.get(segmentId) ?? null,
          borrowedReachComid: entry?.nhdplusV2Comid ?? null,
          sources: [...sources],
        };
      });
  };

  const isTransferSegment = (segmentId: string, comid: string): boolean =>
    crosswalkTransferIds.has(segmentId) ||
    [...(store.loadedFlowline(comid)?.seriesByKey.values() ?? [])].some((series) =>
      series.transferSegmentIds.has(segmentId),
    );

  const readSegment = (segmentId: string): ModeledSegmentReading | null => {
    if (!segmentCenters.has(segmentId)) return null;
    const tncComid = segmentId.split('-')[0];
    const series = store.seriesAt(tncComid, state.selectedTimeUtcMs);
    return {
      segmentId,
      tncComid,
      elevationM: series ? heldValueAt(series, segmentId, state.selectedTimeUtcMs, holdMs) : null,
      isLoaded: series !== null,
      drainageAreaRatioTransfer: isTransferSegment(segmentId, tncComid),
    };
  };

  const nearestSegment = (
    lonLat: LonLat,
    maxDistanceM: number,
  ): { segmentId: string; distanceM: number } | null => {
    let best: { segmentId: string; distanceM: number } | null = null;
    for (const [segmentId, center] of segmentCenters) {
      const distanceM = equirectangularDistanceM(lonLat, center);
      if (distanceM <= maxDistanceM && (best === null || distanceM < best.distanceM)) {
        best = { segmentId, distanceM };
      }
    }
    return best;
  };

  const inspectSegment = (segmentId: string): ModeledSegmentInspection | null => {
    if (!segmentCenters.has(segmentId)) return null;
    const tncComid = segmentId.split('-')[0];
    const flowline = store.loadedFlowline(tncComid);
    const path = segmentPaths.get(segmentId)?.path;
    const chordLengthM = segmentChordLengthM(segmentId);
    return buildModeledSegmentInspection({
      segmentId,
      timeUtcMs: state.selectedTimeUtcMs,
      holdMs,
      method: wsePolygonMethod,
      series: store.seriesAt(tncComid, state.selectedTimeUtcMs),
      buckets: flowline?.polygonBucketsBySegmentId.get(segmentId) ?? null,
      ribbonSummary: flowline?.channelRibbonBySegmentId.get(segmentId) ?? null,
      graphic: renderer.graphicForSegment(segmentId),
      chord:
        path && path.length >= 2 && chordLengthM !== null
          ? { first: path[0], last: path[path.length - 1], lengthM: chordLengthM }
          : null,
      pinnedWseM: pinnedBySegmentId.get(segmentId) ?? null,
    });
  };

  /** Says only what a reader can act on: water still loading, or a load error. Counts live in the dev tools. */
  const updateStatus = (): void => {
    if (store.lastError) elements.status.textContent = store.lastError;
    else if (store.isLoading) showLoadingMessage(elements.status, 'Loading modeled water…');
    else elements.status.textContent = '';
  };

  const applySelectedTime = (timeUtcMs: number): void => {
    state.selectedTimeUtcMs = timeUtcMs;
    store.setNeeded(state.visible.tncComids, timeUtcMs);
    renderer.schedule(resolvePlacements(timeUtcMs));
    updateStatus();
    selectedCreekSegmentChart?.setSelectedTime(timeUtcMs);
  };

  const refreshVisibleFlowlines = (): void => {
    const visible = selectVisibleFlowlines(view, index.flowlines);
    if (state.priorityComids.length > 0) {
      // Priority flowlines go first; the distance-ranked rest fill up to the same cap.
      const merged = [...new Set([...state.priorityComids, ...visible.tncComids])];
      visible.tncComids = merged.slice(0, Math.max(MAX_FLOWLINES_IN_VIEW, state.priorityComids.length));
    }
    state.visible = visible;
    applySelectedTime(state.selectedTimeUtcMs);
  };

  const clock = timelineClock(selected.dataset.timeRangeUtcMs, selected.dataset.timeStep);
  const timeline = bindObservationTimelineControls(
    {
      playButton: elements.playButton,
      slider: elements.slider,
      timeReadout: elements.timeReadout,
      speedButtons: elements.speedButtons,
      timeRangeControls: elements.timeRangeControls ?? undefined,
    },
    clock,
    openingGridIndex(clock, selection.openingTimeUtcMs),
    applySelectedTime,
    lifetime,
  );

  /**
   * The chart shows the Time Series file that covers the selected time: the
   * water year for hourly Datasets, the whole record otherwise. Only that file
   * is in memory, so a click on the chart always lands on a loaded value.
   */
  const chartContentForSegment = (segmentId: string): SegmentChartContent => {
    const tncComid = segmentId.split('-')[0];
    const series = store.seriesAt(tncComid, state.selectedTimeUtcMs);
    if (!series) return { emptyText: `Loading modeled water-surface elevation for Creek Segment ${segmentId}…` };
    const valuesM = series.valuesBySegmentId.get(segmentId);
    if (!valuesM) return { emptyText: `${datasetLabel} has no values for Creek Segment ${segmentId}.` };
    const coverage =
      selected.dataset.timeStep === 'hourly' ? `, water year ${waterYearOf(state.selectedTimeUtcMs)}` : '';
    return {
      series: {
        segmentId,
        sourceLabel: `Modeled, ${datasetLabel}${coverage} (m NAVD88)`,
        timestampsUtcMs: series.timestampsUtcMs,
        valuesM,
      },
    };
  };

  const chartElements = readWaterSurfaceElevationChartElements();
  if (chartElements) {
    selectedCreekSegmentChart = bindSelectedCreekSegmentChart({
      view,
      waterGraphics: renderer,
      chartElements,
      chartContentForSegment,
      onChartTimeClicked: (timeUtcMs) => timeline.selectTime(timeUtcMs),
      lifetime,
    });
    selectedCreekSegmentChart.setSelectedTime(state.selectedTimeUtcMs);
  }

  elements.transferToggle.addEventListener(
    'change',
    () => {
      state.showTransferWater = elements.transferToggle.checked;
      applySelectedTime(state.selectedTimeUtcMs);
    },
    { signal: lifetime.signal },
  );

  refreshVisibleFlowlines();
  const stationaryWatch = watch(
    () => view.stationary,
    (stationary) => {
      if (stationary) refreshVisibleFlowlines();
    },
  );
  lifetime.onEnd(() => stationaryWatch.remove());

  const whenIdle = async (): Promise<void> => {
    // A landed fetch can queue the next one (polygons, then Time Series), so loop.
    for (let round = 0; round < 8; round += 1) {
      await store.whenIdle();
      await renderer.flush();
      if (!store.isLoading) break;
    }
  };

  /** Swaps the drawn polygons to another saved method version; the camera and selected time stay. */
  const setWsePolygonMethod = async (key: string): Promise<void> => {
    const next = [...methodList.versions, ...methodList.channelPairings].find((entry) => derivedDataSelectionKey(entry) === key);
    if (!next) throw new Error(`No saved WSE Polygon Generation Method ${key} for ${extentId}.`);
    if (next !== wsePolygonMethod) {
      const nextIndex = await loadFlowlineIndex(extentId, next);
      wsePolygonMethod = next;
      index = nextIndex;
      segmentCenters = segmentCentersById(index);
      knownComids = new Set(index.flowlines.map((flowline) => flowline.tncComid));
      // Also reloads the Time Series when the new method draws another modeled WSE version.
      store.setWsePolygonMethodPath(next.path, drawnModeledWsePathOf(next) ?? null);
      renderer.clear();
      writeWsePolygonMethodToUrl(methodList, next);
      refreshVisibleFlowlines();
    }
    await whenIdle();
  };

  const attachment: CreekVisualizationAttachment = {
    get selectedTimeUtcMs() {
      return state.selectedTimeUtcMs;
    },
    observedWaterSurfaceElevationM: null,
    get waterSegmentIds() {
      return state.waterSegmentIds;
    },
    get waterGraphicGeometryIdentity() {
      return state.identity;
    },
    get selectedCreekSegmentChart() {
      return selectedCreekSegmentChart;
    },
    flush: () => renderer.flush(),
    async pinSegmentWaterSurfaceElevationM(segmentId, elevationM) {
      if (elevationM === null) pinnedBySegmentId.delete(segmentId);
      else pinnedBySegmentId.set(segmentId, elevationM);
      applySelectedTime(state.selectedTimeUtcMs);
      await renderer.flush();
    },
  };

  const seam: ModeledExperienceSeam = {
    datasetId,
    datasetLabel,
    extentId,
    get selectedTimeUtcMs() {
      return state.selectedTimeUtcMs;
    },
    get visibleFlowlineComids() {
      return state.visible.tncComids;
    },
    get loadedFlowlineComids() {
      return store.loadedFlowlineComids;
    },
    get waterSegmentCount() {
      return state.waterSegmentIds.length;
    },
    get transferSegmentIds() {
      return [...state.transferSegmentIds];
    },
    get isLoading() {
      return store.isLoading;
    },
    get crosswalkHasTransferFlags() {
      return crosswalk?.hasTransferFlags ?? false;
    },
    whenIdle,
    async setShowTransferWater(show) {
      elements.transferToggle.checked = show;
      elements.transferToggle.dispatchEvent(new Event('change'));
      await renderer.flush();
    },
    listDrainageAreaRatioTransferSegments,
    refreshVisibleFlowlines,
    setPriorityFlowlines(tncComids) {
      state.priorityComids = [...new Set(tncComids.filter((comid) => knownComids.has(comid)))];
      refreshVisibleFlowlines();
    },
    readSegment,
    nearestSegment,
    inspectSegment,
    wsePolygonMethods: methodList.versions,
    derivedDataGroups: groupDerivedData(methodList),
    notGeneratedDerivedData: methodList.notGenerated,
    anchorClearance: {
      get marginM() {
        return anchorClearanceMarginM();
      },
      get drape() {
        return stationDrapeSettings();
      },
      get byStationInterval() {
        return ribbonDrawnByStationInterval();
      },
      get groundSampleCount() {
        return anchorGround.sampleCount;
      },
      get terrainRecomputeCount() {
        return anchorClearanceStats.terrainRecomputeCount;
      },
      get lastTerrainRecompute() {
        return anchorClearanceStats.lastTerrainRecompute;
      },
    },
    defaultWsePolygonMethodId: methodList.defaultMethodId,
    get wsePolygonMethod() {
      return wsePolygonMethod;
    },
    setWsePolygonMethod,
  };
  Object.defineProperty(window as ModeledSeamWindow, '__TNC_MODELED__', {
    configurable: true,
    value: seam,
  });
  lifetime.onEnd(() => {
    if ((window as ModeledSeamWindow).__TNC_MODELED__ === seam) {
      Reflect.deleteProperty(window, '__TNC_MODELED__');
    }
  });

  await whenIdle();
  return { view, attachment };
}

/**
 * Creek Segment flowline paths and neighbours from the dev middleware. The
 * file is computed from the extent's flowline snapshot and Stage 1 output;
 * when either is not there yet the request fails and every polygon draws flat.
 */
async function loadSegmentPaths(extentId: string): Promise<ReadonlyMap<string, CreekSegmentPathRecord>> {
  try {
    return readCreekSegmentPaths(await modeledDataSource().loadCreekSegmentPaths(extentId));
  } catch (error) {
    console.warn(`Creek Segment paths unavailable; modeled water draws flat. ${String(error)}`);
    return new Map();
  }
}

/** The flowline index of one WSE Polygon Generation Method version, computed by the dev middleware. */
async function loadFlowlineIndex(extentId: string, method: WsePolygonMethodVersion): Promise<FlowlineIndex> {
  return readFlowlineIndex(await modeledDataSource().loadFlowlineIndex(extentId, method.path));
}

/**
 * Keeps the address bar reloadable after a live switch: the default pairing
 * (what the page opens without parameters) drops both parameters. Any other
 * choice names its polygon version, plus `modeledWse` for a channel pairing's
 * Time Series; without `modeledWse` a named version draws its own Time Series.
 */
function writeWsePolygonMethodToUrl(list: WsePolygonMethodList, method: WsePolygonMethodVersion): void {
  const url = new URL(window.location.href);
  const isDefault = derivedDataSelectionKey(resolveWsePolygonMethod(list, null).selected) === derivedDataSelectionKey(method);
  if (isDefault) url.searchParams.delete(WSE_POLYGON_METHOD_QUERY_PARAM);
  else url.searchParams.set(WSE_POLYGON_METHOD_QUERY_PARAM, wsePolygonMethodKey(method));
  if (!isDefault && method.drawnWithModeledWsePath) {
    url.searchParams.set(MODELED_WSE_QUERY_PARAM, modeledWseKeyOfPath(method.drawnWithModeledWsePath));
  } else {
    url.searchParams.delete(MODELED_WSE_QUERY_PARAM);
  }
  window.history.replaceState(window.history.state, '', url);
}

function datasetLabelFor(selection: Extract<DatasetSelection, { kind: 'modeled' }>): string {
  const option = DATASET_PICKER_OPTIONS.find((item) => item.id === selection.datasetId);
  return option?.label ?? selection.datasetId;
}

function labelPage(
  elements: ModeledExperienceElements,
  selection: Extract<DatasetSelection, { kind: 'modeled' }>,
  datasetLabel: string,
): void {
  document.title = `Modeled creek water · ${datasetLabel}`;
  if (elements.title) elements.title.textContent = 'Modeled water';
  if (elements.subtitle) {
    elements.subtitle.textContent = `${datasetLabel}, extent ${selection.extentId}. Modeled, not observed.`;
  }
  if (elements.legendLabel) {
    elements.legendLabel.textContent = `Modeled water on Creek Segments near the camera: ${datasetLabel}`;
  }
}

const EARTH_RADIUS_M = 6378137;

/** Good to well under a percent over the few hundred meters a click can miss by. */
function equirectangularDistanceM([lonA, latA]: LonLat, [lonB, latB]: LonLat): number {
  const latRadians = (((latA + latB) / 2) * Math.PI) / 180;
  const dx = (((lonB - lonA) * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(latRadians);
  const dy = (((latB - latA) * Math.PI) / 180) * EARTH_RADIUS_M;
  return Math.hypot(dx, dy);
}

function segmentCentersById(index: FlowlineIndex): Map<string, LonLat> {
  const centers = new Map<string, LonLat>();
  for (const flowline of index.flowlines) {
    for (const segment of flowline.segments) {
      if (segment.centerWgs84) centers.set(segment.segmentId, [segment.centerWgs84[0], segment.centerWgs84[1]]);
    }
  }
  return centers;
}

/** Two nearby segment centers so the shell can frame and head the camera. */
function openingPath(index: FlowlineIndex): LonLat[] {
  const centers = segmentCentersById(index);
  const [comid, vertex] = OPENING_SEGMENT_ID.split('-');
  const next = `${comid}-${String(Number(vertex) + 1).padStart(vertex.length, '0')}`;
  const first = centers.get(OPENING_SEGMENT_ID) ?? centers.values().next().value;
  if (!first) throw new Error('The flowline index has no Creek Segment with prepared polygons.');
  const second = centers.get(next) ?? ([first[0] + 0.0002, first[1]] as LonLat);
  return [first, second];
}

function timelineClock(range: readonly [number, number], timeStep: string): ObservationClock {
  const stepMs = timelineGridStepMs(timeStep);
  return {
    firstUtcMs: range[0],
    stepMs,
    count: Math.floor((range[1] - range[0]) / stepMs) + 1,
  };
}

function openingGridIndex(clock: ObservationClock, openingTimeUtcMs: number | null): number {
  if (openingTimeUtcMs === null) return 0;
  const index = Math.round((openingTimeUtcMs - clock.firstUtcMs) / clock.stepMs);
  return Math.max(0, Math.min(clock.count - 1, index));
}
