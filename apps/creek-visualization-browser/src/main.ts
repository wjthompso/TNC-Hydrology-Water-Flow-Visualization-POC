import '@arcgis/core/assets/esri/themes/dark/main.css';
import './style.css';
import {
  attachCreekVisualization,
  type CreekVisualizationAttachment,
} from './creek-visualization-library-interface';
import type { WaterGraphicGeometryIdentity } from './arcgis-scene-renderer';
import { loadPublishedCreekVisualizationData } from './http-data-contract-loader';
import {
  createStandaloneExperienceShell,
  type BasemapMode,
  type ElevationSource,
} from './standalone-experience-shell';

interface CreekVisualizationTestSeam {
  ready: Promise<boolean>;
  readonly selectedTimeUtcMs: number | null;
  readonly waterSegmentIds: readonly string[];
  readonly waterGraphicGeometryIdentity: readonly WaterGraphicGeometryIdentity[];
}

type TestModeWindow = Window & { __TNC_TEST__?: CreekVisualizationTestSeam };

let attachment: CreekVisualizationAttachment | null = null;

const ready = startExperience();
installTestSeam(ready);

async function startExperience(): Promise<boolean> {
  try {
    const container = document.getElementById('arcgis-view');
    const playButton = document.getElementById('timeline-play-btn');
    const slider = document.getElementById('timeline-slider');
    const timeReadout = document.getElementById('timeline-readout');
    const status = document.getElementById('timeline-status');
    if (!(container instanceof HTMLDivElement)) throw new Error('The map view is missing.');
    if (!(playButton instanceof HTMLButtonElement)) throw new Error('The play button is missing.');
    if (!(slider instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    if (!(timeReadout instanceof HTMLElement) || !(status instanceof HTMLElement)) {
      throw new Error('The time readout is missing.');
    }

    const data = await loadPublishedCreekVisualizationData();
    const segment = data.segmentsById.get(data.station.segmentId);
    if (!segment) throw new Error('The gauge segment is missing from the creek network.');

    const shell = await createStandaloneExperienceShell(container, segment.pathWgs84);
    setSceneNote(shell.basemapMode, shell.elevationSource);
    attachment = attachCreekVisualization(shell.view, {
      data,
      playButton,
      slider,
      timeReadout,
      status,
    });
    await attachment.flush();
    hideLoadingOverlay();
    return true;
  } catch (error: unknown) {
    console.error(error);
    showExperienceError(error instanceof Error ? error.message : 'The scene could not be started.');
    return false;
  }
}

function installTestSeam(readyPromise: Promise<boolean>): void {
  const seam: CreekVisualizationTestSeam = {
    ready: readyPromise,
    get selectedTimeUtcMs() {
      return attachment?.selectedTimeUtcMs ?? null;
    },
    get waterSegmentIds() {
      return attachment?.waterSegmentIds ?? [];
    },
    get waterGraphicGeometryIdentity() {
      return attachment?.waterGraphicGeometryIdentity ?? [];
    },
  };
  Object.defineProperty(window as TestModeWindow, '__TNC_TEST__', {
    configurable: true,
    value: seam,
  });
}

function setSceneNote(basemapMode: BasemapMode, elevationSource: ElevationSource): void {
  const note = document.getElementById('scene-note');
  if (!note) return;
  if (basemapMode === 'arcgis-imagery') {
    note.textContent = 'Esri imagery and world elevation.';
    return;
  }
  if (elevationSource === 'usgs-3dep') {
    note.textContent = 'USGS imagery and USGS 3DEP terrain.';
    return;
  }
  note.textContent = 'USGS imagery. Terrain elevation was unavailable, so the ground is flat.';
}

function showExperienceError(message: string): void {
  const error = document.getElementById('experience-error');
  if (error) {
    error.textContent = message;
    error.classList.remove('hidden');
  }
  hideLoadingOverlay();
}

function hideLoadingOverlay(): void {
  document.getElementById('loading-overlay')?.remove();
}
