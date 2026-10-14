import {
  expect,
  test,
  type Page,
} from '../../../../support/browser/deterministic-network.ts';
import { timelineFixturePath } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';

/**
 * Methodology: Opens the local page on the timeline fixture while the test
 * server has VITE_TEST_MODE set. That path runs the real Play button, time
 * slider, and speed buttons through the production timeline control, on a
 * 500-slot stand-in clock. The ArcGIS scene, imagery, terrain, and published
 * gauge series are not loaded, and the test fails if the page requests
 * ArcGIS. For each of 0.5×, 1×, 2×, 5×, and 10×, the test pauses, returns the
 * slider to the first slot, clicks that speed button, clicks Play, and reads
 * the slider index at the start and end of one second inside the page. The
 * slot count must sit within 10% of the target for that elapsed time, and the
 * margin is never tighter than one slot, so 1× passes at 9–11 slots in one
 * second. It does not check water, button highlight color, reverse playback,
 * or a chosen calendar date.
 */

const SPEEDS = [
  { label: '0.5 times speed', slotsPerSecond: 5 },
  { label: '1 times speed', slotsPerSecond: 10 },
  { label: '2 times speed', slotsPerSecond: 20 },
  { label: '5 times speed', slotsPerSecond: 50 },
  { label: '10 times speed', slotsPerSecond: 100 },
] as const;

test('Playing at 0.5×, 1×, 2×, 5×, and 10× advances the observation slider by about 5, 10, 20, 50, and 100 slots in one second.', async ({
  page,
}) => {
  const arcgisRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().toLowerCase().includes('arcgis')) arcgisRequests.push(request.url());
  });

  await page.goto(timelineFixturePath());
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');
  expect(arcgisRequests, 'The speed check loaded ArcGIS.').toEqual([]);

  for (const speed of SPEEDS) {
    await pauseIfPlaying(page);
    await scrubToFirstSlot(page);
    await page.getByRole('button', { name: speed.label, exact: true }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();

    const sample = await sampleSliderAdvance(page);
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

async function sampleSliderAdvance(page: Page): Promise<{
  slots: number;
  elapsedSeconds: number;
  slotsPerSecond: number;
}> {
  return page.evaluate(async () => {
    const slider = document.getElementById('timeline-slider');
    if (!(slider instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    const startIndex = Number(slider.value);
    const startedAt = performance.now();
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const slots = Number(slider.value) - startIndex;
    return {
      slots,
      elapsedSeconds,
      slotsPerSecond: slots / elapsedSeconds,
    };
  });
}
