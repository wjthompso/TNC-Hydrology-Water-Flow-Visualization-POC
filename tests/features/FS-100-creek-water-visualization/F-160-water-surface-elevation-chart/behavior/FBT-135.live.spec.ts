import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import { watchLiveServices } from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import { settleScene } from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-camera.ts';
import {
  finishSceneCheck,
  rethrowSceneFailure,
  watchTerrainTraffic,
} from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-check-outcome.ts';
import {
  JALAMA_EXTENT_ID,
  JALAMA_TNC_COMID,
  NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
  missingLocalPipelineOutput,
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/local-pipeline-output.ts';
import {
  modeledWaterPageUrl,
  openModeledWaterPage,
  waitForModeledWaterIdle,
} from '../../F-140-modeled-creek-water-surface-elevation/behavior/modeled-water-page.ts';

/** Same hour as FBT-025: inside the typical Jan–May spawning season, with water in the creek. */
const SELECTED_HOUR_UTC = '2023-02-01T00:00:00Z';
const TOAST_TEXT =
  'Showing steelhead trout habitat suitability based on modeled water depth only. Temperature, connectivity, spawning gravel etc. not currently factored in.';

/** Methodology: see the FBT-135 catalog entry. */
test('Turning on steelhead trout conditions shows a toast at the top middle of the page saying the suitability ranges use modeled water depth only, and turning them off removes it.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const terrain = watchTerrainTraffic(page);
  const failures: string[] = [];
  try {
    const missing = missingLocalPipelineOutput({
      extentId: JALAMA_EXTENT_ID,
      datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
      comid: JALAMA_TNC_COMID,
      timesUtcMs: [Date.parse(SELECTED_HOUR_UTC)],
    });
    if (missing) throw new Error(`INCONCLUSIVE: ${missing}`);

    await openModeledWaterPage(
      page,
      watch,
      modeledWaterPageUrl({
        datasetId: NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
        extentId: JALAMA_EXTENT_ID,
        timeUtc: SELECTED_HOUR_UTC,
      }),
    );
    await settleScene(page, 'opening-frame');
    await waitForModeledWaterIdle(page);

    const toast = page.getByText(TOAST_TEXT, { exact: true });
    await expect(toast, 'No toast while trout conditions are off').toBeHidden();

    await page.locator('#trout-conditions-toggle').check();
    await expect(toast, 'The toast appears once trout conditions are on').toBeVisible();

    // Top middle of the open map: centered between the sidebar's right edge and the map buttons' left edge.
    const box = await toast.boundingBox();
    const sidebarBox = await page.locator('aside').first().boundingBox();
    const buttonsBox = await page.locator('#imagery-widget').boundingBox();
    const viewport = page.viewportSize();
    if (!box || !sidebarBox || !buttonsBox || !viewport) throw new Error('Could not measure the toast.');
    const openMapCenter = (sidebarBox.x + sidebarBox.width + buttonsBox.x) / 2;
    expect(
      Math.abs(box.x + box.width / 2 - openMapCenter),
      `The toast is centered between the sidebar and the map buttons (toast ${JSON.stringify(box)}, middle ${openMapCenter})`,
    ).toBeLessThanOrEqual(8);
    expect(box.y, 'The toast sits near the top of the window').toBeLessThan(viewport.height * 0.2);

    await page.locator('#trout-conditions-toggle').uncheck();
    await expect(toast, 'The toast goes away when trout conditions are turned off').toBeHidden();

    finishSceneCheck(failures, terrain, watch);
  } catch (error) {
    rethrowSceneFailure(error, failures, watch);
  }
});
