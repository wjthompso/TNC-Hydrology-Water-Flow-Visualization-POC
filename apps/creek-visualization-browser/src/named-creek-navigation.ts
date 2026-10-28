// Named creek navigation: when the camera is high, each named creek gets a colored
// highlight along all of its flowlines and a floating label button hanging over its
// middle, showing the creek's name and length. Clicking the label flies the camera to a
// medium view that fits the whole creek. It appears on its own as the camera rises; there
// is no control for it. Zoomed in, the highlights and labels fade out so they never sit on
// top of the water being inspected.
//
// The labels are real <button>s positioned over the map every camera frame (the same
// way the monitoring station card follows its station), so they take keyboard focus and
// Tailwind styling. The highlight is a draped line layer inside the scene.

import { watch } from '@arcgis/core/core/reactiveUtils';
import Camera from '@arcgis/core/Camera';
import Graphic from '@arcgis/core/Graphic';
import Multipoint from '@arcgis/core/geometry/Multipoint';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import LineSymbol3D from '@arcgis/core/symbols/LineSymbol3D';
import LineSymbol3DLayer from '@arcgis/core/symbols/LineSymbol3DLayer';
import type SceneView from '@arcgis/core/views/SceneView';
import { fitNorthUpCamera, type ScreenRegion } from './camera-fit-to-region';
import type { ExperienceLifetime } from './experience-lifetime';
import type { NamedCreek } from './named-creeks';

/** Camera height above which labels and highlights are fully shown, m. */
export const NAMED_CREEK_FULL_VISIBILITY_ABOVE_M = 5000;
/** Camera height below which they are gone, m. Between the two they fade. */
export const NAMED_CREEK_GONE_BELOW_M = 2500;

/** Distinct from the amber Selected Creek Segment highlight and from the blue water. */
const CREEK_COLORS = ['#f472b6', '#a3e635', '#c084fc', '#fb923c', '#2dd4bf'] as const;

/** Medium view: the whole creek framed in the visible part of the map, tilted so the valley relief reads. */
const FLY_TO_TILT_DEGREES = 40;
/** Space kept between the framed creek and the sidebar, panels, and map edges, px. */
const FLY_TO_MARGIN_PX = 32;
/** A rectangle narrower or shorter than this is too small to frame a creek in, px. */
const MIN_FLY_TO_REGION_PX = 160;
/** Panels over the map's corners that a framed creek should stay clear of. */
const FLY_TO_CORNER_PANEL_SELECTORS = ['[aria-label="Map legend"]', '#imagery-widget', '#dev-tools-toggle'];
const FLY_TO_DURATION_MS = 1600;

/** Below this opacity a label is hidden outright, so a ghost label cannot be clicked or tabbed to. */
const MIN_CLICKABLE_OPACITY = 0.15;

const HIGHLIGHT_LAYER_ID = 'named-creek-highlights';
const GLOW_WIDTH_PT = 9;
const CORE_WIDTH_PT = 3.5;
const EMPHASIS_WIDTH_FACTOR = 1.6;
const DIMMED_OPACITY_FACTOR = 0.35;

const PIN_CLASS =
  'group pointer-events-auto absolute flex w-max -translate-x-1/2 -translate-y-full cursor-pointer flex-col items-center whitespace-nowrap rounded-full outline-none';
const PIN_LABEL_CLASS =
  'flex items-center gap-2 rounded-full border border-[color:var(--creek-color)] bg-slate-900/90 py-1 pl-2.5 pr-3.5 text-left shadow-lg shadow-black/50 backdrop-blur transition-colors group-hover:bg-slate-800 group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-cyan-300';
const PIN_STEM_CLASS = 'h-3 w-0.5 bg-[color:var(--creek-color)]';
const PIN_FOOT_CLASS = 'h-2.5 w-2.5 rounded-full bg-[color:var(--creek-color)] ring-2 ring-slate-900';
const PIN_NAME_CLASS = 'text-sm font-semibold leading-tight text-slate-50';
const PIN_LENGTH_CLASS = 'text-xs font-normal leading-tight tabular-nums text-slate-300';
/** Water-drop mark in the creek's color. */
const DROP_ICON_SVG =
  '<svg class="h-4 w-4 shrink-0 text-[color:var(--creek-color)]" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5c-.3 0-.6.2-.8.5C5.4 4.4 3.5 6.8 3.5 9.25a4.5 4.5 0 0 0 9 0c0-2.45-1.9-4.85-3.7-7.25A1 1 0 0 0 8 1.5Z"/></svg>';

