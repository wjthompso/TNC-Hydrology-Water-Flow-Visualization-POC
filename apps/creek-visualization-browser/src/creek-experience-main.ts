import '@arcgis/core/assets/esri/themes/dark/main.css';
import { whenOnce } from '@arcgis/core/core/reactiveUtils';
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
import { resolveShowDevTools } from './dev-tools-visibility';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';
import { loadPublishedCreekVisualizationData } from './http-data-contract-loader';
import {
  availableDatasetPickerOptions,
  OBSERVED_DATASET_OPTION_ID,
  CAMERA_QUERY_PARAM,
  SEGMENT_QUERY_PARAM,
  datasetPageUrl,
  readCameraQuery,
  readDatasetSelection,
  readOpeningTimeQuery,
  type DatasetSelection,
} from './modeled-water-catalog';
import { creekDataSourceConfiguration } from './creek-data-source-configuration';
import { showModeledDatasetAccuracyNotice } from './modeled-dataset-accuracy-notices';
import { waitAtMost } from './bounded-startup-wait';
import { bindDatasetAboutDialog, fillObservedGaugeAbout } from './dataset-about-dialog';
import { bindSceneImageryWidget } from './scene-imagery-widget';
import { showLoadingMessage } from './loading-spinner';
import { installMonitoringStationLocator } from './monitoring-station-locator';
import { addMonitoringStationMarkers } from './monitoring-station-marker-layer';
import { readPlaybackSpeedButtons, readTimeRangeControls } from './observation-timeline-controls';
import { createStandaloneExperienceShell } from './standalone-experience-shell';
import type { WaterSurfaceElevationChartState } from './water-surface-elevation-chart';

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
  /** The Selected Creek Segment, or null. Read-only. */
  readonly selectedCreekSegmentId: string | null;
  /** Creek Segments whose drawn water carries the selection highlight. Read-only. */
  readonly highlightedSegmentIds: readonly string[];
  /** Water-Surface Elevation Chart state; null when the page has no chart. Read-only. */
  readonly waterSurfaceElevationChart: WaterSurfaceElevationChartState | null;
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
/** Ends everything the open Dataset's experience attached to the scene. The SceneView stays. */
let lifetime: ExperienceLifetime | null = null;
let experienceElements: ExperienceElements | null = null;
let observedChrome: ObservedChrome | null = null;
let switchingDataset = false;

interface ExperienceElements {
  container: HTMLDivElement;
  playButton: HTMLButtonElement;
  slider: HTMLInputElement;
  timeReadout: HTMLElement;
  status: HTMLElement;
}

/** Page text the observed experience owns; the modeled experience overwrites it and a switch back restores it. */
interface ObservedChrome {
  documentTitle: string;
  title: string | null;
  subtitle: string | null;
  legendLabel: string | null;
}

const ready = startExperience();
installTestSeam(ready);

async function startExperience(): Promise<boolean> {
  try {
    experienceElements = readExperienceElements();
    observedChrome = readObservedChrome();
    const selection = readDatasetSelection(location.search);
    bindDatasetPicker(selection.kind === 'modeled' ? selection.datasetId : OBSERVED_DATASET_OPTION_ID);
    await openExperience(selection, experienceElements, { carriedSegmentId: null, initial: true });
    return true;
  } catch (error: unknown) {
    console.error(error);
    showExperienceError(error instanceof Error ? error.message : 'The scene could not be started.');
    return false;
  }
}

function readExperienceElements(): ExperienceElements {
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
  return { container, playButton, slider, timeReadout, status };
}

/**
 * Opens one Dataset's experience on the page. The first call creates the
 * SceneView; every later call reuses it, so the imagery, terrain, and camera
 * stay while only the creek water, controls, and chart change.
 */
async function openExperience(
  selection: DatasetSelection,
  elements: ExperienceElements,
  options: { carriedSegmentId: string | null; initial: boolean },
): Promise<void> {
  const experienceLifetime = createExperienceLifetime();
  lifetime = experienceLifetime;
  try {
    if (selection.kind === 'modeled') await openModeledExperience(selection, elements, experienceLifetime);
    else await openObservedExperience(elements, experienceLifetime, options.carriedSegmentId);
  } catch (error: unknown) {
    experienceLifetime.end();
    lifetime = null;
    attachment = null;
    throw error;
  }
  if (!sceneView) throw new Error('The scene view is missing.');
  if (options.carriedSegmentId && selection.kind === 'modeled') {
    attachment?.selectedCreekSegmentChart?.selectSegment(options.carriedSegmentId);
  }
  if (options.initial) {
    await restoreCarriedCamera(sceneView);
    void hideLoadingOverlayWhenSceneDrawn(sceneView);
  }
  await installDevToolsIfRequested(experienceLifetime);
  if (selection.kind === 'modeled') openAccuracyNoticeUnlessTestMode(selection.datasetId);
}

