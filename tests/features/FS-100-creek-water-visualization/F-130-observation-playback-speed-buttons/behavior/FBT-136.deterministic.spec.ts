import { expect, test, type Page } from '../../../../support/browser/deterministic-network.ts';
import { timelineOpeningPath } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';
import {
  PLAYBACK_SPEEDS,
  chooseSpeed,
  directionButton,
  playButton,
  sliderIndex,
} from './playback-controls.ts';

/**
 * Methodology: Opens the timeline-only page for the real published Jalama
 * record, which stands for the observed data state, through the production
 * Play button, direction button, speed menu, and time slider. The 3D scene,
 * modeled data, and map are not loaded, and the test fails if the page
 * requests ArcGIS. The page must open with the direction button named
 * "Playback direction: forward". The test picks 5× speed, scrubs the slider
 * to the middle slot with input and change events, and presses Play. It reads
 * the slider index at the start and end of one second inside the page, which
 * must rise by about 50 slots. The margin is 10% of the target for that
 * elapsed time, never tighter than one slot. After Pause, the test presses
 * the direction button until it reads "Playback direction: reverse", presses
 * Play, and reads one second again, which must fall by about 50 slots. After
 * each leg, the time readout text must equal the slider's aria-valuetext and
 * differ from the text at the start of that leg. Last, at 10× speed in
 * reverse, the test scrubs the slider to slot 5 and presses Play. Within one
 * second the slider must sit on the first slot, and the play button must be
 * named "Play" again. It does not check water, the map, modeled data, the look
 * of the speed menu, or the chosen calendar dates.
 */

const FORWARD_NAME = 'Playback direction: forward';
const REVERSE_NAME = 'Playback direction: reverse';
const SAMPLE_MS = 1000;
const SLOTS_BEFORE_FIRST = 5;
const FIVE_TIMES = PLAYBACK_SPEEDS.find((entry) => entry.speed === 5);
const TEN_TIMES = PLAYBACK_SPEEDS.find((entry) => entry.speed === 10);

