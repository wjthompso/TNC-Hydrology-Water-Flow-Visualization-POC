import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type Page, type TestInfo } from '@playwright/test';
import { approvedExternalDisruptionEvidence } from '../../../../support/network/live-release-evidence.ts';
import {
  distanceMeters,
  openObservedWaterPage,
  rethrowIfExternalOutage,
  watchLiveServices,
  type LiveServiceWatch,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';

/**
 * Methodology: Opens the locally served page and waits until the read-only
 * test seam reports ready, then until SceneView stops updating and live tile
 * requests stay quiet. The browser page, ArcGIS SceneView, and committed
 * published creek data are real. Esri World Imagery and Esri World Elevation
 * tiles are live external services; if those requests fail with DNS, TLS,
 * HTTP 429, or HTTP 5xx, or no initial terrain tiles arrive, the result is
 * inconclusive rather than passed. Nothing is mocked or saved. From the framed
 * scene the test sends real mouse-wheel events at a fixed canvas point outside
 * the sidebar (deltaY 420), one notch at a time for three notches, then the
 * same three notches back in. After the opening frame, each outward notch, and
 * the final return, it samples an 8×8 grid in the central scene through
 * sampleRenderedGroundHeights, which uses SceneView toMap on the drawn ground
 * and not ground.queryElevation. The grid stays right of the sidebar and below
 * the outer horizon band so the fixed Esri scene returns terrain hits. The
 * test fails when more than 20% of those samples are null, when any non-null
 * height is outside -20..2500 m, or when at least 6 edge-contiguous samples
 * form a block whose elevation range is under 1 m, whose median is more than
 * 120 m above the median of the adjacent ring, and whose samples span more
 * than 200 m on the map. Failure messages include the measured null share,
 * heights, and plateau figures. The last checked frame is a settled non-broken
 * terrain frame. It does not check exact terrain accuracy, imagery appearance,
 * sharpness, vintage, ocean flatness, or water placement.
 */

/**
 * Regression RCA (root cause analysis)
 * Symptom: a large photographic square appears lifted high with vertical walls during zoom.
 * Root cause: old custom Usgs3DepElevationLayer.fetchTile returned
 * `{values,width,height,noDataValue,usedMemory}` as a plain object instead of
 * `new ElevationTileData(...)`. ArcGIS got undefined minValue/maxValue/hasNoDataValues,
 * producing invalid/NaN terrain mesh bounds and vertical tile walls. Raw 3DEP heights
 * were valid (~0–330 m), so source-height queries false-passed.
 * Reproduction baseline: git commit cac781c, old USGS scene; viewport 1440×900; wheel at
 * (893,495), deltaY 420; by notch 3 camera ~(-120.474,34.502), z~1245 m, heading 321°,
 * tilt 58°; rendered `view.toMap` samples were 100% null while source elevation was 0–328 m.
 * Fixed-environment evidence: returning actual ElevationTileData made samples 0% null at
 * the same camera; the current fix removes the custom layer and uses Esri World Elevation.
 * Future failure triage: first inspect actual rendered `toMap` hit rate and any custom
 * ElevationLayer fetchTile return type/metadata; then inspect similar mesh-bound failures;
 * only after that investigate source elevation values.
 */

/** More than this share of missed ground rays is a broken frame. */
const NULL_SHARE_LIMIT = 0.2;
const MIN_GROUND_ELEVATION_M = -20;
const MAX_GROUND_ELEVATION_M = 2500;
const MIN_PLATEAU_CELLS = 6;
/** A lifted tile is flat. A real hillside exceeds this across six samples. */
const MAX_PLATEAU_RANGE_M = 1;
const MIN_PLATEAU_LIFT_M = 120;
const MIN_PLATEAU_SPAN_M = 200;
const GRID_SIZE = 8;
const WHEEL_DELTA_Y = 420;
/** One wheel event is one notch. Notch 3 is the known slab camera on the old scene. */
const ZOOM_OUT_NOTCHES = 3;
const SETTLED_QUIET_MS = 80;
const OPENING_SETTLE_BUDGET_MS = 20_000;
const ZOOM_SETTLE_BUDGET_MS = 12_000;
/**
 * Central scene on a 1440×900 view. x starts past the sidebar (about x=368).
 * y starts below the sky/horizon band so rays hit drawn terrain on the Esri scene.
 */
const GRID_ORIGIN = { x: 480, y: 340 };
const GRID_SPACING = { x: 100, y: 56 };
const WHEEL_POINT = { x: 893, y: 495 };

const ABORTED_REQUEST = /ERR_ABORTED|\baborted\b/i;
const TRANSPORT_FAILURE =
  /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_CERT|ERR_SSL|ERR_TLS|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_TUNNEL|ERR_PROXY|ERR_EMPTY_RESPONSE|ERR_SSL_PROTOCOL|NS_ERROR_NET|ECONNRESET|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|certificate|tls handshake/i;

const LIVE_TERRAIN_REQUEST =
  /services\.arcgisonline\.com|server\.arcgisonline\.com|ibasemaps|elevation3d\.arcgis\.com|basemaps\.arcgis\.com|basemaps-api\.arcgis\.com|basemap\.nationalmap\.gov|elevation\.nationalmap\.gov/i;

interface TerrainTraffic {
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

interface GroundSample {
  x: number;
  y: number;
  row: number;
  col: number;
  elevationM: number | null;
  longitude: number | null;
  latitude: number | null;
}

interface CameraPose {
  altitudeM: number | null;
  longitude: number | null;
  latitude: number | null;
}

interface LiftedPlateau {
  cellCount: number;
  minElevationM: number;
  maxElevationM: number;
  rangeM: number;
  blockMedianM: number;
  ringMedianM: number;
  ringCount: number;
  liftM: number;
  spanM: number;
}

test.use({ viewport: { width: 1440, height: 900 } });

test('Zoom across the Jalama creek scene without raising tile-shaped terrain slabs.', async ({
  page,
}, testInfo) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const evidenceDir = process.env.FBT007_EVIDENCE_DIR;
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

  const notes: string[] = [];
  const failures: string[] = [];

  try {
    await openObservedWaterPage(page, watch);
    await settleScene(page, terrain, OPENING_SETTLE_BUDGET_MS, null);
    const sidebar = await sidebarMask(page);
    const grid = centralGrid(sidebar);
    await page.mouse.move(WHEEL_POINT.x, WHEEL_POINT.y);

    let altitudeM = await inspectFrame(page, testInfo, 'opening', grid, notes, failures, evidenceDir);

    for (let notch = 1; notch <= ZOOM_OUT_NOTCHES; notch += 1) {
      await wheelZoom(page, WHEEL_DELTA_Y, sidebar);
      await settleScene(page, terrain, ZOOM_SETTLE_BUDGET_MS, altitudeM);
      altitudeM = await inspectFrame(
        page,
        testInfo,
        `zoom-out-${notch}`,
        grid,
        notes,
        failures,
        evidenceDir,
      );
    }

    for (let notch = 0; notch < ZOOM_OUT_NOTCHES; notch += 1) {
      await wheelZoom(page, -WHEEL_DELTA_Y, sidebar);
    }
    await settleScene(page, terrain, ZOOM_SETTLE_BUDGET_MS, altitudeM);
    await inspectFrame(page, testInfo, 'zoom-in-return', grid, notes, failures, evidenceDir);

    console.log(notes.join('\n'));
    throwIfTerrainOutage(terrain, watch);
    if (failures.length > 0) throw new Error(failures.join('\n'));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('INCONCLUSIVE:')) throw error;
    if (failures.length > 0) {
      const detail = error instanceof Error ? error.message : String(error);
      const report = failures.join('\n');
      throw new Error(detail.includes(failures[0] ?? report) ? detail : `${report}\n${detail}`, {
        cause: error,
      });
    }
    rethrowIfExternalOutage(watch, error);
  }
});

