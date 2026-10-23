// Developer-only HUD. Mounted when the page URL carries `?devtools` (or
// `?devtools=1`), or from the development-server corner toggle
// (dev-tools-toggle.ts). Reads from `window.__TNC_TEST__` so the HUD and future
// replay tests share the same capture shape. In the modeled experience it also
// reads `window.__TNC_MODELED__` for the Drainage-Area Ratio Transfer tools.
//
// Two independent toggles:
// - Style: Classic matches the time panel (slate glass, cyan accents). Flight
//   is a boarding-pass look: banded ice-blue glass, black type, a blueprint
//   grid, a hazard band, and a signal-yellow edge stripe.
// - View: Simple shows headline numbers and a 3D camera attitude indicator.
//   Detailed shows the raw JSON readouts.
// Both toggles share one data feed, so switching never loses state.
// Dataset and time sits above both views. In the modeled experience it also
// holds the 'Polygon method' select, which switches the drawn WSE Polygon
// Generation Method version live. Copy all JSON bundles that readout (with the
// drawn method), the camera pose, and the last click capture.

import 'overlayscrollbars/overlayscrollbars.css';
import './dev-tools-hud.css';
import Graphic from '@arcgis/core/Graphic';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol';
import { watch } from '@arcgis/core/core/reactiveUtils';
import Extent from '@arcgis/core/geometry/Extent';
import Point from '@arcgis/core/geometry/Point';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import type SceneView from '@arcgis/core/views/SceneView';
import { OverlayScrollbars } from 'overlayscrollbars';
import type { CreekVisualizationAttachment } from './creek-visualization-library-interface';
import type { HitTestCapture } from './dev-tools-capture-schema';
import {
  DRAINAGE_AREA_RATIO_TRANSFER_DEV_TOOLS_SUBTITLE,
  DRAINAGE_AREA_RATIO_TRANSFER_DEV_TOOLS_TITLE,
  DRAINAGE_AREA_RATIO_TRANSFER_NO_FLAGS_YET,
  DRAINAGE_AREA_RATIO_TRANSFER_NONE_IN_EXTENT,
  DRAINAGE_AREA_RATIO_TRANSFER_NONE_IN_JALAMA_EXTENT,
  DRAINAGE_AREA_RATIO_TRANSFER_READING_NOTE,
  DRAINAGE_AREA_RATIO_TRANSFER_SWITCH_EXTENT_LABEL,
} from './drainage-area-ratio-transfer-labels';
import {
  DATASET_PICKER_OPTIONS,
  MODELED_EXTENT_QUERY_PARAM,
  OBSERVED_DATASET_OPTION_ID,
} from './modeled-water-catalog';
import type {
  DrainageAreaRatioTransferSegment,
  ModeledExperienceSeam,
  ModeledSegmentReading,
} from './modeled-creek-experience';
import { formatObservationTime } from './observation-timeline-controls';
import type { StationMarkerGallery } from './station-marker-gallery';
import type { DevToolsClickMarker } from './dev-tools-click-marker';
import { createDevToolsClickMarker } from './dev-tools-click-marker';
import { wsePolygonMethodKey, type WsePolygonMethodVersion } from './wse-polygon-generation-methods';

interface DevToolsHudOptions {
  view: SceneView;
  attachment: CreekVisualizationAttachment;
  container: HTMLElement;
  /**
   * `top` (default) pins the HUD to the top-right corner. `below-dev-tools-toggle`
   * leaves room above it for the development-server toggle button and the
   * imagery widget stacked under it.
   */
  placement?: 'top' | 'below-dev-tools-toggle';
  /**
   * When the dev-server toggle already tracks clicks, it owns the marker and
   * forwards clicks here. A direct `?devtools` mount leaves this unset and the
   * HUD creates the marker itself.
   */
  clickMarker?: DevToolsClickMarker;
}

export interface DevToolsHudHandle {
  readonly root: HTMLElement;
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
  /** Fills the click readout for a click the toggle already marked on the map. */
  captureScreenClick(screen: { x: number; y: number }): void;
}

type ModeledSeamWindow = Window & { __TNC_MODELED__?: ModeledExperienceSeam };

interface CameraPoseShape {
  positionWgs84: readonly [number, number, number];
  headingDegrees: number;
  tiltDegrees: number;
}

interface SegmentPlacementShape {
  segmentId: string;
  bucketMinElevationM: number | null;
}

/** Copied from Dataset and time, and nested as `dataset` in Copy all JSON. */
interface DatasetAndTimeCapture {
  datasetId: string | null;
  datasetLabel: string | null;
  extentId: string | null;
  /** ISO 8601 UTC, for example `2017-10-01T00:00:00.000Z`. */
  selectedTimeUtc: string | null;
  /** Same America/Los_Angeles label the time panel shows, for example `Sep 30, 2017, 5:00 PM PDT`. */
  selectedTimeLocal: string | null;
  /** Modeled only: the WSE Polygon Generation Method version drawn, e.g. `junction-sloped-terrain-fill@v1`. */
  wsePolygonMethod: string | null;
  wsePolygonMethodLabel: string | null;
}

interface SeamShape {
  cameraPose: CameraPoseShape | null;
  segmentPlacements: readonly SegmentPlacementShape[];
  hitTestAtScreen(screen: { x: number; y: number }): Promise<HitTestCapture>;
}

type HudViewMode = 'simple' | 'detailed';
type HudStyle = 'classic' | 'flight';

const HUD_VIEW_MODE_STORAGE_KEY = 'tnc-dev-tools-hud-view-mode';
const HUD_STYLE_STORAGE_KEY = 'tnc-dev-tools-hud-style';
const HUD_DISPLAY_FONT_STYLESHEET_ID = 'dev-tools-hud-display-font';
const HUD_DISPLAY_FONT_STYLESHEET_URL =
  'https://fonts.googleapis.com/css2?family=Exo+2:wght@600;700;800&display=swap';

/**
 * The attachment is a plain object, so `reactiveUtils.watch` cannot observe it.
 * Water readouts refresh on this interval and only touch the DOM on change.
 */
const WATER_READOUT_REFRESH_MS = 250;
/** A click this close to a Creek Segment's center counts as a click on that segment. */
const NEAR_SEGMENT_MAX_DISTANCE_M = 60;

// Style tokens: RGB channels (some with "/ alpha") consumed by the `hud-*`
// colors in tailwind.config.js. Written as literal class strings so Tailwind's
// source scan finds them.
const CLASSIC_STYLE_TOKENS = [
  // Matches the time panel: slate-900/90 glass, slate-700 edges, cyan accents.
  'data-[hud-style=classic]:[--hud-panel:15_23_42_/_0.9]',
  'data-[hud-style=classic]:[--hud-panel-edge:51_65_85_/_0.8]',
  'data-[hud-style=classic]:[--hud-ink:241_245_249]',
  'data-[hud-style=classic]:[--hud-accent:103_232_249]',
  'data-[hud-style=classic]:[--hud-title:165_243_252]',
  'data-[hud-style=classic]:[--hud-label:148_163_184]',
  'data-[hud-style=classic]:[--hud-rule:51_65_85]',
  'data-[hud-style=classic]:[--hud-grid:0_0_0_/_0]',
  'data-[hud-style=classic]:[--hud-band-1:0_0_0_/_0]',
  'data-[hud-style=classic]:[--hud-band-2:0_0_0_/_0]',
  'data-[hud-style=classic]:[--hud-band-3:0_0_0_/_0]',
  'data-[hud-style=classic]:[--hud-well:2_6_23_/_0.7]',
  'data-[hud-style=classic]:[--hud-well-edge:51_65_85]',
  'data-[hud-style=classic]:[--hud-button:8_51_68_/_0.6]',
  'data-[hud-style=classic]:[--hud-button-ink:207_250_254]',
  'data-[hud-style=classic]:[--hud-button-edge:6_182_212_/_0.6]',
  'data-[hud-style=classic]:[--hud-button-hover:22_78_99_/_0.7]',
  'data-[hud-style=classic]:[--hud-toggle-ink:207_250_254]',
  'data-[hud-style=classic]:[--hud-toggle-hover:22_78_99_/_0.7]',
  'data-[hud-style=classic]:[--hud-pressed:34_211_238]',
  'data-[hud-style=classic]:[--hud-on-pressed:2_6_23]',
  'data-[hud-style=classic]:[--hud-focus:103_232_249]',
];

const FLIGHT_STYLE_TOKENS = [
  // Boarding pass: #D3EBEE glass, #B5DDE2 and #ADD9E1 bands, near-black ink.
  'data-[hud-style=flight]:[--hud-panel:211_235_238_/_0.78]',
  'data-[hud-style=flight]:[--hud-panel-edge:255_255_255_/_0.5]',
  'data-[hud-style=flight]:[--hud-ink:10_15_18]',
  'data-[hud-style=flight]:[--hud-accent:10_15_18]',
  'data-[hud-style=flight]:[--hud-title:10_15_18]',
  'data-[hud-style=flight]:[--hud-label:10_15_18_/_0.78]',
  'data-[hud-style=flight]:[--hud-rule:10_15_18_/_0.55]',
  'data-[hud-style=flight]:[--hud-grid:10_15_18_/_0.07]',
  // Solid bands so the blues read clearly over any aerial imagery backdrop.
  'data-[hud-style=flight]:[--hud-band-1:181_221_226]',
  'data-[hud-style=flight]:[--hud-band-2:173_217_225]',
  'data-[hud-style=flight]:[--hud-band-3:211_235_238]',
  'data-[hud-style=flight]:[--hud-well:255_255_255_/_0.42]',
  'data-[hud-style=flight]:[--hud-well-edge:10_15_18_/_0.35]',
  'data-[hud-style=flight]:[--hud-button:10_15_18]',
  'data-[hud-style=flight]:[--hud-button-ink:211_235_238]',
  'data-[hud-style=flight]:[--hud-button-edge:10_15_18]',
  'data-[hud-style=flight]:[--hud-button-hover:40_52_58]',
  'data-[hud-style=flight]:[--hud-toggle-ink:10_15_18]',
  'data-[hud-style=flight]:[--hud-toggle-hover:10_15_18_/_0.1]',
  'data-[hud-style=flight]:[--hud-pressed:10_15_18]',
  'data-[hud-style=flight]:[--hud-on-pressed:211_235_238]',
  'data-[hud-style=flight]:[--hud-focus:10_15_18]',
];

