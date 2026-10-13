import { expect, test } from '../../../../support/browser/deterministic-network.ts';

/**
 * Methodology: Loads the Esri dark theme and the app stylesheet, in that
 * order, on a local page whose only view markup is an .esri-view containing
 * a focusable .esri-view-surface. SceneView, the map, imagery, terrain, and
 * the network are absent. The test clicks the surface and reads the computed
 * outline of its ::after pseudo-element. It fails when that outline has a
 * non-zero width and a painted style. It does not check keyboard focus,
 * widget rings, water, or camera navigation.
 */

/**
 * Regression RCA (root cause analysis)
 * Symptom: clicking the creek scene paints a light-blue frame around the whole view.
 * Root cause: the Esri dark theme draws that frame on .esri-view .esri-view-surface:focus::after
 * as a 2px solid Calcite brand outline, offset -2px. Calcite is Esri's design system.
 * The surface is focusable, and its own outline is already 0, so resetting the element
 * outline misses the frame.
 * Reproduction: before the fix, the clicked surface ::after outline measured 2px solid rgb(0, 122, 194).
 * Fix: the app stylesheet clears that ::after outline for pointer focus and leaves the keyboard :focus-visible ring.
 * Future triage: after a click, inspect the surface ::after computed outline width, and
 * confirm the app stylesheet still loads after the Esri theme.
 */

test('Clicking the creek scene does not draw a (usually light blue) focus frame around the view.', async ({
  page,
}) => {
  await page.goto('/scene-focus-frame-harness.html');
  const surface = page.locator('.esri-view-surface');
  const view = page.locator('.esri-view');

  const themeOutline = (
    await view.evaluate((element) => getComputedStyle(element).getPropertyValue('--esri-view-outline'))
  ).trim();
  expect(themeOutline, 'The Esri theme did not load on the scene view.').toContain('2px');

  const box = await surface.boundingBox();
  if (!box || box.width < 10 || box.height < 10) {
    throw new Error(`The scene surface has no clickable area: ${JSON.stringify(box)}`);
  }

  await surface.click();
  const focusedClass = await page.evaluate(() => document.activeElement?.className ?? '');
  expect(focusedClass, 'The click did not focus the scene surface.').toContain('esri-view-surface');

  const frame = await surface.evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    return {
      width: style.outlineWidth,
      style: style.outlineStyle,
      color: style.outlineColor,
    };
  });
  const widthPx = Number.parseFloat(frame.width);
  const painted =
    Number.isFinite(widthPx) &&
    widthPx > 0 &&
    frame.style !== 'none' &&
    frame.color !== 'transparent' &&
    frame.color !== 'rgba(0, 0, 0, 0)';
  expect(
    painted,
    `Clicked scene surface ::after outline is ${frame.width} ${frame.style} ${frame.color}.`,
  ).toBe(false);
});
