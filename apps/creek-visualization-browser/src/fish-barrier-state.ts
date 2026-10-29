// The one drawn set of fish barriers, shared between the sidebar checkbox that draws it
// (fish-barrier-toggle.ts) and the Dev tools section that lists and flies to its barriers
// (dev-tools-hud.ts). Holds no ArcGIS code, so the Dev tools panel can read it without loading
// the drawing module.

import type { FishBarrierMap } from './fish-barrier-map';

let current: FishBarrierMap | null = null;
const listeners = new Set<(map: FishBarrierMap | null) => void>();

/** The barriers now drawn on the map, or null when they are hidden. */
export function currentFishBarrierMap(): FishBarrierMap | null {
  return current;
}

export function setCurrentFishBarrierMap(map: FishBarrierMap | null): void {
  current = map;
  for (const listener of [...listeners]) listener(map);
}

/** Calls `listener` whenever the barriers are drawn or hidden. Returns a function that stops it. */
export function onFishBarrierMapChange(listener: (map: FishBarrierMap | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
