// Fish barrier markers: every barrier gets a dot, colored by how much it blocks fish, and a two-line
// label above it when there is room. Line one says what the barrier is, line two which creek and how
// much it blocks. Clicking either hands the barrier to the caller (fish-barrier-map.ts), which flies the
// camera to it and opens its info card.
//
// The dot always shows, at every camera height, wherever the barrier is on the map and clear of the
// floating panels, so no barrier ever disappears. The label is the part that gives way: a label that would
// cover a label nearer the middle of the screen, or run off the map, waits until the camera moves.
// Both are real <button>s positioned over the map every camera frame, so they take keyboard focus.
// The label looks unlike the creek name pins on purpose (map-pin-button.ts): a gate icon, a corner "i" and a
// warm brown background, with the border colored like the dot.

import { watch } from '@arcgis/core/core/reactiveUtils';
import Point from '@arcgis/core/geometry/Point';
import type SceneView from '@arcgis/core/views/SceneView';
import type { ExperienceLifetime } from './experience-lifetime';
import type { FishBarrierSite } from './fish-barrier-map';
import { barrierColorHex, barrierPinText, barrierTopHeightM } from './fish-barrier-sites';
import { createMapPinButton } from './map-pin-button';
import { LABEL_GAP_PX, boxFitsOnMap, boxesOverlap, coveringPanelBoxes, type ScreenBox } from './screen-box-layout';

/** A question mark in the pin's color, for a barrier whose passage status the survey did not determine. */
const UNKNOWN_ICON_SVG =
  '<svg class="h-4 w-4 shrink-0 text-[color:var(--pin-color)]" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5.5 6a2.5 2.5 0 1 1 3.6 2.2C8.4 8.5 8 9 8 9.8"/><path d="M8 12.6v.1"/></svg>';

/**
 * A gate in the pin's color: two tall posts with two shorter rails between them, like a fence gate. The posts
 * span y 2 to 14 and the rails y 6 to 11.5, with a 1.5-unit gap between the rails, so at 16 px it reads as a
 * gate and not a solid block. Every shape is at least 2 units (2 px) thick.
 */
const FISH_BARRIER_GATE_ICON_SVG =
  '<svg class="h-4 w-4 shrink-0 text-[color:var(--pin-color)]" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1.5" y="2" width="3" height="12" rx="0.5"/><rect x="11.5" y="2" width="3" height="12" rx="0.5"/><rect x="4.5" y="6" width="7" height="2"/><rect x="4.5" y="9.5" width="7" height="2"/></svg>';

/** The dot at a barrier's spot. Its ring matches the sidebar so it reads over imagery and over a label. */
const DOT_CLASS =
  'pointer-events-auto absolute z-[1] h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-2 border-slate-900 bg-[color:var(--pin-color)] shadow shadow-black/60 outline-none transition-transform hover:scale-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300';

export interface FishBarrierPins {
  /** Takes every dot and label off the page. */
  dispose(): void;
}

interface BarrierPin {
  site: FishBarrierSite;
  /** Always shown where the barrier is on the map. */
  dot: HTMLButtonElement;
  /** Shown above the dot when there is room. */
  pin: HTMLButtonElement;
  /** Height the pin's foot sits at, m above sea level: the ground under the barrier, plus its pipe's height (zero for a pointer-only barrier, so the stem ends on the dot). */
  footHeightM: number;
}

