import type { Locator, Page } from '@playwright/test';

/**
 * Page contract for the compact playback controls (mockup option E5,
 * docs/design/mockups/time-slider-e.html). The page does not implement this yet,
 * so every helper here fails until the controls are built.
 *
 * - Play/Pause button: `#timeline-play-btn`, named "Play" or "Pause".
 * - Direction button: `#timeline-direction-btn`. Its accessible name states the
 *   current direction: "Playback direction: forward" or "Playback direction: reverse".
 *   The page opens on forward. Pressing it flips the direction.
 * - Speed button: `#timeline-speed-btn`. It shows the current speed (such as "1×"),
 *   has no caret, and opens a menu showing every speed with no scrolling.
 * - Speed menu: `#timeline-speed-menu`, role listbox. Each speed is a role option
 *   named "<speed> times speed", such as "0.1 times speed" or "10 times speed".
 *   The current speed's option has aria-selected="true" and shows a check mark.
 */

/** Playback speeds in menu order, with the slots one second of playback should advance (1× is 10 slots per second). */
export const PLAYBACK_SPEEDS = [
  { speed: 0.1, label: '0.1×', optionName: '0.1 times speed', slotsPerSecond: 1 },
  { speed: 0.2, label: '0.2×', optionName: '0.2 times speed', slotsPerSecond: 2 },
  { speed: 0.5, label: '0.5×', optionName: '0.5 times speed', slotsPerSecond: 5 },
  { speed: 1, label: '1×', optionName: '1 times speed', slotsPerSecond: 10 },
  { speed: 2, label: '2×', optionName: '2 times speed', slotsPerSecond: 20 },
  { speed: 5, label: '5×', optionName: '5 times speed', slotsPerSecond: 50 },
  { speed: 10, label: '10×', optionName: '10 times speed', slotsPerSecond: 100 },
] as const;

export type PlaybackDirection = 'forward' | 'reverse';

export function playButton(page: Page): Locator {
  return page.locator('#timeline-play-btn');
}

export function directionButton(page: Page): Locator {
  return page.locator('#timeline-direction-btn');
}

export function speedButton(page: Page): Locator {
  return page.locator('#timeline-speed-btn');
}

export function speedMenu(page: Page): Locator {
  return page.locator('#timeline-speed-menu');
}

/** Opens the speed menu from the speed button, unless it is already open. */
export async function openSpeedMenu(page: Page): Promise<void> {
  const menu = speedMenu(page);
  if (await menu.isVisible()) return;
  await speedButton(page).click();
  await menu.waitFor({ state: 'visible' });
}

/** Picks one speed from the speed menu. The menu closes after the pick. */
export async function chooseSpeed(page: Page, optionName: string): Promise<void> {
  await openSpeedMenu(page);
  await speedMenu(page).getByRole('option', { name: optionName, exact: true }).click();
}

/** Flips the direction button until it names the wanted direction. */
export async function setDirection(page: Page, wanted: PlaybackDirection): Promise<void> {
  const button = directionButton(page);
  const name = `Playback direction: ${wanted}`;
  if ((await button.getAttribute('aria-label')) === name) return;
  await button.click();
}

/** The time slider's current slot index. */
export async function sliderIndex(page: Page): Promise<number> {
  return page.locator('#timeline-slider').evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    return Number(element.value);
  });
}
