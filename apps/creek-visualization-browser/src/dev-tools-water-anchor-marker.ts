// Hot-pink marker for the selected Creek Segment's WSE Anchor Point (glossary: the
// spot on the creek bed where the modeled water-surface elevation applies), drawn
// in the 3D scene by the Dev tools water click inspector:
// - a dot at the anchor's longitude and latitude, at the water height drawn there;
// - a flag floating above it on a callout line (a screen-space offset, so terrain cannot bury it);
// - a smaller dot at the anchor's bed height and a line up to the water, when the bed is known.
// The layer stays on the map for the experience; callers show it only while Dev tools is open.

import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import IconSymbol3DLayer from '@arcgis/core/symbols/IconSymbol3DLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol';
import LineCallout3D from '@arcgis/core/symbols/callouts/LineCallout3D';
import type SceneView from '@arcgis/core/views/SceneView';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';

const ANCHOR_PINK = '#ff2d95';
const FLAG_LIFT_SCREEN_PX = 56;

export interface WaterAnchorMarkerPosition {
  longitude: number;
  latitude: number;
  /** Water height drawn at the anchor, m NAVD88. */
  waterSurfaceM: number;
  /** Creek-bed height at the anchor, m NAVD88; null draws no bed dot or line. */
  bedM: number | null;
}

export interface WaterAnchorMarker {
  /** Draws the marker at the position; null removes it. */
  show(position: WaterAnchorMarkerPosition | null): void;
  /** Shows or hides the layer without forgetting the position. */
  setVisible(visible: boolean): void;
}

export function createWaterAnchorMarker(
  view: SceneView,
  lifetime: ExperienceLifetime = createExperienceLifetime(),
): WaterAnchorMarker {
  const layer = new GraphicsLayer({
    id: 'dev-hud-water-anchor-marker',
    listMode: 'hide',
    visible: false,
    elevationInfo: { mode: 'absolute-height' },
  });
  view.map?.add(layer);
  lifetime.onEnd(() => {
    view.map?.remove(layer);
    layer.destroy();
  });

  const flagSymbol = new PointSymbol3D({
    symbolLayers: [
      new IconSymbol3DLayer({
        resource: { primitive: 'circle' },
        size: 16,
        material: { color: ANCHOR_PINK },
        outline: { color: 'white', size: 2 },
      }),
    ],
    verticalOffset: { screenLength: FLAG_LIFT_SCREEN_PX, maxWorldLength: 500, minWorldLength: 2 },
    callout: new LineCallout3D({ color: ANCHOR_PINK, size: 1.5, border: { color: 'white' } }),
  });
  const waterDotSymbol = new SimpleMarkerSymbol({
    style: 'circle',
    color: ANCHOR_PINK,
    size: 7,
    outline: new SimpleLineSymbol({ color: 'white', width: 1.5 }),
  });
  const bedDotSymbol = new SimpleMarkerSymbol({
    style: 'circle',
    color: 'white',
    size: 6,
    outline: new SimpleLineSymbol({ color: ANCHOR_PINK, width: 1.5 }),
  });
  const depthLineSymbol = new SimpleLineSymbol({ color: ANCHOR_PINK, width: 2 });

  let graphics: Graphic[] = [];

  return {
    setVisible(visible) {
      layer.visible = visible;
    },
    show(position) {
      if (graphics.length > 0) layer.removeMany(graphics);
      graphics = [];
      if (!position) return;
      const { longitude, latitude, waterSurfaceM, bedM } = position;
      const pointAt = (z: number): Point =>
        new Point({ longitude, latitude, z, hasZ: true, spatialReference: { wkid: 4326 } });
      graphics.push(
        new Graphic({ geometry: pointAt(waterSurfaceM), symbol: flagSymbol }),
        new Graphic({ geometry: pointAt(waterSurfaceM), symbol: waterDotSymbol }),
      );
      if (bedM !== null) {
        graphics.push(
          new Graphic({ geometry: pointAt(bedM), symbol: bedDotSymbol }),
          new Graphic({
            geometry: new Polyline({
              hasZ: true,
              paths: [
                [
                  [longitude, latitude, bedM],
                  [longitude, latitude, waterSurfaceM],
                ],
              ],
              spatialReference: { wkid: 4326 },
            }),
            symbol: depthLineSymbol,
          }),
        );
      }
      layer.addMany(graphics);
    },
  };
}