test('On the observed Jalama gauge time slider, playing forward moves toward the To date and playing in reverse moves toward the From date, at the chosen speed.', async ({
  page,
}) => {
  if (!FIVE_TIMES || !TEN_TIMES) throw new Error('The 5× or 10× speed is missing from the playback speed list.');

  const arcgisRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().toLowerCase().includes('arcgis')) arcgisRequests.push(request.url());
  });

  // Open the real Jalama record on the time slider alone. The map stays unloaded.
  await page.goto(timelineOpeningPath());
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');
  expect(arcgisRequests, 'The playback direction check loaded ArcGIS.').toEqual([]);

  // The page opens on forward playback.
  await expect(
    directionButton(page),
    'The page has no playback direction button (#timeline-direction-btn) named "Playback direction: forward".',
  ).toHaveAccessibleName(FORWARD_NAME);

  const range = await sliderRange(page);
  const middle = Math.floor((range.min + range.max) / 2);
  expect(
    middle - range.min,
    `The record spans slots ${range.min}–${range.max}, too short for a 50-slot leg either way.`,
  ).toBeGreaterThan(FIVE_TIMES.slotsPerSecond * 2);

  // Forward at 5×, from the middle of the record: the slider moves toward the To date.
  await chooseSpeed(page, FIVE_TIMES.optionName);
  await scrubToSlot(page, middle);
  const forwardStartText = await readoutText(page);
  await playButton(page).click();
  const forward = await sampleSliderMovement(page);
  await playButton(page).click();
  await expect(playButton(page), 'Forward playback did not pause.').toHaveAccessibleName('Play');
  const forwardBand = slotBand(FIVE_TIMES.slotsPerSecond, forward.elapsedSeconds);
  const forwardDetail = `Forward at 5× moved ${forward.slots} slots in ${forward.elapsedSeconds.toFixed(3)} s. Expected +${forwardBand.min.toFixed(1)} to +${forwardBand.max.toFixed(1)} slots.`;
  expect(forward.slots, forwardDetail).toBeGreaterThanOrEqual(forwardBand.min);
  expect(forward.slots, forwardDetail).toBeLessThanOrEqual(forwardBand.max);
  await expectReadoutMatchesSlider(page, forwardStartText, 'After forward playback');

  // Reverse at 5×, from where forward stopped: the slider moves toward the From date.
  const reverseStartText = await readoutText(page);
  await directionButton(page).click();
  await expect(
    directionButton(page),
    'Pressing the direction button did not rename it "Playback direction: reverse".',
  ).toHaveAccessibleName(REVERSE_NAME);
  await playButton(page).click();
  const reverse = await sampleSliderMovement(page);
  await playButton(page).click();
  await expect(playButton(page), 'Reverse playback did not pause.').toHaveAccessibleName('Play');
  const reverseBand = slotBand(FIVE_TIMES.slotsPerSecond, reverse.elapsedSeconds);
  const reverseDetail = `Reverse at 5× moved ${reverse.slots} slots in ${reverse.elapsedSeconds.toFixed(3)} s. Expected -${reverseBand.max.toFixed(1)} to -${reverseBand.min.toFixed(1)} slots.`;
  expect(reverse.slots, reverseDetail).toBeLessThanOrEqual(-reverseBand.min);
  expect(reverse.slots, reverseDetail).toBeGreaterThanOrEqual(-reverseBand.max);
  await expectReadoutMatchesSlider(page, reverseStartText, 'After reverse playback');

  // Reverse stops on the first slot and offers Play again, without looping.
  await chooseSpeed(page, TEN_TIMES.optionName);
  await scrubToSlot(page, range.min + SLOTS_BEFORE_FIRST);
  await playButton(page).click();
  await page.waitForTimeout(SAMPLE_MS);
  expect(
    await sliderIndex(page),
    `Reverse playback at 10× from slot ${range.min + SLOTS_BEFORE_FIRST} did not stop on the first slot (${range.min}) within one second.`,
  ).toBe(range.min);
  await expect(
    playButton(page),
    'The play button was not named "Play" after reverse playback reached the first slot.',
  ).toHaveAccessibleName('Play');
});

function slotBand(targetSlotsPerSecond: number, elapsedSeconds: number): { min: number; max: number } {
  const expected = targetSlotsPerSecond * elapsedSeconds;
  const margin = Math.max(1, expected * 0.1);
  return { min: expected - margin, max: expected + margin };
}

async function sliderRange(page: Page): Promise<{ min: number; max: number }> {
  return page.locator('#timeline-slider').evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    return { min: Number(element.min), max: Number(element.max) };
  });
}

async function scrubToSlot(page: Page, slot: number): Promise<void> {
  await page.locator('#timeline-slider').evaluate((element, wanted) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    element.value = String(wanted);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, slot);
}

async function readoutText(page: Page): Promise<string> {
  return (await page.locator('#timeline-readout').textContent())?.trim() ?? '';
}

/** Signed slot change over one second inside the page: positive toward the To date, negative toward the From date. */
async function sampleSliderMovement(page: Page): Promise<{ slots: number; elapsedSeconds: number }> {
  return page.evaluate(async (sampleMs) => {
    const slider = document.getElementById('timeline-slider');
    if (!(slider instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    const startIndex = Number(slider.value);
    const startedAt = performance.now();
    await new Promise((resolve) => window.setTimeout(resolve, sampleMs));
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    return { slots: Number(slider.value) - startIndex, elapsedSeconds };
  }, SAMPLE_MS);
}

async function expectReadoutMatchesSlider(page: Page, startText: string, when: string): Promise<void> {
  const readout = await readoutText(page);
  const valueText = await page.locator('#timeline-slider').getAttribute('aria-valuetext');
  expect(readout, `${when}, the time readout "${readout}" did not match the slider's aria-valuetext "${valueText}".`).toBe(
    valueText?.trim(),
  );
  expect(readout, `${when}, the time readout still showed the leg's starting time "${startText}".`).not.toBe(startText);
}