export interface NamedCreekNavigation {
  /** Flies the camera to a medium view of the creek. Resolves when the flight ends or is interrupted. */
  flyToCreek(name: string): Promise<void>;
  /** The labels and highlights are fully drawn at this camera height. */
  readonly highlightOpacity: number;
  /** Takes the layer, labels, and buttons off the page. The view stays. */
  dispose(): void;
}

export interface NamedCreekNavigationElements {
  /** Full-map container the floating labels are added to. It must not take pointer events itself. */
  pinContainer: HTMLElement;
}

interface CreekPin {
  creek: NamedCreek;
  color: string;
  graphic: Graphic;
  pin: HTMLButtonElement;
  /** Ground height under each of the creek's label spots, m, in the spots' order. All 0 until the terrain answers. */
  groundMBySpot: number[];
}

/** 0 at and below the gone-below height, 1 at and above the full-visibility height, a straight line between. */
export function namedCreekOpacityAtAltitude(altitudeM: number): number {
  if (!Number.isFinite(altitudeM)) return 0;
  const fraction =
    (altitudeM - NAMED_CREEK_GONE_BELOW_M) / (NAMED_CREEK_FULL_VISIBILITY_ABOVE_M - NAMED_CREEK_GONE_BELOW_M);
  return Math.min(1, Math.max(0, fraction));
}

export function createNamedCreekNavigation(
  view: SceneView,
  creeks: readonly NamedCreek[],
  elements: NamedCreekNavigationElements,
  lifetime: ExperienceLifetime,
): NamedCreekNavigation {
  if (!view.map) throw new Error('SceneView has no map.');

  const layer = new GraphicsLayer({
    id: HIGHLIGHT_LAYER_ID,
    listMode: 'hide',
    opacity: 0,
    visible: false,
    elevationInfo: { mode: 'on-the-ground' },
  });
  view.map.add(layer);

  const pins: CreekPin[] = creeks.map((creek, index) => {
    const color = CREEK_COLORS[index % CREEK_COLORS.length];
    const graphic = new Graphic({
      geometry: new Polyline({
        paths: creek.pathsWgs84.map((path) => path.map(([lon, lat]) => [lon, lat])),
        spatialReference: { wkid: 4326 },
      }),
      symbol: highlightSymbol(color, 'normal'),
      attributes: { creekName: creek.name },
    });
    layer.add(graphic);
    return { creek, color, graphic, pin: createPin(creek, color), groundMBySpot: creek.labelSpotsWgs84.map(() => 0) };
  });

  /** Placement order: when two labels collide, the longer creek keeps its label. */
  const pinsLongestFirst = [...pins].sort((a, b) => b.creek.lengthM - a.creek.lengthM);

  let emphasizedName: string | null = null;
  const setEmphasis = (name: string | null): void => {
    if (name === emphasizedName) return;
    emphasizedName = name;
    for (const item of pins) {
      const state = name === null ? 'normal' : item.creek.name === name ? 'emphasized' : 'dimmed';
      item.graphic.symbol = highlightSymbol(item.color, state);
    }
  };

  const flyToCreek = async (name: string): Promise<void> => {
    const item = pins.find((candidate) => candidate.creek.name === name);
    if (!item) return;
    const points = item.creek.pathsWgs84.flat();
    const groundElevationM = averageOf(item.groundMBySpot);
    // The creek is framed in whichever clear region lets the camera sit closest, so a tall creek goes
    // beside the legend and a wide one above it.
    const fit = visibleMapRegions(view)
      .map((region) =>
        fitNorthUpCamera({
          pointsWgs84: points,
          viewWidthPx: view.width,
          viewHeightPx: view.height,
          diagonalFovDegrees: view.camera.fov,
          tiltDegrees: FLY_TO_TILT_DEGREES,
          region,
          groundElevationM,
        }),
      )
      .reduce((closest, candidate) => (candidate.altitudeM < closest.altitudeM ? candidate : closest));
    try {
      await view.goTo(
        new Camera({
          position: { longitude: fit.longitude, latitude: fit.latitude, z: fit.altitudeM, spatialReference: { wkid: 4326 } },
          heading: 0,
          tilt: FLY_TO_TILT_DEGREES,
        }),
        { duration: FLY_TO_DURATION_MS },
      );
    } catch (error) {
      // Grabbing the map or picking another creek mid-flight cancels this one; that is not a failure.
      if (!(error instanceof Error && error.name === 'AbortError')) console.error(`[named-creek-navigation] could not fly to ${name}`, error);
    }
  };

  let opacity = 0;
  const update = (): void => {
    opacity = namedCreekOpacityAtAltitude(view.camera?.position?.z ?? 0);
    layer.opacity = opacity;
    layer.visible = opacity > 0;
    placePins(view, pinsLongestFirst, opacity);
  };

  const container = elements.pinContainer;
  for (const item of pins) {
    const { creek, pin } = item;
    pin.addEventListener('click', () => void flyToCreek(creek.name), { signal: lifetime.signal });
    pin.addEventListener('pointerenter', () => setEmphasis(creek.name), { signal: lifetime.signal });
    pin.addEventListener('pointerleave', () => setEmphasis(null), { signal: lifetime.signal });
    pin.addEventListener('focus', () => setEmphasis(creek.name), { signal: lifetime.signal });
    pin.addEventListener('blur', () => setEmphasis(null), { signal: lifetime.signal });
    container.append(pin);
    void fillGroundHeights(view, item, update);
  }

  const cameraWatch = watch(() => view.camera, update, { initial: true });
  // Width and height changes move every screen point without moving the camera.
  const sizeWatch = watch(() => [view.width, view.height], update);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cameraWatch.remove();
    sizeWatch.remove();
    for (const item of pins) item.pin.remove();
    view.map?.remove(layer);
    layer.destroy();
  };
  lifetime.onEnd(dispose);

  return {
    flyToCreek,
    get highlightOpacity() {
      return opacity;
    },
    dispose,
  };
}

