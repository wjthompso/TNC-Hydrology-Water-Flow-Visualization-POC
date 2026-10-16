import '@arcgis/core/assets/esri/themes/dark/main.css';
import './style.css';
import Camera from '@arcgis/core/Camera';
import Point from '@arcgis/core/geometry/Point';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import type SceneView from '@arcgis/core/views/SceneView';
import {
  attachCreekVisualization,
  type CreekVisualizationAttachment,
} from './creek-visualization-library-interface';
import type { WaterGraphicGeometryIdentity } from './arcgis-scene-renderer';
import type { HitTestCapture, HitTestCaptureHit } from './dev-tools-capture-schema';
import { loadPublishedCreekVisualizationData } from './http-data-contract-loader';
import {
  DATASET_PICKER_OPTIONS,
  OBSERVED_DATASET_OPTION_ID,
  datasetPageUrl,
  readDatasetSelection,
} from './modeled-water-catalog';
import { readPlaybackSpeedButtons } from './observation-timeline-controls';
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
  /**
   * Runs `SceneView.hitTest` at a screen point and returns a frozen snapshot
   * of the camera pose, ground hit, and every reported graphic. Available in
   * all environments so the dev HUD and future replay tests share one path.
   */
  hitTestAtScreen(screen: { x: number; y: number }): Promise<HitTestCapture>;
  /**
   * Projects a WGS84 ground point to a screen pixel. Returns null when the
   * point is off-screen. Available in all environments so viewport-independent
   * hit-testing fixtures do not require test mode.
   */
  projectMapPointToScreen(mapPoint: {
    longitude: number;
    latitude: number;
    z?: number | null;
  }): { x: number; y: number } | null;
  /**
   * Test-only pin that forces a specific water-surface elevation on one Creek
   * Segment. Setting `elevationM` to `null` clears the pin. Present only when
   * the page is served in test mode. Awaits a renderer flush so the frame
   * reflects the pin before resolving.
   */
  pinSegmentWaterSurfaceElevationM?(segmentId: string, elevationM: number | null): Promise<void>;
  /**
   * Frozen view of the current segment identity list the renderer last applied.
   * Mirrors `waterGraphicGeometryIdentity` and is kept so dev tooling can
   * capture placements with a short, replay-friendly name.
   */
  readonly segmentPlacements: readonly {
    segmentId: string;
    bucketMinElevationM: number | null;
  }[];
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

    const selection = readDatasetSelection(location.search);
    bindDatasetPicker(selection.kind === 'modeled' ? selection.datasetId : OBSERVED_DATASET_OPTION_ID);

    if (selection.kind === 'modeled') {
      // Modeled water (UCS-271). The observed path below stays unchanged.
      setLoadingOverlayText('Loading modeled water…');
      const { startModeledCreekExperience } = await import('./modeled-creek-experience');
      const started = await startModeledCreekExperience(selection, {
        container,
        playButton,
        slider,
        timeReadout,
        status,
        speedButtons: readPlaybackSpeedButtons(),
        ...readModeledPanelElements(),
      });
      sceneView = started.view;
      attachment = started.attachment;
      setSceneNote();
      hideLoadingOverlay();
      await installDevToolsIfRequested();
      return true;
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
      speedButtons: readPlaybackSpeedButtons(),
    });
    await attachment.flush();
    hideLoadingOverlay();
    await installDevToolsIfRequested();
    return true;
  } catch (error: unknown) {
    console.error(error);
    showExperienceError(error instanceof Error ? error.message : 'The scene could not be started.');
    return false;
  }
}

/**
 * `?devtools` mounts the HUD open in every build. A development server also
 * gets a corner toggle button so the HUD is always one click away; Vite drops
 * that branch, and the toggle module, from production builds.
 */
async function installDevToolsIfRequested(): Promise<void> {
  if (!sceneView || !attachment) return;
  const requested = new URLSearchParams(location.search).has('devtools');
  if (import.meta.env.DEV) {
    const { installDevToolsToggle } = await import('./dev-tools-toggle');
    installDevToolsToggle({ view: sceneView, attachment, container: document.body, openOnLoad: requested });
    return;
  }
  if (!requested) return;
  const { installDevToolsHud } = await import('./dev-tools-hud');
  installDevToolsHud({ view: sceneView, attachment, container: document.body });
}