// Shared class lists. Kept here so both views read as one visual system.
const MICRO_LABEL_CLASS = 'text-[9px] font-bold uppercase tracking-[0.14em] text-hud-label';
const FIELD_LABEL_CLASS = 'text-[10px] font-bold uppercase tracking-[0.12em] text-hud-label';
const HEAVY_RULE_CLASS = 'h-[3px] w-full bg-hud-accent';
const READOUT_BLOCK_CLASS =
  'whitespace-pre-wrap break-all rounded-sm border border-hud-well-edge bg-hud-well p-2 font-mono text-[11px] font-semibold leading-relaxed text-hud-ink';
const DOT_GRID_CLASS =
  'bg-[radial-gradient(rgb(var(--hud-ink)/0.25)_1px,transparent_1px)] bg-[length:6px_6px]';
/** Full-bleed block. Flight tints it with one of the three ice blues; Classic leaves it clear. */
const BAND_CLASS = 'border-t border-hud-rule px-4 py-3';
const BAND_TINT_CLASSES = ['bg-hud-band-1', 'bg-hud-band-2', 'bg-hud-band-3'] as const;
/** Shown only in the Flight style (descendants of the HUD root). */
const FLIGHT_ONLY_CLASS = 'group-data-[hud-style=classic]:hidden';

