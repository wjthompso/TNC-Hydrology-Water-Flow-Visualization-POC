// Developer-only HUD. Mounted from the Dev tools corner button
// (dev-tools-toggle.ts) when dev tools are enabled. `?devtools` opens it on
// load in that same case. Reads from `window.__TNC_TEST__` so the HUD and future
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
// Dataset and time sits above both views. In the modeled experience the
// 'Derived data products' section below it picks the modeled WSE version and
// the WSE polygon version drawn on the map, live, and lists which versions are
// saved and which are not generated yet. Copy all JSON bundles the dataset
// readout (with the drawn versions), the camera pose, and the last click capture.

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
import type { BarrierMarkerGallery } from './barrier-marker-gallery';
import type { FishBarrierMap, FishBarrierSite } from './fish-barrier-map';
import { currentFishBarrierMap, onFishBarrierMapChange } from './fish-barrier-state';
import { drawsSolidShape } from './fish-barrier-sites';
import type { StationMarkerGallery } from './station-marker-gallery';
import type { DevToolsClickMarker } from './dev-tools-click-marker';
import { createDevToolsClickMarker } from './dev-tools-click-marker';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';
import { displayDepthFloorDescription } from './display-depth-floor';
import { anchorClearanceRuleDescription, ribbonDisplayRuleDescription } from './channel-ribbon-surface';
import { sampleBrowserTerrain } from './browser-terrain-sampler';
import { lidarGroundKey, lookUpLidarGround, type LidarGroundLookup } from './dev-lidar-ground-client';
import { createDevToolsInfoTips, type DevToolsInfoTips, type InfoTipSource } from './dev-tools-info-tip';
import {
  ANCHOR_BED_MARKER_TIP,
  ANCHOR_LIDAR_GROUND_MARKER_TIP,
  ANCHOR_WATER_MARKER_TIP,
  DRAWN_ELEVATION_TIP,
  SEGMENT_BADGE_TIP,
  SEGMENT_PLACEMENTS_TIP,
  WATER_CLICK_INSPECTOR_TIP,
  WATER_SURFACE_READING_TIP_MODELED,
  WATER_SURFACE_READING_TIP_OBSERVED,
  WSE_OVERRIDE_ANCHOR_UNIT_TIP,
  WSE_OVERRIDE_PLAIN_UNIT_TIP,
  WSE_OVERRIDE_STATUS_TIP,
  WSE_OVERRIDE_TARGET_TIP,
  WSE_OVERRIDE_TIP,
} from './dev-tools-metric-tips';
import { createWaterAnchorMarker, type WaterAnchorMarkerPosition } from './dev-tools-water-anchor-marker';
import type { ModeledSegmentInspection } from './modeled-segment-inspection';
import { readWaterLevelUnit, saveWaterLevelUnit, type WaterLevelUnit } from './water-level-units';
import {
  buildWaterClickReadout,
  readoutRowGroups,
  sampleDrawnPolygon,
  type ClickedPoint,
  type GroundSamples,
  type InspectorGroup,
  type InspectorRow,
  type TerrainSample,
  type WaterClickReadout,
} from './water-click-readout';
import {
  derivedDataGroupOf,
  derivedDataSelectionKey,
  drawnModeledWsePathOf,
  drawsDepthBuckets,
  preferredPolygonVersionOf,
  wsePolygonMethodKey,
  type WsePolygonMethodVersion,
} from './wse-polygon-generation-methods';

interface DevToolsHudOptions {
  view: SceneView;
  attachment: CreekVisualizationAttachment;
  container: HTMLElement;
  /**
   * `top` (default) pins the HUD to the top-right corner. `below-dev-tools-toggle`
   * leaves room above it for the development-server toggle button only; the HUD
   * then covers the imagery widget stacked under that button, so closing the HUD
   * brings the imagery widget back.
   */
  placement?: 'top' | 'below-dev-tools-toggle';
  /**
   * When the corner toggle already tracks clicks, it owns the marker and
   * forwards clicks here. A mount without a marker creates one.
   */
  clickMarker?: DevToolsClickMarker;
  /** Ending it removes the panel, its timers, and its map layers. The view stays. */
  lifetime?: ExperienceLifetime;
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
  /** `bed-parallel-depth` methods only: the drawn bucket's minimum water depth, m. */
  bucketMinDepthM?: number | null;
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
  /** Modeled only: the modeled WSE version folder the drawn polygons pair with, e.g. `m2-multi-section-manning-depth/v1`. */
  modeledWseVersionPath: string | null;
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
  const lifetime = options.lifetime ?? createExperienceLifetime();
  const clickMarker = options.clickMarker ?? createDevToolsClickMarker(options.view, lifetime);
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
    belowToggle ? 'top-14' : 'top-4',
    // Above the imagery widget (z-30), which sits in the same spot and stays hidden while the panel is open.
    'z-40',
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
  // One shared popover for every "(i)" button; it lives on the root so the scrolling body never clips it.
  const infoTips = createDevToolsInfoTips(root);

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
  datasetSection.body.append(datasetReadout, copyDatasetButton);
  scrollHost.appendChild(datasetSection.root);

  // --- Derived data products: which modeled WSE version and polygons are drawn ---
  if (modeledSeam) scrollHost.appendChild(buildDerivedDataProductsTools(modeledSeam));

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
  const segmentCaption = createElement('span', [MICRO_LABEL_CLASS], 'Segment');
  segmentCaption.append(infoTips.create({ subject: 'Segment', text: SEGMENT_BADGE_TIP }));
  segmentBadgeGroup.append(segmentBadge, segmentCaption);
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
  const waterSurfaceLabel = createElement('p', ['text-sm', 'font-bold'], 'Water surface:');
  waterSurfaceLabel.append(
    infoTips.create({
      subject: 'Water surface',
      text: modeledSeam ? WATER_SURFACE_READING_TIP_MODELED : WATER_SURFACE_READING_TIP_OBSERVED,
      source: modeledSeam ? 'model' : null,
    }),
  );
  waterBand.appendChild(waterSurfaceLabel);
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
  // The value's text is replaced on every refresh, so its "(i)" sits beside it, not inside it.
  const drawnElevationGroup = createElement('span', ['flex', 'shrink-0', 'items-baseline', 'gap-1']);
  drawnElevationGroup.append(
    infoTips.create({ subject: 'Drawn elevation', text: DRAWN_ELEVATION_TIP, source: 'drawn' }),
    drawnElevationValue,
  );
  waterCaptionRow.appendChild(drawnElevationGroup);
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

