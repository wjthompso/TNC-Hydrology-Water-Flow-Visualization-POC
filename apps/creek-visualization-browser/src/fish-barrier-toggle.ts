// The sidebar checkbox that draws the TNC Digital Catalog fish barriers on the map. Sits under
// "Show creek centerlines and vertices" in the modeled-water panel. The drawing module loads and
// the two catalog layers are queried the first time it is ticked, so a reader who never ticks it
// pays nothing. Ticking it does not move the camera.

import type SceneView from '@arcgis/core/views/SceneView';
import type { ExperienceLifetime } from './experience-lifetime';
import type { FishBarrierMap } from './fish-barrier-map';
import { setCurrentFishBarrierMap } from './fish-barrier-state';

/** Sidebar checkbox label: a plain phrase first, the data source in parentheses. */
export const FISH_BARRIER_TOGGLE_LABEL = 'Show fish barriers (TNC Digital Catalog)';

export function bindFishBarrierToggle(
  toggle: HTMLInputElement,
  status: HTMLElement,
  view: SceneView,
  pinContainer: HTMLElement,
  lifetime: ExperienceLifetime,
): void {
  let map: FishBarrierMap | null = null;

  const show = async (): Promise<void> => {
    status.textContent = 'Reading the catalog…';
    const { openFishBarrierMap } = await import('./fish-barrier-map');
    const opened = await openFishBarrierMap(view, { pinContainer, lifetime });
    // The Dataset can change while the catalog is read; the barriers then belong to no experience.
    if (lifetime.signal.aborted) {
      opened.close();
      return;
    }
    map = opened;
    setCurrentFishBarrierMap(map);
    const noLongerBlocking = map.sites.filter((site) => site.description.removal !== null).length;
    const movedOntoChannel = map.sites.filter((site) => site.channelSnap.kind === 'channel').length;
    status.textContent =
      `${map.sites.length} barriers surveyed by TNC, ${movedOntoChannel} placed in the channel the scene draws. ` +
      `${noLongerBlocking} no longer block fish (removed or bypassed). Sizes are partly assumed.`;
  };

  const hide = (): void => {
    map?.close();
    map = null;
    setCurrentFishBarrierMap(null);
    status.textContent = '';
  };

  toggle.addEventListener(
    'change',
    () => {
      // One request at a time: a second tick before the catalog answers would draw the barriers twice.
      toggle.disabled = true;
      void (toggle.checked ? show() : Promise.resolve(hide()))
        .catch((error: unknown) => {
          console.warn('[fish-barrier-toggle] could not change the fish barriers', error);
          toggle.checked = false;
          status.textContent = 'Could not load the fish barriers.';
        })
        .finally(() => {
          toggle.disabled = false;
        });
    },
    { signal: lifetime.signal },
  );

  // A new Dataset starts with the barriers hidden, like the centerlines.
  lifetime.onEnd(() => {
    hide();
    toggle.checked = false;
  });
}