export function installDevToolsHud(options: DevToolsHudOptions): DevToolsHudHandle | null {
  const seam = (window as unknown as { __TNC_TEST__?: SeamShape }).__TNC_TEST__;
  if (!seam) {
    console.warn('[dev-tools-hud] __TNC_TEST__ seam is missing; HUD will not mount.');
    return null;
  }

  loadHudDisplayFont();
  const clickMarker = options.clickMarker ?? createDevToolsClickMarker(options.view);
  // The toggle owns the marker and calls setOpen. A direct mount starts open.
  const panelStartsOpen = !options.clickMarker;
  if (panelStartsOpen) clickMarker.setVisible(true);
  const belowToggle = options.placement === 'below-dev-tools-toggle';
  /** Present only in the modeled experience; the water readouts then follow the active Dataset. */
  const modeledSeam = (window as ModeledSeamWindow).__TNC_MODELED__ ?? null;

  // The positioned shell owns the glass; the inner host owns scrolling, so the
  // overlay scrollbar library never overrides the shell's absolute position.
  const root = createElement('aside', [
    ...CLASSIC_STYLE_TOKENS,
    ...FLIGHT_STYLE_TOKENS,
    'group',
    'pointer-events-auto',
    'absolute',
    'right-4',
    belowToggle ? 'top-[6.25rem]' : 'top-4',
    'z-20',
    'w-[min(24rem,calc(100vw-2rem))]',
    'overflow-hidden',
    'border',
    'border-hud-panel-edge',
    'bg-hud-panel',
    'bg-[linear-gradient(rgb(var(--hud-grid))_1px,transparent_1px),linear-gradient(90deg,rgb(var(--hud-grid))_1px,transparent_1px)]',
    'bg-[length:16px_16px]',
    'text-hud-ink',
    'text-xs',
    'shadow-2xl',
    'shadow-black/40',
    'backdrop-blur-xl',
    'backdrop-saturate-150',
    'transition-colors',
    'duration-300',
    'data-[hud-style=classic]:rounded-xl',
    'data-[hud-style=classic]:font-sans',
    'data-[hud-style=flight]:rounded-md',
    'data-[hud-style=flight]:border-r-[10px]',
    'data-[hud-style=flight]:border-r-hud-signal',
    'data-[hud-style=flight]:font-hud-display',
    'data-[hud-style=flight]:font-semibold',
  ]);
  root.id = 'dev-tools-hud';
  root.hidden = !panelStartsOpen;
  root.setAttribute('aria-label', 'Developer tools');

  const scrollHost = createElement('div', [
    belowToggle ? 'max-h-[calc(100vh-7.25rem)]' : 'max-h-[calc(100vh-2rem)]',
  ]);
  root.appendChild(scrollHost);

  // --- Header: hazard band, title, toggles ---------------------------------
  scrollHost.appendChild(
    decorative(
      createElement('div', [
        FLIGHT_ONLY_CLASS,
        'h-2',
        'w-full',
        'bg-[repeating-linear-gradient(135deg,#0a0f12_0_7px,#f3ef2a_7px_14px)]',
      ]),
    ),
  );

  const header = createElement('header', ['bg-hud-band-3', 'px-4', 'py-3']);
  const titleRow = createElement('div', ['flex', 'items-end', 'justify-between', 'gap-3']);
  const titleGroup = createElement('div', ['min-w-0']);
  titleGroup.appendChild(createElement('p', [MICRO_LABEL_CLASS], 'Scene view // ?devtools=1'));
  titleGroup.appendChild(
    createElement(
      'h2',
      ['text-2xl', 'font-extrabold', 'leading-none', 'tracking-tight', 'text-hud-title'],
      'Dev tools',
    ),
  );
  titleRow.appendChild(titleGroup);
  titleRow.appendChild(
    decorative(createElement('span', [FLIGHT_ONLY_CLASS, 'pb-0.5', 'tracking-[0.3em]', 'text-hud-label'], '• • •')),
  );
  header.appendChild(titleRow);

  // Grid: label column auto-sized to the longest label, toggle column fills the rest.
  // Both rows therefore share identical column boundaries and the borders align.
  const toggleRow = createElement('div', ['mt-3', 'grid', 'grid-cols-[auto_1fr]', 'items-center', 'gap-x-3', 'gap-y-2']);
  const styleToggle = buildSegmentedToggle('Style', 'HUD style', ['Classic', 'Flight']);
  const viewToggle = buildSegmentedToggle('View', 'HUD detail level', ['Simple', 'Detailed']);
  // Render each toggle's label and control as separate grid cells so the columns align.
  toggleRow.append(styleToggle.labelEl, styleToggle.groupEl, viewToggle.labelEl, viewToggle.groupEl);
  header.appendChild(toggleRow);
  const copyAllButton = buildCopyButton('Copy all JSON');
  copyAllButton.classList.add('mt-3', 'w-full', 'px-3', 'py-1.5', 'text-center', 'text-[11px]');
  header.appendChild(copyAllButton);
  scrollHost.appendChild(header);

  // --- Dataset and time: above both views, so either view can copy it --------
  const datasetSection = buildSection('Dataset and time', '01', 2);
  const datasetReadout = createElement('pre', [READOUT_BLOCK_CLASS], '{}');
  const copyDatasetButton = buildCopyButton('Copy JSON');
  if (modeledSeam) datasetSection.body.appendChild(buildWsePolygonMethodPicker(modeledSeam));
  datasetSection.body.append(datasetReadout, copyDatasetButton);
  scrollHost.appendChild(datasetSection.root);

  // --- Simple view: boarding-pass headline numbers -------------------------
  const simpleView = createElement('div', []);

  const headingBand = buildBand(0);
  const headingRow = createElement('div', ['flex', 'items-start', 'justify-between', 'gap-3']);
  const headingGroup = createElement('div', []);
  headingGroup.appendChild(createElement('p', ['text-sm', 'font-bold'], 'Heading:'));
  const headingValue = createElement(
    'p',
    ['text-6xl', 'font-extrabold', 'leading-none', 'tracking-tight', 'tabular-nums'],
    '—',
  );
  headingGroup.appendChild(headingValue);
  headingRow.appendChild(headingGroup);

  const segmentBadgeGroup = createElement('div', ['flex', 'flex-col', 'items-end', 'gap-1', 'pt-1']);
  const segmentBadge = createElement(
    'span',
    ['border-2', 'border-hud-ink', 'px-1.5', 'text-lg', 'font-extrabold', 'italic', 'leading-tight'],
    '—',
  );
  segmentBadge.setAttribute('aria-label', 'Segment suffix');
  segmentBadgeGroup.append(segmentBadge, createElement('span', [MICRO_LABEL_CLASS], 'Segment'));
  headingRow.appendChild(segmentBadgeGroup);
  headingBand.appendChild(headingRow);
  headingBand.appendChild(createElement('div', [HEAVY_RULE_CLASS, 'mt-2']));
  simpleView.appendChild(headingBand);

  // Attitude indicator beside tilt and altitude.
  const attitudeBand = buildBand(1);
  const attitudeRow = createElement('div', ['grid', 'grid-cols-[1fr_auto]', 'items-stretch', 'gap-3']);
  const cameraStatsList = createElement('dl', ['flex', 'flex-col', 'justify-between', 'gap-1']);
  const tiltValue = appendStat(cameraStatsList, 'Tilt');
  const altitudeValue = appendStat(cameraStatsList, 'Altitude');
  attitudeRow.appendChild(cameraStatsList);
  const attitudeIndicator = buildCameraAttitudeIndicator();
  attitudeRow.appendChild(attitudeIndicator.root);
  attitudeBand.appendChild(attitudeRow);

  const positionBlock = createElement('div', [
    'mt-3',
    'rounded-sm',
    'border',
    'border-hud-well-edge',
    'p-2',
    DOT_GRID_CLASS,
  ]);
  positionBlock.appendChild(createElement('p', [FIELD_LABEL_CLASS], 'Position (WGS84)'));
  const positionValue = createElement(
    'p',
    ['font-mono', 'text-[11px]', 'font-bold', 'tabular-nums'],
    '(camera not ready)',
  );
  positionBlock.appendChild(positionValue);
  attitudeBand.appendChild(positionBlock);
  simpleView.appendChild(attitudeBand);

  const waterBand = buildBand(0);
  waterBand.id = 'dev-tools-water-band';
  waterBand.appendChild(createElement('p', ['text-sm', 'font-bold'], 'Water surface:'));
  const waterReadingValue = createElement(
    'p',
    ['text-5xl', 'font-extrabold', 'leading-none', 'tracking-tight', 'tabular-nums'],
    '—',
  );
  waterReadingValue.id = 'dev-tools-water-reading';
  waterBand.appendChild(waterReadingValue);
  waterBand.appendChild(createElement('div', [HEAVY_RULE_CLASS, 'mt-2']));
  const waterCaptionRow = createElement('div', ['mt-1', 'flex', 'items-baseline', 'justify-between', 'gap-2']);
  const waterCaption = createElement(
    'span',
    [FIELD_LABEL_CLASS],
    modeledSeam ? `Modeled WSE · NAVD88 · ${modeledSeam.datasetLabel}` : 'Observed WSE · NAVD88',
  );
  waterCaption.id = 'dev-tools-water-caption';
  waterCaptionRow.appendChild(waterCaption);
  const drawnElevationValue = createElement(
    'span',
    ['shrink-0', 'text-sm', 'font-bold', 'tabular-nums'],
    'Not drawn',
  );
  waterCaptionRow.appendChild(drawnElevationValue);
  waterBand.appendChild(waterCaptionRow);
  // Modeled only: which Creek Segment the reading belongs to, and whether its flow is borrowed.
  const waterDetailLine = createElement('p', ['mt-1', 'text-[11px]', 'font-bold', 'text-hud-label']);
  waterDetailLine.id = 'dev-tools-water-detail';
  waterDetailLine.hidden = !modeledSeam;
  waterBand.appendChild(waterDetailLine);
  simpleView.appendChild(waterBand);

  const clickBand = buildBand(1);
  const lastClickBlock = createElement('div', ['rounded-sm', 'border', 'border-hud-well-edge', 'bg-hud-well', 'p-2']);
  lastClickBlock.appendChild(createElement('p', [FIELD_LABEL_CLASS], 'Last click'));
  const lastClickValue = createElement('p', ['text-sm', 'font-bold'], 'Click the scene to capture a hit test.');
  lastClickBlock.appendChild(lastClickValue);
  clickBand.appendChild(lastClickBlock);

  const simpleCopyRow = createElement('div', ['mt-3', 'flex', 'flex-wrap', 'gap-1.5']);
  const simpleCopyPoseButton = buildCopyButton('Copy pose');
  const simpleCopyCaptureButton = buildCopyButton('Copy click');
  const simpleCopyPlacementsButton = buildCopyButton('Copy placements');
  simpleCopyRow.append(simpleCopyPoseButton, simpleCopyCaptureButton, simpleCopyPlacementsButton);
  clickBand.appendChild(simpleCopyRow);
  simpleView.appendChild(clickBand);
  scrollHost.appendChild(simpleView);

  // --- Detailed view: raw JSON readouts ------------------------------------
  const detailedView = createElement('div', []);

  const cameraSection = buildSection('Camera pose', '02', 1);
  const cameraReadout = createElement('pre', [READOUT_BLOCK_CLASS], '{}');
  const detailedCopyPoseButton = buildCopyButton('Copy JSON');
  cameraSection.body.append(cameraReadout, detailedCopyPoseButton);
  detailedView.appendChild(cameraSection.root);

  const clickSection = buildSection('Click capture', '03', 0);
  const clickSummary = createElement('div', [READOUT_BLOCK_CLASS, 'flex', 'flex-col', 'gap-2']);
  renderEmptyClickCapture(clickSummary);
  const detailedCopyCaptureButton = buildCopyButton('Copy capture JSON');
  clickSection.body.append(clickSummary, detailedCopyCaptureButton);
  detailedView.appendChild(clickSection.root);

  const placementsSection = buildSection('Current segment placements', '04', 1);
  // Wrapper box: text rows on top, optional toggle footer inside the same well.
  const placementsBox = createElement('div', [READOUT_BLOCK_CLASS, 'flex', 'flex-col', 'gap-0', '!p-0', 'overflow-hidden']);
  const placementsList = createElement('div', ['px-2', 'py-2', 'font-mono', 'text-[11px]', 'font-semibold', 'leading-relaxed', 'whitespace-pre-wrap', 'break-all'], '(none)');
  const placementsToggleButton = createElement(
    'button',
    [
      'cursor-pointer',
      'w-full',
      'border-t',
      'border-hud-well-edge',
      'px-2',
      'py-1.5',
      'text-left',
      'text-[10px]',
      'font-extrabold',
      'uppercase',
      'tracking-[0.12em]',
      'text-hud-label',
      'transition-colors',
      'hover:bg-hud-toggle-hover',
      'hover:text-hud-ink',
      'focus-visible:outline',
      'focus-visible:outline-2',
      'focus-visible:-outline-offset-2',
      'focus-visible:outline-hud-focus',
    ],
    'Show all',
  );
  placementsToggleButton.type = 'button';
  placementsToggleButton.hidden = true;
  placementsBox.append(placementsList, placementsToggleButton);
  const detailedCopyPlacementsButton = buildCopyButton('Copy JSON');
  placementsSection.body.append(placementsBox, detailedCopyPlacementsButton);
  detailedView.appendChild(placementsSection.root);
  scrollHost.appendChild(detailedView);

  // --- WSE override: draw the Selected Creek Segment at a chosen elevation ---
  // Shown in both views. Lets you compare how observed and modeled polygons
  // look at the same water-surface elevation.
  scrollHost.appendChild(buildWseOverrideTools(options.attachment, modeledSeam));

  // --- Drainage-Area Ratio Transfer tools (modeled experience only) --------
  // Shown in both views: it is a camera tool, not a readout.
  if (modeledSeam) {
    scrollHost.appendChild(buildDrainageAreaRatioTransferTools(options.view, modeledSeam));
  }

  // --- Station marker gallery (UCS-261): every candidate model on Jalama Road ---
  scrollHost.appendChild(buildStationMarkerGalleryTools(options.view));

  // --- Footer: shared copy feedback ----------------------------------------
  const footer = createElement('footer', [
    'flex',
    'items-center',
    'justify-between',
    'gap-3',
    'border-t',
    'border-hud-rule',
    'bg-hud-band-3',
    'px-4',
    'py-2',
  ]);
  const copyFeedback = createElement('p', ['min-h-4', 'text-[11px]', 'font-bold']);
  copyFeedback.setAttribute('aria-live', 'polite');
  footer.appendChild(copyFeedback);
  footer.appendChild(
    decorative(createElement('span', [MICRO_LABEL_CLASS, FLIGHT_ONLY_CLASS], 'Gate // Jalama 026')),
  );
  scrollHost.appendChild(footer);

  options.container.appendChild(root);

  // Auto-hiding overlay scrollbar: floats over the content, fades when idle.
  OverlayScrollbars(scrollHost, {
    overflow: { x: 'hidden' },
    scrollbars: {
      theme: 'os-theme-hud',
      autoHide: 'move',
      autoHideDelay: 800,
    },
  });

  // --- Style and view toggles ----------------------------------------------
  const applyStyle = (style: HudStyle): void => {
    root.dataset.hudStyle = style;
    styleToggle.setPressed(style === 'classic' ? 0 : 1);
    saveChoice(HUD_STYLE_STORAGE_KEY, style);
  };
  const applyViewMode = (mode: HudViewMode): void => {
    simpleView.hidden = mode !== 'simple';
    detailedView.hidden = mode !== 'detailed';
    viewToggle.setPressed(mode === 'simple' ? 0 : 1);
    saveChoice(HUD_VIEW_MODE_STORAGE_KEY, mode);
  };
  applyStyle(readChoice(HUD_STYLE_STORAGE_KEY, ['classic', 'flight'], 'flight'));
  applyViewMode(readChoice(HUD_VIEW_MODE_STORAGE_KEY, ['simple', 'detailed'], 'simple'));
  styleToggle.buttons[0].addEventListener('click', () => applyStyle('classic'));
  styleToggle.buttons[1].addEventListener('click', () => applyStyle('flight'));
  viewToggle.buttons[0].addEventListener('click', () => applyViewMode('simple'));
  viewToggle.buttons[1].addEventListener('click', () => applyViewMode('detailed'));

  // --- Camera pose: live update on every camera tick -----------------------
  const renderCameraPose = (): void => {
    const pose = seam.cameraPose;
    cameraReadout.textContent = pose ? JSON.stringify(pose, null, 2) : '(camera not ready)';
    attitudeIndicator.update(pose);
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
  // The yellow ring itself lives in dev-tools-click-marker.ts. This block only
  // fills the readout. The dev-server toggle marks the map and then calls
  // captureScreenClick, including for a click made before this panel mounted.

  let lastCapture: HitTestCapture | null = null;
  const captureCopyButtons = [simpleCopyCaptureButton, detailedCopyCaptureButton];
  for (const button of captureCopyButtons) button.disabled = true;

  let renderedDatasetKey = '';
  const renderDatasetAndTime = (): void => {
    const capture = readDatasetAndTime(modeledSeam, options.attachment.selectedTimeUtcMs);
    const serialized = JSON.stringify(capture);
    if (serialized === renderedDatasetKey) return;
    renderedDatasetKey = serialized;
    datasetReadout.textContent = JSON.stringify(capture, null, 2);
  };

  const copyDatasetAndTime = (): void => {
    const capture = readDatasetAndTime(modeledSeam, options.attachment.selectedTimeUtcMs);
    void copyWithFeedback(JSON.stringify(capture, null, 2), copyFeedback, 'Dataset and time copied.');
  };
  copyDatasetButton.addEventListener('click', copyDatasetAndTime);

  const copyAllJson = (): void => {
    const capture = {
      dataset: readDatasetAndTime(modeledSeam, options.attachment.selectedTimeUtcMs),
      cameraPose: seam.cameraPose,
      clickCapture: lastCapture,
    };
    void copyWithFeedback(JSON.stringify(capture, null, 2), copyFeedback, 'All JSON copied.');
  };
  copyAllButton.addEventListener('click', copyAllJson);

  // Modeled only: the Creek Segment the last click landed on or near. Its
  // reading is re-read on every refresh so time scrubbing updates the number.
  let selectedModeledSegment: SelectedModeledSegment | null = null;
  let renderedWaterKey: string | null = null;

  const captureScreenClick = (screen: { x: number; y: number }): void => {
    seam
      .hitTestAtScreen(screen)
      .then((capture) => {
        lastCapture = capture;
        renderClickCapture(capture, clickSummary);
        if (modeledSeam) {
          selectedModeledSegment = pickModeledSegment(capture, modeledSeam);
          const reading = selectedModeledSegment ? modeledSeam.readSegment(selectedModeledSegment.segmentId) : null;
          clickSummary.appendChild(
            buildCaptureRow(
              `Modeled WSE · ${modeledSeam.datasetLabel}`,
              describeModeledReading(reading, selectedModeledSegment).lines,
            ),
          );
          renderedWaterKey = null;
          renderWaterReadouts();
        }
        lastClickValue.textContent = summarizeClickCapture(capture, selectedModeledSegment);
        for (const button of captureCopyButtons) button.disabled = false;
      })
      .catch((error: unknown) => {
        console.error('[dev-tools-hud] hit test failed', error);
        clickSummary.textContent = 'Hit test failed. See console.';
        lastClickValue.textContent = 'Hit test failed. See console.';
      });
  };

  if (panelStartsOpen) {
    options.view.on('click', (event) => {
      clickMarker.noteClick(event.mapPoint);
      captureScreenClick({ x: event.x, y: event.y });
    });
  }

  const copyClickCapture = (): void => {
    if (!lastCapture) return;
    void copyWithFeedback(JSON.stringify(lastCapture, null, 2), copyFeedback, 'Click capture copied.');
  };
  for (const button of captureCopyButtons) button.addEventListener('click', copyClickCapture);

  // --- Water readouts: the active Dataset's reading vs drawn polygon height --
  // Observed: the gauge reading. Modeled: the clicked Creek Segment's modeled
  // water-surface elevation at the selected time.
  const PLACEMENTS_COLLAPSE_ROWS = 5;
  let placementsExpanded = false;
  let allPlacementLines: readonly string[] = [];

  const renderPlacementsList = (fullLines: readonly string[]): void => {
    allPlacementLines = fullLines;
    const hiddenCount = fullLines.length - PLACEMENTS_COLLAPSE_ROWS;
    const shouldTruncate = hiddenCount > 0;
    placementsList.textContent = shouldTruncate && !placementsExpanded
      ? fullLines.slice(0, PLACEMENTS_COLLAPSE_ROWS).join('\n')
      : fullLines.join('\n');
    if (shouldTruncate) {
      placementsToggleButton.hidden = false;
      placementsToggleButton.textContent = placementsExpanded
        ? 'Collapse'
        : `Show all (${hiddenCount} more)`;
    } else {
      placementsToggleButton.hidden = true;
    }
  };

  placementsToggleButton.addEventListener('click', () => {
    placementsExpanded = !placementsExpanded;
    renderPlacementsList(allPlacementLines);
  });

  const renderWaterReadouts = (): void => {
    const placements = seam.segmentPlacements;
    const placementsKey = placements.map((p) => `${p.segmentId}:${p.bucketMinElevationM}`).join(',');
    const placementLines = placements.map(
      (placement) => `${placement.segmentId} → drawn at ${formatPlacementElevation(placement)}`,
    );
    const placementBlock = placementLines.length > 0 ? placementLines : ['(no placements)'];

    if (modeledSeam) {
      const selected = selectedModeledSegment;
      const reading = selected ? modeledSeam.readSegment(selected.segmentId) : null;
      const readingKey = reading
        ? `${reading.segmentId}:${reading.elevationM}:${reading.isLoaded}:${reading.drainageAreaRatioTransfer}`
        : String(selected?.segmentId ?? null);
      const waterKey = `modeled|${modeledSeam.selectedTimeUtcMs}|${readingKey}|${placementsKey}`;
      if (waterKey === renderedWaterKey) return;
      renderedWaterKey = waterKey;

      const view = describeModeledReading(reading, selected);
      waterReadingValue.textContent = view.headline;
      waterDetailLine.textContent = view.detail;
      const selectedPlacement = selected
        ? placements.find((placement) => placement.segmentId === selected.segmentId) ?? null
        : null;
      drawnElevationValue.textContent = selected
        ? describeDrawnElevation(reading?.elevationM ?? null, selectedPlacement)
        : '—';
      const drawnPlacement = placements.find((placement) => placement.bucketMinElevationM != null) ?? null;
      segmentBadge.textContent = readSegmentSuffix(
        selected?.segmentId ?? drawnPlacement?.segmentId ?? placements[0]?.segmentId ?? '—',
      );
      renderPlacementsList([
        `modeled WSE (${modeledSeam.datasetLabel}) → ${view.lines.join(' · ')}`,
        ...placementBlock,
      ]);
      return;
    }

    const observedM = options.attachment.observedWaterSurfaceElevationM;
    const waterKey = `observed|${observedM}|${placementsKey}`;
    if (waterKey === renderedWaterKey) return;
    renderedWaterKey = waterKey;

    waterReadingValue.textContent = observedM == null ? 'No reading' : `${observedM.toFixed(3)} m`;

    const drawnPlacement = placements.find((placement) => placement.bucketMinElevationM != null) ?? null;
    drawnElevationValue.textContent = describeDrawnElevation(observedM, drawnPlacement);
    segmentBadge.textContent = readSegmentSuffix(drawnPlacement?.segmentId ?? placements[0]?.segmentId ?? '—');

    const gaugeLine = `observed WSE → ${observedM == null ? 'none' : `${observedM.toFixed(3)} m NAVD88`}`;
    renderPlacementsList([gaugeLine, ...placementBlock]);
  };
  const refreshLiveReadouts = (): void => {
    renderDatasetAndTime();
    renderWaterReadouts();
  };
  refreshLiveReadouts();
  window.setInterval(refreshLiveReadouts, WATER_READOUT_REFRESH_MS);

  const copyPlacements = (): void => {
    void copyWithFeedback(
      JSON.stringify(seam.segmentPlacements, null, 2),
      copyFeedback,
      'Segment placements copied.',
    );
  };
  simpleCopyPlacementsButton.addEventListener('click', copyPlacements);
  detailedCopyPlacementsButton.addEventListener('click', copyPlacements);

  return {
    root,
    get isOpen() {
      return !root.hidden;
    },
    setOpen(open) {
      clickMarker.setVisible(open);
      root.hidden = !open;
    },
    captureScreenClick,
  };
}

// --- WSE override tools --------------------------------------------------------

const WSE_OVERRIDE_REFRESH_MS = 500;
const WSE_OVERRIDE_NUDGE_M = 0.05;

/**
 * Temporarily draws the Selected Creek Segment's water at a typed
 * water-surface elevation (m NAVD88), using the same prepared polygon the map
 * would pick for that value. Open the same segment in another Dataset, set the
 * same value, and compare screenshots: if the two polygons sit at different
 * heights or shapes, the WSE Polygon Generation Method or the reported WSE
 * values disagree. Clear restores the Dataset's own value. Nothing is saved.
 */
function buildWseOverrideTools(
  attachment: CreekVisualizationAttachment,
  modeledSeam: ModeledExperienceSeam | null,
): HTMLElement {
  const section = buildSection('WSE override', '04b', 2, 'Selected Creek Segment · temporary');
  section.root.id = 'dev-tools-wse-override';

  const target = createElement('p', ['text-sm', 'font-bold'], 'Click creek water to select a segment.');
  const row = createElement('div', ['flex', 'items-center', 'gap-1.5']);
  const input = createElement('input', [
    'w-24',
    'rounded-sm',
    'border',
    'border-hud-well-edge',
    'bg-hud-well',
    'px-2',
    'py-1',
    'font-mono',
    'text-[12px]',
    'font-bold',
    'tabular-nums',
    'text-hud-ink',
    'focus-visible:outline',
    'focus-visible:outline-2',
    'focus-visible:outline-hud-focus',
  ]);
  input.type = 'number';
  input.step = String(WSE_OVERRIDE_NUDGE_M);
  input.inputMode = 'decimal';
  input.setAttribute('aria-label', 'Override water-surface elevation, meters NAVD88');
  const unitLabel = createElement('span', [FIELD_LABEL_CLASS], 'm NAVD88');
  const downButton = buildCopyButton('−');
  downButton.setAttribute('aria-label', `Lower by ${WSE_OVERRIDE_NUDGE_M} m`);
  const upButton = buildCopyButton('+');
  upButton.setAttribute('aria-label', `Raise by ${WSE_OVERRIDE_NUDGE_M} m`);
  row.append(input, unitLabel, downButton, upButton);

  const actionRow = createElement('div', ['flex', 'items-center', 'gap-1.5']);
  const applyButton = buildCopyButton('Apply');
  const clearButton = buildCopyButton('Clear');
  const status = createElement('p', ['ml-auto', 'text-[11px]', 'font-bold', 'text-hud-label']);
  status.setAttribute('aria-live', 'polite');
  actionRow.append(applyButton, clearButton, status);
  section.body.append(target, row, actionRow);

  /**
   * The one override in effect. It belongs to the Selected Creek Segment only:
   * selecting another segment, or clicking away, clears it and that segment's
   * water goes back to the Dataset's value.
   */
  const pins = new Map<string, number>();
  let shownSegmentId: string | null = null;

  const clearPinsExcept = (keepSegmentId: string | null): void => {
    for (const segmentId of [...pins.keys()]) {
      if (segmentId === keepSegmentId) continue;
      pins.delete(segmentId);
      void attachment.pinSegmentWaterSurfaceElevationM(segmentId, null);
    }
  };

  const selectedSegmentId = (): string | null =>
    attachment.selectedCreekSegmentChart?.selection.selectedSegmentId ?? null;

  /** The Dataset's own value for the segment at the selected time, before any pin. */
  const datasetValueM = (segmentId: string): number | null => {
    if (modeledSeam) return modeledSeam.readSegment(segmentId)?.elevationM ?? null;
    return attachment.observedWaterSurfaceElevationM;
  };

  const render = (): void => {
    const segmentId = selectedSegmentId();
    if (segmentId !== shownSegmentId) clearPinsExcept(segmentId);
    const enabled = segmentId !== null;
    for (const control of [input, downButton, upButton, applyButton]) control.disabled = !enabled;
    clearButton.disabled = !enabled || !pins.has(segmentId ?? '');
    if (!segmentId) {
      target.textContent = 'Click creek water to select a segment.';
      shownSegmentId = null;
      return;
    }
    target.textContent = `Creek Segment ${segmentId}`;
    if (segmentId !== shownSegmentId) {
      shownSegmentId = segmentId;
      const start = pins.get(segmentId) ?? datasetValueM(segmentId);
      input.value = start === null ? '' : start.toFixed(2);
    }
    const pinned = pins.get(segmentId);
    status.textContent = pinned === undefined ? 'Dataset value' : `Pinned at ${pinned.toFixed(2)} m`;
  };

  const apply = async (elevationM: number | null): Promise<void> => {
    const segmentId = selectedSegmentId();
    if (!segmentId) return;
    if (elevationM === null) pins.delete(segmentId);
    else pins.set(segmentId, elevationM);
    await attachment.pinSegmentWaterSurfaceElevationM(segmentId, elevationM);
    if (elevationM === null) {
      const value = datasetValueM(segmentId);
      input.value = value === null ? '' : value.toFixed(2);
    }
    render();
  };

  const applyInput = (): void => {
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value)) {
      status.textContent = 'Type a number in meters.';
      return;
    }
    void apply(value);
  };
  const nudge = (deltaM: number): void => {
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value)) return;
    input.value = (value + deltaM).toFixed(2);
    applyInput();
  };

  applyButton.addEventListener('click', applyInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyInput();
  });
  upButton.addEventListener('click', () => nudge(WSE_OVERRIDE_NUDGE_M));
  downButton.addEventListener('click', () => nudge(-WSE_OVERRIDE_NUDGE_M));
  clearButton.addEventListener('click', () => void apply(null));

  render();
  // Polled so a selection change clears the override within half a second, even with the HUD closed.
  window.setInterval(render, WSE_OVERRIDE_REFRESH_MS);
  return section.root;
}