  const placementsSection = buildSection(
    'Current segment placements',
    '04',
    1,
    undefined,
    infoTips.create({ subject: 'Current segment placements', text: SEGMENT_PLACEMENTS_TIP }),
  );
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

  // --- Water click inspector: the numbers behind a click on modeled water ------
  // Shown in both views. Marks the selected segment's WSE Anchor Point in the scene.
  const waterInspector = buildWaterClickInspector({
    view: options.view,
    attachment: options.attachment,
    modeledSeam,
    lifetime,
    infoTips,
    copyJson: (text) => void copyWithFeedback(text, copyFeedback, 'Water click readout copied.'),
  });
  waterInspector.setOpen(panelStartsOpen);
  scrollHost.appendChild(waterInspector.root);

  // --- WSE override: draw the Selected Creek Segment at a chosen elevation ---
  // Shown in both views. Lets you compare how observed and modeled polygons
  // look at the same water-surface elevation.
  scrollHost.appendChild(buildWseOverrideTools(options.attachment, modeledSeam, lifetime, infoTips));

  // --- Drainage-Area Ratio Transfer tools (modeled experience only) --------
  // Shown in both views: it is a camera tool, not a readout.
  if (modeledSeam) {
    scrollHost.appendChild(buildDrainageAreaRatioTransferTools(options.view, modeledSeam, lifetime));
  }

  // --- Station marker gallery (UCS-261): every candidate model on Jalama Road ---
  scrollHost.appendChild(buildStationMarkerGalleryTools(options.view, lifetime));

  // --- Fish barrier models: candidate 3D barriers on Jalama Creek beside the gauge ---
  scrollHost.appendChild(buildBarrierMarkerGalleryTools(options.view, lifetime));

