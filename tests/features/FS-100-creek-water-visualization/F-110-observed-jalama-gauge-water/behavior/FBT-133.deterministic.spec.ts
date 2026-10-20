import { expect, test } from '../../../../support/browser/deterministic-network.ts';
import { timelineOpeningPath } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';

/**
 * Methodology: Opens the timeline-only page for the real published Jalama
 * record and the app's real opening slot. The 3D scene is not loaded, and the
 * test fails if the page requests ArcGIS. When the time readout leaves the
 * loading text, the slider's slot is 0 and is before the last slot. It does
 * not press Play, and it does not check water, playback speed, or the map.
 */

test('Open the Jalama time slider at the first observation slot, not the last.', async ({
  page,
}) => {
  const arcgisRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().toLowerCase().includes('arcgis')) arcgisRequests.push(request.url());
  });

  await page.goto(timelineOpeningPath());
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');
  expect(arcgisRequests, 'The opening-slot check loaded ArcGIS.').toEqual([]);

  const position = await page.locator('#timeline-slider').evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    return { value: Number(element.value), max: Number(element.max) };
  });

  expect(position.max, 'The record has no slots after the first one.').toBeGreaterThan(0);
  expect(position.value, `The slider opened at slot ${position.value} of 0–${position.max}.`).toBe(0);
  expect(position.value, 'The slider opened on the last slot.').toBeLessThan(position.max);
});
