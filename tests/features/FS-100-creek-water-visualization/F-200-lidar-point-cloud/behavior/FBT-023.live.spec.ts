import { expect, test } from '../../../../support/browser/response-cache/index.ts';
import type { Page } from '../../../../support/browser/response-cache/index.ts';
import { FAST_TEST_SCENE_IMAGERY_ID } from '../../../../../apps/creek-visualization-browser/src/scene-imagery-options.ts';
import {
  openObservedWaterPage,
  rethrowIfExternalOutage,
  watchLiveServices,
} from '../../F-110-observed-jalama-gauge-water/behavior/observed-jalama-gauge-water.ts';
import { settleScene } from '../../F-120-creek-scene-imagery-and-terrain-navigation/behavior/scene-camera.ts';

/**
 * Methodology: Opens the locally served observed-water page in test mode and
 * waits until SceneView has finished loading with a still camera. The browser
 * page, SceneView, published creek data, and the 2018 colorized LiDAR scene
 * layer are real. Esri imagery, terrain, and LiDAR responses from
 * tiles.arcgis.com are real and reused from the Esri response cache; a missing
 * response is fetched live and saved. Nothing else is mocked. Before the click,
 * the settled view has no point-cloud layer. The test clicks the button by its
 * visible name, Show 2018 LiDAR point cloud, then waits until the view is still
 * and finished drawing. It fails unless that view then holds one visible
 * point-cloud layer that has loaded. A measured miss stays a failure even if
 * Esri also returns HTTP 429 or 5xx. If no LiDAR response arrives and the scene
 * never finishes, the result is inconclusive. It does not check screen pixels,
 * the hide click, point color, point size, density, or elevation agreement with
 * the water.
 *
 * Imagery dataset used in the visualization: Esri World Imagery.
 */

const LIDAR_SERVICE_REQUEST = /tiles\.arcgis\.com\/tiles\/6DIQcwlPy8knb6sg\/arcgis\/rest\/services\/All_Aeroptic_ColorizedPointCloud/i;
const LAYER_LOADED_BUDGET_MS = 10_000;

interface LidarTraffic {
  successfulResponses: number;
  unavailableResponses: number;
}

/** Counts LiDAR scene service outcomes, including responses served from the cache. */
function watchLidarTraffic(page: Page): LidarTraffic {
  const traffic: LidarTraffic = { successfulResponses: 0, unavailableResponses: 0 };
  page.on('response', (response) => {
    if (!LIDAR_SERVICE_REQUEST.test(response.url())) return;
    const status = response.status();
    if (status >= 200 && status < 300) traffic.successfulResponses += 1;
    else if (status === 429 || status >= 500) traffic.unavailableResponses += 1;
  });
  return traffic;
}

async function readPointCloudLayers(page: Page) {
  return page.evaluate(() => (window.__TNC_TEST__?.pointCloudLayers ?? []).map((layer) => ({ ...layer })));
}

test('Clicking Show 2018 LiDAR point cloud draws colorized LiDAR points over the settled Jalama Creek scene.', async ({
  page,
}) => {
  const watch = watchLiveServices(page);
  const lidar = watchLidarTraffic(page);
  const failures: string[] = [];

  try {
    // Open Jalama Creek and wait for a finished, still frame with the cloud off.
    await openObservedWaterPage(page, watch, FAST_TEST_SCENE_IMAGERY_ID);
    await settleScene(page, 'opening');
    const before = await readPointCloudLayers(page);
    expect(before, 'point-cloud layers before the click').toEqual([]);

    // Turn the cloud on with the real button, then wait for the layer to load.
    await page.getByRole('button', { name: 'Show 2018 LiDAR point cloud' }).click();
    await page
      .waitForFunction(
        () => (window.__TNC_TEST__?.pointCloudLayers ?? []).some((layer) => layer.loaded),
        undefined,
        { timeout: LAYER_LOADED_BUDGET_MS },
      )
      .catch(() => undefined);

    // Finished, still frame with the cloud on.
    const settleError = await settleScene(page, 'after the LiDAR click').then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    const after = await readPointCloudLayers(page);
    const shown = after.length === 1 && after[0]?.visible === true && after[0].loaded === true;

    if (settleError) {
      if (lidar.successfulResponses === 0) {
        throw new Error(
          `INCONCLUSIVE: no LiDAR response arrived and the scene never finished drawing (${lidar.unavailableResponses} HTTP 429 or 5xx LiDAR responses). ${settleError.message}`,
        );
      }
      failures.push(`After the click the scene never finished drawing. ${settleError.message}`);
    } else if (!shown) {
      failures.push(
        `After the click and a finished frame the view holds ${JSON.stringify(after)} instead of one visible, loaded point-cloud layer.`,
      );
    }
    if (failures.length > 0 && lidar.unavailableResponses > 0) {
      failures.push(
        `Esri also returned ${lidar.unavailableResponses} HTTP 429 or 5xx LiDAR responses during this run; the measured failure stands.`,
      );
    }
  } catch (error) {
    if (failures.length === 0) rethrowIfExternalOutage(watch, error);
    throw error;
  }

  if (failures.length > 0) throw new Error(failures.join('\n'));
});
