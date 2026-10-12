import '@arcgis/core/assets/esri/themes/dark/main.css';
import './style.css';
import type Point from '@arcgis/core/geometry/Point';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import type SceneView from '@arcgis/core/views/SceneView';
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
  /** SceneView center in WGS84. Read-only; nothing is added to the page. */
  readonly cameraTargetWgs84: readonly [number, number] | null;
}

type TestModeWindow = Window & { __TNC_TEST__?: CreekVisualizationTestSeam };

let attachment: CreekVisualizationAttachment | null = null;
let sceneView: SceneView | null = null;

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
    sceneView = shell.view;
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
    get cameraTargetWgs84() {
      return readCameraTargetWgs84(sceneView);
    },
  };
  Object.defineProperty(window as TestModeWindow, '__TNC_TEST__', {
    configurable: true,
    value: seam,
  });
}

/** View center, converted to longitude/latitude. This is the camera's framed target. */
function readCameraTargetWgs84(view: SceneView | null): [number, number] | null {
  const center = view?.center;
  if (!center) return null;
  const geographic = geographicPoint(center);
  if (!geographic) return null;
  const { longitude, latitude } = geographic;
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return [longitude, latitude];
}

function geographicPoint(point: Point): Point | null {
  const wkid = point.spatialReference?.wkid;
  if (wkid === 4326 || wkid === 4269 || (Math.abs(point.x) <= 180 && Math.abs(point.y) <= 90)) {
    return point;
  }
  const geographic = webMercatorUtils.webMercatorToGeographic(point);
  if (!geographic || geographic.type !== 'point') return null;
  return geographic as Point;
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
