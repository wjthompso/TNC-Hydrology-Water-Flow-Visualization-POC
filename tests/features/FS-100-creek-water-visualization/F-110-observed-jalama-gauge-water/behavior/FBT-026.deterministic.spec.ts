import { expect, test } from '../../../../support/browser/deterministic-network.ts';
import { TEST_MODE_DATA_SOURCE_QUERY_PARAM } from '../../../../../apps/creek-visualization-browser/src/creek-data-source-configuration.ts';
import { TIMELINE_FIXTURE_PARAM, TIMELINE_OPENING_VALUE } from '../../../../../apps/creek-visualization-browser/src/timeline-fixture-request.ts';
import { replayHostedObservedGaugeServices } from './hosted-observed-gauge-services.ts';

/**
 * Methodology: Opens the locally served page on the timeline-only view of the
 * observed Jalama gauge Dataset, with the test-mode data-source parameter set
 * to hosted. That is the production data path: the app's real loader asks the
 * Dangermond Preserve ArcGIS services for the gauge's readings, Creek Segments,
 * versions, and water polygons, merges them with the shipped
 * observed-wse-propagation.json, and runs the real data-contract checks.
 * The ArcGIS responses are saved: reviewed recordings of the public m1-v1
 * modeled-WSE, WSE-polygon, and Creek Gauge Data services (version rows and
 * the 61 Creek Segments in full; the gauge segment's and its six neighbours'
 * polygons and nine gauge readings trimmed), captured 2026-10-28 and replayed
 * by the test. The recordings and checksums are in tests/fixtures. The test
 * fails on any other external request, and on a Dangermond request that no
 * recording answers. Nothing is mocked inside the app. The shipped data files
 * are the real ones. The test passes when the loading overlay clears, the
 * error panel stays hidden, the time readout leaves its loading text, the
 * slider spans the nine recorded readings, and the page asked the hosted
 * gauge service for those readings. A failure quotes the error panel's text.
 * It does not load the 3D scene, so it does not check the water drawing, the
 * water-depth chart, imagery, terrain, the sign-in dialog, or any value
 * the services return beyond the reading count. It does not check that the
 * recordings still match the live services; the manual command
 * `npm run data-products:verify-hosted-observed-data` compares them.
 */

test("Open the observed Jalama gauge water from the hosted ArcGIS services and show the gauge's water, not a data-loading error.", async ({
  page,
}) => {
  // Replay the public Dangermond services from their recordings.
  const replay = await replayHostedObservedGaugeServices(page);

  // Open the observed gauge Dataset's time slider on the hosted data path.
  await page.goto(
    `/?${TIMELINE_FIXTURE_PARAM}=${TIMELINE_OPENING_VALUE}&${TEST_MODE_DATA_SOURCE_QUERY_PARAM}=hosted`,
  );
  await expect(page.locator('#loading-overlay'), 'The page stayed on its loading screen.').toHaveCount(0);

  // The page shows no startup error. A failure quotes what the error panel told the person.
  const errorPanel = page.locator('#experience-error');
  const errorText = (await errorPanel.isVisible()) ? (await errorPanel.innerText()).trim() : '';
  expect(errorText, `The page showed this data-loading error instead of the gauge's water: "${errorText}"`).toBe('');

  // The time slider holds the gauge's readings: nine 15-minute readings make nine slots.
  await expect(page.locator('#timeline-readout')).not.toHaveText('Loading time…');
  const lastSlot = await page.locator('#timeline-slider').evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    return Number(element.max);
  });
  expect(lastSlot, 'The time slider does not span the recorded gauge readings.').toBe(8);

  // The readings came from the hosted gauge service, and no hosted layer went unanswered.
  expect(replay.served, 'The page never read the gauge from the hosted service.').toContain(
    'rows Dangermond_Creek_Gauges/FeatureServer/2',
  );
  expect(replay.unserved, 'The page asked the Dangermond server for something with no recording.').toEqual([]);
});
