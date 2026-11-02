import { expect, test, type Page } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import { formatObservationTime } from '../../../../../apps/creek-visualization-browser/src/observation-timeline-controls.ts';
import { watchLiveServices } from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import { settleScene } from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-camera.ts';
import {
  finishSceneCheck,
  rethrowSceneFailure,
  watchTerrainTraffic,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-check-outcome.ts';
import {
  NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
  missingLocalPipelineOutput,
  readWaterSurfaceElevationsAt,
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/local-pipeline-output.ts';
import {
  modeledWaterPageUrl,
  openModeledWaterPage,
  waitForModeledWaterIdle,
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/modeled-water-page.ts';
import {
  chooseSpeed,
  directionButton,
  playButton,
  setDirection,
  sliderIndex,
  speedButton,
  type PlaybackDirection,
} from './playback-controls.ts';

/**
 * Methodology: Opens the locally served page on the "Inferred Creek WSE — hourly (from NOAA National Water Model
 * v3.0 flows)" Dataset for the dangermond-preserve extent at 2023-01-08T00:00Z, with no polygon method in the URL, so
 * the page opens the default pairing: flowline-channel-ribbon v2 drawn with the m5-flowline-profile-jarrett-depth v1
 * Time Series. This is the modeled data state. The test waits until the test seam reports ready and the modeled seam
 * has finished loading, then checks the opening sync. The page must open with the direction button named "Playback
 * direction: forward". The test scrubs the time slider to 2023-01-09T12:00Z, about 12 hours before the January 2023
 * storm peak, with input and change events, picks 10× speed from the speed menu, and presses Play. It polls until the
 * slider has moved forward at least 20 slots, presses Pause, and waits for the modeled loads to finish. Then four
 * times must agree: the time the slider points at (the opening slot plus the slots moved, on the Dataset's 1-hour
 * grid), the time readout text (which must equal the production formatter's text for that time and the slider's
 * spoken value), the test seam's selected time, and the modeled seam's selected time. The modeled elevation the page
 * holds for Creek Segment 27714637-026 must be loaded and equal the elevation in the developer's local pipeline output
 * at that time. The test then presses the direction button, which must now read "Playback direction: reverse", presses
 * Play, polls until the slider has moved backward at least 20 slots, presses Pause, and repeats the same checks; the
 * selected time must be earlier than after the forward leg. Last, it presses the direction button back to "Playback
 * direction: forward", plays at least 5 slots, pauses, and repeats the checks; the selected time must be later than
 * after the reverse leg, so no reverse state is left over. Across the four stops, the segment's local-output elevation
 * must differ at least once, so a water level stuck at the starting time cannot pass. What is real: the browser page,
 * ArcGIS SceneView, the production Play button, direction button, speed menu, time slider, and time readout, the
 * modeled-water seam, the local pipeline output served by the development middleware, and Esri World Imagery and Esri
 * World Elevation responses reused from the local disk cache; a response missing from the cache is fetched live, and
 * when that fetch is unavailable and nothing was measured wrong the result is inconclusive rather than passed. What is
 * saved or test-only: the opening and scrub times, the segment, and the read-only seams. The expected elevation comes
 * from the local pipeline output; when it is missing the test is inconclusive with a message naming the pipeline
 * command, and it never passes without it. The water is compared as the elevation the page holds for the segment
 * (the seam), not as drawn pixels. A measured sync failure stays a failure even when Esri also reported an outage.
 * It does not check camera framing, water polygon shape or colour, the observed record, the speed menu look, how fast
 * the slider moves, or whether the modeled elevations are hydrologically right. Imagery dataset used in the
 * visualization: Esri World Imagery.
 */

/** The Jalama gauge Creek Segment, on the Dangermond Preserve extent whose default pairing is drawn here (as in FBT-014). */
const SEGMENT_ID = '27714637-026';
const JALAMA_GAUGE_TNC_COMID = '27714637';
const PRESERVE_EXTENT_ID = 'dangermond-preserve';
/** The default pairing's Time Series, whose files the page reads: Modeled WSE Derivation Method m5 v1. */
const DEFAULT_MODELED_WSE_VERSION_PATH = 'm5-flowline-profile-jarrett-depth/v1';
/** The page opens here; the scrub then moves to a mid-record start. */
const OPENING_HOUR_UTC = '2023-01-08T00:00:00Z';
/** Mid-record start for the legs: about 12 hours before the 2023-01-10T01:00Z storm peak. */
const SCRUB_START_HOUR_UTC = '2023-01-09T12:00:00Z';
const HOUR_MS = 60 * 60 * 1000;
const MIN_SLOTS_PER_LEG = 20;
const MIN_SLOTS_RETURN_LEG = 5;
const LEG_POLL_TIMEOUT_MS = 8_000;

/** Methodology: see the FBT-137 catalog entry. */
test('On the modeled creek page, playing forward and in reverse moves the time slider, the time readout, and the modeled water together, so the slider, the readout, and the water always show the same time.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    // Read the local pipeline output for every hour the legs can reach. Stop if it is missing.
    const openingUtcMs = Date.parse(OPENING_HOUR_UTC);
    const scrubStartUtcMs = Date.parse(SCRUB_START_HOUR_UTC);
    const missing = missingLocalPipelineOutput({
      extentId: PRESERVE_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_GAUGE_TNC_COMID,
      timesUtcMs: [openingUtcMs, scrubStartUtcMs],
      modeledWseVersionPath: DEFAULT_MODELED_WSE_VERSION_PATH,
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);

    // Open the modeled Dataset and let the first frame settle.
    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: PRESERVE_EXTENT_ID,
        timeUtc: OPENING_HOUR_UTC,
        imagery: FAST_TEST_SCENE_IMAGERY_ID,
      }),
    );
    await settleScene(page, 'opening-frame');
    const openingSlot: SlotAnchor = { index: await sliderIndex(page), timeUtcMs: openingUtcMs };
    await expectSynced(page, openingSlot, 'at the opening time');
    // The setup above reached the modeled page with its slider and readout. The controls below are the ones under test.
    await expectControlExists(page, '#timeline-direction-btn', 'direction button');
    await expectControlExists(page, '#timeline-speed-btn', 'speed button');

    // (1) The page opens on forward.
    await expectDirection(page, 'forward', 'the page opening');

    // (2) Mid-record start, then play forward at 10× for at least 20 slots.
    await scrubSliderToSlot(page, openingSlot.index + (scrubStartUtcMs - openingUtcMs) / HOUR_MS);
    const start = await expectSynced(page, openingSlot, 'after scrubbing to the mid-record start');
    expect(start.timeUtcMs, 'the scrub should land on the requested mid-record start').toBe(scrubStartUtcMs);
    await chooseSpeed(page, '10 times speed');
    await expect(speedButton(page), 'the speed button should show the chosen 10× speed').toContainText('10×');
    const forward = await playLeg(page, openingSlot, 'forward', MIN_SLOTS_PER_LEG);
    expect(forward.timeUtcMs, 'after playing forward the selected time should be later than the start').toBeGreaterThan(
      start.timeUtcMs,
    );

    // (3) Flip to reverse and play backward for at least 20 slots.
    await setDirection(page, 'reverse');
    await expectDirection(page, 'reverse', 'pressing the direction button once');
    const reverse = await playLeg(page, openingSlot, 'reverse', MIN_SLOTS_PER_LEG);
    expect(reverse.timeUtcMs, 'after playing in reverse the selected time should be earlier than after the forward leg').toBeLessThan(
      forward.timeUtcMs,
    );

    // (4) Flip back to forward: no reverse state is left over.
    await setDirection(page, 'forward');
    await expectDirection(page, 'forward', 'pressing the direction button a second time');
    const returned = await playLeg(page, openingSlot, 'forward', MIN_SLOTS_RETURN_LEG);
    expect(returned.timeUtcMs, 'after flipping back to forward the selected time should be later than after the reverse leg').toBeGreaterThan(
      reverse.timeUtcMs,
    );

    // The water must have moved with the time at least once, or a water level stuck at the start could pass.
    const elevations = [start, forward, reverse, returned].map((stop) => stop.expectedElevationM);
    expect(
      new Set(elevations).size,
      `the segment's local-output elevation should differ across the stops, got ${elevations.join(', ')} m`,
    ).toBeGreaterThan(1);
    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});