function centralGrid(sidebar: SidebarMask): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let col = 0; col < GRID_SIZE; col += 1) {
      const point = {
        x: GRID_ORIGIN.x + col * GRID_SPACING.x,
        y: GRID_ORIGIN.y + row * GRID_SPACING.y,
      };
      if (pointInside(point, sidebar)) {
        throw new Error(
          `Ground sample (${point.x}, ${point.y}) is inside the sidebar, so the central grid is not calibrated.`,
        );
      }
      points.push(point);
    }
  }
  return points;
}

function pointInside(point: { x: number; y: number }, box: SidebarMask): boolean {
  return (
    point.x >= box.x &&
    point.x < box.x + box.width &&
    point.y >= box.y &&
    point.y < box.y + box.height
  );
}

function watchTerrainTraffic(page: Page): TerrainTraffic {
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

function throwIfTerrainOutage(terrain: TerrainTraffic, watch: LiveServiceWatch): void {
  if (terrain.rateLimitedResponses > 0) {
    throw new Error(`INCONCLUSIVE: HTTP 429 responses: ${terrain.rateLimitedResponses}`);
  }
  if (terrain.serverErrorResponses > 0) {
    throw new Error(`INCONCLUSIVE: HTTP 5xx responses: ${terrain.serverErrorResponses}`);
  }
  const transportFailure = terrain.transportFailures[0];
  if (transportFailure) throw new Error(`INCONCLUSIVE: ${transportFailure}`);
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

async function wheelZoom(page: Page, deltaY: number, sidebar: SidebarMask): Promise<void> {
  if (pointInside(WHEEL_POINT, sidebar)) {
    throw new Error(
      `Wheel point (${WHEEL_POINT.x}, ${WHEEL_POINT.y}) is inside the sidebar (${Math.round(sidebar.x)}, ${Math.round(sidebar.y)}, ${Math.round(sidebar.width)}×${Math.round(sidebar.height)}).`,
    );
  }
  await page.mouse.wheel(0, deltaY);
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

async function inspectFrame(
  page: Page,
  testInfo: TestInfo,
  step: string,
  grid: readonly { x: number; y: number }[],
  notes: string[],
  failures: string[],
  evidenceDir: string | undefined,
): Promise<number | null> {
  const samples = await sampleGrid(page, grid);
  const pose = await readCameraPose(page);
  const problems = groundProblems(samples);
  const note = `${step} ${formatPose(pose)} ${formatSamples(samples)}${problems.length ? ` FAIL ${problems.join(' ')}` : ''}`;
  notes.push(note);
  if (evidenceDir) {
    const png = await page.screenshot({ type: 'png' });
    writeFileSync(path.join(evidenceDir, `${step}.png`), png);
    writeFileSync(path.join(evidenceDir, 'measurements.txt'), `${notes.join('\n')}\n`);
  }
  if (problems.length > 0) {
    const png = await page.screenshot({ type: 'png' });
    await testInfo.attach(`${step} rendered ground`, { body: png, contentType: 'image/png' });
    failures.push(`${step} ${formatPose(pose)}\n${problems.join('\n')}\n${formatSamples(samples)}`);
  }
  return pose.altitudeM;
}

async function sampleGrid(
  page: Page,
  grid: readonly { x: number; y: number }[],
): Promise<GroundSample[]> {
  const raw = await page.evaluate((screenPoints) => {
    const seam = window.__TNC_TEST__;
    if (!seam?.sampleRenderedGroundHeights) {
      throw new Error('The rendered-ground test seam is missing.');
    }
    return seam.sampleRenderedGroundHeights(screenPoints);
  }, [...grid]);

  return raw.map((sample, index) => ({
    x: sample.x,
    y: sample.y,
    row: Math.floor(index / GRID_SIZE),
    col: index % GRID_SIZE,
    elevationM: sample.elevationM,
    longitude: sample.longitude,
    latitude: sample.latitude,
  }));
}

function groundProblems(samples: readonly GroundSample[]): string[] {
  const problems: string[] = [];
  const nullCount = samples.filter((sample) => sample.elevationM === null).length;
  const nullShare = samples.length === 0 ? 1 : nullCount / samples.length;
  if (nullShare > NULL_SHARE_LIMIT) {
    problems.push(
      `${nullCount}/${samples.length} central samples missed the drawn ground (${(nullShare * 100).toFixed(1)}%, limit ${(NULL_SHARE_LIMIT * 100).toFixed(0)}%).`,
    );
  }

  for (const sample of samples) {
    if (sample.elevationM === null) continue;
    if (sample.elevationM < MIN_GROUND_ELEVATION_M || sample.elevationM > MAX_GROUND_ELEVATION_M) {
      problems.push(
        `height ${sample.elevationM.toFixed(1)} m at screen (${sample.x}, ${sample.y}) is outside ${MIN_GROUND_ELEVATION_M}..${MAX_GROUND_ELEVATION_M} m.`,
      );
    }
  }

  const plateau = findLiftedPlateau(samples);
  if (plateau) {
    problems.push(
      `lifted plateau of ${plateau.cellCount} edge-contiguous samples, elevation ${plateau.minElevationM.toFixed(1)}..${plateau.maxElevationM.toFixed(1)} m (range ${plateau.rangeM.toFixed(2)} m), block median ${plateau.blockMedianM.toFixed(1)} m is ${plateau.liftM.toFixed(1)} m above the adjacent-ring median ${plateau.ringMedianM.toFixed(1)} m (${plateau.ringCount} ring samples), map span ${plateau.spanM.toFixed(0)} m. Limits: at least ${MIN_PLATEAU_CELLS} samples, range under ${MAX_PLATEAU_RANGE_M} m, lift over ${MIN_PLATEAU_LIFT_M} m, span over ${MIN_PLATEAU_SPAN_M} m.`,
    );
  }
  return problems;
}

/**
 * A tile slab is a flat block of screen samples sitting far above the ground
 * around it. Cells connect when they share an edge and the block's elevation
 * range stays under 1 m. The ring is the 8-connected samples just outside that block.
 */
function findLiftedPlateau(samples: readonly GroundSample[]): LiftedPlateau | null {
  const byKey = new Map(samples.map((sample) => [cellKey(sample.row, sample.col), sample]));
  let strongest: LiftedPlateau | null = null;

  for (const seed of samples) {
    if (seed.elevationM === null) continue;
    const block = flatBlockFrom(seed, byKey);
    if (block.length < MIN_PLATEAU_CELLS) continue;

    const blockElevations = block.map((sample) => sample.elevationM as number);
    const ringElevations = adjacentRingElevations(block, byKey);
    if (ringElevations.length === 0) continue;

    const minElevationM = Math.min(...blockElevations);
    const maxElevationM = Math.max(...blockElevations);
    const blockMedianM = median(blockElevations);
    const ringMedianM = median(ringElevations);
    const liftM = blockMedianM - ringMedianM;
    const spanM = mapSpanM(block);
    if (liftM <= MIN_PLATEAU_LIFT_M || spanM <= MIN_PLATEAU_SPAN_M) continue;

    const candidate: LiftedPlateau = {
      cellCount: block.length,
      minElevationM,
      maxElevationM,
      rangeM: maxElevationM - minElevationM,
      blockMedianM,
      ringMedianM,
      ringCount: ringElevations.length,
      liftM,
      spanM,
    };
    if (!strongest || candidate.liftM > strongest.liftM) strongest = candidate;
  }

  return strongest;
}

function flatBlockFrom(seed: GroundSample, byKey: ReadonlyMap<string, GroundSample>): GroundSample[] {
  const block: GroundSample[] = [seed];
  const queued = new Set([cellKey(seed.row, seed.col)]);
  const queue = [seed];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const neighbor of edgeNeighbors(current, byKey)) {
      const key = cellKey(neighbor.row, neighbor.col);
      if (queued.has(key) || neighbor.elevationM === null) continue;
      const rangeM = elevationRange([...block, neighbor]);
      if (rangeM >= MAX_PLATEAU_RANGE_M) continue;
      queued.add(key);
      block.push(neighbor);
      queue.push(neighbor);
    }
  }

  return block;
}

function edgeNeighbors(sample: GroundSample, byKey: ReadonlyMap<string, GroundSample>): GroundSample[] {
  const offsets = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const neighbors: GroundSample[] = [];
  for (const [rowOffset, colOffset] of offsets) {
    const neighbor = byKey.get(cellKey(sample.row + rowOffset, sample.col + colOffset));
    if (neighbor) neighbors.push(neighbor);
  }
  return neighbors;
}

function adjacentRingElevations(block: readonly GroundSample[], byKey: ReadonlyMap<string, GroundSample>): number[] {
  const inside = new Set(block.map((sample) => cellKey(sample.row, sample.col)));
  const seen = new Set<string>();
  const elevations: number[] = [];
  for (const sample of block) {
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
        if (rowOffset === 0 && colOffset === 0) continue;
        const key = cellKey(sample.row + rowOffset, sample.col + colOffset);
        if (inside.has(key) || seen.has(key)) continue;
        seen.add(key);
        const neighbor = byKey.get(key);
        if (neighbor?.elevationM === null || neighbor?.elevationM === undefined) continue;
        elevations.push(neighbor.elevationM);
      }
    }
  }
  return elevations;
}

