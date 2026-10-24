import { expect, test } from '../../../../support/browser/deterministic-network.ts';
import { timelineFixturePath } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';

/**
 * Methodology: Opens the timeline fixture page, picks 10× speed, and starts
 * playback. It then moves the real mouse to the centre of the play/pause icon,
 * confirms the point sits on the icon itself and not the button's padding,
 * presses, holds 100 ms like a person's click, and releases. After 100 ms it
 * reads, once and without retrying, that the button is named Play, and checks
 * that the slider index does not change over the next 300 ms. It does not wait
 * for the button to become Play, because playback also ends by itself at the
 * last slot and would hide a lost click. The page and the production timeline control are real. The
 * ArcGIS scene and published gauge series are not loaded, and nothing is
 * mocked. The test runs in the Chromium browser channel, because the default
 * headless shell delivers the click even when the bug is present. It does not
 * check the icon's look, the hover tooltip, keyboard use, or speeds other than
 * 10×.
 */

// The default headless shell hides this bug; the Chromium channel shows it.
test.use({ channel: 'chromium' });

const HOLD_MS = 100;
const SETTLE_MS = 100;
const QUIET_PERIOD_MS = 300;

test('Pressing the pause icon itself at 10× speed pauses playback, the same as pressing the button edge.', async ({
  page,
}) => {
  // Open the local timeline and wait until its clock is ready.
  await page.goto(timelineFixturePath());
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');

  // Pick 10× and start playback, so the button is showing the pause icon.
  await page.getByRole('button', { name: '10 times speed', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const button = page.locator('#timeline-play-btn');
  await expect(button).toHaveAttribute('aria-label', 'Pause');

  // The press point is the centre of that icon, not the padding around it.
  const box = await button.boundingBox();
  if (!box) throw new Error('The play button has no box.');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const onIcon = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('svg') != null,
    centre,
  );
  expect(onIcon, 'The press point is not on the icon, so this would not test the icon.').toBe(true);

  // Press and hold the icon briefly, the way a person clicks, then release.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.waitForTimeout(HOLD_MS);
  await page.mouse.up();

  // Playback stops: the button offers Play again, and the slider does not keep moving.
  // One immediate read. A retrying assertion would pass once playback reached its last slot by itself.
  await page.waitForTimeout(SETTLE_MS);
  expect(await button.getAttribute('aria-label'), 'Pressing the pause icon did not pause playback.').toBe('Play');
  const slotAfterPress = await sliderIndex(page);
  await page.waitForTimeout(QUIET_PERIOD_MS);
  expect(await sliderIndex(page), 'The slider kept moving after the press.').toBe(slotAfterPress);
});

async function sliderIndex(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('#timeline-slider').evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    return Number(element.value);
  });
}
