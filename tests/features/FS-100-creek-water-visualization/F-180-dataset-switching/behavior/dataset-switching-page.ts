/**
 * Playwright helpers for the Dataset picker: tag the live page and its
 * SceneView canvas, switch Dataset through the real picker, and read whether
 * the tags survived.
 */

import type { Page } from '../../../../support/browser/response-cache/index.ts';

const DOCUMENT_TAG_KEY = '__datasetSwitchDocumentTag';
const CANVAS_REFERENCE_KEY = '__datasetSwitchCanvasReference';
const DOCUMENT_TAG_VALUE = 'opened-before-the-switch';

export interface SceneSurvival {
  /** The page's JavaScript window is the one tagged before the switch. */
  readonly sameDocument: boolean;
  /** The SceneView canvas on screen is the element tagged before the switch. */
  readonly sameSceneCanvas: boolean;
}

/** Tags the current window and the SceneView canvas so a later read can tell whether either was replaced. */
export async function tagLiveScene(page: Page): Promise<void> {
  await page.evaluate(
    ({ documentKey, canvasKey, documentValue }) => {
      const canvas = document.querySelector('#arcgis-view canvas');
      if (!canvas) throw new Error('The SceneView canvas is missing, so the scene cannot be tagged.');
      Reflect.set(window, documentKey, documentValue);
      Reflect.set(window, canvasKey, canvas);
    },
    { documentKey: DOCUMENT_TAG_KEY, canvasKey: CANVAS_REFERENCE_KEY, documentValue: DOCUMENT_TAG_VALUE },
  );
}

/** Reads the tags; a reloaded page has neither. Returns null while the page is mid-navigation. */
export async function readSceneSurvival(page: Page): Promise<SceneSurvival | null> {
  try {
    return await page.evaluate(
      ({ documentKey, canvasKey, documentValue }) => ({
        sameDocument: Reflect.get(window, documentKey) === documentValue,
        sameSceneCanvas:
          Reflect.get(window, canvasKey) !== undefined &&
          document.querySelector('#arcgis-view canvas') === Reflect.get(window, canvasKey),
      }),
      { documentKey: DOCUMENT_TAG_KEY, canvasKey: CANVAS_REFERENCE_KEY, documentValue: DOCUMENT_TAG_VALUE },
    );
  } catch {
    return null;
  }
}

/** Chooses a Dataset in the real picker, the way a person does. */
export async function chooseDataset(page: Page, datasetOptionId: string): Promise<void> {
  await page.locator('#dataset-picker').selectOption(datasetOptionId);
}

/**
 * Counts full page loads from now on. The `load` event fires for a new
 * document only, so an address-bar update by `history.replaceState` is not counted.
 */
export function countPageLoads(page: Page): { readonly count: () => number } {
  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });
  return { count: () => loads };
}

/** Experience title text (“Observed water” or “Modeled water”), or null mid-navigation. */
export async function readExperienceTitle(page: Page): Promise<string | null> {
  try {
    return (await page.locator('#experience-title').textContent({ timeout: 1_000 }))?.trim() ?? null;
  } catch {
    return null;
  }
}

/** The modeled-water seam exists and its loads have finished. False while the page has no modeled seam, or is mid-navigation. */
export async function modeledWaterIsDrawn(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(async () => {
      const modeled = window.__TNC_MODELED__;
      if (!modeled) return false;
      await modeled.whenIdle();
      return true;
    });
  } catch {
    return false;
  }
}

/** Creek Segment ids the observed-water seam draws now, or null while the page is mid-navigation. */
export async function readDrawnWaterSegmentIds(page: Page): Promise<readonly string[] | null> {
  try {
    return await page.evaluate(() => [...(window.__TNC_TEST__?.waterSegmentIds ?? [])]);
  } catch {
    return null;
  }
}
