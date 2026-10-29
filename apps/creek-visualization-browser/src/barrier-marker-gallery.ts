// Developer-only gallery of every fish barrier model, lined up along the TNC Jalama Creek
// flowline just upstream of the Jalama Near Lompoc gauge, so a team can compare them on real
// terrain next to the observed creek. Opened from the dev tools HUD; never part of the shipped scene.

import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import TextSymbol3DLayer from '@arcgis/core/symbols/TextSymbol3DLayer';
import type SceneView from '@arcgis/core/views/SceneView';
import {
  BARRIER_MARKER_GALLERY_MODELS,
  barrierMarkerSymbol,
  type BarrierMarkerModel,
} from './barrier-marker-models';
import { bearingAlongPath, offsetPoint, pointAlongPath, type LonLatPair } from './geographic-path-geometry';

/**
 * TNC flowline 27714637 (Jalama Creek), from 443 m upstream of the USGS 11120600 gauge to 97 m
 * downstream, upstream to downstream. Converted from the flowline's UTM zone 10N (Universal
 * Transverse Mercator) vertices in data/source-inputs/tnc-flowline-27714637.json.
 */
const JALAMA_CREEK_NEAR_GAUGE_WGS84: readonly LonLatPair[] = [
  [-120.4811593, 34.5132851],
  [-120.4819951, 34.5124113],
  [-120.4821145, 34.5123454],
  [-120.4823269, 34.5123398],
  [-120.4827783, 34.5125155],
  [-120.4829177, 34.5125429],
  [-120.4833758, 34.5125537],
  [-120.4836081, 34.5126141],
  [-120.4841525, 34.5129764],
  [-120.4843584, 34.5131466],
  [-120.4847901, 34.5136904],
  [-120.4849295, 34.5138332],
  [-120.4851221, 34.513976],
  [-120.4856134, 34.5142285],
];

/** Distance along the path from its upstream end to the first model. The gauge sits 443 m along. */
const FIRST_MODEL_DISTANCE_M = 130;
const MODEL_SPACING_M = 60;
const LABEL_GAP_ABOVE_MODEL_M = 1.5;
const GALLERY_CAMERA_TILT_DEGREES = 65;

export interface BarrierMarkerGallery {
  readonly models: readonly BarrierMarkerModel[];
  /** Removes the gallery and flies back to the camera it opened from. */
  close(options?: { restoreCamera?: boolean }): Promise<void>;
}

export async function openBarrierMarkerGallery(view: SceneView): Promise<BarrierMarkerGallery> {
  const returnCamera = view.camera.clone();
  const layer = new GraphicsLayer({
    id: 'dev-hud-barrier-marker-gallery',
    listMode: 'hide',
    elevationInfo: { mode: 'relative-to-ground' },
  });
  view.map?.add(layer);

  const graphics: Graphic[] = [];
  for (const [index, model] of BARRIER_MARKER_GALLERY_MODELS.entries()) {
    const distanceM = FIRST_MODEL_DISTANCE_M + index * MODEL_SPACING_M;
    const center = pointAlongPath(JALAMA_CREEK_NEAR_GAUGE_WGS84, distanceM);
    const downstreamBearing = bearingAlongPath(JALAMA_CREEK_NEAR_GAUGE_WGS84, distanceM);
    const headingDegrees = (downstreamBearing + model.headingOffsetDegrees + 360) % 360;
    // Copies sit side by side across the creek: perpendicular to the flow.
    const acrossBearing = (downstreamBearing + 90) % 360;

    for (let copy = 0; copy < model.copiesAcrossCreek; copy += 1) {
      const sideM = (copy - (model.copiesAcrossCreek - 1) / 2) * model.copySpacingM;
      const [longitude, latitude] = sideM === 0 ? center : offsetPoint(center, acrossBearing, sideM);
      const marker = new Graphic({
        geometry: new Point({ longitude, latitude, z: 0, spatialReference: { wkid: 4326 } }),
        symbol: barrierMarkerSymbol(model, { headingDegrees }),
      });
      graphics.push(marker);
      layer.add(marker);
    }

    const labelHeightM = (model.sizeM.height ?? 3) + LABEL_GAP_ABOVE_MODEL_M;
    layer.add(
      new Graphic({
        geometry: new Point({
          longitude: center[0],
          latitude: center[1],
          z: labelHeightM,
          spatialReference: { wkid: 4326 },
        }),
        symbol: new PointSymbol3D({
          symbolLayers: [
            new TextSymbol3DLayer({
              text: `${index + 1}. ${model.label}`,
              size: 10,
              material: { color: 'white' },
              halo: { color: [10, 15, 18, 0.9], size: 1.5 },
            }),
          ],
        }),
      }),
    );
  }

  await view.goTo({ target: graphics, tilt: GALLERY_CAMERA_TILT_DEGREES }, { duration: 900 });

  return {
    models: BARRIER_MARKER_GALLERY_MODELS,
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
