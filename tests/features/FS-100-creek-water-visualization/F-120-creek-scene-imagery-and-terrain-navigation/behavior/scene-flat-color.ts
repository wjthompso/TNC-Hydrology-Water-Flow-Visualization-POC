import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page, TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';
import { approvedExternalDisruptionEvidence } from '../../../../support/network/live-release-evidence.ts';
import {
  rethrowIfExternalOutage,
  type LiveServiceWatch,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';

/** Exact-RGB mode share. Photographic frames stay under this; a void does not. */
export const EXACT_FLAT_SHARE_LIMIT = 0.1;
/** Far-zoom bug only appears once the camera is beyond the old 80 km clip. */
export const FAR_ZOOM_ALTITUDE_M = 100_000;
export const WHEEL_DELTA_Y = 420;
/** One grouped notch. Three events reach the coast-scale camera, about 12 km. */
export const COAST_WHEEL_EVENTS = 3;
/** Coast notch, then two more events. That sequence reaches about 330 km. */
export const FAR_ZOOM_WHEEL_BURSTS = [3, 2] as const;

const SETTLED_QUIET_MS = 80;
const OPENING_SETTLE_BUDGET_MS = 250;
const ZOOM_SETTLE_BUDGET_MS = 200;
/** Sample every Nth pixel. Voids are uniform, so the exact-flat share is unchanged. */
const PIXEL_STRIDE = 4;
/** Left-center viewport clip. On the old failure frames this still measured 34% navy and 92% white. */
const SCENE_CLIP = { x: 0, y: 120, width: 640, height: 480 };
const WHEEL_POINT = { x: 893, y: 495 };

const ABORTED_REQUEST = /ERR_ABORTED|\baborted\b/i;
const TRANSPORT_FAILURE =
  /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_CERT|ERR_SSL|ERR_TLS|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_TUNNEL|ERR_PROXY|ERR_EMPTY_RESPONSE|ERR_SSL_PROTOCOL|NS_ERROR_NET|ECONNRESET|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|certificate|tls handshake/i;

const LIVE_TERRAIN_REQUEST =
  /services\.arcgisonline\.com|server\.arcgisonline\.com|ibasemaps|elevation3d\.arcgis\.com|basemaps\.arcgis\.com|basemaps-api\.arcgis\.com/i;

export interface TerrainTraffic {
  successfulTiles: number;
  rateLimitedResponses: number;
  serverErrorResponses: number;
  transportFailures: string[];
  lastActivityAt: number;
}

interface SidebarMask {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FlatColorSample {
  share: number;
  count: number;
  unmaskedPixels: number;
  red: number;
  green: number;
  blue: number;
}

export function watchTerrainTraffic(page: Page): TerrainTraffic {
  const traffic: TerrainTraffic = {
    successfulTiles: 0,
    rateLimitedResponses: 0,
    serverErrorResponses: 0,
    transportFailures: [],
    lastActivityAt: Date.now(),
  };
  const noteTerrainActivity = (url: string) => {
    if (LIVE_TERRAIN_REQUEST.test(url)) traffic.lastActivityAt = Date.now();
  };
  page.on('request', (request) => noteTerrainActivity(request.url()));
  page.on('response', (response) => {
    noteTerrainActivity(response.url());
    if (!LIVE_TERRAIN_REQUEST.test(response.url())) return;
    const status = response.status();
    if (status === 429) traffic.rateLimitedResponses += 1;
    else if (status >= 500) traffic.serverErrorResponses += 1;
    else if (status >= 200 && status < 300) traffic.successfulTiles += 1;
  });
  page.on('requestfailed', (request) => {
    if (!LIVE_TERRAIN_REQUEST.test(request.url())) return;
    const failure = request.failure()?.errorText ?? 'unknown request failure';
    if (ABORTED_REQUEST.test(failure) || !TRANSPORT_FAILURE.test(failure)) return;
    traffic.transportFailures.push(`${request.url()} ${failure}`);
  });
  return traffic;
}

export function throwIfTerrainOutage(terrain: TerrainTraffic, watch: LiveServiceWatch): void {
  if (terrain.rateLimitedResponses > 0) {
    throw new Error(`INCONCLUSIVE: HTTP 429 responses: ${terrain.rateLimitedResponses}`);
  }
  if (terrain.serverErrorResponses > 0) {
    throw new Error(`INCONCLUSIVE: HTTP 5xx responses: ${terrain.serverErrorResponses}`);
  }
  const transportFailure = terrain.transportFailures[0];
  if (transportFailure) {
    throw new Error(`INCONCLUSIVE: ${transportFailure}`);
  }
  if (terrain.successfulTiles === 0) {
    const evidence = approvedExternalDisruptionEvidence({
      message: 'no imagery or elevation tiles arrived',
      pageErrors: watch.pageErrors,
      network: watch.summarize(),
    });
    throw new Error(
      `INCONCLUSIVE: no imagery or elevation tiles arrived. ${evidence ?? 'The frame never drew terrain.'}`,
    );
  }
}

export function rethrowSceneFailure(
  error: unknown,
  failures: readonly string[],
  watch: LiveServiceWatch,
): never {
  if (error instanceof Error && error.message.startsWith('INCONCLUSIVE:')) throw error;
  if (failures.length > 0) {
    const detail = error instanceof Error ? error.message : String(error);
    const flatReport = failures.join('\n');
    throw new Error(detail.includes(failures[0] ?? flatReport) ? detail : `${flatReport}\n${detail}`, {
      cause: error,
    });
  }
  rethrowIfExternalOutage(watch, error);
}

export async function sidebarMask(page: Page): Promise<SidebarMask> {
  const box = await page.locator('aside').boundingBox();
  if (!box) throw new Error('The sidebar panel is missing, so its pixels cannot be masked.');
  return box;
}

export async function moveToWheelPoint(page: Page): Promise<void> {
  await page.mouse.move(WHEEL_POINT.x, WHEEL_POINT.y);
}

export async function wheelZoom(page: Page, deltaY: number, sidebar: SidebarMask): Promise<void> {
  const pointIsOutsideSidebar =
    WHEEL_POINT.x < sidebar.x ||
    WHEEL_POINT.x >= sidebar.x + sidebar.width ||
    WHEEL_POINT.y < sidebar.y ||
    WHEEL_POINT.y >= sidebar.y + sidebar.height;
  if (!pointIsOutsideSidebar) {
    throw new Error(
      `Wheel point (${WHEEL_POINT.x}, ${WHEEL_POINT.y}) is inside the sidebar (${Math.round(sidebar.x)}, ${Math.round(sidebar.y)}, ${Math.round(sidebar.width)}×${Math.round(sidebar.height)}).`,
    );
  }
  await page.mouse.wheel(0, deltaY);
}

export async function wheelBurst(
  page: Page,
  wheelCount: number,
  deltaY: number,
  sidebar: SidebarMask,
): Promise<void> {
  for (let wheel = 0; wheel < wheelCount; wheel += 1) {
    await wheelZoom(page, deltaY, sidebar);
  }
}

export async function settleOpening(page: Page, terrain: TerrainTraffic): Promise<void> {
  await settleScene(page, terrain, OPENING_SETTLE_BUDGET_MS, null);
}

export async function settleAfterZoom(
  page: Page,
  terrain: TerrainTraffic,
  previousAltitudeM: number | null,
): Promise<void> {
  await settleScene(page, terrain, ZOOM_SETTLE_BUDGET_MS, previousAltitudeM);
}

export async function sampleFlatFrame(
  page: Page,
  cdp: CDPSession,
  testInfo: TestInfo,
  step: string,
  samples: string[],
  failures: string[],
  evidenceDir: string | undefined,
  sidebar: SidebarMask,
): Promise<number | null> {
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
    clip: { ...SCENE_CLIP, scale: 1 },
  });
  const pngBytes = Buffer.from(shot.data, 'base64');
  const png = PNG.sync.read(pngBytes);
  const mask = maskInsideClip(sidebar, png.width, png.height);
  const flat = exactFlatShare(png, mask);
  const altitudeM = await readCameraAltitudeM(page);
  const color = `rgb(${flat.red}, ${flat.green}, ${flat.blue})`;
  const sharePercent = `${(flat.share * 100).toFixed(1)}%`;
  const sample = `${step} height=${formatAltitude(altitudeM)} flat=${sharePercent} ${color} pixels=${flat.count}/${flat.unmaskedPixels}`;
  samples.push(sample);
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, `${step}.png`), pngBytes);
    writeFileSync(path.join(evidenceDir, 'samples.txt'), `${samples.join('\n')}\n`);
  }
  if (flat.share > EXACT_FLAT_SHARE_LIMIT) {
    await testInfo.attach(`${step} ${sharePercent} ${color}`, {
      body: pngBytes,
      contentType: 'image/png',
    });
    failures.push(
      `${step} at camera height ${formatAltitude(altitudeM)} is ${sharePercent} exactly ${color}.`,
    );
  }
  return altitudeM;
}