/** The slider slot that sits at a known time; every other slot is that many hours away. */
interface SlotAnchor {
  readonly index: number;
  readonly timeUtcMs: number;
}

interface SettledStop {
  readonly timeUtcMs: number;
  readonly expectedElevationM: number;
}

async function expectControlExists(page: Page, selector: string, name: string): Promise<void> {
  expect(
    await page.locator(selector).count(),
    `The modeled page has no ${name} (${selector}). The playback direction and speed controls are not on the page.`,
  ).toBe(1);
}

async function expectDirection(page: Page, direction: PlaybackDirection, when: string): Promise<void> {
  await expect(
    directionButton(page),
    `After ${when}, the direction button should be named "Playback direction: ${direction}".`,
  ).toHaveAccessibleName(`Playback direction: ${direction}`, { timeout: 3_000 });
}

async function scrubSliderToSlot(page: Page, index: number): Promise<void> {
  await page.locator('#timeline-slider').evaluate((element, slot) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    element.value = String(slot);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
}

/**
 * Presses Play, polls until the slider has moved the wanted number of slots in the direction, presses Pause, and
 * checks that the slider, readout, and water agree. A running leg starts from the slider's slot at the call.
 */
async function playLeg(page: Page, anchor: SlotAnchor, direction: PlaybackDirection, minimumSlots: number): Promise<SettledStop> {
  const startIndex = await sliderIndex(page);
  await expect(playButton(page), `Before playing ${direction}, the play button should be named "Play".`).toHaveAccessibleName('Play');
  await playButton(page).click();
  const sign = direction === 'forward' ? 1 : -1;
  await expect
    .poll(async () => sign * ((await sliderIndex(page)) - startIndex), {
      message: `playing ${direction} at 10× should move the slider ${direction} by at least ${minimumSlots} slots`,
      timeout: LEG_POLL_TIMEOUT_MS,
      intervals: [25],
    })
    .toBeGreaterThanOrEqual(minimumSlots);
  await playButton(page).click();
  await expect(playButton(page), `After pausing the ${direction} leg, the play button should be named "Play".`).toHaveAccessibleName('Play');
  return expectSynced(page, anchor, `after playing ${direction}`);
}

/**
 * After the modeled loads finish, the slider's time, the readout text, the test seam's selected time, and the modeled
 * seam's selected time must be one time, and the modeled elevation for the segment must be the local-output elevation
 * at that time. Returns that time and elevation.
 */
async function expectSynced(page: Page, anchor: SlotAnchor, when: string): Promise<SettledStop> {
  await waitForModeledWaterIdle(page);
  const reading = await page.evaluate((segmentId) => {
    const slider = document.getElementById('timeline-slider');
    if (!(slider instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    return {
      sliderIndex: Number(slider.value),
      sliderSpokenValue: slider.getAttribute('aria-valuetext'),
      readoutText: document.getElementById('timeline-readout')?.textContent?.trim() ?? null,
      testSeamTimeUtcMs: window.__TNC_TEST__?.selectedTimeUtcMs ?? null,
      modeledSeamTimeUtcMs: window.__TNC_MODELED__?.selectedTimeUtcMs ?? null,
      segment: window.__TNC_MODELED__?.readSegment(segmentId) ?? null,
    };
  }, SEGMENT_ID);

  const sliderTimeUtcMs = anchor.timeUtcMs + (reading.sliderIndex - anchor.index) * HOUR_MS;
  const sliderTime = `${formatObservationTime(sliderTimeUtcMs)} (slot ${reading.sliderIndex})`;
  expect(reading.readoutText, `${when}: the time readout should show the slider's time, ${sliderTime}`).toBe(
    formatObservationTime(sliderTimeUtcMs),
  );
  expect(reading.sliderSpokenValue, `${when}: the slider's spoken value should match the readout`).toBe(reading.readoutText);
  expect(reading.testSeamTimeUtcMs, `${when}: the test seam's selected time should be the slider's time, ${sliderTime}`).toBe(
    sliderTimeUtcMs,
  );
  expect(reading.modeledSeamTimeUtcMs, `${when}: the modeled seam's selected time should be the slider's time, ${sliderTime}`).toBe(
    sliderTimeUtcMs,
  );

  const expectedElevationM = readWaterSurfaceElevationsAt({
    extentId: PRESERVE_EXTENT_ID,
    datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
    comid: JALAMA_GAUGE_TNC_COMID,
    timeUtcMs: sliderTimeUtcMs,
    modeledWseVersionPath: DEFAULT_MODELED_WSE_VERSION_PATH,
  })?.get(SEGMENT_ID);
  if (typeof expectedElevationM !== 'number') {
    throw new Error(`The local pipeline output has no modeled value for ${SEGMENT_ID} at ${formatObservationTime(sliderTimeUtcMs)}.`);
  }
  expect(reading.segment?.isLoaded, `${when}: the modeled water for ${SEGMENT_ID} should be loaded for ${sliderTime}`).toBe(true);
  expect(
    reading.segment?.elevationM,
    `${when}: the modeled water for ${SEGMENT_ID} should show the elevation for ${sliderTime} (${expectedElevationM} m)`,
  ).toBeCloseTo(expectedElevationM, 3);
  return { timeUtcMs: sliderTimeUtcMs, expectedElevationM };
}
