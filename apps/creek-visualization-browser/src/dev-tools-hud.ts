// Developer-only HUD. Mounted only when the page URL carries `?devtools` (or
// `?devtools=1`). Reads from `window.__TNC_TEST__` so the HUD and future
// replay tests share the same capture shape.
//
// Visual language follows a flight boarding-pass identity: ice-blue panel,
// dark ink type, oversized display numerals, hairline rules, a signal-yellow
// edge stripe, and a hazard-stripe header band. Two views share one data feed:
// Simple shows the headline numbers; Detailed shows the raw JSON readouts.

import Graphic from '@arcgis/core/Graphic';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol';
import { watch } from '@arcgis/core/core/reactiveUtils';
import Point from '@arcgis/core/geometry/Point';
import type SceneView from '@arcgis/core/views/SceneView';
import type { CreekVisualizationAttachment } from './creek-visualization-library-interface';
import type { HitTestCapture } from './dev-tools-capture-schema';

interface DevToolsHudOptions {
  view: SceneView;
  attachment: CreekVisualizationAttachment;
  container: HTMLElement;
}

interface CameraPoseShape {
  positionWgs84: readonly [number, number, number];
  headingDegrees: number;
  tiltDegrees: number;
}

interface SegmentPlacementShape {
  segmentId: string;
  bucketMinElevationM: number | null;
}

interface SeamShape {
  cameraPose: CameraPoseShape | null;
  segmentPlacements: readonly SegmentPlacementShape[];
  hitTestAtScreen(screen: { x: number; y: number }): Promise<HitTestCapture>;
}

type HudViewMode = 'simple' | 'detailed';

const HUD_VIEW_MODE_STORAGE_KEY = 'tnc-dev-tools-hud-view-mode';
const HUD_DISPLAY_FONT_STYLESHEET_ID = 'dev-tools-hud-display-font';
const HUD_DISPLAY_FONT_STYLESHEET_URL =
  'https://fonts.googleapis.com/css2?family=Exo+2:wght@500;600;700&display=swap';

// Shared class lists. Kept here so both views read as one visual system.
const MICRO_LABEL_CLASS = 'text-[9px] font-semibold uppercase tracking-[0.14em] text-hud-ink/70';
const FIELD_LABEL_CLASS = 'text-[10px] font-semibold uppercase tracking-[0.12em] text-hud-ink/80';
const HAIRLINE_RULE_CLASS = 'h-px w-full bg-hud-ink/40';
const HEAVY_RULE_CLASS = 'h-[3px] w-full bg-hud-ink';
const READOUT_BLOCK_CLASS =
  'whitespace-pre-wrap break-all border border-hud-ink/30 bg-hud-frost p-2 font-mono text-[11px] leading-relaxed text-hud-ink';
const DOT_GRID_CLASS =
  'bg-[radial-gradient(rgb(22_36_42/0.28)_1px,transparent_1px)] bg-[length:6px_6px]';

