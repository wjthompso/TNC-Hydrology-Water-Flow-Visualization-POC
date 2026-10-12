import type SceneView from '@arcgis/core/views/SceneView';
import { createArcGISSceneRenderer, type WaterGraphicGeometryIdentity } from './arcgis-scene-renderer';
import type { LoadedCreekVisualization } from './creek-data-contract';
import { bindObservationTimelineControls } from './observation-timeline-controls';
import { resolveSelectedTimeCreekState } from './selected-time-creek-state-resolver';

export interface AttachCreekVisualizationOptions {
  data: LoadedCreekVisualization;
  playButton: HTMLButtonElement;
  slider: HTMLInputElement;
  timeReadout: HTMLElement;
  status: HTMLElement;
}

export interface CreekVisualizationAttachment {
  readonly selectedTimeUtcMs: number;
  readonly waterSegmentIds: readonly string[];
  readonly waterGraphicGeometryIdentity: readonly WaterGraphicGeometryIdentity[];
  flush(): Promise<void>;
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

  bindObservationTimelineControls(
    {
      playButton: options.playButton,
      slider: options.slider,
      timeReadout: options.timeReadout,
    },
    options.data.clock,
    options.data.openingGridIndex,
    (timeUtcMs) => {
      state.selectedTimeUtcMs = timeUtcMs;
      const resolved = resolveSelectedTimeCreekState(options.data, timeUtcMs);
      options.status.textContent = resolved.hasObservation ? '' : NO_OBSERVATION_STATUS;
      renderer.schedule(resolved.placements);
    },
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
  };
}
