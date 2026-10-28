// Selected Creek Segment indicator: while the Selected Creek Segment is off the
// screen (or hidden under the control panel), a bubble sits on the screen edge
// nearest it, its arrow pointing the way, with the distance beneath. Clicking
// the bubble flies the camera back to the segment. Like a quest marker in a
// video game: it hides again once the segment is in view.

import type Camera from '@arcgis/core/Camera';
import { watch } from '@arcgis/core/core/reactiveUtils';
import Point from '@arcgis/core/geometry/Point';
import type SceneView from '@arcgis/core/views/SceneView';
import type { LonLat } from './creek-data-contract';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';

const INDICATOR_ID = 'selected-segment-indicator';
/** Same framing the developer HUD uses to visit a segment: close enough to see it, tilted to read the terrain. */
const FLY_TO_SCALE = 1500;
const FLY_TO_TILT_DEGREES = 55;
const FLY_TO_DURATION_MS = 1200;

/** Distance from the screen edge to the bubble's center. The bottom is larger to leave room for the distance label. */
const EDGE_INSET_PX = { left: 40, right: 40, top: 40, bottom: 92 };
/** Gap between the control panel and the bubble when the bubble must sit beside the panel. */
const PANEL_GAP_PX = 12;

/** Only the sign of "ahead or behind" depends on this, so the ground's rough sea-level height is enough. */
const GROUND_ELEVATION_M = 0;
const METERS_PER_DEGREE_LATITUDE = 110540;
const METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111320;

export interface SelectedSegmentIndicatorInput {
  view: SceneView;
  /** The Selected Creek Segment's id; null when nothing is selected. */
  selectedSegmentId: () => string | null;
  /** A longitude/latitude on the segment; null when its location is unknown. */
  segmentLocation: (segmentId: string) => LonLat | null;
  /** Ending it hides the bubble and unbinds its listeners. */
  lifetime?: ExperienceLifetime;
}

export interface SelectedSegmentIndicator {
  /** Re-places the bubble. Call on every selection change; camera and size changes are watched already. */
  update(): void;
}

/**
 * True when the target lies ahead of the camera's image plane. `view.toScreen` mirrors targets behind that
 * plane, so only this sign needs the camera's heading and tilt (heading 0 faces north; tilt 0 looks straight
 * down, 90 at the horizon). A flat local projection is plenty accurate over the few kilometers this scene covers.
 */
function isInFrontOfCamera(camera: Camera, target: LonLat): boolean {
  const eastM =
    (target[0] - (camera.position.longitude ?? 0)) *
    METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR *
    Math.cos(toRadians(target[1]));
  const northM = (target[1] - (camera.position.latitude ?? 0)) * METERS_PER_DEGREE_LATITUDE;
  const upM = GROUND_ELEVATION_M - (camera.position.z ?? 0);
  const sinTilt = Math.sin(toRadians(camera.tilt));
  const forwardM =
    (eastM * Math.sin(toRadians(camera.heading)) + northM * Math.cos(toRadians(camera.heading))) * sinTilt -
    upM * Math.cos(toRadians(camera.tilt));
  return forwardM > 0;
}

/** Clockwise degrees from screen-up to the direction `from` → `to`. Straight down when the two coincide. */
function screenAngleDegrees(from: ScreenXY, to: ScreenXY): number {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.hypot(deltaX, deltaY) < 1e-6) return 180;
  return toDegrees(Math.atan2(deltaX, -deltaY));
}

interface ScreenXY {
  readonly x: number;
  readonly y: number;
}