async function openModeledExperience(
  selection: Extract<DatasetSelection, { kind: 'modeled' }>,
  elements: ExperienceElements,
  experienceLifetime: ExperienceLifetime,
): Promise<void> {
  // Modeled water (UCS-271). The observed path stays separate.
  setLoadingOverlayText(
    creekDataSourceConfiguration.dataSource === 'hosted'
      ? 'Loading modeled water from the Dangermond Preserve ArcGIS portal… (sign in if asked)'
      : 'Loading modeled water…',
  );
  const { startModeledCreekExperience } = await import('./modeled-creek-experience');
  const started = await startModeledCreekExperience(
    selection,
    {
      ...elements,
      speedButtons: readPlaybackSpeedButtons(),
      timeRangeControls: readTimeRangeControls(),
      ...readModeledPanelElements(),
    },
    { view: sceneView ?? undefined, lifetime: experienceLifetime },
  );
  const firstScene = sceneView === null;
  sceneView = started.view;
  attachment = started.attachment;
  if (firstScene) bindImageryWidget(sceneView);
}

async function openObservedExperience(
  elements: ExperienceElements,
  experienceLifetime: ExperienceLifetime,
  carriedSegmentId: string | null,
): Promise<void> {
  restoreObservedChrome();
  const data = await loadPublishedCreekVisualizationData();
  showInferredWaterLegend(data.propagation?.hopsPerDirection ?? 0);
  experienceLifetime.onEnd(hideInferredWaterLegend);
  const segment = data.segmentsById.get(data.station.segmentId);
  if (!segment) throw new Error('The gauge segment is missing from the creek network.');

  if (!sceneView) {
    sceneView = await createStandaloneExperienceShell(elements.container, segment.pathWgs84);
    bindImageryWidget(sceneView);
  }
  bindDatasetAboutDialog('About the observed gauge data', fillObservedGaugeAbout);
  attachment = attachCreekVisualization(sceneView, {
    data,
    playButton: elements.playButton,
    slider: elements.slider,
    timeReadout: elements.timeReadout,
    status: elements.status,
    speedButtons: readPlaybackSpeedButtons(),
    timeRangeControls: readTimeRangeControls(),
    openingTimeUtcMs: readOpeningTimeQuery(location.search),
    // The gauge's creek segment opens selected, so the chart is visible before anyone discovers clicking.
    initialSelectedSegmentId: carriedSegmentId ?? data.station.segmentId,
    lifetime: experienceLifetime,
  });
  await attachment.flush();
  // UCS-261: a stream gauge mast where the Jalama Near Lompoc gauge is installed.
  const markers = await addMonitoringStationMarkers(sceneView, [data.station], data.segmentsById, experienceLifetime);
  await installMonitoringStationLocator(sceneView, markers.stations, experienceLifetime);
}

function readObservedChrome(): ObservedChrome {
  return {
    documentTitle: document.title,
    title: document.getElementById('experience-title')?.textContent ?? null,
    subtitle: document.getElementById('experience-subtitle')?.textContent ?? null,
    legendLabel: document.getElementById('legend-water-label')?.textContent ?? null,
  };
}

/** Undoes what the modeled experience wrote over the observed page text and panels. */
function restoreObservedChrome(): void {
  if (!observedChrome) return;
  document.title = observedChrome.documentTitle;
  const text: readonly [string, string | null][] = [
    ['experience-title', observedChrome.title],
    ['experience-subtitle', observedChrome.subtitle],
    ['legend-water-label', observedChrome.legendLabel],
  ];
  for (const [id, value] of text) {
    const element = document.getElementById(id);
    if (element && value !== null) element.textContent = value;
  }
  document.getElementById('modeled-panel')?.classList.add('hidden');
  const transferRow = document.getElementById('legend-transfer-row');
  transferRow?.classList.add('hidden');
  transferRow?.classList.remove('flex');
}

/**
 * Creek Segment Observed WSE Propagation (UCS-300): names the teal water in the legend as inferred,
 * never as measured. Hidden when the data propagates nothing.
 */
function hideInferredWaterLegend(): void {
  const row = document.getElementById('legend-inferred-row');
  row?.classList.add('hidden');
  row?.classList.remove('flex');
}

function showInferredWaterLegend(hopsPerDirection: number): void {
  const row = document.getElementById('legend-inferred-row');
  const label = document.getElementById('legend-inferred-label');
  if (!row || !label || hopsPerDirection < 1) return;
  label.textContent = `Inferred water on up to ${hopsPerDirection} creek segments each way. Estimated from the gauge's water depth, not measured.`;
  row.classList.remove('hidden');
  row.classList.add('flex');
}

