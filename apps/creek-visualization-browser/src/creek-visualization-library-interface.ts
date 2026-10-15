import type SceneView from '@arcgis/core/views/SceneView';
import { createArcGISSceneRenderer, type WaterGraphicGeometryIdentity } from './arcgis-scene-renderer';
import type { ElevationBucket, LoadedCreekVisualization } from './creek-data-contract';
import {
  bindObservationTimelineControls,
  type PlaybackSpeedControl,
} from './observation-timeline-controls';
import {
  resolveSelectedTimeCreekState,
  type SegmentWaterPlacement,
} from './selected-time-creek-state-resolver';

export interface AttachCreekVisualizationOptions {
  data: LoadedCreekVisualization;
  playButton: HTMLButtonElement;
  slider: HTMLInputElement;
  timeReadout: HTMLElement;
  status: HTMLElement;
  speedButtons: readonly PlaybackSpeedControl[];
}

export interface CreekVisualizationAttachment {
  readonly selectedTimeUtcMs: number;
  readonly waterSegmentIds: readonly string[];
  readonly waterGraphicGeometryIdentity: readonly WaterGraphicGeometryIdentity[];
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

/** Attaches observed-water playback to a SceneView the shell already created. */
export function attachCreekVisualization(
  view: SceneView,
  options: AttachCreekVisualizationOptions,
): CreekVisualizationAttachment {
  const state: {
    selectedTimeUtcMs: number;
    waterSegmentIds: readonly string[];
    waterGraphicGeometryIdentity: readonly WaterGraphicGeometryIdentity[];
  } = {
    selectedTimeUtcMs: options.data.clock.firstUtcMs,
    waterSegmentIds: [],
    waterGraphicGeometryIdentity: [],
  };

  const pinnedBySegmentId = new Map<string, number>();

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
    },
  );

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
      // No matching bucket shouldn't happen in practice; leave the resolved placement intact.
      if (!bucket) return placement;
      return { segmentId: placement.segmentId, bucket };
    });
  };

  const applySelectedTime = (timeUtcMs: number): void => {
    state.selectedTimeUtcMs = timeUtcMs;
    const resolved = resolveSelectedTimeCreekState(options.data, timeUtcMs);
    options.status.textContent = resolved.hasObservation ? '' : NO_OBSERVATION_STATUS;
    renderer.schedule(applyPins(resolved.placements));
  };

  bindObservationTimelineControls(
    {
      playButton: options.playButton,
      slider: options.slider,
      timeReadout: options.timeReadout,
      speedButtons: options.speedButtons,
    },
    options.data.clock,
    options.data.openingGridIndex,
    applySelectedTime,
  );

  return {
    get selectedTimeUtcMs() {
      return state.selectedTimeUtcMs;
    },
    get waterSegmentIds() {
      return state.waterSegmentIds;
    },
    get waterGraphicGeometryIdentity() {
      return state.waterGraphicGeometryIdentity;
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
