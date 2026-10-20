// Monitoring station wayfinding (UCS-261):
// - an info card that floats over the clicked station and follows it as the camera moves
// - a screen-sized map-pin icon over each station that appears once the camera is
//   far enough that the 4 m mast is too small to find; clicking it flies back.

import Graphic from '@arcgis/core/Graphic';
import { watch } from '@arcgis/core/core/reactiveUtils';
import Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import IconSymbol3DLayer from '@arcgis/core/symbols/IconSymbol3DLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import LineCallout3D from '@arcgis/core/symbols/callouts/LineCallout3D';
import type SceneView from '@arcgis/core/views/SceneView';
import {
  MONITORING_STATION_MARKER_LAYER_ID,
  type StationMarkerAttributes,
} from './monitoring-station-marker-layer';
import { STREAM_GAUGE_MAST } from './station-marker-models';

export const MONITORING_STATION_LOCATOR_LAYER_ID = 'monitoring-station-locators';

/** Beyond this camera-to-station distance the mast is a few pixels tall, so the pin shows. */
const LOCATOR_VISIBLE_BEYOND_M = 400;
/** The pin floats this high over the station, joined to the ground by a callout line. */
const LOCATOR_HEIGHT_ABOVE_GROUND_M = 25;
const LOCATOR_ICON_SIZE_PX = 34;
/** The floating card's tail points at this height over the mast's base. */
const CARD_ANCHOR_ABOVE_MAST_TOP_M = 0.5;
/** Camera framing when flying back to a station from its pin. */
const RETURN_SCALE = 1200;
const RETURN_TILT_DEGREES = 62;

/**
 * Cyan teardrop map pin with a white gauge mast glyph (pole, arm, sensor).
 * Drawn as SVG so it stays crisp at any device pixel ratio.
 */
const LOCATOR_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="80" viewBox="0 0 64 80">
  <path d="M32 78 C32 78 6 48 6 30 A26 26 0 1 1 58 30 C58 48 32 78 32 78 Z"
        fill="#0891b2" stroke="#ecfeff" stroke-width="4"/>
  <g stroke="#ffffff" stroke-width="4" stroke-linecap="round" fill="none">
    <path d="M27 46 V16"/>
    <path d="M27 22 H44"/>
    <path d="M44 22 V28"/>
    <path d="M20 46 H34"/>
  </g>
  <rect x="21" y="30" width="12" height="9" rx="1.5" fill="#ffffff"/>
</svg>`;

const LOCATOR_ICON_HREF = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LOCATOR_ICON_SVG.trim())}`;

interface StationOnMap {
  readonly attributes: StationMarkerAttributes;
  /** Ground height in meters at the station, from the drawn terrain. */
  readonly groundElevationM: number;
  readonly locator: Graphic;
}

/**
 * Adds a pin per station, shows the info card over a clicked station or pin,
 * and keeps both in step with the camera.
 */
export async function installMonitoringStationLocator(
  view: SceneView,
  stationAttributes: readonly StationMarkerAttributes[],
): Promise<void> {
  const card = readCardElements();
  if (!card) return;

  const locatorLayer = new GraphicsLayer({
    id: MONITORING_STATION_LOCATOR_LAYER_ID,
    title: 'Monitoring station locators',
    elevationInfo: { mode: 'relative-to-ground' },
  });
  view.map?.add(locatorLayer);

  const stations: StationOnMap[] = [];
  for (const attributes of stationAttributes) {
    const locator = new Graphic({
      geometry: groundPoint(attributes),
      symbol: locatorSymbol(),
      attributes,
      visible: false,
    });
    locatorLayer.add(locator);
    stations.push({ attributes, groundElevationM: await groundElevationM(view, attributes), locator });
  }

  let openStation: StationOnMap | null = null;

  const placeCard = (): void => {
    if (!openStation) return;
    const { attributes, groundElevationM: groundM } = openStation;
    const anchor = view.toScreen(
      new Point({
        longitude: attributes.longitude,
        latitude: attributes.latitude,
        z: groundM + STREAM_GAUGE_MAST.heightM + CARD_ANCHOR_ABOVE_MAST_TOP_M,
        spatialReference: { wkid: 4326 },
      }),
    );
    const onScreen =
      anchor !== null &&
      anchor !== undefined &&
      anchor.x >= 0 &&
      anchor.y >= 0 &&
      anchor.x <= view.width &&
      anchor.y <= view.height;
    // Off-screen or behind the camera: hide the card but keep it open, so it
    // reappears when the station comes back into view.
    card.root.classList.toggle('invisible', !onScreen);
    if (!onScreen) return;
    card.root.style.left = `${anchor.x}px`;
    card.root.style.top = `${anchor.y}px`;
  };

  const updateLocators = (): void => {
    const cameraPosition = view.camera.position;
    for (const station of stations) {
      const distanceM = cameraDistanceM(cameraPosition, station);
      station.locator.visible = distanceM > LOCATOR_VISIBLE_BEYOND_M;
    }
  };

  const openCard = (station: StationOnMap): void => {
    openStation = station;
    fillCard(card, station.attributes);
    card.root.classList.remove('hidden');
    placeCard();
  };

  const closeCard = (): void => {
    openStation = null;
    card.root.classList.add('hidden');
  };

  card.closeButton.addEventListener('click', closeCard);

  view.on('click', async (event) => {
    const result = await view.hitTest(event, { include: [locatorLayer, ...stationMarkerLayers(view)] });
    const hit = result.results.find((item) => item.type === 'graphic');
    const station =
      hit?.type === 'graphic'
        ? stations.find((item) => item.attributes.stationId === hit.graphic.attributes?.stationId)
        : undefined;
    if (!station) {
      closeCard();
      return;
    }
    openCard(station);
    if (hit?.type === 'graphic' && hit.graphic.layer?.id === MONITORING_STATION_LOCATOR_LAYER_ID) {
      await view
        .goTo({ target: groundPoint(station.attributes), scale: RETURN_SCALE, tilt: RETURN_TILT_DEGREES }, { duration: 1200 })
        .catch(() => undefined);
    }
  });

  watch(
    () => view.camera,
    () => {
      updateLocators();
      placeCard();
    },
    { initial: true },
  );
  // Width and height changes move every screen point without moving the camera.
  watch(
    () => [view.width, view.height],
    () => placeCard(),
  );
}