/**
 * Opens the modeled Dataset's accuracy notice (UCS-285), returning focus to the
 * Dataset picker. Not awaited, so the experience is ready while the notice is
 * open. Test mode skips it: an open modal would block the map clicks of live
 * browser tests.
 */
function openAccuracyNoticeUnlessTestMode(datasetId: string): void {
  if (import.meta.env.VITE_TEST_MODE === 'true') return;
  const picker = document.getElementById('dataset-picker');
  if (!(picker instanceof HTMLElement)) return;
  void showModeledDatasetAccuracyNotice(datasetId, picker);
}

/**
 * Dev tools button and `?devtools` hatch. On for the development server unless
 * `VITE_SHOW_DEV_TOOLS` says otherwise. A production build leaves both out
 * unless that variable is true, so a shared Digital Twin link cannot open the HUD.
 */
const devToolsEnabled = resolveShowDevTools({
  DEV: import.meta.env.DEV,
  VITE_SHOW_DEV_TOOLS: import.meta.env.VITE_SHOW_DEV_TOOLS,
});

/**
 * Mounts the corner button when dev tools are enabled, and opens the HUD
 * immediately when the URL has `?devtools`. The toggle module loads only in
 * that case.
 */
async function installDevToolsIfRequested(experienceLifetime: ExperienceLifetime): Promise<void> {
  if (!sceneView || !attachment || !devToolsEnabled) return;
  const view = sceneView;
  const open = attachment;
  const requested = new URLSearchParams(location.search).has('devtools');
  const { installDevToolsToggle } = await import('./dev-tools-toggle');
  if (experienceLifetime.signal.aborted) return;
  installDevToolsToggle({
    view,
    attachment: open,
    container: document.body,
    openOnLoad: requested,
    lifetime: experienceLifetime,
  });
}

/**
 * Puts the camera back where it was before a Dataset switch (`?camera=`), then
 * drops the parameter so a plain reload frames the gauge segment again.
 */
async function restoreCarriedCamera(view: SceneView): Promise<void> {
  const pose = readCameraQuery(location.search);
  const segmentId = new URLSearchParams(location.search).get(SEGMENT_QUERY_PARAM);
  if (pose) await moveCamera(view, pose);
  if (segmentId) attachment?.selectedCreekSegmentChart?.selectSegment(segmentId);
  if (!pose && !segmentId) return;
  const url = new URL(location.href);
  url.searchParams.delete(CAMERA_QUERY_PARAM);
  url.searchParams.delete(SEGMENT_QUERY_PARAM);
  history.replaceState(history.state, '', url);
}

/**
 * Fills the Dataset picker. A change swaps the creek water on the open scene
 * at the same selected time, camera, and selected Creek Segment, so the switch
 * keeps your place and the imagery and terrain are not drawn again.
 */
function bindDatasetPicker(selectedOptionId: string): void {
  const picker = document.getElementById('dataset-picker');
  if (!(picker instanceof HTMLSelectElement)) return;
  picker.replaceChildren(
    ...availableDatasetPickerOptions().map((option) => {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.label;
      node.selected = option.id === selectedOptionId;
      return node;
    }),
  );
  let shownOptionId = selectedOptionId;
  picker.addEventListener('change', () => {
    if (switchingDataset || picker.value === shownOptionId) return;
    void switchDataset(picker, shownOptionId).then((openedOptionId) => {
      shownOptionId = openedOptionId;
      picker.value = openedOptionId;
    });
  });
}

/**
 * Takes the open Dataset's water, controls, and chart off the scene and puts
 * the picked Dataset's on, keeping the SceneView. Returns the picker option now
 * open: the new one, or the old one when the switch failed.
 */
async function switchDataset(picker: HTMLSelectElement, previousOptionId: string): Promise<string> {
  const elements = experienceElements;
  if (!elements) return previousOptionId;
  switchingDataset = true;
  picker.disabled = true;
  const carriedSegmentId = attachment?.selectedCreekSegmentChart?.selection.selectedSegmentId ?? null;
  const nextUrl = datasetPageUrl(picker.value, location, {
    selectedTimeUtcMs: attachment?.selectedTimeUtcMs ?? null,
    cameraPose: null,
    selectedCreekSegmentId: null,
  });
  try {
    lifetime?.end();
    lifetime = null;
    attachment = null;
    showLoadingMessage(elements.status, 'Switching Dataset…');
    history.replaceState(history.state, '', nextUrl);
    await openExperience(readDatasetSelection(location.search), elements, { carriedSegmentId, initial: false });
    return picker.value;
  } catch (error: unknown) {
    console.error(error);
    showExperienceError(error instanceof Error ? error.message : 'The Dataset could not be opened.');
    return previousOptionId;
  } finally {
    picker.disabled = false;
    switchingDataset = false;
  }
}

