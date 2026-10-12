import { expect, test } from '@playwright/test';
import {
  floodPeakObservation,
  gapSlotOn9June2026,
  openingObservation,
  openObservedWaterPage,
  rethrowIfExternalOutage,
  scrubToTime,
  visibleWaterCopy,
  watchLiveServices,
  waterNumberViolations,
} from './observed-jalama-gauge-water.ts';

/**
 * Methodology: At the opening time, the published flood peak, and a gap slot,
 * reads document.body.innerText plus every aria-label, aria-valuetext, and
 * title value and checks that none contain a water number, the words stage or
 * discharge, or the published water-surface elevations for those times rounded
 * to 1, 2, or 3 decimals. The browser page and committed published data are
 * real. Esri World Imagery and Esri World Elevation tiles are live; if they
 * are unavailable the result is inconclusive rather than passed. Nothing is mocked
 * or saved. Console output and the visual appearance of the water are not
 * checked.
 */
test('Hide every numeric water-surface elevation, stage, and discharge value on the page.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  try {
    await openObservedWaterPage(page, watch);
    const opening = openingObservation();
    const peak = floodPeakObservation();
    const moments = [
      { timeUtcMs: opening.timeUtcMs, elevationsM: [opening.waterSurfaceElevationM] },
      { timeUtcMs: peak.timeUtcMs, elevationsM: [peak.waterSurfaceElevationM] },
      { timeUtcMs: gapSlotOn9June2026(), elevationsM: [] },
    ];

    for (const moment of moments) {
      await scrubToTime(page, moment.timeUtcMs);
      const copy = await visibleWaterCopy(page);
      expect(waterNumberViolations(copy, moment.elevationsM)).toEqual([]);
    }
  } catch (error) {
    rethrowIfExternalOutage(watch, error);
  }
});
