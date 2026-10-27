// 2018 colorized LiDAR point cloud. The Digital Twin's 3D LiDAR button draws
// this same scene layer. Heights are absolute NAVD88 (North American Vertical
// Datum of 1988) meters, the vertical datum on the service, so the points sit
// in this scene at the elevations they were surveyed. The layer stays unloaded
// until the corner button is pressed.

import PointCloudLayer from '@arcgis/core/layers/PointCloudLayer';
import PointCloudRGBRenderer from '@arcgis/core/renderers/PointCloudRGBRenderer';
import type EsriMap from '@arcgis/core/Map';
import type SceneView from '@arcgis/core/views/SceneView';

/**
 * Scene layer (a cached 3D point cloud), the service the Digital Twin loads.
 * ArcGIS Online item b510959fce08462d9ac792c471e9d727.
 */
const LIDAR_POINT_CLOUD_URL =
  'https://tiles.arcgis.com/tiles/6DIQcwlPy8knb6sg/arcgis/rest/services/All_Aeroptic_ColorizedPointCloud/SceneServer';

const LIDAR_POINT_CLOUD_LAYER_ID = 'dangermond-preserve-lidar-point-cloud';

const SHOW_LABEL = 'Show 2018 LiDAR point cloud';
const HIDE_LABEL = 'Hide 2018 LiDAR point cloud';

/** Same point size and color field the Digital Twin uses for this layer. */
const LIDAR_RENDERER = new PointCloudRGBRenderer({
  field: 'RGB',
  pointSizeAlgorithm: {
    type: 'fixed-size',
    useRealWorldSymbolSizes: false,
    size: 3,
  },
});

export function bindLidarPointCloudToggle(view: SceneView): void {
  const button = document.getElementById('lidar-visibility-toggle');
  const map = view.map;
  if (!(button instanceof HTMLButtonElement) || !map) return;

  let visible = false;
  let loadGeneration = 0;

  const paint = (): void => {
    button.setAttribute('aria-pressed', String(visible));
    const label = visible ? HIDE_LABEL : SHOW_LABEL;
    button.title = label;
    button.setAttribute('aria-label', label);
  };

  button.addEventListener('click', () => {
    visible = !visible;
    paint();
    if (!visible) {
      const layer = map.findLayerById(LIDAR_POINT_CLOUD_LAYER_ID);
      if (layer) layer.visible = false;
      button.removeAttribute('aria-busy');
      return;
    }

    const layer = showLidarPointCloud(map);
    const generation = ++loadGeneration;
    button.setAttribute('aria-busy', 'true');
    void layer
      .load()
      .catch((error: unknown) => {
        console.error('The 2018 LiDAR point cloud did not load.', error);
        if (generation !== loadGeneration) return;
        visible = false;
        layer.visible = false;
        paint();
      })
      .finally(() => {
        if (generation === loadGeneration) button.removeAttribute('aria-busy');
      });
  });

  paint();
}

/** Adds the point cloud the first time it is shown, then turns it on. */
function showLidarPointCloud(map: EsriMap): PointCloudLayer {
  const existing = map.findLayerById(LIDAR_POINT_CLOUD_LAYER_ID);
  if (existing?.type === 'point-cloud') {
    existing.visible = true;
    return existing as PointCloudLayer;
  }

  const layer = new PointCloudLayer({
    id: LIDAR_POINT_CLOUD_LAYER_ID,
    url: LIDAR_POINT_CLOUD_URL,
    title: 'Dangermond Preserve LiDAR Point Cloud',
    visible: true,
    popupEnabled: false,
    elevationInfo: { mode: 'absolute-height' },
    renderer: LIDAR_RENDERER,
  });
  map.add(layer);
  return layer;
}