function readModeledPanelElements(): {
  modeledPanel: HTMLElement;
  transferToggle: HTMLInputElement;
  transferToggleLabel: HTMLElement;
  centerlineToggle: HTMLInputElement;
  centerlineToggleLabel: HTMLElement;
  title: HTMLElement | null;
  subtitle: HTMLElement | null;
  legendLabel: HTMLElement | null;
  legendTransferRow: HTMLElement | null;
  legendTransferLabel: HTMLElement | null;
} {
  const modeledPanel = document.getElementById('modeled-panel');
  const transferToggle = document.getElementById('transfer-water-toggle');
  const transferToggleLabel = document.getElementById('transfer-water-toggle-label');
  const centerlineToggle = document.getElementById('centerline-toggle');
  const centerlineToggleLabel = document.getElementById('centerline-toggle-label');
  if (
    !(modeledPanel instanceof HTMLElement) ||
    !(transferToggle instanceof HTMLInputElement) ||
    !(transferToggleLabel instanceof HTMLElement) ||
    !(centerlineToggle instanceof HTMLInputElement) ||
    !(centerlineToggleLabel instanceof HTMLElement)
  ) {
    throw new Error('The modeled water panel is missing.');
  }
  return {
    modeledPanel,
    transferToggle,
    transferToggleLabel,
    centerlineToggle,
    centerlineToggleLabel,
    title: document.getElementById('experience-title'),
    subtitle: document.getElementById('experience-subtitle'),
    legendLabel: document.getElementById('legend-water-label'),
    legendTransferRow: document.getElementById('legend-transfer-row'),
    legendTransferLabel: document.getElementById('legend-transfer-label'),
  };
}

function setLoadingOverlayText(text: string): void {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) showLoadingMessage(overlay, text);
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
    get selectedCreekSegmentId() {
      return attachment?.selectedCreekSegmentChart?.selection.selectedSegmentId ?? null;
    },
    get highlightedSegmentIds() {
      return attachment?.selectedCreekSegmentChart?.selection.highlightedSegmentIds ?? [];
    },
    get waterSurfaceElevationChart() {
      return attachment?.selectedCreekSegmentChart?.chart ?? null;
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
          waterSurfaceElevationM?: unknown;
          bucketMinDepthM?: unknown;
          bucketMaxDepthM?: unknown;
        }
      | null;
    const segmentId = typeof attributes?.segmentId === 'string' ? attributes.segmentId : null;
    const bucketMinDepthM = readFiniteOrNull(attributes?.bucketMinDepthM);
    if (bucketMinDepthM !== null) {
      // `bed-parallel-depth` water: its buckets are depths, so the elevation reported is the modeled WSE.
      const waterSurfaceElevationM = readFiniteOrNull(attributes?.waterSurfaceElevationM);
      return {
        layerId,
        graphicType: 'water-surface',
        segmentId,
        bucketMinElevationM: waterSurfaceElevationM,
        bucketMaxElevationM: null,
        waterSurfaceElevationM,
        bucketMinDepthM,
        bucketMaxDepthM: readFiniteOrNull(attributes?.bucketMaxDepthM),
        mapPointWgs84: mapPoint,
        distanceM,
      };
    }
    return {
      layerId,
      graphicType: 'water-surface',
      segmentId,
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

/** With Dev tools enabled, the imagery widget sits under that button. Otherwise it keeps the corner. */
function bindImageryWidget(view: SceneView): void {
  bindSceneImageryWidget(view, { belowDevTools: devToolsEnabled });
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

/** Longest the overlay waits for the first scene draw; a stalled terrain service must not trap it. */
const FIRST_SCENE_DRAW_WAIT_LIMIT_MS = 20_000;
const LOADING_OVERLAY_FADE_MS = 500;

/**
 * Keeps the loading overlay over the 3D scene until SceneView has drawn its
 * first still frame (no layer or terrain updating, camera stationary), then
 * fades it out. Data loading finishes well before terrain and imagery tiles
 * stream in, so removing the overlay earlier shows a blank or half-drawn globe.
 * Not awaited by startup: the test seam's `ready` promise keeps its timing, and
 * test mode removes the overlay without a fade so pixel reads never see it.
 */
async function hideLoadingOverlayWhenSceneDrawn(view: SceneView): Promise<void> {
  setLoadingOverlayText('Drawing terrain and imagery…');
  try {
    await waitAtMost(
      whenOnce(() => !view.updating && view.stationary),
      FIRST_SCENE_DRAW_WAIT_LIMIT_MS,
    );
  } finally {
    const overlay = document.getElementById('loading-overlay');
    if (overlay && import.meta.env.VITE_TEST_MODE !== 'true') {
      overlay.classList.add('opacity-0');
      await new Promise((resolve) => setTimeout(resolve, LOADING_OVERLAY_FADE_MS));
    }
    hideLoadingOverlay();
  }
}
