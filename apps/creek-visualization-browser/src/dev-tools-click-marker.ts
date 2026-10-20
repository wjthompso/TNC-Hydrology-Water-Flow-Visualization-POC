// Yellow ring and center dot at the last place clicked on the map.
// The layer stays on the map for the whole session. Callers show it only
// while the dev tools panel is open; hiding the layer keeps the last click.

import Graphic from '@arcgis/core/Graphic';
import type Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol';
import type SceneView from '@arcgis/core/views/SceneView';

/** Signal yellow, the same yellow as the dev tools hazard stripe. */
const MARKER_YELLOW = '#f3ef2a';

export interface DevToolsClickMarker {
  /** Show or hide the ring without forgetting the last click. */
  setVisible(visible: boolean): void;
  /** Draws the ring and dot at this map point. A missing point clears them. */
  noteClick(mapPoint: Point | null | undefined): void;
}

export function createDevToolsClickMarker(view: SceneView): DevToolsClickMarker {
  const layer = new GraphicsLayer({
    id: 'dev-hud-click-marker',
    listMode: 'hide',
    visible: false,
  });
  view.map?.add(layer);

  const ringSymbol = new SimpleMarkerSymbol({
    style: 'circle',
    color: [0, 0, 0, 0],
    size: 14,
    outline: new SimpleLineSymbol({ color: MARKER_YELLOW, width: 2 }),
  });
  const dotSymbol = new SimpleMarkerSymbol({
    style: 'circle',
    color: MARKER_YELLOW,
    size: 5,
  });

  let graphics: Graphic[] = [];

  return {
    setVisible(visible) {
      layer.visible = visible;
    },
    noteClick(mapPoint) {
      if (graphics.length > 0) layer.removeMany(graphics);
      if (!mapPoint) {
        graphics = [];
        return;
      }
      const ring = new Graphic({ geometry: mapPoint, symbol: ringSymbol });
      const dot = new Graphic({ geometry: mapPoint, symbol: dotSymbol });
      layer.addMany([ring, dot]);
      graphics = [ring, dot];
    },
  };
}