export interface EdgeRectangle {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Where a ray from the rectangle's center, `angleDegrees` clockwise from up, leaves the rectangle. */
export function edgePointAtAngle(rectangle: EdgeRectangle, angleDegrees: number): { x: number; y: number } {
  const centerX = (rectangle.left + rectangle.right) / 2;
  const centerY = (rectangle.top + rectangle.bottom) / 2;
  const halfWidth = Math.max(0, (rectangle.right - rectangle.left) / 2);
  const halfHeight = Math.max(0, (rectangle.bottom - rectangle.top) / 2);
  const directionX = Math.sin(toRadians(angleDegrees));
  const directionY = -Math.cos(toRadians(angleDegrees));
  const reachToSide = Math.abs(directionX) > 1e-9 ? halfWidth / Math.abs(directionX) : Infinity;
  const reachToTopOrBottom = Math.abs(directionY) > 1e-9 ? halfHeight / Math.abs(directionY) : Infinity;
  const reach = Math.min(reachToSide, reachToTopOrBottom);
  return { x: centerX + directionX * reach, y: centerY + directionY * reach };
}

/** The vertex halfway along a path's vertex list, a point that lies on the segment. */
export function pathMidpointWgs84(path: readonly LonLat[] | undefined): LonLat | null {
  if (!path || path.length === 0) return null;
  return path[Math.floor(path.length / 2)];
}

export function formatIndicatorDistance(distanceM: number): string {
  if (distanceM < 1000) return `${Math.max(1, Math.round(distanceM / 10) * 10)} m`;
  return `${(distanceM / 1000).toFixed(distanceM < 10_000 ? 1 : 0)} km`;
}

export function bindSelectedSegmentIndicator(input: SelectedSegmentIndicatorInput): SelectedSegmentIndicator {
  const { view } = input;
  const lifetime = input.lifetime ?? createExperienceLifetime();
  const elements = readIndicatorElements();
  if (!elements) return { update() {} };

  let flyingToSegmentId: string | null = null;

  const hide = (): void => {
    elements.root.classList.add('hidden');
  };

  const update = (): void => {
    const segmentId = input.selectedSegmentId();
    const location = segmentId && view.ready ? input.segmentLocation(segmentId) : null;
    if (!segmentId || !location) {
      hide();
      return;
    }

    const container = view.container?.getBoundingClientRect();
    const originX = container?.left ?? 0;
    const originY = container?.top ?? 0;
    const panel = controlPanelRectangle(originX, originY);

    // toScreen returns a point even off screen, so the segment's true screen direction is known at any distance.
    const projected = view.toScreen(
      new Point({ longitude: location[0], latitude: location[1], spatialReference: { wkid: 4326 } }),
    );
    const inFront = isInFrontOfCamera(view.camera, location);
    if (projected && inFront && isVisibleOnScreen(view, projected, panel)) {
      hide();
      return;
    }

    // The bubble leaves the safe area's center along the ray toward the segment, so the arrow, drawn from the
    // bubble along that same ray, points straight at the segment. A segment behind the camera has no true
    // screen location; its direction from the view center is the one that turns the camera toward it.
    const safeArea = safeAreaRectangle(view.width, view.height, panel);
    const rayOrigin = inFront ? rectangleCenter(safeArea) : { x: view.width / 2, y: view.height / 2 };
    const angleDegrees = projected ? screenAngleDegrees(rayOrigin, projected) : 180;
    const position = edgePointAtAngle(safeArea, angleDegrees);
    const distanceText = formatIndicatorDistance(horizontalDistanceFromViewCenterM(view, location));

    elements.root.classList.remove('hidden');
    elements.root.style.left = `${position.x}px`;
    elements.root.style.top = `${position.y}px`;
    elements.arrow.style.transform = `rotate(${angleDegrees}deg)`;
    elements.distance.textContent = distanceText;
    const label = `Selected Creek Segment ${segmentId} is off screen, ${distanceText} away. Activate to fly to it.`;
    elements.root.setAttribute('aria-label', label);
    elements.root.title = label;
  };

  elements.root.addEventListener(
    'click',
    () => {
      const segmentId = input.selectedSegmentId();
      const location = segmentId ? input.segmentLocation(segmentId) : null;
      if (!segmentId || !location || flyingToSegmentId === segmentId) return;
      flyingToSegmentId = segmentId;
      void view
        .goTo(
          {
            target: new Point({ longitude: location[0], latitude: location[1], spatialReference: { wkid: 4326 } }),
            scale: FLY_TO_SCALE,
            tilt: FLY_TO_TILT_DEGREES,
          },
          { duration: FLY_TO_DURATION_MS },
        )
        .catch(() => undefined)
        .finally(() => {
          flyingToSegmentId = null;
        });
    },
    { signal: lifetime.signal },
  );

  const cameraWatch = watch(
    () => view.camera,
    () => update(),
    { initial: true },
  );
  // Width and height changes move the screen edges without moving the camera.
  const sizeWatch = watch(
    () => [view.width, view.height],
    () => update(),
  );
  lifetime.onEnd(() => {
    cameraWatch.remove();
    sizeWatch.remove();
    hide();
  });

  return { update };
}

function isVisibleOnScreen(view: SceneView, screenPoint: ScreenXY, panel: EdgeRectangle | null): boolean {
  const insideView =
    screenPoint.x >= 0 && screenPoint.y >= 0 && screenPoint.x <= view.width && screenPoint.y <= view.height;
  if (!insideView) return false;
  const underPanel =
    panel !== null &&
    screenPoint.x >= panel.left &&
    screenPoint.x <= panel.right &&
    screenPoint.y >= panel.top &&
    screenPoint.y <= panel.bottom;
  return !underPanel;
}

function rectangleCenter(rectangle: EdgeRectangle): ScreenXY {
  return { x: (rectangle.left + rectangle.right) / 2, y: (rectangle.top + rectangle.bottom) / 2 };
}

/** The screen area where the bubble may sit: inside the screen edges and, when it fits, to the right of the control panel. */
function safeAreaRectangle(width: number, height: number, panel: EdgeRectangle | null): EdgeRectangle {
  let left = EDGE_INSET_PX.left;
  const right = width - EDGE_INSET_PX.right;
  // On a narrow screen the panel covers too much to keep clear of; the bubble then floats over it.
  if (panel && panel.right + PANEL_GAP_PX + EDGE_INSET_PX.left < right) {
    left = Math.max(left, panel.right + PANEL_GAP_PX + EDGE_INSET_PX.left);
  }
  return { left, right, top: EDGE_INSET_PX.top, bottom: height - EDGE_INSET_PX.bottom };
}

/** The control panel's box in view coordinates; null when the page has no panel. */
function controlPanelRectangle(originX: number, originY: number): EdgeRectangle | null {
  const panel = document.getElementById('control-panel-scroll')?.parentElement;
  if (!panel) return null;
  const box = panel.getBoundingClientRect();
  return { left: box.left - originX, top: box.top - originY, right: box.right - originX, bottom: box.bottom - originY };
}

/** Ground distance from the point the camera looks at (the view center), falling back to the camera's own position. */
function horizontalDistanceFromViewCenterM(view: SceneView, location: LonLat): number {
  const from = view.center ?? view.camera.position;
  const eastM =
    (location[0] - (from.longitude ?? 0)) *
    METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR *
    Math.cos(toRadians(location[1]));
  const northM = (location[1] - (from.latitude ?? 0)) * METERS_PER_DEGREE_LATITUDE;
  return Math.hypot(eastM, northM);
}

interface IndicatorElements {
  root: HTMLButtonElement;
  arrow: HTMLElement;
  distance: HTMLElement;
}

function readIndicatorElements(): IndicatorElements | null {
  const root = document.getElementById(INDICATOR_ID);
  const arrow = root?.querySelector<HTMLElement>('[data-indicator-arrow]');
  const distance = root?.querySelector<HTMLElement>('[data-indicator-distance]');
  if (!(root instanceof HTMLButtonElement) || !arrow || !distance) return null;
  return { root, arrow, distance };
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
