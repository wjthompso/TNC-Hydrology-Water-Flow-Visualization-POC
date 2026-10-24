import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  midRecordObservation,
  OBSERVATION_STEP_MS,
  openObservedWaterPage,
  readSeam,
  rethrowIfExternalOutage,
  scrubToTime,
  watchLiveServices,
} from './observed-jalama-gauge-water.ts';

/**
 * Methodology: Scrubs the real time slider to a mid-record observation taken
 * from the committed series, presses the Play button, and samples the selected
 * time until the samples have moved forward by 15-minute steps, then presses
 * Pause and checks that the time stays unchanged for 1 second. The browser
 * page and committed published data are real. Esri World Imagery and Esri
 * World Elevation responses are real and are reused from a local disk cache; a
 * response missing from the cache is fetched live, and if that fetch is
 * unavailable the result is inconclusive rather than passed. Nothing else is
 * mocked. It does not check the visual
 * appearance of the water.
 *
 * Imagery dataset used in the visualization: Esri World Imagery.
 */
test('Play the Jalama gauge observations in chronological order, and stop that advance when Pause is pressed.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    // Open Jalama Creek on the Jalama Near Lompoc gauge 15-minute readings,
    // then move to a reading midway through the record.
    await openObservedWaterPage(page, watch, FAST_TEST_SCENE_IMAGERY_ID);
    const midRecord = midRecordObservation();
    await scrubToTime(page, midRecord);

    // Press Play. The selected time steps forward through later 15-minute readings.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    // A poll can land twice in one 15-minute slot. Keep each new slot.
    // Every new slot must be a later multiple of 15 minutes.
    const samples: number[] = [];
    await expect
      .poll(
        async () => {
          const selected = await page.evaluate(
            () => window.__TNC_TEST__?.selectedTimeUtcMs ?? null,
          );
          if (selected === null) return samples.length;
          const previous = samples[samples.length - 1];
          if (previous === undefined || selected !== previous) samples.push(selected);
          return samples.length;
        },
        { intervals: [100], timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(4);

    expect(samples[0]).toBeGreaterThanOrEqual(midRecord);
    for (let index = 1; index < samples.length; index += 1) {
      const step = samples[index] - samples[index - 1];
      expect(step).toBeGreaterThan(0);
      expect(step % OBSERVATION_STEP_MS).toBe(0);
    }

    // Press Pause. Play returns, and the selected time holds still for a second.
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    const held = (await readSeam(page)).selectedTimeUtcMs;
    const stayed = await page.evaluate(async (pausedAt: number | null) => {
      const deadline = performance.now() + 1000;
      while (performance.now() < deadline) {
        if (window.__TNC_TEST__?.selectedTimeUtcMs !== pausedAt) return false;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      return window.__TNC_TEST__?.selectedTimeUtcMs === pausedAt;
    }, held);
    expect(stayed).toBe(true);
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
