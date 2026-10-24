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
import type { SegmentPolygonPlacement, WaterGraphicGeometryIdentity } from './arcgis-scene-renderer';
import { ribbonDisplayAdjustmentForSlope } from './channel-ribbon-surface';
import { localBedSlope, withDisplayDepthFloor } from './display-depth-floor';
import type { ElevationBucket, LonLat, ObservationClock } from './creek-data-contract';
import type { CreekVisualizationAttachment } from './creek-visualization-library-interface';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';
import {
  bindObservationTimelineControls,
  type PlaybackSpeedControl,
} from './observation-timeline-controls';
import {
  DRAINAGE_AREA_RATIO_TRANSFER_LEGEND_LABEL,
  DRAINAGE_AREA_RATIO_TRANSFER_TOGGLE_LABEL,
} from './drainage-area-ratio-transfer-labels';
import { renderModeledDatasetInfoPanel } from './modeled-dataset-info-panel';
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
  heldJunctionWaterSurfaceAt,
  heldValueAt,
  heldWaterDepthAt,
  readCreekSegmentPaths,
  readFlowlineIndex,
  type CreekSegmentPathRecord,
  type FlowlineIndex,
} from './modeled-water-data-store';
import { createModeledWaterSceneRenderer } from './modeled-water-scene-renderer';
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
  WSE_POLYGON_METHOD_QUERY_PARAM,
  drawsDepthBuckets,
  groupDerivedData,
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
  modeledPanel: HTMLElement;
  transferToggle: HTMLInputElement;
  transferToggleLabel: HTMLElement;
  datasetInfo: HTMLElement;
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
  /** Every saved WSE Polygon Generation Method version of this extent, sorted by method id, then version. */
  readonly wsePolygonMethods: readonly WsePolygonMethodVersion[];
  /**
   * Dev tools: the extent's derived data products grouped by modeled WSE
   * version (Time Series), each with the polygon versions built from it.
   */
  readonly derivedDataGroups: readonly DerivedDataGroup[];
  /** Dev tools: registered methods with no saved output in this extent. */
  readonly notGeneratedDerivedData: NotGeneratedDerivedData;
  /** The method name the page opens with when no `wsePolygonMethod` is requested. */
  readonly defaultWsePolygonMethodId: string;
  /** The method version whose polygons are drawn now. */
  readonly wsePolygonMethod: WsePolygonMethodVersion;
  /**
   * Dev tools: draws another saved method version (`<method-id>@v<version>`)
   * without a page reload, keeping the camera and the selected time, and
   * writes it to the `wsePolygonMethod` URL parameter. Resolves once its
   * polygons are drawn.
   */
  setWsePolygonMethod(key: string): Promise<void>;
}

type ModeledSeamWindow = Window & { __TNC_MODELED__?: ModeledExperienceSeam };

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
  const requestedMethod = new URLSearchParams(window.location.search).get(WSE_POLYGON_METHOD_QUERY_PARAM);
  const resolvedMethod = resolveWsePolygonMethod(methodList, requestedMethod);
  if (resolvedMethod.unmatchedRequest) {
    console.warn(
      `No saved WSE Polygon Generation Method ${resolvedMethod.unmatchedRequest} for ${extentId}; ` +
        `drawing ${wsePolygonMethodKey(resolvedMethod.selected)}.`,
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
  renderModeledDatasetInfoPanel(elements.datasetInfo, selected);
  elements.transferToggleLabel.textContent = DRAINAGE_AREA_RATIO_TRANSFER_TOGGLE_LABEL;
  elements.transferToggle.checked = true;
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

  const store = createModeledWaterDataStore({
    extentId,
    dataSource: modeledDataSource(),
    wsePolygonMethodPath: wsePolygonMethod.path,
    modeledWseVersionPath: wsePolygonMethod.builtFromModeledWsePath ?? null,
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

  const resolvePlacements = (timeUtcMs: number): SegmentPolygonPlacement[] => {
    const placements: SegmentPolygonPlacement[] = [];
    state.transferSegmentIds = new Set();
    for (const comid of state.visible.tncComids) {
      const flowline = store.loadedFlowline(comid);
      if (!flowline) continue;
      const series = store.seriesAt(comid, timeUtcMs);
      for (const [segmentId, buckets] of flowline.polygonBucketsBySegmentId) {
        const isTransfer =
          (series?.transferSegmentIds.has(segmentId) ?? false) || crosswalkTransferIds.has(segmentId);
        if (isTransfer) state.transferSegmentIds.add(segmentId);
        const pinned = pinnedBySegmentId.get(segmentId);
        let bucket: ElevationBucket | null = null;
        let junctionWaterSurface: JunctionWaterSurface | null = null;
        let bedParallelWaterDepth: BedParallelWaterDepth | null = null;
        let channelRibbonLiftM = 0;
        if (pinned !== undefined && drawsBedParallelDepth(wsePolygonMethod)) {
          // The pin is the WSE at the anchor point; buckets are depths. Without an anchor bed, nothing is drawn.
          const anchorBedElevationM = series?.anchorBedElevationMBySegmentId.get(segmentId);
          const depth = anchorBedElevationM === undefined ? null : pinnedWaterDepth(pinned, anchorBedElevationM);
          bucket = depth ? bucketForPinnedDepth(buckets, depth.anchorDepthM) : null;
          if (bucket) bedParallelWaterDepth = depth;
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

  const updateStatus = (): void => {
    const loadedVisible = state.visible.tncComids.filter((comid) => store.loadedFlowline(comid)).length;
    const parts = [
      `${state.waterSegmentIds.length} of ${state.identity.length} loaded Creek Segments show water`,
      `${loadedVisible} of ${state.visible.tncComids.length} flowlines in view loaded`,
    ];
    if (state.visible.inRadiusCount > state.visible.tncComids.length) {
      parts.push(`${state.visible.inRadiusCount - state.visible.tncComids.length} farther flowlines skipped`);
    }
    if (store.isLoading) parts.push('loading…');
    if (store.lastError) parts.push(store.lastError);
    const statusText = parts.join(' · ');
    if (store.isLoading) showLoadingMessage(elements.status, statusText);
    else elements.status.textContent = statusText;
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
    const next = methodList.versions.find((entry) => wsePolygonMethodKey(entry) === key);
    if (!next) throw new Error(`No saved WSE Polygon Generation Method ${key} for ${extentId}.`);
    if (next !== wsePolygonMethod) {
      const nextIndex = await loadFlowlineIndex(extentId, next);
      wsePolygonMethod = next;
      index = nextIndex;
      segmentCenters = segmentCentersById(index);
      knownComids = new Set(index.flowlines.map((flowline) => flowline.tncComid));
      // Also reloads the Time Series when the new method was built from another modeled WSE version.
      store.setWsePolygonMethodPath(next.path, next.builtFromModeledWsePath ?? null);
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
    wsePolygonMethods: methodList.versions,
    derivedDataGroups: groupDerivedData(methodList),
    notGeneratedDerivedData: methodList.notGenerated,
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
 * Keeps the address bar reloadable after a live switch: the parameter names
 * the version, and is dropped when it is the default method's newest version.
 */
function writeWsePolygonMethodToUrl(list: WsePolygonMethodList, method: WsePolygonMethodVersion): void {
  const url = new URL(window.location.href);
  const isDefault = resolveWsePolygonMethod(list, null).selected === method;
  if (isDefault) url.searchParams.delete(WSE_POLYGON_METHOD_QUERY_PARAM);
  else url.searchParams.set(WSE_POLYGON_METHOD_QUERY_PARAM, wsePolygonMethodKey(method));
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