export function installDevToolsHud(options: DevToolsHudOptions): void {
  const seam = (window as unknown as { __TNC_TEST__?: SeamShape }).__TNC_TEST__;
  if (!seam) {
    console.warn('[dev-tools-hud] __TNC_TEST__ seam is missing; HUD will not mount.');
    return;
  }

  loadHudDisplayFont();

  const root = createElement('aside', [
    'pointer-events-auto',
    'absolute',
    'right-4',
    'top-4',
    'z-20',
    'w-[min(24rem,calc(100vw-2rem))]',
    'max-h-[calc(100vh-2rem)]',
    'overflow-auto',
    'rounded-sm',
    'border-r-[10px]',
    'border-hud-signal',
    'bg-hud-ice',
    'text-hud-ink',
    'shadow-2xl',
    'shadow-black/40',
    'font-hud-display',
    'text-xs',
  ]);
  root.id = 'dev-tools-hud';
  root.setAttribute('aria-label', 'Developer tools');

  // --- Header: hazard band, title, view toggle -----------------------------
  root.appendChild(
    decorative(
      createElement('div', [
        'h-2',
        'w-full',
        'bg-[repeating-linear-gradient(135deg,#16242a_0_7px,#f3ef2a_7px_14px)]',
      ]),
    ),
  );

  const header = createElement('header', ['flex', 'items-end', 'justify-between', 'gap-3', 'px-4', 'pt-3']);
  const titleGroup = createElement('div', ['min-w-0']);
  titleGroup.appendChild(createElement('p', [MICRO_LABEL_CLASS], 'Scene view // ?devtools=1'));
  titleGroup.appendChild(
    createElement('h2', ['text-2xl', 'font-semibold', 'leading-none', 'tracking-tight'], 'Dev tools'),
  );
  header.appendChild(titleGroup);

  const viewToggle = createElement('div', ['flex', 'shrink-0', 'border-2', 'border-hud-ink']);
  viewToggle.setAttribute('role', 'group');
  viewToggle.setAttribute('aria-label', 'HUD detail level');
  const simpleToggleButton = buildViewToggleButton('Simple');
  const detailedToggleButton = buildViewToggleButton('Detailed');
  viewToggle.append(simpleToggleButton, detailedToggleButton);
  header.appendChild(viewToggle);
  root.appendChild(header);

  root.appendChild(buildTickDivider());

  // --- Simple view: boarding-pass headline numbers -------------------------
  const simpleView = createElement('div', ['px-4', 'pb-2']);

  const headingRow = createElement('div', ['flex', 'items-start', 'justify-between', 'gap-3']);
  const headingGroup = createElement('div', []);
  headingGroup.appendChild(createElement('p', ['text-sm', 'font-semibold'], 'Heading:'));
  const headingValue = createElement('p', ['text-6xl', 'font-semibold', 'leading-none', 'tracking-tight'], '—');
  headingGroup.appendChild(headingValue);
  headingRow.appendChild(headingGroup);

  const segmentBadgeGroup = createElement('div', ['flex', 'flex-col', 'items-end', 'gap-1', 'pt-1']);
  const segmentBadge = createElement(
    'span',
    ['border-2', 'border-hud-ink', 'px-1.5', 'text-lg', 'font-bold', 'italic', 'leading-tight'],
    '—',
  );
  segmentBadge.setAttribute('aria-label', 'Segment suffix');
  segmentBadgeGroup.append(segmentBadge, createElement('span', [MICRO_LABEL_CLASS], 'Segment'));
  headingRow.appendChild(segmentBadgeGroup);
  simpleView.appendChild(headingRow);

  simpleView.appendChild(createElement('div', [HEAVY_RULE_CLASS, 'mt-2']));

  const cameraStatsGrid = createElement('dl', ['mt-2', 'grid', 'grid-cols-2', 'gap-x-4', 'gap-y-1']);
  const tiltValue = appendStat(cameraStatsGrid, 'Tilt');
  const altitudeValue = appendStat(cameraStatsGrid, 'Altitude');
  simpleView.appendChild(cameraStatsGrid);

  const positionBlock = createElement('div', ['mt-3', 'border', 'border-hud-ink/30', 'p-2', DOT_GRID_CLASS]);
  positionBlock.appendChild(createElement('p', [FIELD_LABEL_CLASS], 'Position (WGS84)'));
  const positionValue = createElement('p', ['font-mono', 'text-[11px]', 'tabular-nums'], '(camera not ready)');
  positionBlock.appendChild(positionValue);
  simpleView.appendChild(positionBlock);

  simpleView.appendChild(buildTickDivider());

  simpleView.appendChild(createElement('p', ['text-sm', 'font-semibold'], 'Water surface:'));
  const waterElevationValue = createElement(
    'p',
    ['text-5xl', 'font-semibold', 'leading-none', 'tracking-tight', 'tabular-nums'],
    '—',
  );
  simpleView.appendChild(waterElevationValue);
  simpleView.appendChild(createElement('div', [HEAVY_RULE_CLASS, 'mt-2']));
  const waterSegmentValue = createElement('p', ['mt-1', 'text-lg', 'font-semibold'], 'No placements');
  simpleView.appendChild(waterSegmentValue);

  const lastClickBlock = createElement('div', ['mt-3', 'bg-hud-frost', 'p-2']);
  lastClickBlock.appendChild(createElement('p', [FIELD_LABEL_CLASS], 'Last click'));
  const lastClickValue = createElement('p', ['text-sm', 'font-semibold'], 'Click the scene to capture a hit test.');
  lastClickBlock.appendChild(lastClickValue);
  simpleView.appendChild(lastClickBlock);

  const simpleCopyRow = createElement('div', ['mt-3', 'flex', 'flex-wrap', 'gap-1.5']);
  const simpleCopyPoseButton = buildCopyButton('Copy pose');
  const simpleCopyCaptureButton = buildCopyButton('Copy click');
  const simpleCopyPlacementsButton = buildCopyButton('Copy placements');
  simpleCopyRow.append(simpleCopyPoseButton, simpleCopyCaptureButton, simpleCopyPlacementsButton);
  simpleView.appendChild(simpleCopyRow);
  root.appendChild(simpleView);

  // --- Detailed view: raw JSON readouts ------------------------------------
  const detailedView = createElement('div', ['px-4', 'pb-2']);

  const cameraSection = buildSection('Camera pose', '01');
  const cameraReadout = createElement('pre', [READOUT_BLOCK_CLASS], '{}');
  const detailedCopyPoseButton = buildCopyButton('Copy JSON');
  cameraSection.body.append(cameraReadout, detailedCopyPoseButton);
  detailedView.appendChild(cameraSection.root);

  const clickSection = buildSection('Click capture', '02');
  const clickSummary = createElement('div', [READOUT_BLOCK_CLASS, 'flex', 'flex-col', 'gap-2']);
  renderEmptyClickCapture(clickSummary);
  const detailedCopyCaptureButton = buildCopyButton('Copy capture JSON');
  clickSection.body.append(clickSummary, detailedCopyCaptureButton);
  detailedView.appendChild(clickSection.root);

  const placementsSection = buildSection('Current segment placements', '03');
  const placementsList = createElement('div', [READOUT_BLOCK_CLASS], '(none)');
  const detailedCopyPlacementsButton = buildCopyButton('Copy JSON');
  placementsSection.body.append(placementsList, detailedCopyPlacementsButton);
  detailedView.appendChild(placementsSection.root);
  root.appendChild(detailedView);

  // --- Footer: shared copy feedback ----------------------------------------
  const footer = createElement('footer', [
    'flex',
    'items-center',
    'justify-between',
    'gap-3',
    'border-t',
    'border-hud-ink/30',
    'px-4',
    'py-2',
  ]);
  const copyFeedback = createElement('p', ['min-h-4', 'text-[11px]', 'font-semibold']);
  copyFeedback.setAttribute('aria-live', 'polite');
  footer.appendChild(copyFeedback);
  footer.appendChild(decorative(createElement('span', ['tracking-[0.3em]', 'text-hud-ink/60'], '• • •')));
  root.appendChild(footer);

  options.container.appendChild(root);

  // --- View toggle ---------------------------------------------------------
  const applyViewMode = (mode: HudViewMode): void => {
    simpleView.hidden = mode !== 'simple';
    detailedView.hidden = mode !== 'detailed';
    simpleToggleButton.setAttribute('aria-pressed', String(mode === 'simple'));
    detailedToggleButton.setAttribute('aria-pressed', String(mode === 'detailed'));
    saveViewMode(mode);
  };
  applyViewMode(readSavedViewMode());
  simpleToggleButton.addEventListener('click', () => applyViewMode('simple'));
  detailedToggleButton.addEventListener('click', () => applyViewMode('detailed'));

  // --- Camera pose: live update on every camera tick -----------------------
  const renderCameraPose = (): void => {
    const pose = seam.cameraPose;
    cameraReadout.textContent = pose ? JSON.stringify(pose, null, 2) : '(camera not ready)';
    if (!pose) {
      headingValue.textContent = '—';
      tiltValue.textContent = '—';
      altitudeValue.textContent = '—';
      positionValue.textContent = '(camera not ready)';
      return;
    }
    const [longitude, latitude, altitudeM] = pose.positionWgs84;
    headingValue.textContent = `${pose.headingDegrees.toFixed(1)}°`;
    tiltValue.textContent = `${pose.tiltDegrees.toFixed(1)}°`;
    altitudeValue.textContent = `${altitudeM.toFixed(1)} m`;
    positionValue.textContent = `${longitude.toFixed(6)}, ${latitude.toFixed(6)}`;
  };
  renderCameraPose();
  watch(
    () => options.view.camera,
    () => renderCameraPose(),
  );

  const copyCameraPose = (): void => {
    void copyWithFeedback(JSON.stringify(seam.cameraPose, null, 2), copyFeedback, 'Camera pose copied.');
  };
  simpleCopyPoseButton.addEventListener('click', copyCameraPose);
  detailedCopyPoseButton.addEventListener('click', copyCameraPose);

  // --- Click capture: hit-test on each view click --------------------------
  const markerLayer = new GraphicsLayer({
    id: 'dev-hud-click-marker',
    listMode: 'hide',
  });
  if (options.view.map) options.view.map.add(markerLayer);
  const markerSymbol = new SimpleMarkerSymbol({
    style: 'circle',
    color: [0, 0, 0, 0],
    size: 14,
    outline: new SimpleLineSymbol({ color: '#f3ef2a', width: 2 }),
  });
  let markerGraphic: Graphic | null = null;

  let lastCapture: HitTestCapture | null = null;
  const captureCopyButtons = [simpleCopyCaptureButton, detailedCopyCaptureButton];
  for (const button of captureCopyButtons) button.disabled = true;

  options.view.on('click', (event) => {
    const screen = { x: event.x, y: event.y };
    seam
      .hitTestAtScreen(screen)
      .then((capture) => {
        lastCapture = capture;
        renderClickCapture(capture, clickSummary);
        lastClickValue.textContent = summarizeClickCapture(capture);
        for (const button of captureCopyButtons) button.disabled = false;
        drawClickMarker(options.view, markerLayer, markerSymbol, event.mapPoint, (next) => {
          markerGraphic = next;
        }, markerGraphic);
      })
      .catch((error: unknown) => {
        console.error('[dev-tools-hud] hit test failed', error);
        clickSummary.textContent = 'Hit test failed. See console.';
        lastClickValue.textContent = 'Hit test failed. See console.';
      });
  });

  const copyClickCapture = (): void => {
    if (!lastCapture) return;
    void copyWithFeedback(JSON.stringify(lastCapture, null, 2), copyFeedback, 'Click capture copied.');
  };
  for (const button of captureCopyButtons) button.addEventListener('click', copyClickCapture);

  // --- Segment placements: refresh on every renderer update ----------------
  const renderPlacements = (): void => {
    const placements = seam.segmentPlacements;
    if (placements.length === 0) {
      placementsList.textContent = '(none)';
      waterElevationValue.textContent = '—';
      waterSegmentValue.textContent = 'No placements';
      segmentBadge.textContent = '—';
      return;
    }
    placementsList.textContent = placements
      .map((placement) => `${placement.segmentId} → ${formatPlacementElevation(placement)}`)
      .join('\n');

    const [firstPlacement] = placements;
    const additionalCount = placements.length - 1;
    waterElevationValue.textContent = formatPlacementElevation(firstPlacement);
    waterSegmentValue.textContent =
      additionalCount > 0
        ? `${firstPlacement.segmentId} +${additionalCount} more`
        : firstPlacement.segmentId;
    segmentBadge.textContent = readSegmentSuffix(firstPlacement.segmentId);
  };
  renderPlacements();
  // The attachment exposes the same identity list; its getter mirrors seam.segmentPlacements.
  watch(
    () => options.attachment.waterGraphicGeometryIdentity,
    () => renderPlacements(),
  );

  const copyPlacements = (): void => {
    void copyWithFeedback(
      JSON.stringify(seam.segmentPlacements, null, 2),
      copyFeedback,
      'Segment placements copied.',
    );
  };
  simpleCopyPlacementsButton.addEventListener('click', copyPlacements);
  detailedCopyPlacementsButton.addEventListener('click', copyPlacements);
}

