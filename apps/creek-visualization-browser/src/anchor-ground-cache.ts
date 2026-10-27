// The ground the browser draws at WSE Anchor Points and at the midlines of thin-water ribbon stations, for ribbon v2's anchor
// clearance lift and station drape (channel-ribbon-surface.ts).
// Each point is sampled once from the ground view's elevation sampler, the same source as the Dev tools "browser terrain"
// rows (browser-terrain-sampler.ts), and every sample is forgotten when the sampler reports that the drawn terrain changed
// (finer tiles loaded, or coarser ones replaced them after the camera moved). Tile loads come in bursts, so the owner is told
// once they pause, and a burst costs one recompute.

import { watch } from '@arcgis/core/core/reactiveUtils';
import Point from '@arcgis/core/geometry/Point';
import type SceneView from '@arcgis/core/views/SceneView';
import type { LonLat } from './creek-data-contract';

const GROUND_CHANGE_PAUSE_MS = 300;

export interface AnchorGroundCache {
  /** The drawn ground under the point, m NAVD88; null while the map has no ground there. */
  groundAt(lonLat: LonLat): number | null;
  /** How many times the map was sampled (cache misses), for measuring the cost. */
  readonly sampleCount: number;
  dispose(): void;
}

export function createAnchorGroundCache(view: SceneView, onGroundChanged: () => void): AnchorGroundCache {
  const groundByKey = new Map<string, number>();
  let sampleCount = 0;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let changedHandle: __esri.Handle | null = null;

  const noteChanged = (): void => {
    groundByKey.clear();
    if (pauseTimer !== null) clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      onGroundChanged();
    }, GROUND_CHANGE_PAUSE_MS);
  };
  // The ground view can replace its sampler, so follow it.
  const samplerWatch = watch(
    () => view.groundView?.elevationSampler,
    (sampler) => {
      changedHandle?.remove();
      changedHandle = sampler?.on('changed', noteChanged) ?? null;
      noteChanged();
    },
  );
  changedHandle = view.groundView?.elevationSampler?.on('changed', noteChanged) ?? null;

  return {
    groundAt([longitude, latitude]) {
      const key = `${longitude}|${latitude}`;
      const known = groundByKey.get(key);
      if (known !== undefined) return known;
      const sampler = view.groundView?.elevationSampler;
      if (!sampler) return null;
      sampleCount += 1;
      const sampled = sampler.queryElevation(new Point({ longitude, latitude, spatialReference: { wkid: 4326 } }));
      const z = sampled?.type === 'point' ? (sampled as Point).z : null;
      if (typeof z !== 'number' || !Number.isFinite(z) || z === sampler.noDataValue) return null;
      groundByKey.set(key, z);
      return z;
    },
    get sampleCount() {
      return sampleCount;
    },
    dispose() {
      samplerWatch.remove();
      changedHandle?.remove();
      if (pauseTimer !== null) clearTimeout(pauseTimer);
      groundByKey.clear();
    },
  };
}