function elevationRange(samples: readonly GroundSample[]): number {
  const elevations = samples.flatMap((sample) => (sample.elevationM === null ? [] : [sample.elevationM]));
  if (elevations.length === 0) return 0;
  return Math.max(...elevations) - Math.min(...elevations);
}

function mapSpanM(block: readonly GroundSample[]): number {
  let spanM = 0;
  for (let index = 0; index < block.length; index += 1) {
    for (let other = index + 1; other < block.length; other += 1) {
      const a = block[index];
      const b = block[other];
      if (!a || !b) continue;
      if (a.longitude === null || a.latitude === null || b.longitude === null || b.latitude === null) continue;
      spanM = Math.max(spanM, distanceMeters([a.longitude, a.latitude], [b.longitude, b.latitude]));
    }
  }
  return spanM;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return Number.NaN;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function formatSamples(samples: readonly GroundSample[]): string {
  const elevations = samples.flatMap((sample) => (sample.elevationM === null ? [] : [sample.elevationM]));
  const nullCount = samples.length - elevations.length;
  const nullShare = samples.length === 0 ? 1 : nullCount / samples.length;
  if (elevations.length === 0) {
    return `null=${nullCount}/${samples.length} (${(nullShare * 100).toFixed(1)}%) heights=none plateau=not measurable`;
  }
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  return `null=${nullCount}/${samples.length} (${(nullShare * 100).toFixed(1)}%) heights=${min.toFixed(1)}..${max.toFixed(1)} m median=${median(elevations).toFixed(1)} m`;
}

async function readCameraPose(page: Page): Promise<CameraPose> {
  return page.evaluate(() => {
    const seam = window.__TNC_TEST__;
    const target = seam?.cameraTargetWgs84;
    return {
      altitudeM: seam?.cameraAltitudeM ?? null,
      longitude: target ? target[0] : null,
      latitude: target ? target[1] : null,
    };
  });
}

async function readCameraAltitudeM(page: Page): Promise<number | null> {
  return page.evaluate(() => window.__TNC_TEST__?.cameraAltitudeM ?? null);
}

function formatPose(pose: CameraPose): string {
  const target =
    pose.longitude === null || pose.latitude === null
      ? 'target unavailable'
      : `target (${pose.longitude.toFixed(3)}, ${pose.latitude.toFixed(3)})`;
  return `${target} ${formatAltitude(pose.altitudeM)}`;
}

function formatAltitude(altitudeM: number | null): string {
  if (altitudeM === null) return 'altitude unavailable';
  if (altitudeM >= 1000) return `z=${(altitudeM / 1000).toFixed(2)} km`;
  return `z=${Math.round(altitudeM)} m`;
}

async function sidebarMask(page: Page): Promise<SidebarMask> {
  const box = await page.locator('aside').boundingBox();
  if (!box) throw new Error('The sidebar panel is missing, so the scene grid cannot avoid it.');
  return box;
}
