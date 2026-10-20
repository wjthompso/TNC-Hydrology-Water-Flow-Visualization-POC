import { expect, test, type Page } from '../../../../support/browser/deterministic-network.ts';
import { timelineFixturePath } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';

/**
 * Methodology: Opens the timeline fixture page, waits until the page
 * stylesheet has painted, and reads the computed background, border, and text
 * color of the five speed buttons. Before any click, 1× is the only button
 * whose paint differs. It then clicks 2× and checks that 2× is the only
 * button whose paint differs. The ArcGIS scene and published gauge series are
 * not loaded. It does not press Play, and it does not check how fast the
 * slider moves or the map.
 */

const SPEED_BUTTON_IDS = [
  'timeline-speed-0-5x',
  'timeline-speed-1x',
  'timeline-speed-2x',
  'timeline-speed-5x',
  'timeline-speed-10x',
] as const;

test('Highlight the current playback speed, starting at 1× until another speed is chosen.', async ({
  page,
}) => {
  await page.goto(timelineFixturePath());
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(2, 6, 23)');

  await expectHighlightedSpeed(page, 'timeline-speed-1x');
  await page.getByRole('button', { name: '2 times speed', exact: true }).click();
  await expectHighlightedSpeed(page, 'timeline-speed-2x');
});

async function expectHighlightedSpeed(page: Page, selectedId: string): Promise<void> {
  const paints = await page.evaluate((ids: readonly string[]) => {
    const result: Record<string, string> = {};
    for (const id of ids) {
      const button = document.getElementById(id);
      if (!(button instanceof HTMLElement)) throw new Error(`The speed button ${id} is missing.`);
      const style = getComputedStyle(button);
      result[id] = `${style.backgroundColor}|${style.borderTopColor}|${style.color}`;
    }
    return result;
  }, SPEED_BUTTON_IDS);

  const selected = paints[selectedId];
  const others = SPEED_BUTTON_IDS.filter((id) => id !== selectedId).map((id) => paints[id]);
  const detail = JSON.stringify(paints);
  expect(others.every((paint) => paint === others[0]), `Inactive speeds should match. ${detail}`).toBe(true);
  expect(selected, `${selectedId} should use a different highlight. ${detail}`).not.toBe(others[0]);
}