// --- Element builders -------------------------------------------------------

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  classNames: readonly string[],
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = classNames.join(' ');
  if (textContent !== undefined) element.textContent = textContent;
  return element;
}

function decorative<T extends HTMLElement>(element: T): T {
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/** Hairline rule with evenly spaced tick dots, echoing the boarding-pass separators. */
function buildTickDivider(): HTMLElement {
  const divider = decorative(createElement('div', ['flex', 'items-center', 'gap-2', 'px-4', 'py-3']));
  divider.appendChild(createElement('span', [HAIRLINE_RULE_CLASS, 'w-6', 'shrink-0']));
  divider.appendChild(
    createElement('span', ['flex-1', 'text-center', 'text-[8px]', 'tracking-[0.9em]', 'text-hud-ink/70'], '••••••••'),
  );
  divider.appendChild(createElement('span', [HAIRLINE_RULE_CLASS, 'w-6', 'shrink-0']));
  return divider;
}

function buildViewToggleButton(label: string): HTMLButtonElement {
  const button = createElement(
    'button',
    [
      'cursor-pointer',
      'px-2',
      'py-0.5',
      'text-[10px]',
      'font-bold',
      'uppercase',
      'tracking-[0.12em]',
      'text-hud-ink',
      'transition-colors',
      'hover:bg-hud-frost',
      'aria-pressed:bg-hud-ink',
      'aria-pressed:text-hud-ice',
      'aria-pressed:hover:bg-hud-ink',
      'focus-visible:outline',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-hud-ink',
    ],
    label,
  );
  button.type = 'button';
  return button;
}

function buildCopyButton(label: string): HTMLButtonElement {
  const button = createElement(
    'button',
    [
      'cursor-pointer',
      'self-start',
      'bg-hud-ink',
      'px-2',
      'py-1',
      'text-[10px]',
      'font-bold',
      'uppercase',
      'tracking-[0.12em]',
      'text-hud-ice',
      'transition-colors',
      'hover:bg-hud-ink/85',
      'focus-visible:outline',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-hud-ink',
      'disabled:cursor-not-allowed',
      'disabled:opacity-35',
    ],
    label,
  );
  button.type = 'button';
  return button;
}

function buildSection(label: string, indexLabel: string): { root: HTMLElement; body: HTMLElement } {
  const section = createElement('section', ['mt-4', 'first:mt-0']);
  const headingRow = createElement('div', ['mb-1.5', 'flex', 'items-baseline', 'justify-between', 'gap-2']);
  headingRow.appendChild(createElement('h3', ['text-sm', 'font-semibold'], label));
  headingRow.appendChild(decorative(createElement('span', [MICRO_LABEL_CLASS], indexLabel)));
  section.appendChild(headingRow);
  section.appendChild(createElement('div', [HAIRLINE_RULE_CLASS, 'mb-2']));
  const body = createElement('div', ['flex', 'flex-col', 'gap-2']);
  section.appendChild(body);
  return { root: section, body };
}

/** Appends a definition-list stat and returns its value element. */
function appendStat(list: HTMLElement, label: string): HTMLElement {
  const group = createElement('div', []);
  group.appendChild(createElement('dt', [FIELD_LABEL_CLASS], label));
  const value = createElement('dd', ['text-xl', 'font-semibold', 'leading-tight', 'tabular-nums'], '—');
  group.appendChild(value);
  list.appendChild(group);
  return value;
}

// --- Click capture rendering ------------------------------------------------

function renderEmptyClickCapture(summary: HTMLElement): void {
  summary.replaceChildren(createElement('p', ['text-hud-ink/70'], 'Click the scene to capture a hit test.'));
}

function renderClickCapture(capture: HitTestCapture, summary: HTMLElement): void {
  summary.replaceChildren();

  summary.appendChild(
    buildCaptureRow('Pixel', [`(${capture.screenPoint.x.toFixed(1)}, ${capture.screenPoint.y.toFixed(1)})`]),
  );

  if (capture.mapHitWgs84) {
    const { longitude, latitude, z } = capture.mapHitWgs84;
    const zText = z == null ? '—' : `${z.toFixed(2)} m`;
    summary.appendChild(
      buildCaptureRow('Ground hit', [`${longitude.toFixed(6)}, ${latitude.toFixed(6)} @ ${zText}`]),
    );
  }

  const waterHits = capture.hits.filter((hit) => hit.graphicType === 'water-surface');
  if (waterHits.length > 0) {
    const lines = waterHits.map((hit) => {
      const segmentId = hit.segmentId ?? '(unknown)';
      const min = hit.bucketMinElevationM == null ? '—' : String(hit.bucketMinElevationM);
      const max = hit.bucketMaxElevationM == null ? '—' : String(hit.bucketMaxElevationM);
      return `segment ${segmentId} @ ${min} m (bucket ${min}–${max})`;
    });
    summary.appendChild(buildCaptureRow('Water hit', lines));
  }

  const otherHits = capture.hits.filter((hit) => hit.graphicType === 'other');
  if (otherHits.length > 0) {
    summary.appendChild(buildCaptureRow('Other hits', otherHits.map((hit) => `layer ${hit.layerId ?? 'unknown'}`)));
  }

  if (capture.hits.length === 0) {
    summary.appendChild(buildCaptureRow('No hits', ['No graphics hit']));
  }
}

function buildCaptureRow(label: string, lines: readonly string[]): HTMLElement {
  const row = createElement('div', ['flex', 'flex-col', 'gap-0.5']);
  row.appendChild(createElement('span', [FIELD_LABEL_CLASS, 'font-hud-display'], label));
  for (const line of lines) {
    row.appendChild(createElement('span', ['break-all'], line));
  }
  return row;
}

/** One-line summary for the Simple view: water hit first, then ground, then nothing. */
function summarizeClickCapture(capture: HitTestCapture): string {
  const waterHit = capture.hits.find((hit) => hit.graphicType === 'water-surface');
  if (waterHit) {
    const elevationText = waterHit.bucketMinElevationM == null ? '—' : `${waterHit.bucketMinElevationM} m`;
    return `Water · ${waterHit.segmentId ?? '(unknown)'} @ ${elevationText}`;
  }
  const groundZ = capture.mapHitWgs84?.z;
  if (groundZ != null) return `Ground @ ${groundZ.toFixed(2)} m`;
  return 'No graphics hit';
}

// --- Formatting -------------------------------------------------------------

function formatPlacementElevation(placement: SegmentPlacementShape): string {
  return placement.bucketMinElevationM == null ? 'hidden' : `${placement.bucketMinElevationM.toFixed(3)} m`;
}

/** `27714637-026` → `026`. Falls back to the whole id when there is no dash. */
function readSegmentSuffix(segmentId: string): string {
  const dashIndex = segmentId.lastIndexOf('-');
  return dashIndex === -1 ? segmentId : segmentId.slice(dashIndex + 1);
}

// --- View mode persistence ---------------------------------------------------

function readSavedViewMode(): HudViewMode {
  try {
    return localStorage.getItem(HUD_VIEW_MODE_STORAGE_KEY) === 'detailed' ? 'detailed' : 'simple';
  } catch {
    return 'simple';
  }
}

function saveViewMode(mode: HudViewMode): void {
  try {
    localStorage.setItem(HUD_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be blocked (private mode); the toggle still works for this session.
  }
}

/** Loads the display face only when the HUD mounts, so normal page loads make no font request. */
function loadHudDisplayFont(): void {
  if (document.getElementById(HUD_DISPLAY_FONT_STYLESHEET_ID)) return;
  const link = document.createElement('link');
  link.id = HUD_DISPLAY_FONT_STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = HUD_DISPLAY_FONT_STYLESHEET_URL;
  document.head.appendChild(link);
}

// --- Map marker and clipboard -------------------------------------------------

function drawClickMarker(
  view: SceneView,
  layer: GraphicsLayer,
  symbol: SimpleMarkerSymbol,
  mapPoint: Point | null | undefined,
  setMarker: (next: Graphic | null) => void,
  previous: Graphic | null,
): void {
  if (previous) layer.remove(previous);
  if (!mapPoint) {
    setMarker(null);
    return;
  }
  const marker = new Graphic({ geometry: mapPoint, symbol });
  layer.add(marker);
  setMarker(marker);
  void view;
}

async function copyWithFeedback(text: string, feedback: HTMLElement, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    feedback.textContent = successMessage;
  } catch {
    feedback.textContent = 'Copy failed — selecting instead';
    fallbackCopyViaExecCommand(text);
  }
  window.setTimeout(() => {
    feedback.textContent = '';
  }, 1500);
}

function fallbackCopyViaExecCommand(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'fixed left-[-9999px] top-[-9999px] opacity-0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    // Nothing to do; the textarea stays selected so the developer can hit Cmd+C manually.
  }
  document.body.removeChild(area);
}