export async function readCameraAltitudeM(page: Page): Promise<number | null> {
  return page.evaluate(() => window.__TNC_TEST__?.cameraAltitudeM ?? null);
}

export function formatAltitude(altitudeM: number | null): string {
  if (altitudeM === null) return 'unavailable';
  if (altitudeM >= 1000) return `${(altitudeM / 1000).toFixed(1)} km`;
  return `${Math.round(altitudeM)} m`;
}

export function finishFlatColorCheck(
  samples: readonly string[],
  failures: readonly string[],
  terrain: TerrainTraffic,
  watch: LiveServiceWatch,
): void {
  console.log(samples.join('\n'));
  throwIfTerrainOutage(terrain, watch);
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

async function settleScene(
  page: Page,
  terrain: TerrainTraffic,
  budgetMs: number,
  previousAltitudeM: number | null,
): Promise<void> {
  await page.evaluate(
    async ({ budget, quietMs, previousAltitude }) => {
      const deadline = performance.now() + budget;
      let stillSince = 0;
      let stableSince = 0;
      let lastAltitude = Number.NaN;
      let moved = previousAltitude === null;
      while (performance.now() < deadline) {
        const seam = window.__TNC_TEST__;
        const updating = seam?.sceneUpdating !== false;
        const altitude = seam?.cameraAltitudeM;
        if (
          !moved &&
          previousAltitude !== null &&
          typeof altitude === 'number' &&
          Math.abs(altitude - previousAltitude) > 1
        ) {
          moved = true;
          stableSince = 0;
        }
        if (!updating) {
          if (stillSince === 0) stillSince = performance.now();
        } else {
          stillSince = 0;
        }
        if (typeof altitude === 'number' && Math.abs(altitude - lastAltitude) < 0.5) {
          if (stableSince === 0) stableSince = performance.now();
        } else {
          stableSince = 0;
          lastAltitude = typeof altitude === 'number' ? altitude : Number.NaN;
        }
        const viewStill = stillSince !== 0 && performance.now() - stillSince >= quietMs;
        const cameraStill = moved && stableSince !== 0 && performance.now() - stableSince >= quietMs;
        if (previousAltitude === null ? viewStill || cameraStill : cameraStill) return;
        await new Promise((resolve) => window.setTimeout(resolve, 16));
      }
    },
    { budget: budgetMs, quietMs: SETTLED_QUIET_MS, previousAltitude: previousAltitudeM },
  );

  const sinceTileMs = Date.now() - terrain.lastActivityAt;
  if (sinceTileMs < SETTLED_QUIET_MS) await delay(SETTLED_QUIET_MS - sinceTileMs);

  if (terrain.successfulTiles === 0) {
    const altitudeM = await readCameraAltitudeM(page).catch(() => null);
    throw new Error(
      `INCONCLUSIVE: no imagery or elevation tiles arrived (camera ${formatAltitude(altitudeM)}). The frame never drew terrain.`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exactFlatShare(png: PNG, mask: SidebarMask): FlatColorSample {
  const counts = new Map<number, number>();
  let unmaskedPixels = 0;
  for (let y = 0; y < png.height; y += PIXEL_STRIDE) {
    for (let x = 0; x < png.width; x += PIXEL_STRIDE) {
      if (
        x >= mask.x &&
        x < mask.x + mask.width &&
        y >= mask.y &&
        y < mask.y + mask.height
      ) {
        continue;
      }
      const index = (png.width * y + x) << 2;
      const red = png.data[index] ?? 0;
      const green = png.data[index + 1] ?? 0;
      const blue = png.data[index + 2] ?? 0;
      const key = (red << 16) | (green << 8) | blue;
      unmaskedPixels += 1;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  let count = 0;
  let key = 0;
  for (const [candidate, candidateCount] of counts) {
    if (candidateCount > count) {
      count = candidateCount;
      key = candidate;
    }
  }

  return {
    share: unmaskedPixels === 0 ? 1 : count / unmaskedPixels,
    count,
    unmaskedPixels,
    red: (key >> 16) & 255,
    green: (key >> 8) & 255,
    blue: key & 255,
  };
}

function maskInsideClip(sidebar: SidebarMask, pngWidth: number, pngHeight: number): SidebarMask {
  const scaleX = pngWidth / SCENE_CLIP.width;
  const scaleY = pngHeight / SCENE_CLIP.height;
  const left = (sidebar.x - SCENE_CLIP.x) * scaleX;
  const top = (sidebar.y - SCENE_CLIP.y) * scaleY;
  const right = left + sidebar.width * scaleX;
  const bottom = top + sidebar.height * scaleY;
  const x = Math.max(0, Math.floor(left));
  const y = Math.max(0, Math.floor(top));
  const x2 = Math.min(pngWidth, Math.ceil(right));
  const y2 = Math.min(pngHeight, Math.ceil(bottom));
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}
