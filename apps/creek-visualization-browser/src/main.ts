import '@arcgis/core/assets/esri/themes/dark/main.css';
import './style.css';
import Camera from '@arcgis/core/Camera';
import type Point from '@arcgis/core/geometry/Point';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import type SceneView from '@arcgis/core/views/SceneView';
import {
  attachCreekVisualization,
  type CreekVisualizationAttachment,
} from './creek-visualization-library-interface';
import type { WaterGraphicGeometryIdentity } from './arcgis-scene-renderer';
import { loadPublishedCreekVisualizationData } from './http-data-contract-loader';
import { createStandaloneExperienceShell } from './standalone-experience-shell';

interface CreekVisualizationTestSeam {
  ready: Promise<boolean>;
  readonly selectedTimeUtcMs: number | null;
  readonly waterSegmentIds: readonly string[];
  readonly waterGraphicGeometryIdentity: readonly WaterGraphicGeometryIdentity[];
  /** SceneView center in WGS84. Read-only; nothing is added to the page. */
  readonly cameraTargetWgs84: readonly [number, number] | null;
  /** True while SceneView is drawing or loading. Read-only. */
  readonly sceneUpdating: boolean;
  /** True when no camera animation or user navigation is in progress. Read-only. */
  readonly sceneStationary: boolean;
  /** Camera position height in meters. Read-only; null before the view exists. */
  readonly cameraAltitudeM: number | null;
  /** Camera position, heading, and tilt. Read-only; null before the view exists. */
  readonly cameraPose: CameraPose | null;
  /**
   * Moves the camera instantly, the same way the opening frame is set.
   * Present only when the page is served in test mode.
   */
  moveCamera?(pose: CameraPose): Promise<void>;
  /**
   * Elevations of the terrain mesh actually drawn in the SceneView.
   * Read-only; nothing is added to the page.
   */
  sampleRenderedGroundHeights(
    screenPoints: readonly { readonly x: number; readonly y: number }[],
  ): readonly RenderedGroundHeight[];
}

interface RenderedGroundHeight {
  readonly x: number;
  readonly y: number;
  /** Meters from the drawn ground hit. Null when the screen ray misses that mesh. */
  readonly elevationM: number | null;
  readonly longitude: number | null;
  readonly latitude: number | null;
}

interface CameraPose {
  /** Longitude, latitude, and height in meters. */
  readonly positionWgs84: readonly [number, number, number];
  readonly headingDegrees: number;
  readonly tiltDegrees: number;
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

    sceneView = await createStandaloneExperienceShell(container, segment.pathWgs84);
    setSceneNote();
    attachment = attachCreekVisualization(sceneView, {
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
    get sceneUpdating() {
      return sceneView?.updating ?? true;
    },
    get sceneStationary() {
      return sceneView?.stationary ?? false;
    },
    get cameraAltitudeM() {
      const altitudeM = sceneView?.camera?.position?.z;
      return typeof altitudeM === 'number' && Number.isFinite(altitudeM) ? altitudeM : null;
    },
    get cameraPose() {
      return readCameraPose(sceneView);
    },
    sampleRenderedGroundHeights(screenPoints) {
      return readRenderedGroundHeights(sceneView, screenPoints);
    },
    ...(import.meta.env.VITE_TEST_MODE === 'true'
      ? {
          async moveCamera(pose: CameraPose) {
            if (!sceneView) throw new Error('The scene view is not ready.');
            await moveCamera(sceneView, pose);
          },
        }
      : {}),
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

function readCameraPose(view: SceneView | null): CameraPose | null {
  const camera = view?.camera;
  const position = camera?.position ? geographicPoint(camera.position) : null;
  if (!camera || !position) return null;
  const { longitude, latitude } = position;
  const z = camera.position.z;
  if (typeof longitude !== 'number' || typeof latitude !== 'number' || typeof z !== 'number') {
    return null;
  }
  return {
    positionWgs84: [longitude, latitude, z],
    headingDegrees: camera.heading,
    tiltDegrees: camera.tilt,
  };
}

async function moveCamera(view: SceneView, pose: CameraPose): Promise<void> {
  const [longitude, latitude, z] = pose.positionWgs84;
  await view.goTo(
    new Camera({
      position: { longitude, latitude, z, spatialReference: { wkid: 4326 } },
      heading: pose.headingDegrees,
      tilt: pose.tiltDegrees,
    }),
    { duration: 0 },
  );
}

/**
 * Screen rays against the drawn ground mesh (`SceneView.toMap`), not `ground.queryElevation`.
 * `toMap` hits the terrain surface the view is rendering.
 */
function readRenderedGroundHeights(
  view: SceneView | null,
  screenPoints: readonly { readonly x: number; readonly y: number }[],
): readonly RenderedGroundHeight[] {
  const ground = view?.map?.ground;
  return screenPoints.map((screenPoint) => {
    const missed: RenderedGroundHeight = {
      x: screenPoint.x,
      y: screenPoint.y,
      elevationM: null,
      longitude: null,
      latitude: null,
    };
    if (!view) return missed;
    let hit: Point | null | undefined;
    try {
      hit = ground ? view.toMap(screenPoint, { include: ground }) : view.toMap(screenPoint);
    } catch {
      return missed;
    }
    if (!hit) return missed;
    const elevationM = typeof hit.z === 'number' && Number.isFinite(hit.z) ? hit.z : null;
    const geographic = geographicPoint(hit);
    const longitude = finiteCoordinate(geographic?.longitude);
    const latitude = finiteCoordinate(geographic?.latitude);
    return { x: screenPoint.x, y: screenPoint.y, elevationM, longitude, latitude };
  });
}

function finiteCoordinate(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function setSceneNote(): void {
  const note = document.getElementById('scene-note');
  if (!note) return;
  note.textContent =
    'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community. Terrain: Esri World Elevation.';
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
