import { expect, test, type Page } from '../../../../support/browser/deterministic-network.ts';
import { timelineFixturePath } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';
import {
  PLAYBACK_SPEEDS,
  chooseSpeed,
  openSpeedMenu,
  speedButton,
  speedMenu,
} from './playback-controls.ts';

/**
 * Methodology: Opens the timeline fixture page and waits until the page
 * stylesheet has painted. Before any pick, it reads the speed button text, which
 * must be 1×, then opens the speed menu and checks that exactly the 1× option
 * has aria-selected="true" and a check mark (✓) in its text, and that no other
 * option is selected or shows one. It then picks 2× from the menu and checks
 * that the speed button text is 2× and that, in the reopened menu, only the 2×
 * option is selected and marked. The ArcGIS scene and published gauge series are
 * not loaded. It does not press Play, and it does not check colors, how fast
 * the slider moves, or the map.
 */

test('Show the current playback speed on the speed button and mark it in the speed menu, starting at 1× until another speed is chosen.', async ({
  page,
}) => {
  // Open the timeline and wait until the page has painted.
  await page.goto(timelineFixturePath());
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(2, 6, 23)');

  // Before any pick, the button reads 1× and the menu marks 1× alone.
  await expect(speedButton(page)).toHaveText('1×');
  await expectMarkedSpeed(page, '1 times speed');

  // Picking 2× moves the button text and the menu mark onto 2× alone.
  await chooseSpeed(page, '2 times speed');
  await expect(speedButton(page)).toHaveText('2×');
  await expectMarkedSpeed(page, '2 times speed');
});

async function expectMarkedSpeed(page: Page, markedOptionName: string): Promise<void> {
  await openSpeedMenu(page);
  const options = speedMenu(page).getByRole('option');
  await expect(options).toHaveCount(PLAYBACK_SPEEDS.length);

  for (const speed of PLAYBACK_SPEEDS) {
    const option = speedMenu(page).getByRole('option', { name: speed.optionName, exact: true });
    if (speed.optionName === markedOptionName) {
      await expect(option, `${speed.optionName} should be selected.`).toHaveAttribute('aria-selected', 'true');
      await expect(option, `${speed.optionName} should show a check mark.`).toContainText('✓');
    } else {
      await expect(option, `${speed.optionName} should not be selected.`).not.toHaveAttribute('aria-selected', 'true');
      await expect(option, `${speed.optionName} should not show a check mark.`).not.toContainText('✓');
    }
  }

  // Close the menu again so the next step opens it fresh.
  await page.keyboard.press('Escape');
}
