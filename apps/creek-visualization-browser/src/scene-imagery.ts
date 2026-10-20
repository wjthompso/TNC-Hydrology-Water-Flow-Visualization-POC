// Scene imagery choice (UCS-262). Terms follow docs/architecture/glossary.md:
// Esri World Imagery is the base imagery everywhere; the Preserve Aerial
// Imagery Overlay (overlay imagery) draws over it inside the Preserve flight
// area only, so wide and coastal views keep the base imagery.

import type EsriMap from '@arcgis/core/Map';
import type Layer from '@arcgis/core/layers/Layer';
import ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import TileLayer from '@arcgis/core/layers/TileLayer';
import RasterStretchRenderer from '@arcgis/core/renderers/RasterStretchRenderer';
import {
  DEFAULT_SCENE_IMAGERY_ID,
  SCENE_IMAGERY_QUERY_PARAM,
  type SceneImageryId,
} from './scene-imagery-options';

export {
  SCENE_IMAGERY_OPTIONS,
  readSceneImageryId,
  sceneImageryCredit,
  type SceneImageryId,
} from './scene-imagery-options';

/** One map layer id for whichever overlay imagery is showing, so a switch replaces it. */
const OVERLAY_IMAGERY_LAYER_ID = 'preserve-aerial-imagery-overlay';

/**
 * Overlay imagery draws only when zoomed closer than about 1:20,000
 * (a camera a few kilometers up). Farther out the base imagery looks the
 * same, and skipping these tiles keeps wide and coastal views fast to load.
 */
const OVERLAY_IMAGERY_MIN_SCALE = 20_000;

/**
 * 8 cm, January 2024, donated via Vandenberg. A tiled ImageServer of 5-band
 * LERC (Limited Error Raster Compression) tiles: bands 1–3 are red, green,
 * blue; band 5 is the validity mask. ArcGIS Online item 51897a70885a47a9817dcc4bebd9b304.
 * The item's license reads "FOR DEMO PURPOSES ONLY".
 */
const OVERLAY_IMAGERY_2024_URL =
  'https://tiledimageservices.arcgis.com/6DIQcwlPy8knb6sg/arcgis/rest/services/DangermondPreserve/ImageServer';

/**
 * October 2019, 4-band imagery flown for Vandenberg, published by the TNC
 * Preserve account as a cached MapServer (tiles to zoom 20).
 * ArcGIS Online item 1d9d43d88bf4437b9d72a5d7584a3e3c.
 */
const OVERLAY_IMAGERY_2019_URL =
  'https://tiles.arcgis.com/tiles/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_imagery_2019/MapServer';

/**
 * Replaces the overlay imagery with the chosen one. Index 0 keeps it
 * directly above the base imagery and below the water graphics.
 */
export function showSceneImagery(map: EsriMap, id: SceneImageryId): void {
  const previous = map.findLayerById(OVERLAY_IMAGERY_LAYER_ID);
  if (previous) {
    map.remove(previous);
    previous.destroy();
  }
  const layer = createOverlayImageryLayer(id);
  if (layer) map.add(layer, 0);
}

/** Keeps the address bar reloadable; the default choice is dropped from the URL. */
export function writeSceneImageryToUrl(id: SceneImageryId): void {
  const url = new URL(window.location.href);
  if (id === DEFAULT_SCENE_IMAGERY_ID) url.searchParams.delete(SCENE_IMAGERY_QUERY_PARAM);
  else url.searchParams.set(SCENE_IMAGERY_QUERY_PARAM, id);
  window.history.replaceState(window.history.state, '', url);
}

function createOverlayImageryLayer(id: SceneImageryId): Layer | null {
  switch (id) {
    case 'preserve-2024':
      return new ImageryTileLayer({
        id: OVERLAY_IMAGERY_LAYER_ID,
        url: OVERLAY_IMAGERY_2024_URL,
        title: 'Preserve Aerial Imagery Overlay, January 2024',
        bandIds: [0, 1, 2],
        // Raw 8-bit values are already display-ready color; a stretch would shift it.
        renderer: new RasterStretchRenderer({ stretchType: 'none' }),
        interpolation: 'bilinear',
        minScale: OVERLAY_IMAGERY_MIN_SCALE,
        // The service stops at maxScale 300. Without this override the layer turns
        // off at very close zoom and the base imagery shows through instead.
        maxScale: 0,
      });
    case 'preserve-2019':
      return new TileLayer({
        id: OVERLAY_IMAGERY_LAYER_ID,
        url: OVERLAY_IMAGERY_2019_URL,
        title: 'Preserve Aerial Imagery Overlay, October 2019',
        minScale: OVERLAY_IMAGERY_MIN_SCALE,
        // The service stops at zoom 20 (maxScale 564). Without this override the layer
        // turns off at close zoom and the base imagery shows through instead.
        maxScale: 0,
      });
    case 'esri-world-imagery':
      return null;
  }
}