function locatorSymbol(): PointSymbol3D {
  return new PointSymbol3D({
    symbolLayers: [
      new IconSymbol3DLayer({
        resource: { href: LOCATOR_ICON_HREF },
        size: LOCATOR_ICON_SIZE_PX,
        anchor: 'bottom',
      }),
    ],
    verticalOffset: {
      screenLength: 40,
      minWorldLength: LOCATOR_HEIGHT_ABOVE_GROUND_M,
      maxWorldLength: 2000,
    },
    callout: new LineCallout3D({
      color: [236, 254, 255, 0.9],
      size: 1.5,
      border: { color: [8, 51, 68, 0.8] },
    }),
  });
}

function stationMarkerLayers(view: SceneView): __esri.Layer[] {
  return view.map?.allLayers.filter((layer) => layer.id === MONITORING_STATION_MARKER_LAYER_ID).toArray() ?? [];
}

function groundPoint(attributes: StationMarkerAttributes): Point {
  return new Point({
    longitude: attributes.longitude,
    latitude: attributes.latitude,
    z: 0,
    spatialReference: { wkid: 4326 },
  });
}

async function groundElevationM(view: SceneView, attributes: StationMarkerAttributes): Promise<number> {
  try {
    const result = await view.map?.ground.queryElevation(groundPoint(attributes));
    const z = result?.geometry.type === 'point' ? result.geometry.z : undefined;
    return typeof z === 'number' && Number.isFinite(z) ? z : 0;
  } catch {
    return 0;
  }
}

/** Straight-line camera-to-station distance, in meters, using a local flat projection. */
function cameraDistanceM(cameraPosition: Point, station: StationOnMap): number {
  // `longitude`/`latitude` are computed for both WGS84 and Web Mercator points.
  const cameraLon = cameraPosition.longitude ?? 0;
  const cameraLat = cameraPosition.latitude ?? 0;
  const { longitude, latitude } = station.attributes;
  const eastM = (cameraLon - longitude) * 111320 * Math.cos((latitude * Math.PI) / 180);
  const northM = (cameraLat - latitude) * 110540;
  const upM = (cameraPosition.z ?? 0) - station.groundElevationM;
  return Math.hypot(eastM, northM, upM);
}

// --- Info card DOM -----------------------------------------------------------

interface CardElements {
  root: HTMLElement;
  name: HTMLElement;
  coords: HTMLElement;
  link: HTMLAnchorElement;
  closeButton: HTMLElement;
}

function readCardElements(): CardElements | null {
  const root = document.getElementById('station-info-card');
  const name = document.getElementById('station-info-name');
  const coords = document.getElementById('station-info-coords');
  const link = document.getElementById('station-info-link');
  const closeButton = document.getElementById('station-info-close');
  if (!root || !name || !coords || !(link instanceof HTMLAnchorElement) || !closeButton) return null;
  return { root, name, coords, link, closeButton };
}

function fillCard(card: CardElements, attributes: StationMarkerAttributes): void {
  card.name.textContent = attributes.name;
  card.coords.textContent = `${attributes.latitude.toFixed(6)}°N, ${Math.abs(attributes.longitude).toFixed(6)}°W`;
  card.link.hidden = attributes.websiteUrl === null;
  if (attributes.websiteUrl) card.link.href = attributes.websiteUrl;
}
