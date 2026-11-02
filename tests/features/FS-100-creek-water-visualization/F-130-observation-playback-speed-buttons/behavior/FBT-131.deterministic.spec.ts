import {
  expect,
  test,
  type Page,
} from '../../../../support/browser/deterministic-network.ts';
import { timelineFixturePath } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';
import { PLAYBACK_SPEEDS, chooseSpeed, playButton, speedButton } from './playback-controls.ts';

/**
 * Methodology: Opens the local page on the timeline fixture while the test
 * server has VITE_TEST_MODE set. That path runs the real Play button, time
 * slider, and speed menu through the production timeline control, on a
 * 500-slot stand-in clock. The ArcGIS scene, imagery, terrain, and published
 * gauge series are not loaded, and the test fails if the page requests
 * ArcGIS. For each of 0.1×, 0.2×, 0.5×, 1×, 2×, 5×, and 10×, the test pauses,
 * returns the slider to the first slot, opens the speed menu and picks that
 * speed, clicks Play, and reads the slider index at the start and end of a
 * sample inside the page. The sample lasts one second, or three seconds for
 * 0.1× and 0.2×, so a stalled slider cannot pass inside the margin. The slot
 * count must sit within 10% of the target for that elapsed time, and the
 * margin is never tighter than one slot, so 1× passes at 9–11 slots in one
 * second and 0.1× passes at 2–4 slots in three seconds. It does not check
 * water, reverse playback, or a chosen calendar date.
 */

const SLOW_SPEED_LIMIT = 0.2;
const SLOW_SAMPLE_MS = 3000;
const NORMAL_SAMPLE_MS = 1000;

test('Playing at 0.1×, 0.2×, 0.5×, 1×, 2×, 5×, and 10× advances the observation slider by about 1, 2, 5, 10, 20, 50, and 100 slots per second.', async ({
  page,
}) => {
  const arcgisRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().toLowerCase().includes('arcgis')) arcgisRequests.push(request.url());
  });

  // Open the local timeline and wait until its clock is ready. The map stays unloaded.
  await page.goto(timelineFixturePath());
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');
  expect(arcgisRequests, 'The speed check loaded ArcGIS.').toEqual([]);
  await expect(speedButton(page), 'The page has no speed button to open the speed menu.').toBeVisible();

  for (const speed of PLAYBACK_SPEEDS) {
    // Pause, return the slider to the first slot, pick this speed from the menu, and press Play.
    await pauseIfPlaying(page);
    await scrubToFirstSlot(page);
    await chooseSpeed(page, speed.optionName);
    await playButton(page).click();

    // Playback should move the slider by about that speed's slot count for the sampled time.
    const sampleMs = speed.speed <= SLOW_SPEED_LIMIT ? SLOW_SAMPLE_MS : NORMAL_SAMPLE_MS;
    const sample = await sampleSliderAdvance(page, sampleMs);
    const band = slotBand(speed.slotsPerSecond, sample.elapsedSeconds);
    const detail = `${speed.label} moved ${sample.slots} slots in ${sample.elapsedSeconds.toFixed(3)} s (${sample.slotsPerSecond.toFixed(1)} slots/s). Expected ${band.min.toFixed(1)}–${band.max.toFixed(1)} slots.`;
    expect(sample.slots, detail).toBeGreaterThanOrEqual(band.min);
    expect(sample.slots, detail).toBeLessThanOrEqual(band.max);
  }
});

function slotBand(targetSlotsPerSecond: number, elapsedSeconds: number): { min: number; max: number } {
  const expected = targetSlotsPerSecond * elapsedSeconds;
  const margin = Math.max(1, expected * 0.1);
  return { min: expected - margin, max: expected + margin };
}

async function pauseIfPlaying(page: Page): Promise<void> {
  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  if (await pause.count()) await pause.click();
}

async function scrubToFirstSlot(page: Page): Promise<void> {
  await page.locator('#timeline-slider').evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    element.value = '0';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function sampleSliderAdvance(
  page: Page,
  sampleMs: number,
): Promise<{
  slots: number;
  elapsedSeconds: number;
  slotsPerSecond: number;
}> {
  return page.evaluate(async (durationMs: number) => {
    const slider = document.getElementById('timeline-slider');
    if (!(slider instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    const startIndex = Number(slider.value);
    const startedAt = performance.now();
    await new Promise((resolve) => window.setTimeout(resolve, durationMs));
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const slots = Number(slider.value) - startIndex;
    return {
      slots,
      elapsedSeconds,
      slotsPerSecond: slots / elapsedSeconds,
    };
  }, sampleMs);
}
