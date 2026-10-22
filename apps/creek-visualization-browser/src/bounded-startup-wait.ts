/**
 * Bounded startup wait (UCS-285).
 *
 * Startup waits on terrain answers (the USGS 3DEP preflight tile, Esri World
 * Elevation, `ground.queryElevation`) that can stall for tens of seconds
 * while the creek data is already loaded. `waitAtMost` stops waiting after a
 * limit so the loading overlay can go away; the promise keeps running, so a
 * caller can still apply its late answer.
 */

export type BoundedWaitResult<Value> =
  | { readonly settled: true; readonly value: Value }
  | { readonly settled: false };

/** Resolves with the promise's value, or `{ settled: false }` once `limitMs` passes first. Rejections pass through. */
export async function waitAtMost<Value>(
  promise: Promise<Value>,
  limitMs: number,
): Promise<BoundedWaitResult<Value>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedWaitResult<Value>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), limitMs);
  });
  try {
    return await Promise.race([
      promise.then((value): BoundedWaitResult<Value> => ({ settled: true, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