// --- Drainage-Area Ratio Transfer camera tools --------------------------------

/** Camera scale for one framed Creek Segment (about 30 m long). */
const TRANSFER_SEGMENT_SCALE = 1500;
const TRANSFER_SEGMENT_TILT_DEGREES = 55;
const TRANSFER_OVERVIEW_TILT_DEGREES = 35;
/** Minimum half-size of the overview box in degrees, about 100 m, so one cluster still frames. */
const TRANSFER_OVERVIEW_MIN_HALF_SIZE_DEGREES = 0.001;
const TRANSFER_LIST_REFRESH_MS = 1000;
/** The extent whose reviewed crosswalk carries Drainage-Area Ratio Transfer segments. */
const TRANSFER_EXTENT_ID = 'dangermond-preserve';

/** Same page on another extent, keeping the dataset, time, and devtools params. */
function extentPageUrl(extentId: string, current: Location): string {
  const params = new URLSearchParams(current.search);
  params.set(MODELED_EXTENT_QUERY_PARAM, extentId);
  return `${current.pathname}?${params.toString()}${current.hash}`;
}

/**
 * Steps the camera through every Drainage-Area Ratio Transfer segment in the
 * extent, loaded or not: the flags come from the reach crosswalk (which lists
 * every segment) plus any Time Series file loaded so far, and the segment
 * centers from the flowline index. Each step flies the camera there, then
 * loads that flowline. The list is re-read on each press because Time Series
 * flags arrive as flowline files load. Framing all at once is secondary.
 */
