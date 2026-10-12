import { expect, test } from '@playwright/test';
import {
  gapSlotOn9June2026,
  nullReadingSlot,
  openObservedWaterPage,
  readSeam,
  rethrowIfExternalOutage,
  scrubToTime,
  watchLiveServices,
} from './observed-jalama-gauge-water.ts';

/**
 * Methodology: Selects a gap slot inside the committed series' 135-minute gap
 * on 2026-06-09 and a null-reading slot from that same series, using the real
 * time slider. It checks that the water-segment list is empty and that the
 * status "No observation at this time" is visible in both cases. The browser
 * page and committed published data are real. Esri World Imagery and Esri
 * World Elevation tiles are live; if they are unavailable the result is
 * inconclusive rather than passed. Nothing is mocked or saved. It does not check the visual
 * appearance of the water.
 */
test('Select a Jalama gauge time with no observation and show no water on its Creek Segment.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    await openObservedWaterPage(page, watch);

    for (const timeUtcMs of [gapSlotOn9June2026(), nullReadingSlot()]) {
      await scrubToTime(page, timeUtcMs);
      await expect.poll(async () => (await readSeam(page)).waterSegmentIds).toEqual([]);
      await expect(page.getByText('No observation at this time', { exact: true })).toBeVisible();
    }
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