  // --- Fish barriers: a picker and size readout for the barriers the sidebar checkbox draws ---
  scrollHost.appendChild(buildFishBarrierMapTools(lifetime));

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
  lifetime.onEnd(() => root.remove());

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
  const cameraWatch = watch(
    () => options.view.camera,
    () => renderCameraPose(),
  );
  lifetime.onEnd(() => cameraWatch.remove());

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
      waterClickInspector: waterInspector.snapshot(),
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
        waterInspector.noteClick(capture, selectedModeledSegment);
        for (const button of captureCopyButtons) button.disabled = false;
      })
      .catch((error: unknown) => {
        console.error('[dev-tools-hud] hit test failed', error);
        clickSummary.textContent = 'Hit test failed. See console.';
        lastClickValue.textContent = 'Hit test failed. See console.';
      });
  };

  if (panelStartsOpen) {
    const clickHandle = options.view.on('click', (event) => {
      clickMarker.noteClick(event.mapPoint);
      captureScreenClick({ x: event.x, y: event.y });
    });
    lifetime.onEnd(() => clickHandle.remove());
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
  lifetime.every(refreshLiveReadouts, WATER_READOUT_REFRESH_MS);

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
      waterInspector.setOpen(open);
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
  lifetime: ExperienceLifetime,
  infoTips: DevToolsInfoTips,
): HTMLElement {
  const section = buildSection(
    'WSE override',
    '04b',
    2,
    'Selected Creek Segment · temporary',
    infoTips.create({ subject: 'WSE override', text: WSE_OVERRIDE_TIP }),
  );
  section.root.id = 'dev-tools-wse-override';

  const target = createElement('p', ['text-sm', 'font-bold'], 'Click creek water to select a segment.');
  // The target's text is replaced on every render, so its "(i)" sits beside it, not inside it.
  const targetRow = createElement('div', ['flex', 'items-baseline']);
  targetRow.append(target, infoTips.create({ subject: 'Creek Segment', text: WSE_OVERRIDE_TARGET_TIP }));
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
  // Its wording depends on the active method, so the "(i)" is swapped in render.
  const unitTipHost = createElement('span', []);
  const anchorUnitTip = infoTips.create({ subject: 'anchor WSE', text: WSE_OVERRIDE_ANCHOR_UNIT_TIP, source: 'model' });
  const plainUnitTip = infoTips.create({ subject: 'm NAVD88', text: WSE_OVERRIDE_PLAIN_UNIT_TIP });
  const downButton = buildCopyButton('−');
  downButton.setAttribute('aria-label', `Lower by ${WSE_OVERRIDE_NUDGE_M} m`);
  const upButton = buildCopyButton('+');
  upButton.setAttribute('aria-label', `Raise by ${WSE_OVERRIDE_NUDGE_M} m`);
  row.append(input, unitLabel, unitTipHost, downButton, upButton);

  const actionRow = createElement('div', ['flex', 'items-center', 'gap-1.5']);
  const applyButton = buildCopyButton('Apply');
  const clearButton = buildCopyButton('Clear');
  const status = createElement('p', ['text-[11px]', 'font-bold', 'text-hud-label']);
  status.setAttribute('aria-live', 'polite');
  const statusGroup = createElement('div', ['ml-auto', 'flex', 'items-baseline']);
  statusGroup.append(status, infoTips.create({ subject: 'WSE override status', text: WSE_OVERRIDE_STATUS_TIP }));
  actionRow.append(applyButton, clearButton, statusGroup);
  section.body.append(targetRow, row, actionRow);
  const displayFloorDescription = displayDepthFloorDescription();
  if (displayFloorDescription) {
    section.body.append(createElement('p', ['text-[11px]', 'font-bold', 'text-hud-label'], displayFloorDescription));
  }

  /** Bed-parallel-depth methods read the typed value as the WSE at the segment's anchor point. */
  const pinIsAnchorWse = (): boolean => (modeledSeam ? drawsDepthBuckets(modeledSeam.wsePolygonMethod.browserDrawing) : false);

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

  /** Only swaps when the wording changes, so a focused "(i)" keeps keyboard focus through the 500 ms refresh. */
  const showUnitTip = (anchorWse: boolean): void => {
    const wanted = anchorWse ? anchorUnitTip : plainUnitTip;
    if (unitTipHost.firstChild !== wanted) unitTipHost.replaceChildren(wanted);
  };

  const render = (): void => {
    const segmentId = selectedSegmentId();
    if (segmentId !== shownSegmentId) clearPinsExcept(segmentId);
    const enabled = segmentId !== null;
    for (const control of [input, downButton, upButton, applyButton]) control.disabled = !enabled;
    clearButton.disabled = !enabled || !pins.has(segmentId ?? '');
    if (!segmentId) {
      target.textContent = 'Click creek water to select a segment.';
      showUnitTip(false);
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
    const anchorWse = pinIsAnchorWse();
    unitLabel.textContent = anchorWse ? 'm NAVD88 · anchor WSE' : 'm NAVD88';
    showUnitTip(anchorWse);
    status.textContent =
      pinned === undefined ? 'Dataset value' : `Pinned at ${pinned.toFixed(2)} m${anchorWse ? ' (anchor WSE)' : ''}`;
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
  lifetime.every(render, WSE_OVERRIDE_REFRESH_MS);
  return section.root;
}

// --- Water click inspector -----------------------------------------------------

const WATER_INSPECTOR_REFRESH_MS = 250;
const WATER_INSPECTOR_EMPTY_TEXT =
  'Click a water polygon to read its drawn height, depth, and the terrain under it.';
const WATER_INSPECTOR_NO_SELECTION_TEXT =
  'Anchor flag: the selected Creek Segment gets a pink flag at its anchor point (click its water).';

interface WaterClickInspectorOptions {
  view: SceneView;
  attachment: CreekVisualizationAttachment;
  /** Null in the observed experience, which has no modeled segments to inspect. */
  modeledSeam: ModeledExperienceSeam | null;
  lifetime: ExperienceLifetime;
  /** The HUD's shared "(i)" popover, for the tooltip on every row and heading. */
  infoTips: DevToolsInfoTips;
  copyJson(text: string): void;
}

interface WaterClickInspectorHandle {
  root: HTMLElement;
  /** Fills or clears the readout for a click the HUD just hit-tested. */
  noteClick(capture: HitTestCapture, picked: SelectedModeledSegment | null): void;
  /** Shows the anchor marker and refreshes while the panel is open; hides the marker otherwise. */
  setOpen(open: boolean): void;
  /** The readout for the last click, for Copy all JSON; null before any click or without a modeled Dataset. */
  snapshot(): WaterClickReadout | null;
}

/** The last click on water: where it landed, the segment it belongs to, and the ground sampled under it. */
interface InspectedClick {
  point: ClickedPoint;
  segmentId: string;
  terrain: TerrainSample | null;
  /** 1 m lidar under the click, from the dev server. */
  lidar: LidarGroundLookup;
}

/** Ground sampled at one segment's anchor point: the browser terrain and the dev server's 1 m lidar. */
interface AnchorGroundEntry {
  terrain: TerrainSample | null;
  lidar: LidarGroundLookup;
}

/** Same layer id the modeled and observed renderers give their water graphics. */
const WATER_POLYGON_LAYER_ID = 'water-surface-elevation-polygons';

/** The water polygon under a screen point, tested against the water layer alone, as the segment selection does. */
async function hitWaterLayer(
  view: SceneView,
  screen: { x: number; y: number },
): Promise<{ segmentId: string; point: { longitude: number; latitude: number; z: number | null } } | null> {
  const layer = view.map?.findLayerById(WATER_POLYGON_LAYER_ID);
  if (!layer) return null;
  try {
    const result = await view.hitTest(screen, { include: [layer] });
    for (const hit of result.results) {
      if (hit.type !== 'graphic') continue;
      const segmentId: unknown = hit.graphic?.attributes?.segmentId;
      const mapPoint = hit.mapPoint;
      if (typeof segmentId !== 'string' || !mapPoint) continue;
      const geographic =
        mapPoint.spatialReference?.wkid === 4326
          ? mapPoint
          : (webMercatorUtils.webMercatorToGeographic(mapPoint) as Point | null);
      if (!geographic || typeof geographic.longitude !== 'number' || typeof geographic.latitude !== 'number') continue;
      const z = typeof geographic.z === 'number' && Number.isFinite(geographic.z) ? geographic.z : null;
      return { segmentId, point: { longitude: geographic.longitude, latitude: geographic.latitude, z } };
    }
  } catch (error) {
    console.warn('[dev-tools-hud] water layer hit test failed', error);
  }
  return null;
}

/**
 * 'Water click inspector': clicking water fills a labeled table of the drawn water height and polygon
 * bottom at the click, the browser terrain under it, and the segment's modeled values at the selected
 * time. The selected segment's WSE Anchor Point is marked in the scene with a pink flag. The map layer
 * and the 4 Hz refresh only act while the panel is open. Modeled Datasets only.
 */
function buildWaterClickInspector(options: WaterClickInspectorOptions): WaterClickInspectorHandle {
  const { view, attachment, modeledSeam, lifetime, infoTips } = options;
  const section = buildSection(
    'Water click inspector',
    '04a',
    1,
    'Click water · heights m or ft NAVD88',
    infoTips.create({ subject: 'Water click inspector', text: WATER_CLICK_INSPECTOR_TIP }),
  );
  section.root.id = 'dev-tools-water-click-inspector';

  if (!modeledSeam) {
    section.body.append(
      createElement(
        'p',
        ['text-[11px]', 'font-bold', 'text-hud-label'],
        'Needs a modeled Dataset, for example ?dataset=national-water-model-hourly.',
      ),
    );
    return { root: section.root, noteClick() {}, setOpen() {}, snapshot: () => null };
  }

  const marker = createWaterAnchorMarker(view, lifetime);
  const status = createElement('p', ['text-[11px]', 'font-bold'], WATER_INSPECTOR_EMPTY_TEXT);
  status.id = 'dev-tools-water-click-status';
  status.setAttribute('aria-live', 'polite');
  const markerNote = createElement('p', ['text-[11px]', 'font-semibold', 'text-hud-label'], WATER_INSPECTOR_NO_SELECTION_TEXT);
  markerNote.id = 'dev-tools-water-anchor-note';
  // Built once: the note's text is replaced on every refresh, which would drop "(i)" buttons placed inside it.
  const markerLegend = createElement('p', ['hidden', 'flex', 'flex-wrap', 'items-center', 'gap-x-3', 'gap-y-1', 'text-[11px]', 'font-semibold', 'text-hud-label']);
  markerLegend.id = 'dev-tools-water-anchor-legend';
  const legendItem = (swatchClasses: string[], text: string, tip: string, source: InfoTipSource): HTMLElement => {
    const item = createElement('span', ['inline-flex', 'items-center', 'gap-1']);
    item.append(decorative(createElement('span', ['inline-block', 'size-2', 'shrink-0', ...swatchClasses])), text);
    item.append(infoTips.create({ subject: text, text: tip, source }));
    return item;
  };
  markerLegend.append(
    legendItem(['rounded-full', 'bg-[#ff2d95]', 'ring-1', 'ring-white'], 'Pink dot: water drawn', ANCHOR_WATER_MARKER_TIP, 'drawn'),
    legendItem(['rounded-full', 'bg-white', 'ring-1', 'ring-[#ff2d95]'], 'White dot: pipeline bed estimate', ANCHOR_BED_MARKER_TIP, 'model'),
    legendItem(['rotate-45', 'bg-[#22c55e]', 'ring-1', 'ring-white'], 'Green diamond: 1 m lidar ground', ANCHOR_LIDAR_GROUND_MARKER_TIP, 'lidar-ground'),
  );
  const unitToggle = buildSegmentedToggle('Units', 'Height unit', ['m', 'ft']);
  const unitRow = createElement('div', ['grid', 'grid-cols-[auto_1fr]', 'items-center', 'gap-x-3']);
  unitRow.append(unitToggle.labelEl, unitToggle.groupEl);
  const rowsHost = createElement('div', ['flex', 'flex-col', 'gap-2']);
  rowsHost.id = 'dev-tools-water-click-rows';
  const copyButton = buildCopyButton('Copy JSON');
  copyButton.disabled = true;
  section.body.append(status, markerNote, markerLegend, unitRow, rowsHost, copyButton);

  let open = false;
  let unit: WaterLevelUnit = readWaterLevelUnit();
  let clicked: InspectedClick | null = null;
  let latestReadout: WaterClickReadout | null = null;
  let markerKey = '';
  let renderedKey = '';
  /** Bumped when ground sampling lands, so the table redraws with the terrain rows. */
  let terrainVersion = 0;
  /**
   * Ground sampled at anchor points, by rounded position, so a redraw never asks the map or the dev server twice.
   * Emptied on every click: the drawn terrain mesh refines as tiles load, so a click re-reads it (the lidar client
   * keeps its own answers, so the dev server is not asked again).
   */
  const anchorGroundByKey = new Map<string, AnchorGroundEntry>();
  const extentId = modeledSeam.extentId;
  /** Bumped on every click, so a slow hit test from an earlier click is dropped. */
  let clickToken = 0;

  /** One label · value line with its "(i)" tip. */
  const buildRowLine = (item: InspectorRow): HTMLElement => {
    const line = createElement('div', [
      'flex',
      'items-baseline',
      'justify-between',
      'gap-3',
      'border-b',
      'border-hud-well-edge',
      'py-0.5',
    ]);
    const toneClasses =
      item.tone === 'alert'
        ? ['text-red-700', 'group-data-[hud-style=classic]:text-red-300']
        : item.tone === 'muted'
          ? ['text-hud-label']
          : ['text-hud-ink'];
    const labelEl = createElement('span', ['text-[11px]', 'font-semibold', 'text-hud-label'], item.label);
    labelEl.append(infoTips.create({ subject: item.label, text: item.hint, source: item.source, focusKey: `row-${item.label}` }));
    line.append(
      labelEl,
      createElement(
        'span',
        ['max-w-[58%]', 'shrink-0', 'break-words', 'text-right', 'font-mono', 'text-[11px]', 'font-bold', 'tabular-nums', ...toneClasses],
        item.value,
      ),
    );
    return line;
  };

  const renderRows = (groups: readonly InspectorGroup[]): void => {
    // The rows are rebuilt on every change (unit, time, terrain), so keep a focused "(i)" focused.
    const focusedTipKey = rowsHost.querySelector<HTMLElement>('[data-info-tip-focus-key]:focus')?.dataset.infoTipFocusKey;
    infoTips.hide();
    rowsHost.replaceChildren(
      ...groups.map((group, groupIndex) => {
        const block = createElement('div', ['flex', 'flex-col']);
        const headingRow = createElement('div', ['mb-0.5', 'flex', 'items-center']);
        headingRow.append(
          createElement('h4', [MICRO_LABEL_CLASS], group.heading),
          infoTips.create({ subject: group.heading, text: group.hint, focusKey: `group-${groupIndex}` }),
        );
        block.appendChild(headingRow);
        if (group.intro) block.appendChild(createElement('p', ['mb-1', 'text-[10px]', 'font-semibold', 'leading-snug', 'text-hud-label'], group.intro));
        group.rows.forEach((item) => block.appendChild(buildRowLine(item)));
        (group.subGroups ?? []).forEach((subGroup, subIndex) => {
          const subBlock = createElement('div', ['mt-2', 'flex', 'flex-col', 'border-l-2', 'border-hud-well-edge', 'pl-2']);
          const subHeading = createElement('div', ['mb-0.5', 'flex', 'items-center']);
          subHeading.append(
            createElement('h5', [MICRO_LABEL_CLASS], subGroup.heading),
            infoTips.create({ subject: subGroup.heading, text: subGroup.hint, focusKey: `group-${groupIndex}-sub-${subIndex}` }),
          );
          subBlock.appendChild(subHeading);
          subGroup.rows.forEach((item) => subBlock.appendChild(buildRowLine(item)));
          block.appendChild(subBlock);
        });
        return block;
      }),
    );
    if (focusedTipKey) {
      // Not a selector string: row labels hold quotes and parentheses.
      const sameTip = [...rowsHost.querySelectorAll<HTMLElement>('[data-info-tip-focus-key]')].find(
        (button) => button.dataset.infoTipFocusKey === focusedTipKey,
      );
      sameTip?.focus({ preventScroll: true });
    }
  };

  /**
   * The ground sampled at an anchor point. The first call for a position starts the browser-terrain sample and the
   * dev lidar lookup (only while the panel is open, since callers are the open panel's refresh); each answer redraws.
   */
  const anchorGroundAt = (lonLat: readonly [number, number]): AnchorGroundEntry => {
    const key = lidarGroundKey(extentId, lonLat[0], lonLat[1]);
    const known = anchorGroundByKey.get(key);
    if (known) return known;
    const entry: AnchorGroundEntry = { terrain: null, lidar: { status: 'pending' } };
    anchorGroundByKey.set(key, entry);
    const noteSampled = (): void => {
      terrainVersion += 1;
      refresh();
    };
    void sampleBrowserTerrain(view, lonLat[0], lonLat[1]).then((terrain) => {
      entry.terrain = terrain;
      noteSampled();
    });
    void lookUpLidarGround(extentId, lonLat[0], lonLat[1]).then((lidar) => {
      entry.lidar = lidar;
      noteSampled();
    });
    return entry;
  };

  /** The drawn water height at the anchor (falls back to the Time Series value when nothing is drawn). */
  const markerPositionOf = (inspection: ModeledSegmentInspection): WaterAnchorMarkerPosition | null => {
    const lonLat = inspection.anchor.lonLat;
    if (!lonLat) return null;
    const drawn = sampleDrawnPolygon(inspection, lonLat[0], lonLat[1]);
    const waterSurfaceM = drawn?.waterSurfaceM ?? inspection.timeSeriesWseM;
    if (waterSurfaceM === null) return null;
    const lidar = anchorGroundAt(lonLat).lidar;
    return {
      longitude: lonLat[0],
      latitude: lonLat[1],
      waterSurfaceM,
      bedM: inspection.anchor.bedElevationM,
      groundM: lidar.status === 'found' ? (lidar.heights.bilinearM ?? lidar.heights.nearestCellM) : null,
    };
  };

  const describeMarker = (inspection: ModeledSegmentInspection | null, position: WaterAnchorMarkerPosition | null): string => {
    if (!inspection) return WATER_INSPECTOR_NO_SELECTION_TEXT;
    if (!inspection.anchor.lonLat) {
      return `No flag: ${inspection.wsePolygonMethod} never saved where segment ${inspection.segmentId}'s anchor point is.`;
    }
    if (!position) return `No flag: segment ${inspection.segmentId} has no modeled water value at this time.`;
    const source =
      inspection.anchor.positionSource === 'ribbon-polygon-file'
        ? 'position saved with the ribbon'
        : 'position estimated at the chord midpoint';
    return `Pink flag: segment ${inspection.segmentId}'s anchor point (${source}).`;
  };

  /** The marker follows the Selected Creek Segment: it stays across time changes and goes when the selection clears. */
  const refreshMarker = (): void => {
    const selectedId = attachment.selectedCreekSegmentChart?.selection.selectedSegmentId ?? null;
    const inspection = selectedId ? modeledSeam.inspectSegment(selectedId) : null;
    const key = inspection ? `${inspection.revisionKey}|${terrainVersion}` : 'none';
    if (key === markerKey) return;
    markerKey = key;
    const position = inspection ? markerPositionOf(inspection) : null;
    marker.show(position);
    markerNote.textContent = describeMarker(inspection, position);
    markerLegend.classList.toggle('hidden', position === null);
  };

  const refreshReadout = (): void => {
    if (!clicked) {
      if (renderedKey === 'empty') return;
      renderedKey = 'empty';
      latestReadout = null;
      copyButton.disabled = true;
      status.textContent = WATER_INSPECTOR_EMPTY_TEXT;
      rowsHost.replaceChildren();
      return;
    }
    const inspection = modeledSeam.inspectSegment(clicked.segmentId);
    if (!inspection) {
      renderedKey = 'not-in-extent';
      latestReadout = null;
      copyButton.disabled = true;
      status.textContent = `Segment ${clicked.segmentId} is not in this extent.`;
      rowsHost.replaceChildren();
      return;
    }
    const key = `${inspection.revisionKey}|${terrainVersion}|${unit}`;
    if (key === renderedKey) return;
    renderedKey = key;
    const anchorLonLat = inspection.anchor.lonLat;
    const anchorGround = anchorLonLat ? anchorGroundAt(anchorLonLat) : null;
    const ground: GroundSamples = {
      lidarAtClick: clicked.lidar,
      anchorTerrain: anchorGround?.terrain ?? null,
      anchorLidar: anchorGround?.lidar ?? { status: 'pending' },
    };
    latestReadout = buildWaterClickReadout(inspection, clicked.point, clicked.terrain, ground);
    copyButton.disabled = false;
    status.textContent =
      clicked.point.landedOn === 'water-polygon'
        ? `Segment ${inspection.segmentId} · ${inspection.selectedTimeUtc}`
        : `Missed the water: showing the nearest segment, ${inspection.segmentId}.`;
    renderRows(readoutRowGroups(latestReadout, unit));
  };

  const refresh = (): void => {
    if (!open) return;
    unit = readWaterLevelUnit();
    unitToggle.setPressed(unit === 'm' ? 0 : 1);
    refreshMarker();
    refreshReadout();
  };

  /** Goes through the page's own m/ft buttons when they exist, so the chart follows. */
  const chooseUnit = (next: WaterLevelUnit): void => {
    const pageButton = document.querySelector<HTMLButtonElement>(`[data-water-level-unit="${next}"]`);
    if (pageButton) pageButton.click();
    else saveWaterLevelUnit(next);
    refresh();
  };
  unitToggle.buttons[0].addEventListener('click', () => chooseUnit('m'));
  unitToggle.buttons[1].addEventListener('click', () => chooseUnit('ft'));
  copyButton.addEventListener('click', () => {
    if (latestReadout) options.copyJson(JSON.stringify(latestReadout, null, 2));
  });
  lifetime.every(refresh, WATER_INSPECTOR_REFRESH_MS);

  return {
    root: section.root,
    noteClick(capture, picked) {
      const thisToken = (clickToken += 1);
      // The scene's all-layer hit test can miss water that the segment selection (water layer only) finds, so ask the water layer.
      void hitWaterLayer(view, capture.screenPoint).then((waterHit) => {
        if (thisToken !== clickToken) return;
        const segmentId = waterHit?.segmentId ?? picked?.segmentId ?? null;
        const point = waterHit?.point ?? capture.mapHitWgs84;
        if (!segmentId || !point) {
          clicked = null;
        } else {
          const thisClick: InspectedClick = {
            point: {
              longitude: point.longitude,
              latitude: point.latitude,
              landedOn: waterHit ? 'water-polygon' : 'ground-near-segment',
              distanceFromSegmentCenterM: waterHit ? null : (picked?.nearDistanceM ?? null),
              arcgisWaterHitZM: waterHit?.point.z ?? null,
            },
            segmentId,
            terrain: null,
            lidar: { status: 'pending' },
          };
          clicked = thisClick;
          anchorGroundByKey.clear();
          void lookUpLidarGround(modeledSeam.extentId, point.longitude, point.latitude).then((lidar) => {
            if (clicked !== thisClick) return;
            thisClick.lidar = lidar;
            terrainVersion += 1;
            refresh();
          });
          void sampleBrowserTerrain(view, point.longitude, point.latitude).then((terrain) => {
            if (clicked !== thisClick) return;
            thisClick.terrain = terrain;
            terrainVersion += 1;
            refresh();
          });
        }
        renderedKey = '';
        refresh();
      });
    },
    setOpen(next) {
      open = next;
      marker.setVisible(next);
      markerKey = '';
      renderedKey = '';
      refresh();
    },
    snapshot: () => latestReadout,
  };
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
function buildDrainageAreaRatioTransferTools(
  view: SceneView,
  seam: ModeledExperienceSeam,
  lifetime: ExperienceLifetime,
): HTMLElement {
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
  lifetime.every(() => {
    if (!busy) refreshList();
  }, TRANSFER_LIST_REFRESH_MS);
  return section.root;
}

/**
 * Opens and closes the Station marker gallery: every candidate 3D station
 * marker lined up along Jalama Road beside the gauge, with status tints to try.
 * The gallery module loads on first open.
 */
function buildStationMarkerGalleryTools(view: SceneView, lifetime: ExperienceLifetime): HTMLElement {
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
  // Take an open gallery off the map without flying the camera back: the next Dataset keeps the view where it is.
  lifetime.onEnd(() => {
    void gallery?.close({ restoreCamera: false });
    gallery = null;
  });
  return section.root;
}

/**
 * Opens and closes the Fish barrier models gallery: every candidate 3D barrier (culvert, weir,
 * waterfall, steep ledge) set along Jalama Creek just upstream of the gauge. The gallery module
 * loads on first open. Sizes are guesses because the barrier layer has no dimensions.
 */
function buildBarrierMarkerGalleryTools(view: SceneView, lifetime: ExperienceLifetime): HTMLElement {
  const section = buildSection('Fish barrier models', '07', 0, 'Candidate 3D barriers, on Jalama Creek');
  section.root.id = 'dev-tools-barrier-marker-gallery';

  const toggleButton = buildCopyButton('Show barrier models');
  toggleButton.classList.add('px-3', 'py-1.5', 'text-[11px]');
  toggleButton.setAttribute('aria-pressed', 'false');

  const legend = createElement('ol', [READOUT_BLOCK_CLASS, 'list-decimal', 'pl-6']);
  legend.hidden = true;
  const status = createElement('p', ['min-h-4', 'text-[11px]', 'font-bold', 'text-hud-label']);
  status.setAttribute('aria-live', 'polite');
  section.body.append(toggleButton, legend, status);

  let gallery: BarrierMarkerGallery | null = null;

  const setBusy = (value: boolean): void => {
    toggleButton.disabled = value;
  };

  const open = async (): Promise<void> => {
    setBusy(true);
    status.textContent = 'Placing barrier models…';
    try {
      const module = await import('./barrier-marker-gallery');
      gallery = await module.openBarrierMarkerGallery(view);
      legend.replaceChildren(
        ...gallery.models.map((model) =>
          createElement('li', [], `${model.label} (${model.standsFor}) — ${model.credit}`),
        ),
      );
      legend.hidden = false;
      toggleButton.textContent = 'Hide barrier models';
      toggleButton.setAttribute('aria-pressed', 'true');
      status.textContent = `${gallery.models.length} barrier models upstream of the gauge. Sizes are guesses.`;
    } catch (error) {
      console.warn('[dev-tools-hud] barrier marker gallery failed', error);
      status.textContent = 'Could not place the barrier models.';
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
      legend.hidden = true;
      toggleButton.textContent = 'Show barrier models';
      toggleButton.setAttribute('aria-pressed', 'false');
      status.textContent = '';
      setBusy(false);
    }
  };

  toggleButton.addEventListener('click', () => void (gallery ? close() : open()));
  // Take an open gallery off the map without flying the camera back: the next Dataset keeps the view where it is.
  lifetime.onEnd(() => {
    void gallery?.close({ restoreCamera: false });
    gallery = null;
  });
  return section.root;
}

/**
 * Lists the fish barriers drawn by the sidebar checkbox "Show fish barriers (TNC Digital Catalog)",
 * nearest the observed gauge first, flies to the one chosen, and shows what its record says, how
 * big it is drawn, and which sizes are assumed. It has no button of its own: it follows the
 * checkbox and shows a hint while the barriers are hidden.
 */
function buildFishBarrierMapTools(lifetime: ExperienceLifetime): HTMLElement {
  const section = buildSection('Fish barriers (catalog)', '08', 1, 'Pick a barrier to fly to it and read its sizes');
  section.root.id = 'dev-tools-fish-barrier-map';

  const hint = createElement('p', ['text-[11px]', 'font-bold', 'text-hud-label'], 'Tick "Show fish barriers" in the left sidebar to list them here.');

  const picker = buildHudSelect('dev-tools-fish-barrier-picker');
  picker.setAttribute('aria-label', 'Fish barrier');
  picker.hidden = true;

  const readout = createElement('div', [READOUT_BLOCK_CLASS]);
  readout.hidden = true;
  readout.setAttribute('aria-live', 'polite');
  section.body.append(hint, picker, readout);

  let map: FishBarrierMap | null = null;

  const showSite = (site: FishBarrierSite): void => {
    readout.textContent = describeFishBarrierSiteForHud(site);
  };

  const render = (next: FishBarrierMap | null): void => {
    map = next;
    hint.hidden = next !== null;
    picker.hidden = next === null;
    readout.hidden = next === null;
    if (!next) {
      picker.replaceChildren();
      readout.textContent = '';
      return;
    }
    picker.replaceChildren(
      ...next.sites.map((site, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        const removed = site.description.removal ? ` (${site.description.removal.fate})` : '';
        option.textContent = `${index + 1}. ${site.record.streamName || 'Unnamed creek'} · ${site.record.siteName}${removed}`;
        return option;
      }),
    );
    if (next.sites.length > 0) showSite(next.sites[0]);
  };

  picker.addEventListener('change', () => {
    const site = map?.sites[Number(picker.value)];
    if (!map || !site) return;
    showSite(site);
    void map.flyTo(site);
  });

  // The barriers may already be drawn when the panel first opens.
  render(currentFishBarrierMap());
  lifetime.onEnd(onFishBarrierMapChange(render));
  return section.root;
}

/** What the catalog record says about one barrier, how it is drawn, and which sizes are guesses. */
function describeFishBarrierSiteForHud(site: FishBarrierSite): string {
  const { record, description } = site;
  const shape = description.shape;
  const lines = [
    `${record.siteName} · ${record.streamName || 'unnamed creek'}`,
    description.removal
      ? `NO LONGER A BARRIER (${description.removal.fate}): ${description.removal.summary}`
      : `Passage: ${record.status} barrier (surveyed ${record.surveyYear || 'year unknown'})`,
    `${Math.round(site.distanceToObservedGaugeM)} m from the observed gauge`,
  ];
  if (drawsSolidShape(shape)) {
    lines.push(
      `Drawn: pipe ${shape.diameterM.toFixed(1)} m across, ${shape.lengthM.toFixed(1)} m long` +
        (shape.perchM > 0 ? `, hanging ${shape.perchM.toFixed(1)} m above the creek bed` : ', at bed level'),
      description.assumedDimensions.length > 0
        ? `Assumed (not documented): ${description.assumedDimensions.join(', ')}`
        : 'Every drawn size is documented',
      `Size basis: ${description.sizeBasis}`,
    );
  } else {
    lines.push('Shown as a pointer only (no solid shape for this kind)');
  }
  if (record.notes) lines.push(`Survey notes: ${record.notes}`);
  lines.push(
    site.downstreamBearingDegrees === null
      ? `Not turned to the creek: ${site.creekDirection.detail}`
      : `Turned to the creek: downstream is ${Math.round(site.downstreamBearingDegrees)}°, ${site.creekDirection.detail}`,
    `Position (${site.placement.source}): ${site.placement.detail}`,
    site.channelSnap.kind === 'channel'
      ? `Terrain guess: ${Math.abs(site.channelSnap.lateralOffsetM).toFixed(0)} m ${site.channelSnap.lateralOffsetM < 0 ? 'left' : 'right'} of the catalog point, ` +
        `from ${site.channelSnap.sectionsUsed} lines across the creek that agree within ${site.channelSnap.spreadM.toFixed(0)} m`
      : `Terrain guess: none, ${site.channelSnap.reason}`,
  );
  return lines.join('\n');
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
  /** An "(i)" button (`DevToolsInfoTips.create`) that explains the section; placed after its title. */
  infoTip?: HTMLElement,
): { root: HTMLElement; body: HTMLElement } {
  const section = createElement('section', [BAND_CLASS, BAND_TINT_CLASSES[tintIndex]]);
  const headingRow = createElement('div', ['mb-2', 'flex', 'items-baseline', 'justify-between', 'gap-2']);
  const headingGroup = createElement('div', ['min-w-0']);
  const title = createElement('h3', ['text-sm', 'font-extrabold'], label);
  if (infoTip) {
    // The button sits beside the heading, not inside it, so the heading's own name stays just its title.
    const titleRow = createElement('div', ['flex', 'items-center']);
    titleRow.append(title, infoTip);
    headingGroup.appendChild(titleRow);
  } else {
    headingGroup.appendChild(title);
  }
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
      if (hit.bucketMinDepthM != null) {
        // `bed-parallel-depth` water: the bucket is a depth range, so show the modeled WSE as the elevation.
        const wse = hit.waterSurfaceElevationM == null ? '—' : String(hit.waterSurfaceElevationM);
        const maxDepth = hit.bucketMaxDepthM == null ? '—' : String(hit.bucketMaxDepthM);
        return `segment ${segmentId} @ ${wse} m (depth bucket ${hit.bucketMinDepthM}–${maxDepth} m)`;
      }
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
    const elevationM = waterHit.bucketMinElevationM ?? waterHit.waterSurfaceElevationM ?? null;
    const elevationText = elevationM == null ? '—' : `${elevationM} m`;
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
    modeledWseVersionPath: (wsePolygonMethod && drawnModeledWsePathOf(wsePolygonMethod)) ?? null,
  };
}

// --- Derived data products (modeled experience only) --------------------------

/**
 * 'Derived data products': pick the modeled WSE version (the Time Series) and
 * the WSE polygon version drawn on the map, live, with no URL parameter to
 * remember. A polygon version is drawn with the Time Series it was built from,
 * or with one solved on the same channel (a channel pairing: m4 and m5 on
 * ribbon v2), so choosing a modeled WSE version draws its newest polygon
 * version, and the polygon select lists only the versions that can draw it.
 * The readout underneath answers "do we have it?": what is saved, what is
 * drawn, and which registered methods have no output in this extent yet.
 */
function buildDerivedDataProductsTools(seam: ModeledExperienceSeam): HTMLElement {
  const section = buildSection('Derived data products', '01b', 1, 'Modeled WSE · WSE polygons · switches live');
  section.root.id = 'dev-tools-derived-data-products';

  const groups = seam.derivedDataGroups;

  const wseLabel = createElement('label', [FIELD_LABEL_CLASS], 'Modeled WSE version');
  const wseSelect = buildHudSelect('dev-tools-modeled-wse-version');
  // Linked so each label names its control for assistive technology.
  wseLabel.htmlFor = wseSelect.id;
  for (const group of groups) {
    const hasPolygons = group.polygonVersions.length > 0;
    const option = createElement('option', [], hasPolygons ? group.label : `${group.label} · no polygons yet`);
    option.value = group.key;
    // Drawing needs polygons: the Time Series alone has nothing to put on the map.
    option.disabled = !hasPolygons;
    wseSelect.appendChild(option);
  }

  const polygonLabel = createElement('label', [FIELD_LABEL_CLASS], 'WSE polygon version');
  const polygonSelect = buildHudSelect('dev-tools-wse-polygon-method');
  polygonLabel.htmlFor = polygonSelect.id;

  const description = createElement('p', ['text-[11px]', 'font-semibold', 'leading-snug', 'text-hud-label']);
  description.setAttribute('aria-live', 'polite');
  const inventory = createElement('pre', [READOUT_BLOCK_CLASS]);
  inventory.id = 'dev-tools-derived-data-inventory';

  const render = (status?: string): void => {
    const drawn = seam.wsePolygonMethod;
    const drawnKey = derivedDataSelectionKey(drawn);
    const group = derivedDataGroupOf(groups, drawn);
    wseSelect.value = group?.key ?? '';
    polygonSelect.replaceChildren(
      ...(group?.polygonVersions ?? [drawn]).map((entry) => {
        const option = createElement('option', [], polygonVersionOptionLabel(entry));
        option.value = derivedDataSelectionKey(entry);
        return option;
      }),
    );
    polygonSelect.value = drawnKey;
    description.textContent = [
      `${drawn.label} (${wsePolygonMethodKey(drawn)}, ${describeBrowserDrawing(drawn)}).`,
      group ? `Time Series: ${group.label}.` : null,
      drawn.description,
      status ?? null,
    ]
      .filter((line): line is string => line !== null && line.length > 0)
      .join(' ');
    inventory.textContent = describeDerivedDataInventory(seam, drawnKey);
  };

  const switchTo = (key: string): void => {
    wseSelect.disabled = true;
    polygonSelect.disabled = true;
    render('Loading…');
    seam
      .setWsePolygonMethod(key)
      .then(() => render())
      .catch((error: unknown) => {
        console.error('[dev-tools-hud] derived data switch failed', error);
        render(`Switch failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        wseSelect.disabled = false;
        polygonSelect.disabled = false;
      });
  };

  wseSelect.addEventListener('change', () => {
    const group = groups.find((candidate) => candidate.key === wseSelect.value);
    const target = group ? preferredPolygonVersionOf(group, seam.defaultWsePolygonMethodId) : null;
    if (target) switchTo(derivedDataSelectionKey(target));
    else render();
  });
  polygonSelect.addEventListener('change', () => switchTo(polygonSelect.value));

  render();
  section.body.append(wseLabel, wseSelect, polygonLabel, polygonSelect, description, inventory);
  return section.root;
}

/**
 * Every modeled WSE version with the polygon versions built from it, the one
 * drawn now marked, then the registered methods that have no saved output.
 */
function describeDerivedDataInventory(seam: ModeledExperienceSeam, drawnKey: string): string {
  const lines: string[] = [];
  for (const group of seam.derivedDataGroups) {
    lines.push(group.label);
    lines.push(`  Time Series: ${group.wseVersion ? '✓ saved' : '— not listed by this data source'}`);
    if (group.polygonVersions.length === 0) lines.push('  Polygons: ✗ none yet');
    for (const entry of group.polygonVersions) {
      const drawnMark = derivedDataSelectionKey(entry) === drawnKey ? '  ◀ drawn' : '';
      const pairing = entry.drawnWithModeledWsePath ? ` (built from ${entry.builtFromModeledWsePath ?? '?'}, same channel)` : '';
      lines.push(`  Polygons: ✓ ${entry.label} v${entry.version}${pairing}${drawnMark}`);
    }
  }
  const { modeledWse, wsePolygon } = seam.notGeneratedDerivedData;
  if (modeledWse.length > 0 || wsePolygon.length > 0) {
    lines.push('Not generated for this extent');
    for (const method of modeledWse) lines.push(`  Time Series: ${method.versionLabel} · ${method.label}`);
    for (const method of wsePolygon) lines.push(`  Polygons: ${method.label}`);
  }
  return lines.join('\n');
}

/** `Flowline channel ribbon · v2`, plus where the polygons came from on a channel pairing. */
function polygonVersionOptionLabel(entry: WsePolygonMethodVersion): string {
  const label = `${entry.label} · v${entry.version}`;
  return entry.drawnWithModeledWsePath ? `${label} · channel of ${entry.builtFromModeledWsePath ?? '?'}` : label;
}

/** Select styled like the HUD's other wells. */
function buildHudSelect(id: string): HTMLSelectElement {
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
  select.id = id;
  return select;
}

function describeBrowserDrawing(method: WsePolygonMethodVersion): string {
  if (method.browserDrawing === 'sloped-between-junctions') return 'drawn sloped between junctions';
  if (drawsDepthBuckets(method.browserDrawing)) {
    const timeSeriesPath = drawnModeledWsePathOf(method);
    const pairing = method.drawnWithModeledWsePath ? ` on polygons built from ${method.builtFromModeledWsePath ?? '?'} (same channel)` : '';
    const source = timeSeriesPath ? `, Time Series from ${timeSeriesPath}${pairing}` : '';
    if (method.browserDrawing === 'channel-ribbon-depth') return `drawn as a ribbon morphed to each station's water depth${source}; ${ribbonDisplayRuleDescription()}`;
    if (method.browserDrawing === 'channel-ribbon-pool-filled') {
      return `drawn as a ribbon on the water surface smoothed over a window scaled by its depth and pool-filled along the creek (deep water drowns bumps of the bed; pools behind steps stand level)${source}; ${ribbonDisplayRuleDescription(false)}; ${anchorClearanceRuleDescription()}`;
    }
    return `drawn at a water depth above the creek bed${source}`;
  }
  return 'drawn flat';
}

// --- Formatting -------------------------------------------------------------

function formatPlacementElevation(placement: SegmentPlacementShape): string {
  if (placement.bucketMinElevationM == null) return 'hidden';
  // `bed-parallel-depth` water: the elevation is the modeled WSE; the bucket is a depth.
  const depth = placement.bucketMinDepthM == null ? '' : ` (depth bucket from ${placement.bucketMinDepthM.toFixed(3)} m)`;
  return `${placement.bucketMinElevationM.toFixed(3)} m${depth}`;
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
