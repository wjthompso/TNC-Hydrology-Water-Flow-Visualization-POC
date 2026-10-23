// Experience lifetime: the span between opening one Dataset's experience
// (observed or modeled) and replacing it with another's. The ArcGIS SceneView,
// the imagery, and the terrain outlive it. Everything an experience attaches to
// them (listeners, timers, map layers, highlights) registers its release here,
// so ending the lifetime leaves the scene as it was before the experience opened.

export interface ExperienceLifetime {
  /** Aborts when the lifetime ends. Pass it to `addEventListener(..., { signal })`. */
  readonly signal: AbortSignal;
  /** Runs `release` when the lifetime ends, or at once when it already has. Releases run last-registered first. */
  onEnd(release: () => void): void;
  /** `setInterval` that stops when the lifetime ends. */
  every(callback: () => void, intervalMs: number): void;
  /** Runs every release once. Later calls do nothing. */
  end(): void;
}

export function createExperienceLifetime(): ExperienceLifetime {
  const controller = new AbortController();
  const releases: (() => void)[] = [];

  const lifetime: ExperienceLifetime = {
    signal: controller.signal,
    onEnd(release) {
      if (controller.signal.aborted) {
        release();
        return;
      }
      releases.push(release);
    },
    every(callback, intervalMs) {
      const timerId = window.setInterval(callback, intervalMs);
      lifetime.onEnd(() => window.clearInterval(timerId));
    },
    end() {
      if (controller.signal.aborted) return;
      controller.abort();
      for (const release of releases.splice(0).reverse()) {
        try {
          release();
        } catch (error: unknown) {
          console.error('[experience-lifetime] a release failed', error);
        }
      }
    },
  };
  return lifetime;
}