export function createFishBarrierPins(
  view: SceneView,
  sites: readonly FishBarrierSite[],
  actions: { pinContainer: HTMLElement; select(site: FishBarrierSite, trigger: HTMLElement): void },
  lifetime: ExperienceLifetime,
): FishBarrierPins {
  const items: BarrierPin[] = sites.map((site) => {
    const text = barrierPinText(site.record, site.description);
    const color = barrierColorHex(site.record, site.description);
    const ariaLabel = `Zoom to ${text.primary.toLowerCase()} on ${text.secondary} and show details`;
    const pin = createMapPinButton({
      variant: 'barrier',
      color,
      iconSvg: site.record.status === 'Unknown' && !site.description.removal ? UNKNOWN_ICON_SVG : FISH_BARRIER_GATE_ICON_SVG,
      primary: text.primary,
      secondary: text.secondary,
      ariaLabel,
      // The dot below is the label's foot.
      showFoot: false,
      // Clicking opens the barrier's info card, which the corner "i" hints at.
      infoBadge: true,
    });
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `${DOT_CLASS} invisible`;
    dot.style.setProperty('--pin-color', color);
    dot.setAttribute('aria-label', ariaLabel);
    // A label may not fit; the hover tip then still says what the dot is.
    dot.title = `${text.primary} · ${text.secondary}`;
    for (const button of [pin, dot]) {
      button.addEventListener('click', () => actions.select(site, button), { signal: lifetime.signal });
      actions.pinContainer.append(button);
    }
    return { site, dot, pin, footHeightM: (site.groundM ?? 0) + barrierTopHeightM(site.description.shape) };
  });

  const update = (): void => placePins(view, items);
  const cameraWatch = watch(() => view.camera, update, { initial: true });
  // Width and height changes move every screen point without moving the camera.
  const sizeWatch = watch(() => [view.width, view.height], update);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cameraWatch.remove();
    sizeWatch.remove();
    for (const item of items) {
      item.pin.remove();
      item.dot.remove();
    }
  };
  lifetime.onEnd(dispose);
  return { dispose };
}

/** A barrier's spot on the screen, with the box its label would fill there. */
interface ScreenSpot {
  item: BarrierPin;
  x: number;
  y: number;
  box: ScreenBox;
}

/** True when the point lies inside the box. */
function boxContains(box: ScreenBox, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * Puts a dot on every barrier that is on the map and not under a panel. Then puts labels over the dots,
 * the barrier nearest the middle of the screen first: a label that falls off the map, behind a panel, or
 * on top of a label already placed stays hidden until the camera moves. Dots never hide for lack of room.
 */
function placePins(view: SceneView, items: readonly BarrierPin[]): void {
  const panels = coveringPanelBoxes(view);
  const centerX = view.width / 2;
  const centerY = view.height / 2;

  const spots: ScreenSpot[] = [];
  for (const item of items) {
    const [longitude, latitude] = item.site.drawnLonLat;
    // The dot sits on the ground under the barrier; the label hangs from the top of the barrier.
    const onGround = view.toScreen(new Point({ longitude, latitude, z: item.site.groundM ?? 0, spatialReference: { wkid: 4326 } }));
    const onTop = view.toScreen(new Point({ longitude, latitude, z: item.footHeightM, spatialReference: { wkid: 4326 } }));
    const dotShown =
      onGround !== null &&
      onGround.x >= 0 &&
      onGround.x <= view.width &&
      onGround.y >= 0 &&
      onGround.y <= view.height &&
      // A dot under a panel is hidden by it anyway; hiding it keeps keyboard focus off it.
      !panels.some((panel) => boxContains(panel, onGround.x, onGround.y));
    item.dot.classList.toggle('invisible', !dotShown);
    if (dotShown) {
      item.dot.style.left = `${onGround.x}px`;
      item.dot.style.top = `${onGround.y}px`;
    }

    item.pin.classList.add('invisible');
    if (!dotShown || !onTop) continue;
    // The label hangs above its spot and is centered on it.
    const halfWidth = item.pin.offsetWidth / 2 + LABEL_GAP_PX;
    const height = item.pin.offsetHeight + LABEL_GAP_PX;
    const box: ScreenBox = { left: onTop.x - halfWidth, right: onTop.x + halfWidth, top: onTop.y - height, bottom: onTop.y + LABEL_GAP_PX };
    if (boxFitsOnMap(box, view) && !panels.some((panel) => boxesOverlap(box, panel))) {
      spots.push({ item, x: onTop.x, y: onTop.y, box });
    }
  }

  spots.sort((a, b) => Math.hypot(a.x - centerX, a.y - centerY) - Math.hypot(b.x - centerX, b.y - centerY));
  const placed: ScreenBox[] = [];
  for (const spot of spots) {
    if (placed.some((other) => boxesOverlap(spot.box, other))) continue;
    placed.push(spot.box);
    spot.item.pin.classList.remove('invisible');
    spot.item.pin.style.left = `${spot.x}px`;
    spot.item.pin.style.top = `${spot.y}px`;
  }
}
