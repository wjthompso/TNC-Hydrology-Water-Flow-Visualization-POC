/**
 * Pixel check for the dev tools click marker: a yellow ring and center dot
 * (#f3ef2a) drawn at the last map click, shown only while the dev tools panel
 * is open.
 */

import { PNG } from 'pngjs';
import { expect, type CDPSession, type Page } from '../../../../support/browser/response-cache/index.ts';

/** Crop around the click. The ring is 14px across, so this holds it with room for a small projection offset. */
export const CLICK_MARKER_CROP_PX = 64;

/**
 * The solid 5px dot alone is enough. Antialiased ring pixels often fall
 * outside the color gate, so the bar stays at the dot.
 */
export const MIN_CLICK_MARKER_PIXELS = 8;

/**
 * Near #f3ef2a (243, 239, 42): red and green both high and close, blue low.
 * The Selected Creek Segment highlight #fbbf24 (251, 191, 36) fails because
 * its red runs well ahead of its green.
 */
export function isClickMarkerYellow(red: number, green: number, blue: number): boolean {
  return red >= 200 && green >= 190 && blue <= 110 && Math.abs(red - green) <= 36 && green > blue + 90;
}

export async function countClickMarkerPixels(
  page: Page,
  cdp: CDPSession,
  center: { x: number; y: number },
): Promise<number> {
  const clip = {
    x: Math.max(0, Math.round(center.x - CLICK_MARKER_CROP_PX / 2)),
    y: Math.max(0, Math.round(center.y - CLICK_MARKER_CROP_PX / 2)),
    width: CLICK_MARKER_CROP_PX,
    height: CLICK_MARKER_CROP_PX,
    scale: 1,
  };
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip,
  });
  const png = PNG.sync.read(Buffer.from(shot.data, 'base64'));
  if (png.width !== clip.width || png.height !== clip.height) {
    throw new Error(
      `Click-marker crop was ${png.width}×${png.height} pixels, expected ${clip.width}×${clip.height}.`,
    );
  }
  const blocked = await blockedBoxes(page);
  let count = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const viewportX = clip.x + x;
      const viewportY = clip.y + y;
      if (blocked.some((box) => contains(box, viewportX, viewportY))) continue;
      const index = (png.width * y + x) << 2;
      if (isClickMarkerYellow(png.data[index] ?? 0, png.data[index + 1] ?? 0, png.data[index + 2] ?? 0)) count += 1;
    }
  }
  return count;
}

/** Opens or collapses the dev tools panel through its corner button. */
export async function setDevToolsOpen(page: Page, open: boolean): Promise<void> {
  const button = page.locator('#dev-tools-toggle');
  await expect(button, 'the dev tools button is on the page').toBeVisible();
  if ((await button.getAttribute('aria-expanded')) === String(open)) return;
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', String(open));
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Sidebar, dev tools button, and dev tools panel. Their chrome is not the map marker. */
async function blockedBoxes(page: Page): Promise<Box[]> {
  const boxes: Box[] = [];
  for (const selector of ['aside:not(#dev-tools-hud)', '#dev-tools-toggle', '#dev-tools-hud']) {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) continue;
    const box = await locator.boundingBox({ timeout: 1_000 });
    if (box && box.width > 0 && box.height > 0) boxes.push(box);
  }
  return boxes;
}

function contains(box: Box, x: number, y: number): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}