function buildDrainageAreaRatioTransferTools(view: SceneView, seam: ModeledExperienceSeam): HTMLElement {
  const section = buildSection(
    DRAINAGE_AREA_RATIO_TRANSFER_DEV_TOOLS_TITLE,
    '05',
    0,
    DRAINAGE_AREA_RATIO_TRANSFER_DEV_TOOLS_SUBTITLE,
  );
  section.root.id = 'dev-tools-transfer-tools';

  const stepRow = createElement('div', ['flex', 'flex-wrap', 'items-center', 'gap-1.5']);
  const nextButton = buildCopyButton('Next side creek ▶');
  nextButton.id = 'dev-tools-transfer-next';
  nextButton.classList.add('px-3', 'py-1.5', 'text-[11px]');
  const previousButton = buildCopyButton('◀ Previous');
  previousButton.id = 'dev-tools-transfer-previous';
  const counter = createElement('span', [FIELD_LABEL_CLASS, 'ml-auto', 'tabular-nums'], '—');
  counter.setAttribute('aria-live', 'polite');
  stepRow.append(nextButton, previousButton, counter);
  const readout = createElement('div', [READOUT_BLOCK_CLASS], 'Reading flagged segments…');
  readout.id = 'dev-tools-transfer-readout';
  const secondaryRow = createElement('div', ['flex', 'items-center', 'justify-between', 'gap-2']);
  const zoomAllButton = buildCopyButton('Frame all');
  zoomAllButton.id = 'dev-tools-transfer-zoom-all';
  // Shown instead of Frame all when this extent has nothing to step through.
  const switchExtentButton = buildCopyButton(DRAINAGE_AREA_RATIO_TRANSFER_SWITCH_EXTENT_LABEL);
  switchExtentButton.id = 'dev-tools-transfer-switch-extent';
  switchExtentButton.classList.add('px-3', 'py-1.5', 'text-[11px]');
  switchExtentButton.hidden = true;
  const status = createElement('p', ['min-h-4', 'text-right', 'text-[11px]', 'font-bold', 'text-hud-label']);
  status.setAttribute('aria-live', 'polite');
  secondaryRow.append(zoomAllButton, switchExtentButton, status);
  section.body.append(stepRow, readout, secondaryRow);

  // Diamond marker on the segment being stepped to, floating just above the ground.
  const markerLayer = new GraphicsLayer({
    id: 'dev-hud-transfer-marker',
    listMode: 'hide',
    elevationInfo: { mode: 'relative-to-ground', offset: 1 },
  });
  view.map?.add(markerLayer);
  const markerSymbol = new SimpleMarkerSymbol({
    style: 'diamond',
    color: [125, 211, 252, 0.35],
    size: 18,
    outline: new SimpleLineSymbol({ color: '#f3ef2a', width: 2 }),
  });

  let segments: readonly DrainageAreaRatioTransferSegment[] = [];
  let currentSegmentId: string | null = null;
  let busy = false;

  const currentIndex = (): number =>
    currentSegmentId === null ? -1 : segments.findIndex((segment) => segment.segmentId === currentSegmentId);

  const render = (): void => {
    const framable = segments.filter((segment) => segment.centerWgs84 !== null).length;
    const index = currentIndex();
    counter.textContent =
      segments.length === 0 ? 'None' : `${index >= 0 ? index + 1 : '—'} of ${segments.length}`;
    previousButton.disabled = framable === 0 || busy;
    nextButton.disabled = framable === 0 || busy;
    zoomAllButton.disabled = framable === 0 || busy;
    const offerSwitch = segments.length === 0 && seam.extentId !== TRANSFER_EXTENT_ID;
    switchExtentButton.hidden = !offerSwitch;
    zoomAllButton.hidden = offerSwitch;
    if (segments.length === 0) {
      readout.textContent = describeNoTransferSegments(seam);
      return;
    }
    const current = index >= 0 ? segments[index] : null;
    if (!current) {
      const unframable = segments.length - framable;
      readout.textContent = [
        `${segments.length} side creek segment${segments.length === 1 ? '' : 's'} with borrowed flow in extent ${seam.extentId}.`,
        unframable > 0 ? `${unframable} without a prepared polygon to frame.` : null,
        'Press Next to fly to the first one; its flowline loads on arrival.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n');
      return;
    }
    readout.textContent = [
      `Segment ${current.segmentId}`,
      DRAINAGE_AREA_RATIO_TRANSFER_READING_NOTE,
      `drainage-area ratio ${formatDrainageAreaRatio(current.drainageAreaRatio)}`,
      current.borrowedReachComid ? `borrows Reach ${current.borrowedReachComid}` : null,
      `marked in ${current.sources.map(describeFlagSource).join(' + ')}`,
      current.centerWgs84 ? null : 'no prepared polygon to frame',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  };

  const refreshList = (): void => {
    segments = seam.listDrainageAreaRatioTransferSegments();
    if (currentIndex() < 0) currentSegmentId = null;
    render();
  };

  const moveCamera = async (
    target: __esri.GoToTarget3D,
    doneMessage: string,
  ): Promise<void> => {
    busy = true;
    render();
    try {
      await view.goTo(target, { duration: 900 });
      status.textContent = `${doneMessage} Loading flowline…`;
    } catch (error) {
      // goTo rejects when the user grabs the camera mid-flight; nothing to repair.
      console.warn('[dev-tools-hud] camera move interrupted', error);
      status.textContent = 'Camera move interrupted.';
    } finally {
      busy = false;
      // Loads the flowline files for whatever is now in view, plus the priority flowline.
      seam.refreshVisibleFlowlines();
      render();
    }
    await seam.whenIdle();
    if (status.textContent.endsWith('Loading flowline…')) {
      status.textContent = `${doneMessage} Flowline loaded.`;
    }
  };

  const frameAll = async (): Promise<void> => {
    refreshList();
    const centers = segments
      .map((segment) => segment.centerWgs84)
      .filter((center): center is readonly [number, number] => center !== null);
    if (centers.length === 0) return;
    currentSegmentId = null;
    markerLayer.removeAll();
    // Load the flagged flowlines even when the overview camera is too far for the per-view cap.
    seam.setPriorityFlowlines(
      segments.filter((segment) => segment.centerWgs84 !== null).map((segment) => segment.tncComid),
    );
    const target: __esri.GoToTarget3D =
      centers.length === 1
        ? { target: groundPoint(centers[0]), scale: TRANSFER_SEGMENT_SCALE, tilt: TRANSFER_SEGMENT_TILT_DEGREES }
        : { target: extentAround(centers), tilt: TRANSFER_OVERVIEW_TILT_DEGREES };
    await moveCamera(
      target,
      `Framed ${centers.length} side creek segment${centers.length === 1 ? '' : 's'} with borrowed flow.`,
    );
  };

  const step = async (delta: 1 | -1): Promise<void> => {
    refreshList();
    if (segments.length === 0) return;
    let index = currentIndex();
    for (let tries = 0; tries < segments.length; tries += 1) {
      index = (index + delta + segments.length) % segments.length;
      if (segments[index].centerWgs84) break;
    }
    const current = segments[index];
    currentSegmentId = current.segmentId;
    render();
    if (!current.centerWgs84) return;
    markerLayer.removeAll();
    markerLayer.add(new Graphic({ geometry: groundPoint(current.centerWgs84), symbol: markerSymbol }));
    seam.setPriorityFlowlines([current.tncComid]);
    await moveCamera(
      { target: groundPoint(current.centerWgs84), scale: TRANSFER_SEGMENT_SCALE, tilt: TRANSFER_SEGMENT_TILT_DEGREES },
      `Camera on ${current.segmentId}.`,
    );
  };

  zoomAllButton.addEventListener('click', () => void frameAll());
  switchExtentButton.addEventListener('click', () => {
    window.location.assign(extentPageUrl(TRANSFER_EXTENT_ID, window.location));
  });
  previousButton.addEventListener('click', () => void step(-1));
  nextButton.addEventListener('click', () => void step(1));

  refreshList();
  window.setInterval(() => {
    if (!busy) refreshList();
  }, TRANSFER_LIST_REFRESH_MS);
  return section.root;
}

/**
 * Opens and closes the Station marker gallery: every candidate 3D station
 * marker lined up along Jalama Road beside the gauge, with status tints to try.
 * The gallery module loads on first open.
 */
function buildStationMarkerGalleryTools(view: SceneView): HTMLElement {
  const section = buildSection('Station marker gallery', '06', 2, 'All candidate 3D markers, on Jalama Road');
  section.root.id = 'dev-tools-station-marker-gallery';

  const toggleButton = buildCopyButton('Show all markers');
  toggleButton.classList.add('px-3', 'py-1.5', 'text-[11px]');
  toggleButton.setAttribute('aria-pressed', 'false');

  const tintRow = createElement('div', [
    'flex',
    'flex-wrap',
    'overflow-hidden',
    'rounded',
    'border',
    'border-hud-button-edge',
  ]);
  tintRow.setAttribute('role', 'group');
  tintRow.setAttribute('aria-label', 'Station status tint');
  tintRow.hidden = true;

  const legend = createElement('ol', [READOUT_BLOCK_CLASS, 'list-decimal', 'pl-6']);
  legend.hidden = true;
  const status = createElement('p', ['min-h-4', 'text-[11px]', 'font-bold', 'text-hud-label']);
  status.setAttribute('aria-live', 'polite');
  section.body.append(toggleButton, tintRow, legend, status);

  let gallery: StationMarkerGallery | null = null;
  let busy = false;

  const setBusy = (value: boolean): void => {
    busy = value;
    toggleButton.disabled = value;
    for (const button of tintRow.querySelectorAll('button')) button.disabled = value;
  };

  const open = async (): Promise<void> => {
    setBusy(true);
    status.textContent = 'Placing markers…';
    try {
      const module = await import('./station-marker-gallery');
      gallery = await module.openStationMarkerGallery(view);
      legend.replaceChildren(
        ...gallery.models.map((model) => createElement('li', [], `${model.label} — ${model.credit}`)),
      );
      tintRow.replaceChildren(
        ...module.STATION_MARKER_STATUS_TINTS.map((tint, index) => {
          const button = buildToggleButton(tint.label);
          button.setAttribute('aria-pressed', String(index === 0));
          button.addEventListener('click', () => {
            if (!gallery || busy) return;
            for (const sibling of tintRow.querySelectorAll('button')) {
              sibling.setAttribute('aria-pressed', String(sibling === button));
            }
            void gallery.setStatusTint(tint.id);
          });
          return button;
        }),
      );
      tintRow.hidden = false;
      legend.hidden = false;
      toggleButton.textContent = 'Hide markers';
      toggleButton.setAttribute('aria-pressed', 'true');
      status.textContent = `${gallery.models.length} markers west of the gauge bridge.`;
    } catch (error) {
      console.warn('[dev-tools-hud] station marker gallery failed', error);
      status.textContent = 'Could not place the markers.';
    } finally {
      setBusy(false);
    }
  };

  const close = async (): Promise<void> => {
    if (!gallery) return;
    setBusy(true);
    try {
      await gallery.close();
    } finally {
      gallery = null;
      tintRow.hidden = true;
      legend.hidden = true;
      toggleButton.textContent = 'Show all markers';
      toggleButton.setAttribute('aria-pressed', 'false');
      status.textContent = '';
      setBusy(false);
    }
  };

  toggleButton.addEventListener('click', () => void (gallery ? close() : open()));
  return section.root;
}

function groundPoint([longitude, latitude]: readonly [number, number]): Point {
  return new Point({ longitude, latitude, spatialReference: { wkid: 4326 } });
}

/** Web Mercator box around the centers, padded by 10% and never smaller than about 200 m. */
function extentAround(centers: readonly (readonly [number, number])[]): Extent {
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (const [lon, lat] of centers) {
    xmin = Math.min(xmin, lon);
    ymin = Math.min(ymin, lat);
    xmax = Math.max(xmax, lon);
    ymax = Math.max(ymax, lat);
  }
  const padX = Math.max((xmax - xmin) * 0.1, TRANSFER_OVERVIEW_MIN_HALF_SIZE_DEGREES);
  const padY = Math.max((ymax - ymin) * 0.1, TRANSFER_OVERVIEW_MIN_HALF_SIZE_DEGREES);
  const geographic = new Extent({
    xmin: xmin - padX,
    ymin: ymin - padY,
    xmax: xmax + padX,
    ymax: ymax + padY,
    spatialReference: { wkid: 4326 },
  });
  const projected = webMercatorUtils.geographicToWebMercator(geographic);
  return projected.type === 'extent' ? (projected as Extent) : geographic;
}

function formatDrainageAreaRatio(ratio: number | null): string {
  if (ratio === null) return 'unknown';
  if (ratio >= 0.01) return ratio.toFixed(3);
  return ratio.toPrecision(2);
}

function describeFlagSource(source: DrainageAreaRatioTransferSegment['sources'][number]): string {
  return source === 'crosswalk' ? 'the reach crosswalk' : 'a loaded Time Series file';
}

/** Why the list is empty, in plain words, with the way out. */
function describeNoTransferSegments(seam: ModeledExperienceSeam): string {
  if (!seam.crosswalkHasTransferFlags) return DRAINAGE_AREA_RATIO_TRANSFER_NO_FLAGS_YET;
  if (seam.extentId === 'jalama-gauge-reach') return DRAINAGE_AREA_RATIO_TRANSFER_NONE_IN_JALAMA_EXTENT;
  return DRAINAGE_AREA_RATIO_TRANSFER_NONE_IN_EXTENT;
}

// --- Modeled water reading (modeled experience only) ---------------------------

/** The Creek Segment a scene click picked: hit directly, or the nearest one within reach. */
interface SelectedModeledSegment {
  segmentId: string;
  /** Null when the click landed on the segment's water; meters from its center otherwise. */
  nearDistanceM: number | null;
}

function pickModeledSegment(capture: HitTestCapture, seam: ModeledExperienceSeam): SelectedModeledSegment | null {
  const waterHit = capture.hits.find((hit) => hit.graphicType === 'water-surface' && hit.segmentId);
  if (waterHit?.segmentId) return { segmentId: waterHit.segmentId, nearDistanceM: null };
  const ground = capture.mapHitWgs84;
  if (!ground) return null;
  const nearest = seam.nearestSegment([ground.longitude, ground.latitude], NEAR_SEGMENT_MAX_DISTANCE_M);
  return nearest ? { segmentId: nearest.segmentId, nearDistanceM: nearest.distanceM } : null;
}

/**
 * One reading, three shapes: the big number, the one-line detail under it, and
 * the lines the detailed view prints. All say the same thing.
 */
function describeModeledReading(
  reading: ModeledSegmentReading | null,
  selected: SelectedModeledSegment | null,
): { headline: string; detail: string; lines: string[] } {
  if (!selected) {
    const hint = 'Click water in the scene to read a Creek Segment.';
    return { headline: '—', detail: hint, lines: [hint] };
  }
  const where =
    selected.nearDistanceM === null
      ? `Segment ${selected.segmentId}`
      : `Segment ${selected.segmentId} (${selected.nearDistanceM.toFixed(0)} m from the click)`;
  if (!reading) {
    const detail = `${where} · not in this extent`;
    return { headline: '—', detail, lines: [detail] };
  }
  const flagged = reading.drainageAreaRatioTransfer ? ` · ${DRAINAGE_AREA_RATIO_TRANSFER_READING_NOTE}` : '';
  if (!reading.isLoaded) {
    const detail = `${where}${flagged} · Time Series not loaded yet`;
    return { headline: '…', detail, lines: [detail] };
  }
  if (reading.elevationM === null) {
    const detail = `${where}${flagged} · no modeled value at this time`;
    return { headline: 'No value', detail, lines: [detail] };
  }
  return {
    headline: `${reading.elevationM.toFixed(3)} m`,
    detail: `${where}${flagged}`,
    lines: [`${where} → ${reading.elevationM.toFixed(3)} m NAVD88${flagged}`],
  };
}

// --- Camera attitude indicator ----------------------------------------------

/**
 * A small ground plane drawn in CSS 3D. It rotates by heading and tips back by
 * tilt, so it shows the ground the way the camera sees it: tilt 0° is a
 * straight-down view (flat disc), tilt 90° looks at the horizon (edge-on).
 */
function buildCameraAttitudeIndicator(): {
  root: HTMLElement;
  update(pose: CameraPoseShape | null): void;
} {
  const root = createElement('figure', [
    'relative',
    'h-32',
    'w-32',
    'overflow-hidden',
    'rounded-sm',
    'border',
    'border-hud-well-edge',
    'bg-hud-well',
    '[perspective:260px]',
  ]);
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', 'Camera orientation');

  const groundPlane = createElement('div', [
    'absolute',
    'inset-0',
    'm-auto',
    'h-24',
    'w-24',
    'rounded-full',
    'border-2',
    'border-hud-ink/70',
    'bg-[linear-gradient(rgb(var(--hud-ink)/0.22)_1px,transparent_1px),linear-gradient(90deg,rgb(var(--hud-ink)/0.22)_1px,transparent_1px)]',
    'bg-[length:12px_12px]',
    'bg-center',
    'transition-transform',
    'duration-150',
    'ease-out',
  ]);
  groundPlane.appendChild(buildCompassLetter('N', ['left-1/2', 'top-0.5', '-translate-x-1/2', 'text-hud-accent']));
  groundPlane.appendChild(buildCompassLetter('E', ['right-1', 'top-1/2', '-translate-y-1/2']));
  groundPlane.appendChild(buildCompassLetter('S', ['bottom-0.5', 'left-1/2', '-translate-x-1/2']));
  groundPlane.appendChild(buildCompassLetter('W', ['left-1', 'top-1/2', '-translate-y-1/2']));
  groundPlane.appendChild(
    decorative(createElement('span', ['absolute', 'inset-0', 'm-auto', 'h-2', 'w-2', 'rounded-full', 'bg-hud-accent'])),
  );
  root.appendChild(groundPlane);

  // Fixed screen-space pointer: the camera looks "up" this figure.
  root.appendChild(
    decorative(
      createElement('span', [
        'absolute',
        'bottom-1',
        'left-1/2',
        '-translate-x-1/2',
        'border-x-[6px]',
        'border-b-[10px]',
        'border-x-transparent',
        'border-b-hud-accent',
      ]),
    ),
  );

  root.appendChild(createElement('figcaption', ['absolute', 'left-1', 'top-0.5', MICRO_LABEL_CLASS], 'Attitude'));

  return {
    root,
    update(pose) {
      if (!pose) {
        groundPlane.style.transform = '';
        return;
      }
      // Rotation order (right to left): spin the ground by heading, then tip it back by tilt.
      groundPlane.style.transform = `rotateX(${pose.tiltDegrees}deg) rotateZ(${-pose.headingDegrees}deg)`;
      root.setAttribute(
        'aria-label',
        `Camera orientation: heading ${pose.headingDegrees.toFixed(0)}°, tilt ${pose.tiltDegrees.toFixed(0)}°`,
      );
    },
  };
}

function buildCompassLetter(letter: string, positionClasses: readonly string[]): HTMLElement {
  return decorative(
    createElement('span', ['absolute', 'text-[10px]', 'font-extrabold', 'leading-none', ...positionClasses], letter),
  );
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

/** Full-bleed section block; `tintIndex` picks which ice blue Flight uses. */
function buildBand(tintIndex: 0 | 1 | 2): HTMLElement {
  return createElement('div', [BAND_CLASS, BAND_TINT_CLASSES[tintIndex]]);
}

/** A labeled two-option segmented control. Each button reports its state with `aria-pressed`. */
function buildSegmentedToggle(
  label: string,
  accessibleGroupLabel: string,
  optionLabels: readonly [string, string],
): {
  root: HTMLElement;
  /** The label span placed in the first grid column. */
  labelEl: HTMLElement;
  /** The button group placed in the second grid column. */
  groupEl: HTMLElement;
  buttons: readonly [HTMLButtonElement, HTMLButtonElement];
  setPressed(index: 0 | 1): void;
} {
  const labelEl = decorative(createElement('span', [MICRO_LABEL_CLASS, 'whitespace-nowrap'], label));
  // `w-full` so both toggle groups fill the same right-column width.
  const groupEl = createElement('div', [
    'flex',
    'w-full',
    'overflow-hidden',
    'rounded',
    'border-2',
    'border-hud-button-edge',
  ]);
  groupEl.setAttribute('role', 'group');
  groupEl.setAttribute('aria-label', accessibleGroupLabel);
  const buttons = [buildToggleButton(optionLabels[0]), buildToggleButton(optionLabels[1])] as const;
  groupEl.append(...buttons);

  // `root` kept for any caller that still appends the whole unit at once.
  const root = createElement('div', ['contents']);
  root.append(labelEl, groupEl);

  return {
    root,
    labelEl,
    groupEl,
    buttons,
    setPressed(index) {
      buttons.forEach((button, buttonIndex) => button.setAttribute('aria-pressed', String(buttonIndex === index)));
    },
  };
}

function buildToggleButton(label: string): HTMLButtonElement {
  const button = createElement(
    'button',
    [
      'cursor-pointer',
      'flex-1',       // equal halves inside the group, so both groups share the same total width
      'whitespace-nowrap',
      'text-center',
      'px-2',
      'py-0.5',
      'text-[10px]',
      'font-extrabold',
      'uppercase',
      'tracking-[0.12em]',
      'text-hud-toggle-ink',
      'transition-colors',
      'hover:bg-hud-toggle-hover',
      'aria-pressed:bg-hud-pressed',
      'aria-pressed:text-hud-on-pressed',
      'aria-pressed:hover:bg-hud-pressed',
      'focus-visible:outline',
      'focus-visible:outline-2',
      'focus-visible:-outline-offset-4',
      'focus-visible:outline-hud-focus',
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
      'rounded',
      'border',
      'border-hud-button-edge',
      'bg-hud-button',
      'px-2',
      'py-1',
      'text-[10px]',
      'font-extrabold',
      'uppercase',
      'tracking-[0.12em]',
      'text-hud-button-ink',
      'transition-colors',
      'hover:bg-hud-button-hover',
      'focus-visible:outline',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-hud-focus',
      'disabled:cursor-not-allowed',
      'disabled:opacity-35',
    ],
    label,
  );
  button.type = 'button';
  return button;
}

function buildSection(
  label: string,
  indexLabel: string,
  tintIndex: 0 | 1 | 2,
  subtitle?: string,
): { root: HTMLElement; body: HTMLElement } {
  const section = createElement('section', [BAND_CLASS, BAND_TINT_CLASSES[tintIndex]]);
  const headingRow = createElement('div', ['mb-2', 'flex', 'items-baseline', 'justify-between', 'gap-2']);
  const headingGroup = createElement('div', ['min-w-0']);
  headingGroup.appendChild(createElement('h3', ['text-sm', 'font-extrabold'], label));
  if (subtitle) headingGroup.appendChild(createElement('p', [MICRO_LABEL_CLASS, 'mt-0.5'], subtitle));
  headingRow.appendChild(headingGroup);
  headingRow.appendChild(decorative(createElement('span', [MICRO_LABEL_CLASS, 'shrink-0'], indexLabel)));
  section.appendChild(headingRow);
  const body = createElement('div', ['flex', 'flex-col', 'gap-2']);
  section.appendChild(body);
  return { root: section, body };
}

/** Appends a definition-list stat and returns its value element. */
function appendStat(list: HTMLElement, label: string): HTMLElement {
  const group = createElement('div', []);
  group.appendChild(createElement('dt', [FIELD_LABEL_CLASS], label));
  const value = createElement('dd', ['text-2xl', 'font-extrabold', 'leading-tight', 'tabular-nums'], '—');
  group.appendChild(value);
  list.appendChild(group);
  return value;
}

// --- Click capture rendering ------------------------------------------------

function renderEmptyClickCapture(summary: HTMLElement): void {
  summary.replaceChildren(createElement('p', ['text-hud-label'], 'Click the scene to capture a hit test.'));
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
  row.appendChild(createElement('span', [FIELD_LABEL_CLASS], label));
  for (const line of lines) {
    row.appendChild(createElement('span', ['break-all'], line));
  }
  return row;
}

/** One-line summary for the Simple view: water hit first, then ground (and the segment near it), then nothing. */
function summarizeClickCapture(capture: HitTestCapture, nearSegment: SelectedModeledSegment | null): string {
  const waterHit = capture.hits.find((hit) => hit.graphicType === 'water-surface');
  if (waterHit) {
    const elevationText = waterHit.bucketMinElevationM == null ? '—' : `${waterHit.bucketMinElevationM} m`;
    return `Water · ${waterHit.segmentId ?? '(unknown)'} @ ${elevationText}`;
  }
  const near =
    nearSegment?.nearDistanceM != null
      ? ` · near ${nearSegment.segmentId} (${nearSegment.nearDistanceM.toFixed(0)} m)`
      : '';
  const groundZ = capture.mapHitWgs84?.z;
  if (groundZ != null) return `Ground @ ${groundZ.toFixed(2)} m${near}`;
  return `No graphics hit${near}`;
}

// --- Dataset and time -------------------------------------------------------

/**
 * Modeled reads the experience seam. Observed reads the gauge Dataset from the
 * picker and the attachment clock, with no extent. Missing pieces stay null.
 */
function readDatasetAndTime(
  modeled: ModeledExperienceSeam | null,
  observedTimeUtcMs: number | null,
): DatasetAndTimeCapture {
  if (modeled) {
    return datasetAndTimeCapture(
      modeled.datasetId,
      modeled.datasetLabel,
      modeled.extentId,
      modeled.selectedTimeUtcMs,
      modeled.wsePolygonMethod,
    );
  }
  const observed = DATASET_PICKER_OPTIONS.find((option) => option.id === OBSERVED_DATASET_OPTION_ID);
  return datasetAndTimeCapture(observed?.id ?? null, observed?.label ?? null, null, observedTimeUtcMs, null);
}

function datasetAndTimeCapture(
  datasetId: string | null,
  datasetLabel: string | null,
  extentId: string | null,
  timeUtcMs: number | null,
  wsePolygonMethod: WsePolygonMethodVersion | null,
): DatasetAndTimeCapture {
  const hasTime = typeof timeUtcMs === 'number' && Number.isFinite(timeUtcMs);
  return {
    datasetId,
    datasetLabel,
    extentId,
    selectedTimeUtc: hasTime ? new Date(timeUtcMs).toISOString() : null,
    selectedTimeLocal: hasTime ? formatObservationTime(timeUtcMs) : null,
    wsePolygonMethod: wsePolygonMethod ? wsePolygonMethodKey(wsePolygonMethod) : null,
    wsePolygonMethodLabel: wsePolygonMethod?.label ?? null,
  };
}

// --- Polygon method (modeled experience only) --------------------------------

/**
 * 'Polygon method' select: every saved WSE Polygon Generation Method version
 * of the extent. Choosing one redraws the water live with that version's
 * polygons; the label and description of the drawn version show underneath.
 */
function buildWsePolygonMethodPicker(seam: ModeledExperienceSeam): HTMLElement {
  const root = createElement('div', ['flex', 'flex-col', 'gap-1']);
  const label = createElement('label', [FIELD_LABEL_CLASS], 'WSE Polygon Generation Method');
  const select = createElement('select', [
    'w-full',
    'cursor-pointer',
    'rounded',
    'border',
    'border-hud-well-edge',
    'bg-hud-well',
    'px-2',
    'py-1',
    'font-mono',
    'text-[11px]',
    'font-semibold',
    'text-hud-ink',
    'focus-visible:outline',
    'focus-visible:outline-2',
    'focus-visible:outline-offset-2',
    'focus-visible:outline-hud-focus',
    'disabled:cursor-wait',
    'disabled:opacity-60',
  ]);
  // Linked so the label names the control for assistive technology.
  select.id = 'dev-tools-wse-polygon-method';
  label.htmlFor = select.id;
  for (const entry of seam.wsePolygonMethods) {
    const option = createElement('option', [], `${entry.label} · v${entry.version}`);
    option.value = wsePolygonMethodKey(entry);
    select.appendChild(option);
  }
  const description = createElement('p', ['text-[11px]', 'font-semibold', 'leading-snug', 'text-hud-label']);
  description.setAttribute('aria-live', 'polite');

  const render = (status?: string): void => {
    const drawn = seam.wsePolygonMethod;
    select.value = wsePolygonMethodKey(drawn);
    const drawing = drawn.browserDrawing === 'sloped-between-junctions' ? 'drawn sloped between junctions' : 'drawn flat';
    description.textContent = [
      `${drawn.label} (${wsePolygonMethodKey(drawn)}, ${drawing}).`,
      drawn.description,
      status ?? null,
    ]
      .filter((line): line is string => line !== null && line.length > 0)
      .join(' ');
  };

  select.addEventListener('change', () => {
    const key = select.value;
    select.disabled = true;
    render('Loading…');
    seam
      .setWsePolygonMethod(key)
      .then(() => render())
      .catch((error: unknown) => {
        console.error('[dev-tools-hud] polygon method switch failed', error);
        render(`Switch failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        select.disabled = false;
      });
  });

  render();
  root.append(label, select, description);
  return root;
}

// --- Formatting -------------------------------------------------------------

function formatPlacementElevation(placement: SegmentPlacementShape): string {
  return placement.bucketMinElevationM == null ? 'hidden' : `${placement.bucketMinElevationM.toFixed(3)} m`;
}

/**
 * The drawn polygon sits at its prepared bucket's floor, so it can be a few
 * centimeters below the gauge reading. Show both and the gap.
 */
function describeDrawnElevation(observedM: number | null, drawnPlacement: SegmentPlacementShape | null): string {
  const drawnM = drawnPlacement?.bucketMinElevationM;
  if (drawnM == null) return 'Not drawn';
  if (observedM == null) return `Drawn ${drawnM.toFixed(2)} m`;
  const gapCm = (drawnM - observedM) * 100;
  const gapText = `${gapCm >= 0 ? '+' : '−'}${Math.abs(gapCm).toFixed(1)} cm`;
  return `Drawn ${drawnM.toFixed(2)} m (${gapText})`;
}

/** `27714637-026` → `026`. Falls back to the whole id when there is no dash. */
function readSegmentSuffix(segmentId: string): string {
  const dashIndex = segmentId.lastIndexOf('-');
  return dashIndex === -1 ? segmentId : segmentId.slice(dashIndex + 1);
}

// --- Toggle persistence -------------------------------------------------------

function readChoice<T extends string>(storageKey: string, allowed: readonly T[], fallback: T): T {
  try {
    const saved = localStorage.getItem(storageKey);
    return allowed.find((choice) => choice === saved) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveChoice(storageKey: string, choice: string): void {
  try {
    localStorage.setItem(storageKey, choice);
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