function highlightSymbol(color: string, state: 'normal' | 'emphasized' | 'dimmed'): LineSymbol3D {
  const widthFactor = state === 'emphasized' ? EMPHASIS_WIDTH_FACTOR : 1;
  const alphaFactor = state === 'dimmed' ? DIMMED_OPACITY_FACTOR : 1;
  return new LineSymbol3D({
    symbolLayers: [
      // Wide, faint line first: the glow that makes the creek read at long range.
      new LineSymbol3DLayer({
        size: GLOW_WIDTH_PT * widthFactor,
        material: { color: [...hexToRgb(color), 0.35 * alphaFactor] },
        cap: 'round',
        join: 'round',
      }),
      new LineSymbol3DLayer({
        size: CORE_WIDTH_PT * widthFactor,
        material: { color: [...hexToRgb(color), alphaFactor] },
        cap: 'round',
        join: 'round',
      }),
    ],
  });
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function createPin(creek: NamedCreek, color: string): HTMLButtonElement {
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = PIN_CLASS;
  pin.style.setProperty('--creek-color', color);
  pin.setAttribute('aria-label', `Zoom to ${creek.name}`);
  pin.title = `Zoom to ${creek.name}`;

  const name = document.createElement('span');
  name.className = PIN_NAME_CLASS;
  name.textContent = creek.name;
  const length = document.createElement('span');
  length.className = PIN_LENGTH_CLASS;
  length.textContent = creekLengthText(creek.lengthM);
  const text = document.createElement('span');
  text.className = 'flex flex-col';
  text.append(name, length);

  const label = document.createElement('span');
  label.className = PIN_LABEL_CLASS;
  label.insertAdjacentHTML('afterbegin', DROP_ICON_SVG);
  label.append(text);

  const stem = document.createElement('span');
  stem.className = PIN_STEM_CLASS;
  const foot = document.createElement('span');
  foot.className = PIN_FOOT_CLASS;

  pin.append(label, stem, foot);
  pin.classList.add('invisible');
  return pin;
}

const METERS_PER_MILE = 1609.344;

/** "16.1 km · 10.0 mi". */
export function creekLengthText(lengthM: number): string {
  return `${(lengthM / 1000).toFixed(1)} km · ${(lengthM / METERS_PER_MILE).toFixed(1)} mi`;
}

/** Space kept between a label and anything it must not cover, px. */
const LABEL_GAP_PX = 6;
/** Distance a label's spot must keep from the map's edge, px, so the pill is never cut off. */
const MAP_EDGE_MARGIN_PX = 8;
/** Panels floating over the map that a label must not hide behind; found on the page each frame. */
const COVERING_PANEL_SELECTORS = ['aside', '[aria-label="Map legend"]', '#imagery-widget', '#dev-tools-toggle'];

interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A label spot on the screen, with the box its label would fill there. */
interface ScreenSpot {
  x: number;
  y: number;
  box: ScreenBox;
}

/**
 * Puts each label on the middle of the part of its creek you can see, longest creek first. The visible
 * part is every spot where the label fits on the map and clears the floating panels. The label takes
 * the most central of those that does not cover a label already placed, so a creek running off the edge
 * or under the sidebar gets its label in the middle of what is left. A creek with no such spot has no
 * label until the camera moves. Hidden entirely when faded out.
 */
function placePins(view: SceneView, itemsLongestFirst: readonly CreekPin[], opacity: number): void {
  const panels = coveringPanelBoxes(view);
  const placed: ScreenBox[] = [];
  for (const item of itemsLongestFirst) {
    const spot = opacity >= MIN_CLICKABLE_OPACITY ? mostCentralFreeSpot(view, item, panels, placed) : null;
    item.pin.classList.toggle('invisible', !spot);
    if (!spot) continue;
    placed.push(spot.box);
    item.pin.style.left = `${spot.x}px`;
    item.pin.style.top = `${spot.y}px`;
    item.pin.style.opacity = String(opacity);
  }
}

/**
 * Of the creek's visible spots, the most central one whose label covers no placed label. "Most central"
 * is the spot with the smallest total on-screen distance to the other visible spots, which stays on the
 * creek even when the visible part bends or forks.
 */
function mostCentralFreeSpot(
  view: SceneView,
  item: CreekPin,
  panels: readonly ScreenBox[],
  placed: readonly ScreenBox[],
): ScreenSpot | null {
  const visible = visibleSpots(view, item, panels);
  const byCentrality = visible
    .map((spot) => ({ spot, spreadPx: visible.reduce((sum, other) => sum + Math.hypot(spot.x - other.x, spot.y - other.y), 0) }))
    .sort((a, b) => a.spreadPx - b.spreadPx);
  return byCentrality.find(({ spot }) => !placed.some((other) => boxesOverlap(spot.box, other)))?.spot ?? null;
}

/** The creek's spots where the label fits on the map and clears every floating panel. */
function visibleSpots(view: SceneView, item: CreekPin, panels: readonly ScreenBox[]): ScreenSpot[] {
  // The pin hangs above its spot and is centered on it: its box is the spot's x +/- half the width, and y up by the height.
  const halfWidth = item.pin.offsetWidth / 2 + LABEL_GAP_PX;
  const height = item.pin.offsetHeight + LABEL_GAP_PX;
  const spots: ScreenSpot[] = [];
  for (const [index, [longitude, latitude]] of item.creek.labelSpotsWgs84.entries()) {
    const screen = view.toScreen(new Point({ longitude, latitude, z: item.groundMBySpot[index], spatialReference: { wkid: 4326 } }));
    if (!screen) continue;
    const box: ScreenBox = { left: screen.x - halfWidth, right: screen.x + halfWidth, top: screen.y - height, bottom: screen.y + LABEL_GAP_PX };
    const fitsOnMap =
      box.left >= MAP_EDGE_MARGIN_PX &&
      box.top >= MAP_EDGE_MARGIN_PX &&
      box.right <= view.width - MAP_EDGE_MARGIN_PX &&
      box.bottom <= view.height - MAP_EDGE_MARGIN_PX;
    if (fitsOnMap && !panels.some((panel) => boxesOverlap(box, panel))) spots.push({ x: screen.x, y: screen.y, box });
  }
  return spots;
}

function boxesOverlap(a: ScreenBox, b: ScreenBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Screen boxes, relative to the map, of the sidebar, legend, and corner buttons, with a gap around each. */
function coveringPanelBoxes(view: SceneView): ScreenBox[] {
  const mapBox = view.container?.getBoundingClientRect();
  if (!mapBox) return [];
  const boxes: ScreenBox[] = [];
  for (const selector of COVERING_PANEL_SELECTORS) {
    const panel = document.querySelector(selector);
    if (!panel || panel.getClientRects().length === 0) continue;
    const rect = panel.getBoundingClientRect();
    boxes.push({
      left: rect.left - mapBox.left - LABEL_GAP_PX,
      top: rect.top - mapBox.top - LABEL_GAP_PX,
      right: rect.right - mapBox.left + LABEL_GAP_PX,
      bottom: rect.bottom - mapBox.top + LABEL_GAP_PX,
    });
  }
  return boxes;
}

/**
 * Asks the terrain for the ground height under every spot of the creek in one request. Spots keep 0 m
 * until it answers, and stay there if it fails: a creek that climbs from the coast then draws its
 * labels a little off the line, which the next camera move after the answer corrects.
 */
async function fillGroundHeights(view: SceneView, item: CreekPin, onFilled: () => void): Promise<void> {
  try {
    const spots = new Multipoint({
      points: item.creek.labelSpotsWgs84.map(([longitude, latitude]) => [longitude, latitude]),
      spatialReference: { wkid: 4326 },
    });
    const answer = await view.map?.ground.queryElevation(spots);
    if (answer?.geometry.type !== 'multipoint') return;
    const heights = answer.geometry.points.map((point) => point[2]);
    if (heights.length !== item.groundMBySpot.length || !heights.every(Number.isFinite)) return;
    item.groundMBySpot = heights;
    onFilled();
  } catch {
    // Terrain unavailable; labels stay at 0 m.
  }
}

/**
 * Rectangles of the map a person can see a creek in. Every one starts right of the sidebar, inside a
 * margin. The legend and corner buttons then sit over its corners, and a rectangle cannot have a corner
 * missing, so each of them is cut away two ways, along its left or right side or along its top or
 * bottom side, which gives one rectangle per combination. The caller keeps the one that fits best.
 */
function visibleMapRegions(view: SceneView): ScreenRegion[] {
  const mapBox = view.container?.getBoundingClientRect();
  const mapLeft = mapBox?.left ?? 0;
  const mapTop = mapBox?.top ?? 0;
  const sidebar = document.querySelector('aside');
  const sidebarRight = sidebar && sidebar.getClientRects().length > 0 ? sidebar.getBoundingClientRect().right - mapLeft : 0;
  const base: ScreenRegion = {
    left: sidebarRight + FLY_TO_MARGIN_PX,
    top: FLY_TO_MARGIN_PX,
    right: view.width - FLY_TO_MARGIN_PX,
    bottom: view.height - FLY_TO_MARGIN_PX,
  };

  const cornerPanels: ScreenBox[] = [];
  for (const selector of FLY_TO_CORNER_PANEL_SELECTORS) {
    const panel = document.querySelector(selector);
    if (!panel || panel.getClientRects().length === 0) continue;
    const rect = panel.getBoundingClientRect();
    const box: ScreenBox = {
      left: rect.left - mapLeft - FLY_TO_MARGIN_PX,
      top: rect.top - mapTop - FLY_TO_MARGIN_PX,
      right: rect.right - mapLeft + FLY_TO_MARGIN_PX,
      bottom: rect.bottom - mapTop + FLY_TO_MARGIN_PX,
    };
    if (boxesOverlap(box, base)) cornerPanels.push(box);
  }

  let regions: ScreenRegion[] = [base];
  for (const panel of cornerPanels) {
    regions = regions.flatMap((region) => {
      if (!boxesOverlap(panel, region)) return [region];
      const onRight = (panel.left + panel.right) / 2 > (region.left + region.right) / 2;
      const onBottom = (panel.top + panel.bottom) / 2 > (region.top + region.bottom) / 2;
      const besideIt = onRight ? { ...region, right: Math.min(region.right, panel.left) } : { ...region, left: Math.max(region.left, panel.right) };
      const aboveOrBelowIt = onBottom ? { ...region, bottom: Math.min(region.bottom, panel.top) } : { ...region, top: Math.max(region.top, panel.bottom) };
      return [besideIt, aboveOrBelowIt];
    });
  }
  // A region squeezed to nothing cannot hold a creek; the base region always can.
  const usable = regions.filter((region) => region.right - region.left > MIN_FLY_TO_REGION_PX && region.bottom - region.top > MIN_FLY_TO_REGION_PX);
  return usable.length > 0 ? usable : [base];
}

function averageOf(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