/** Fills the Dataset picker and reloads the page on a change. */
function bindDatasetPicker(selectedOptionId: string): void {
  const picker = document.getElementById('dataset-picker');
  if (!(picker instanceof HTMLSelectElement)) return;
  picker.replaceChildren(
    ...DATASET_PICKER_OPTIONS.map((option) => {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.label;
      node.selected = option.id === selectedOptionId;
      return node;
    }),
  );
  picker.addEventListener('change', () => {
    location.assign(datasetPageUrl(picker.value, location));
  });
}

function readModeledPanelElements(): {
  modeledPanel: HTMLElement;
  transferToggle: HTMLInputElement;
  transferToggleLabel: HTMLElement;
  datasetInfo: HTMLElement;
  title: HTMLElement | null;
  subtitle: HTMLElement | null;
  legendLabel: HTMLElement | null;
  legendTransferRow: HTMLElement | null;
  legendTransferLabel: HTMLElement | null;
} {
  const modeledPanel = document.getElementById('modeled-panel');
  const transferToggle = document.getElementById('transfer-water-toggle');
  const transferToggleLabel = document.getElementById('transfer-water-toggle-label');
  const datasetInfo = document.getElementById('modeled-dataset-info');
  if (
    !(modeledPanel instanceof HTMLElement) ||
    !(transferToggle instanceof HTMLInputElement) ||
    !(transferToggleLabel instanceof HTMLElement) ||
    !(datasetInfo instanceof HTMLElement)
  ) {
    throw new Error('The modeled water panel is missing.');
  }
  return {
    modeledPanel,
    transferToggle,
    transferToggleLabel,
    datasetInfo,
    title: document.getElementById('experience-title'),
    subtitle: document.getElementById('experience-subtitle'),
    legendLabel: document.getElementById('legend-water-label'),
    legendTransferRow: document.getElementById('legend-transfer-row'),
    legendTransferLabel: document.getElementById('legend-transfer-label'),
  };
}

