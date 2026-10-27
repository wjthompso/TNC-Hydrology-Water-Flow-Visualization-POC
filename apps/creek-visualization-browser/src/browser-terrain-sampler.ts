// Ground height under a longitude and latitude, as the browser's 3D scene draws it
// (Dev tools water click inspector). The scene's ground is Esri World Elevation with
// the USGS 3DEP (3D Elevation Program) layer on top near the creek
// (standalone-experience-shell.ts); this reads that ground, not the 1 m lidar the
// pipeline uses and not a separate service.

import Point from '@arcgis/core/geometry/Point';
import type SceneView from '@arcgis/core/views/SceneView';
import { waitAtMost } from './bounded-startup-wait';
import type { TerrainSample } from './water-click-readout';

/** A ground query that stalls (an unreachable elevation service) must not freeze the readout. */
const GROUND_QUERY_WAIT_LIMIT_MS = 4000;

function finiteHeight(point: { z?: number | null } | null | undefined): number | null {
  const z = point?.z;
  return typeof z === 'number' && Number.isFinite(z) ? z : null;
}

export async function sampleBrowserTerrain(
  view: SceneView,
  longitude: number,
  latitude: number,
): Promise<TerrainSample> {
  const location = new Point({ longitude, latitude, spatialReference: { wkid: 4326 } });

  // The ground view's sampler answers from the terrain tiles currently drawn, so it is the mesh as seen.
  let meshM: number | null = null;
  let source: TerrainSample['browserTerrainSource'] = 'unavailable';
  try {
    const sampled = view.groundView?.elevationSampler?.queryElevation(location);
    meshM = sampled && sampled.type === 'point' ? finiteHeight(sampled as Point) : null;
    if (meshM !== null) source = 'ground-view-elevation-sampler';
  } catch (error) {
    console.warn('[water-click-inspector] ground view sampler failed', error);
  }

  const ground = view.map?.ground;
  if (meshM === null && ground) {
    const queried = await waitAtMost(ground.queryElevation(location), GROUND_QUERY_WAIT_LIMIT_MS).catch(() => null);
    if (queried?.settled && queried.value.geometry.type === 'point') {
      meshM = finiteHeight(queried.value.geometry as Point);
      if (meshM !== null) source = 'ground-query-elevation';
    }
  }

  let finestM: number | null = null;
  if (ground) {
    const queried = await waitAtMost(
      ground.queryElevation(location, { demResolution: 'finest-contiguous' }),
      GROUND_QUERY_WAIT_LIMIT_MS,
    ).catch(() => null);
    if (queried?.settled && queried.value.geometry.type === 'point') finestM = finiteHeight(queried.value.geometry as Point);
  }

  return { browserTerrainMeshM: meshM, browserTerrainSource: source, finestGroundQueryM: finestM };
}
