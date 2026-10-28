import type SceneView from '@arcgis/core/views/SceneView';
import {
  createArcGISSceneRenderer,
  type SegmentPolygonPlacement,
  type WaterGraphicGeometryIdentity,
} from './arcgis-scene-renderer';
import type { ElevationBucket, LoadedCreekVisualization } from './creek-data-contract';
import { inferredWaterSegmentGeometry } from './inferred-water-segment-geometry';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';
import { FEET_TO_METERS, GAUGE_DATUM_FT, gaugeHeightFtFromWaterSurfaceElevationM } from './observed-gauge-readings';
import {
  bindObservationTimelineControls,
  type PlaybackSpeedControl,
  type TimeRangeControls,
} from './observation-timeline-controls';
import {
  bindSelectedCreekSegmentChart,
  readWaterSurfaceElevationChartElements,
  type SelectedCreekSegmentChart,
} from './selected-creek-segment-chart';
import {
  exactTimestampIndex,
  resolveSelectedTimeCreekState,
  type SegmentWaterPlacement,
} from './selected-time-creek-state-resolver';
import { bindSteelheadTroutConditionsControls } from './steelhead-trout-conditions-controls';
import { classifySteelheadCondition } from './steelhead-trout-conditions';
import { anchorWaterDepthSeriesM } from './water-level-units';

const OBSERVED_CHART_SOURCE_LABEL = 'Observed at USGS gauge 11120600, Jalama Creek near Lompoc (gauge height)';
/** Inferred water is a guess made from the gauge; it is never labeled as measured. */
const INFERRED_CHART_SOURCE_LABEL =
  'Inferred from the USGS gauge 11120600 reading, not measured here: the gauge segment\'s water depth applied to this segment\'s bed';

/** The gauge segment's chart shows the gauge height the feature service reports (feet, converted to meters). */
function gaugeHeightSeriesM(waterSurfaceElevationM: readonly (number | null)[]): (number | null)[] {
  return waterSurfaceElevationM.map((wseM) =>
    wseM === null ? null : gaugeHeightFtFromWaterSurfaceElevationM(wseM) * FEET_TO_METERS,
  );
}

export interface AttachCreekVisualizationOptions {
  data: LoadedCreekVisualization;
  playButton: HTMLButtonElement;
  slider: HTMLInputElement;
  timeReadout: HTMLElement;
  status: HTMLElement;
  speedButtons: readonly PlaybackSpeedControl[];
  /** Date pickers that narrow the slider; omit on pages without them. */
  timeRangeControls?: TimeRangeControls | null;
  /** Opens at the grid slot nearest this time (clamped to the record); null opens at the data's opening slot. */
  openingTimeUtcMs?: number | null;
  /** Creek Segment selected on open, so the chart shows without a click. Null opens with no selection. */
  initialSelectedSegmentId?: string | null;
  /** Ending it takes the observed water, timeline controls, chart, and selection off the scene. The view stays. */
  lifetime?: ExperienceLifetime;
}

export interface CreekVisualizationAttachment {
  readonly selectedTimeUtcMs: number;
  /** Gauge reading at the selected time, in meters NAVD88. Null when there is no reading. */
  readonly observedWaterSurfaceElevationM: number | null;
  readonly waterSegmentIds: readonly string[];
  readonly waterGraphicGeometryIdentity: readonly WaterGraphicGeometryIdentity[];
  /** Selected Creek Segment and its Water-Surface Elevation Chart; null when the page has no chart panel. */
  readonly selectedCreekSegmentChart: SelectedCreekSegmentChart | null;
  flush(): Promise<void>;
  /**
   * Test-only pin: forces a specific water-surface elevation on one Creek Segment,
   * replacing the placement's bucket with the matching prepared bucket. Passing
   * `null` clears the pin. Re-emits placements for the latest selected time and
   * awaits a renderer flush so the frame reflects the pin before resolving.
   */
  pinSegmentWaterSurfaceElevationM(
    segmentId: string,
    elevationM: number | null,
  ): Promise<void>;
}

const NO_OBSERVATION_STATUS = 'No observation at this time';
const PROVISIONAL_STATUS = 'Provisional USGS data, subject to revision';