function setLoadingOverlayText(text: string): void {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.textContent = text;
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
    async hitTestAtScreen(screen) {
      if (!sceneView) throw new Error('The scene view is not ready.');
      return captureHitTestAtScreen(sceneView, screen);
    },
    projectMapPointToScreen(mapPoint) {
      return projectMapPointToScreen(sceneView, mapPoint);
    },
    get segmentPlacements() {
      return attachment?.waterGraphicGeometryIdentity ?? [];
    },
    ...(import.meta.env.VITE_TEST_MODE === 'true'
      ? {
          async moveCamera(pose: CameraPose) {
            if (!sceneView) throw new Error('The scene view is not ready.');
            await moveCamera(sceneView, pose);
          },
          async pinSegmentWaterSurfaceElevationM(
            segmentId: string,
            elevationM: number | null,
          ) {
            if (!attachment) throw new Error('The scene view is not ready.');
            await attachment.pinSegmentWaterSurfaceElevationM(segmentId, elevationM);
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
 * One-shot capture of the camera pose, ground hit, and every reported graphic
 * at a screen point. Shared by the dev HUD and future replay tests through
 * `__TNC_TEST__.hitTestAtScreen`.
 */
async function captureHitTestAtScreen(
  view: SceneView,
  screen: { x: number; y: number },
): Promise<HitTestCapture> {
  const screenPoint = { x: screen.x, y: screen.y };
  const cameraPose = readCameraPose(view);
  // Camera pose is reported after the view is ready; if it is missing we fall
  // back to zeros so the capture still has a complete shape.
  const pose: HitTestCapture['cameraPose'] = cameraPose
    ? {
        positionWgs84: [...cameraPose.positionWgs84] as [number, number, number],
        headingDegrees: cameraPose.headingDegrees,
        tiltDegrees: cameraPose.tiltDegrees,
      }
    : { positionWgs84: [0, 0, 0], headingDegrees: 0, tiltDegrees: 0 };

  let mapHitWgs84: HitTestCapture['mapHitWgs84'];
  try {
    const mapHit = view.toMap(screenPoint);
    mapHitWgs84 = pointToWgs84(mapHit ?? null);
  } catch {
    mapHitWgs84 = null;
  }

  let hits: HitTestCaptureHit[];
  try {
    const result = await view.hitTest(screenPoint);
    hits = result.results.map(readHit);
  } catch {
    hits = [];
  }

  const capture: HitTestCapture = {
    screenPoint,
    cameraPose: pose,
    mapHitWgs84,
    hits,
  };
  return capture;
}

function readHit(
  hit:
    | __esri.GraphicHit
    | __esri.MediaHit
    | __esri.RouteHit,
): HitTestCaptureHit {
  const layerId =
    hit.type === 'graphic' || hit.type === 'media' || hit.type === 'route'
      ? hit.layer?.id ?? null
      : null;
  const mapPoint = 'mapPoint' in hit ? pointToWgs84(hit.mapPoint ?? null) : null;
  const distanceM =
    'distance' in hit && typeof hit.distance === 'number' && Number.isFinite(hit.distance)
      ? hit.distance
      : null;
  if (hit.type === 'graphic' && layerId === 'water-surface-elevation-polygons') {
    const attributes = (hit.graphic?.attributes ?? null) as
      | {
          segmentId?: unknown;
          bucketMinElevationM?: unknown;
          bucketMaxElevationM?: unknown;
        }
      | null;
    return {
      layerId,
      graphicType: 'water-surface',
      segmentId: typeof attributes?.segmentId === 'string' ? attributes.segmentId : null,
      bucketMinElevationM: readFiniteOrNull(attributes?.bucketMinElevationM),
      bucketMaxElevationM: readFiniteOrNull(attributes?.bucketMaxElevationM),
      mapPointWgs84: mapPoint,
      distanceM,
    };
  }
  return {
    layerId,
    graphicType: 'other',
    segmentId: null,
    bucketMinElevationM: null,
    bucketMaxElevationM: null,
    mapPointWgs84: mapPoint,
    distanceM,
  };
}

/**
 * Projects a WGS84 longitude/latitude (optionally with a z) to a screen pixel.
 * Returns null when the SceneView is not ready, when `toScreen` returns null,
 * or when the resulting pixel lies outside the view's viewport.
 */
function projectMapPointToScreen(
  view: SceneView | null,
  mapPoint: { longitude: number; latitude: number; z?: number | null },
): { x: number; y: number } | null {
  if (!view) return null;
  const { longitude, latitude } = mapPoint;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const z = typeof mapPoint.z === 'number' && Number.isFinite(mapPoint.z) ? mapPoint.z : undefined;
  const point = new Point({
    longitude,
    latitude,
    ...(z !== undefined ? { z, hasZ: true } : {}),
    spatialReference: { wkid: 4326 },
  });
  let screen: __esri.ScreenPoint | null;
  try {
    screen = view.toScreen(point);
  } catch {
    return null;
  }
  if (!screen) return null;
  const { x, y } = screen;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { width, height } = view;
  if (typeof width === 'number' && typeof height === 'number') {
    if (x < 0 || y < 0 || x > width || y > height) return null;
  }
  return { x, y };
}

function pointToWgs84(point: Point | null): HitTestCapture['mapHitWgs84'] {
  if (!point) return null;
  const geographic = geographicPoint(point);
  if (!geographic) return null;
  const { longitude, latitude } = geographic;
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const z = typeof geographic.z === 'number' && Number.isFinite(geographic.z) ? geographic.z : null;
  return { longitude, latitude, z };
}

function readFiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  // Avoid a number-plus-unit like "1 m" here: FBT-005 forbids any water-quantity
  // string on the page, and "1 m" would trip that guard.
  note.textContent =
    'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community. Terrain: USGS 3DEP, with Esri World Elevation beyond the creek.';
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
