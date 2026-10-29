// Developer-only gallery of every station marker model, lined up along Jalama
// Road west of the Jalama Near Lompoc gauge bridge so a team can compare them
// on real terrain. Opened from the dev tools HUD; never part of the shipped scene.

import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import TextSymbol3DLayer from '@arcgis/core/symbols/TextSymbol3DLayer';
import type SceneView from '@arcgis/core/views/SceneView';
import { bearingAlongPath, pointAlongPath } from './geographic-path-geometry';
import {
  STATION_MARKER_GALLERY_MODELS,
  stationMarkerSymbol,
  type StationMarkerModel,
} from './station-marker-models';

/**
 * Jalama Road centerline west of the gauge bridge, east to west. Vertices from
 * OpenStreetMap way 16263790 (© OpenStreetMap contributors, ODbL), retrieved
 * 2026-10-20. The bridge itself (way 347766858) is skipped: a ground-relative
 * marker there would sit in the creek bed under the deck.
 */
const JALAMA_ROAD_WEST_OF_BRIDGE_WGS84: readonly (readonly [number, number])[] = [
  [-120.4849977, 34.5137303],
  [-120.4853414, 34.513721],
  [-120.48545, 34.513718],
  [-120.485868, 34.513749],
  [-120.4866411, 34.513761],
];

/** Gap between the bridge's west end and the first marker. */
const FIRST_MARKER_DISTANCE_M = 14;
const MARKER_SPACING_M = 11;
const LABEL_GAP_ABOVE_MARKER_M = 1.2;
const GALLERY_CAMERA_TILT_DEGREES = 68;

export const STATION_MARKER_STATUS_TINTS = [
  { id: 'original', label: 'Original colors', color: null },
  { id: 'active', label: 'Active', color: [34, 197, 94, 1] },
  { id: 'unavailable', label: 'Unavailable', color: [148, 163, 184, 1] },
  { id: 'relative-only', label: 'Relative only', color: [245, 158, 11, 1] },
  { id: 'proposed', label: 'Proposed', color: [56, 189, 248, 0.45] },
] as const satisfies readonly {
  id: string;
  label: string;
  color: readonly [number, number, number, number] | null;
}[];

export type StationMarkerStatusTintId = (typeof STATION_MARKER_STATUS_TINTS)[number]['id'];

export interface StationMarkerGallery {
  readonly models: readonly StationMarkerModel[];
  /** Recolors every marker. */
  setStatusTint(tintId: StationMarkerStatusTintId): Promise<void>;
  /** Removes the gallery and flies back to the camera it opened from. */
  close(options?: { restoreCamera?: boolean }): Promise<void>;
}

export async function openStationMarkerGallery(view: SceneView): Promise<StationMarkerGallery> {
  const returnCamera = view.camera.clone();
  const layer = new GraphicsLayer({
    id: 'dev-hud-station-marker-gallery',
    listMode: 'hide',
    elevationInfo: { mode: 'relative-to-ground' },
  });
  view.map?.add(layer);

  const placements = STATION_MARKER_GALLERY_MODELS.map((model, index) => ({
    model,
    position: pointAlongPath(JALAMA_ROAD_WEST_OF_BRIDGE_WGS84, FIRST_MARKER_DISTANCE_M + index * MARKER_SPACING_M),
    // Bearing of travel along the road, so each model faces across it the same way.
    roadBearingDegrees: bearingAlongPath(
      JALAMA_ROAD_WEST_OF_BRIDGE_WGS84,
      FIRST_MARKER_DISTANCE_M + index * MARKER_SPACING_M,
    ),
  }));

  const markerGraphics: Graphic[] = [];
  for (const [index, placement] of placements.entries()) {
    const [longitude, latitude] = placement.position;
    const marker = new Graphic({
      geometry: new Point({ longitude, latitude, z: 0, spatialReference: { wkid: 4326 } }),
      symbol: await stationMarkerSymbol(placement.model, { headingDegrees: placement.roadBearingDegrees }),
    });
    markerGraphics.push(marker);
    layer.add(marker);
    layer.add(
      new Graphic({
        geometry: new Point({
          longitude,
          latitude,
          z: placement.model.heightM + LABEL_GAP_ABOVE_MARKER_M,
          spatialReference: { wkid: 4326 },
        }),
        symbol: new PointSymbol3D({
          symbolLayers: [
            new TextSymbol3DLayer({
              text: `${index + 1}. ${placement.model.label}`,
              size: 10,
              material: { color: 'white' },
              halo: { color: [10, 15, 18, 0.9], size: 1.5 },
            }),
          ],
        }),
      }),
    );
  }

  await view.goTo({ target: markerGraphics, tilt: GALLERY_CAMERA_TILT_DEGREES }, { duration: 900 });

  return {
    models: STATION_MARKER_GALLERY_MODELS,
    async setStatusTint(tintId) {
      const tint = STATION_MARKER_STATUS_TINTS.find((entry) => entry.id === tintId) ?? STATION_MARKER_STATUS_TINTS[0];
      for (const [index, placement] of placements.entries()) {
        markerGraphics[index].symbol = await stationMarkerSymbol(placement.model, {
          headingDegrees: placement.roadBearingDegrees,
          color: tint.color,
        });
      }
    },
    async close(options) {
      view.map?.remove(layer);
      layer.destroy();
      if (options?.restoreCamera === false) return;
      // Not awaited: a user grabbing the camera mid-flight would otherwise leave
      // the gallery panel stuck in its busy state.
      view.goTo(returnCamera, { duration: 900 }).catch(() => undefined);
    },
  };
}