/** Attaches observed-water playback to a SceneView the shell already created. */
export function attachCreekVisualization(
  view: SceneView,
  options: AttachCreekVisualizationOptions,
): CreekVisualizationAttachment {
  const lifetime = options.lifetime ?? createExperienceLifetime();
  const state: {
    selectedTimeUtcMs: number;
    observedWaterSurfaceElevationM: number | null;
    waterSegmentIds: readonly string[];
    waterGraphicGeometryIdentity: readonly WaterGraphicGeometryIdentity[];
  } = {
    selectedTimeUtcMs: options.data.clock.firstUtcMs,
    observedWaterSurfaceElevationM: null,
    waterSegmentIds: [],
    waterGraphicGeometryIdentity: [],
  };

  const pinnedBySegmentId = new Map<string, number>();
  const chartDepthBySourceSeries = new WeakMap<readonly (number | null)[], readonly (number | null)[]>();
  let selectedCreekSegmentChart: SelectedCreekSegmentChart | null = null;

  const renderer = createArcGISSceneRenderer(
    view,
    options.data.polygonSetSegmentIds,
    (identity) => {
      state.waterGraphicGeometryIdentity = Object.freeze(identity.map((item) => Object.freeze(item)));
      state.waterSegmentIds = Object.freeze(
        identity
          .filter((item) => item.bucketMinElevationM != null)
          .map((item) => item.segmentId),
      );
      selectedCreekSegmentChart?.refresh();
    },
    inferredWaterSegmentGeometry(options.data),
  );
  lifetime.onEnd(() => renderer.dispose());

  // Steelhead trout conditions (UCS-293). Bed elevation comes from the propagation file, which lists the
  // gauge segment and its inferred neighbours; without that file no segment has a bed and none is rated.
  const troutConditions = bindSteelheadTroutConditionsControls(lifetime);
  const bedElevationM = (segmentId: string): number | null =>
    options.data.propagation?.nodesById.get(segmentId)?.bedElevationM ?? null;

  /** Adds each drawn segment's trout condition at the selected time when the switch is on. */
  const withTroutConditions = (
    placements: readonly SegmentWaterPlacement[],
    timeUtcMs: number,
  ): readonly SegmentPolygonPlacement[] => {
    const { enabled, lifeStage } = troutConditions.state;
    if (!enabled) return placements;
    const timeIndex = exactTimestampIndex(options.data.timestampsUtcMs, timeUtcMs);
    return placements.map((placement) => {
      if (!placement.bucket || timeIndex < 0) return placement;
      const readings =
        options.data.waterSurfaceElevationMBySegmentId.get(placement.segmentId) ??
        options.data.propagation?.inferredWaterSurfaceElevationMBySegmentId.get(placement.segmentId);
      const waterSurfaceElevationM = readings?.[timeIndex] ?? null;
      return {
        ...placement,
        troutCondition: classifySteelheadCondition(
          lifeStage,
          waterSurfaceElevationM,
          bedElevationM(placement.segmentId),
          timeUtcMs,
        ),
      };
    });
  };

  const applyPins = (
    placements: readonly SegmentWaterPlacement[],
  ): readonly SegmentWaterPlacement[] => {
    if (pinnedBySegmentId.size === 0) return placements;
    return placements.map((placement) => {
      const pinned = pinnedBySegmentId.get(placement.segmentId);
      if (pinned === undefined) return placement;
      const bucket = bucketContaining(
        options.data.polygonBucketsBySegmentId.get(placement.segmentId),
        pinned,
      );
      // Outside the prepared ladder there is no polygon for that elevation, so no water is drawn.
      return { segmentId: placement.segmentId, bucket };
    });
  };

  const applySelectedTime = (timeUtcMs: number): void => {
    state.selectedTimeUtcMs = timeUtcMs;
    const resolved = resolveSelectedTimeCreekState(options.data, timeUtcMs);
    state.observedWaterSurfaceElevationM = resolved.observedWaterSurfaceElevationM;
    const provisional = resolved.hasObservation && resolved.approvalStatus === 'Provisional';
    options.status.textContent = resolved.hasObservation
      ? provisional
        ? PROVISIONAL_STATUS
        : ''
      : NO_OBSERVATION_STATUS;
    options.status.classList.toggle('text-amber-300', provisional);
    options.status.classList.toggle('text-slate-300', !provisional);
    renderer.schedule(withTroutConditions(applyPins(resolved.placements), timeUtcMs));
    selectedCreekSegmentChart?.setSelectedTime(timeUtcMs);
  };

  const timeline = bindObservationTimelineControls(
    {
      playButton: options.playButton,
      slider: options.slider,
      timeReadout: options.timeReadout,
      speedButtons: options.speedButtons,
      timeRangeControls: options.timeRangeControls ?? undefined,
    },
    options.data.clock,
    openingIndexFor(options.data.clock, options.openingTimeUtcMs ?? null, options.data.openingGridIndex),
    applySelectedTime,
    lifetime,
  );

  // Recolor the map when the switch or life stage changes (the chart follows through its own binding).
  troutConditions.onChange(() => applySelectedTime(state.selectedTimeUtcMs));

  const chartElements = readWaterSurfaceElevationChartElements();
  if (chartElements) {
    selectedCreekSegmentChart = bindSelectedCreekSegmentChart({
      view,
      waterGraphics: renderer,
      chartElements,
      chartContentForSegment: (segmentId) => {
        const observedWseM = options.data.waterSurfaceElevationMBySegmentId.get(segmentId);
        const inferredWseM = options.data.propagation?.inferredWaterSurfaceElevationMBySegmentId.get(segmentId);
        const wseM = observedWseM ?? inferredWseM;
        if (!wseM) return { emptyText: `No observed readings for Creek Segment ${segmentId}.` };
        // The chart redraws only when the arrays change, so each source array maps to one depth array.
        let depthM = chartDepthBySourceSeries.get(wseM);
        if (!depthM) {
          if (observedWseM) {
            depthM = gaugeHeightSeriesM(observedWseM);
          } else {
            const bedElevationM = options.data.propagation?.nodesById.get(segmentId)?.bedElevationM;
            if (bedElevationM === undefined) return { emptyText: `No bed elevation for Creek Segment ${segmentId}.` };
            depthM = anchorWaterDepthSeriesM(wseM, bedElevationM);
          }
          chartDepthBySourceSeries.set(wseM, depthM);
        }
        return {
          series: {
            segmentId,
            sourceLabel: observedWseM ? OBSERVED_CHART_SOURCE_LABEL : INFERRED_CHART_SOURCE_LABEL,
            timestampsUtcMs: options.data.timestampsUtcMs,
            depthM,
          },
        };
      },
      onChartTimeClicked: (timeUtcMs) => timeline.selectTime(timeUtcMs),
      troutConditions: {
        controls: troutConditions,
        // The gauge segment charts gauge height, which reads from the gauge datum, so its zero-depth
        // line sits where the bed is above that datum. Inferred segments chart depth above their bed.
        zeroDepthChartValueM: (segmentId) => {
          const bed = bedElevationM(segmentId);
          if (bed === null) return null;
          return options.data.waterSurfaceElevationMBySegmentId.has(segmentId)
            ? bed - GAUGE_DATUM_FT * FEET_TO_METERS
            : 0;
        },
      },
      lifetime,
    });
    selectedCreekSegmentChart.setSelectedTime(state.selectedTimeUtcMs);
    selectedCreekSegmentChart.selectSegment(options.initialSelectedSegmentId ?? null);
  }

  return {
    get selectedTimeUtcMs() {
      return state.selectedTimeUtcMs;
    },
    get observedWaterSurfaceElevationM() {
      return state.observedWaterSurfaceElevationM;
    },
    get waterSegmentIds() {
      return state.waterSegmentIds;
    },
    get waterGraphicGeometryIdentity() {
      return state.waterGraphicGeometryIdentity;
    },
    get selectedCreekSegmentChart() {
      return selectedCreekSegmentChart;
    },
    flush: () => renderer.flush(),
    async pinSegmentWaterSurfaceElevationM(segmentId, elevationM) {
      if (elevationM === null) {
        pinnedBySegmentId.delete(segmentId);
      } else {
        pinnedBySegmentId.set(segmentId, elevationM);
      }
      applySelectedTime(state.selectedTimeUtcMs);
      await renderer.flush();
    },
  };
}

function openingIndexFor(
  clock: LoadedCreekVisualization['clock'],
  openingTimeUtcMs: number | null,
  fallbackIndex: number,
): number {
  if (openingTimeUtcMs === null) return fallbackIndex;
  const index = Math.round((openingTimeUtcMs - clock.firstUtcMs) / clock.stepMs);
  return Math.max(0, Math.min(clock.count - 1, index));
}

/** Half-open match: `[minimum, maximum)`. Returns null when the buckets list is missing or no bucket contains the elevation. */
function bucketContaining(
  buckets: readonly ElevationBucket[] | undefined,
  waterSurfaceElevationM: number,
): ElevationBucket | null {
  if (!buckets) return null;
  for (const bucket of buckets) {
    if (
      waterSurfaceElevationM >= bucket.minWaterSurfaceElevationM &&
      waterSurfaceElevationM < bucket.maxWaterSurfaceElevationM
    ) {
      return bucket;
    }
  }
  return null;
}
