import '@arcgis/core/assets/esri/themes/dark/main.css';
import './style.css';
import {
  ArcGISCreekScene,
  readArcGISTestReferences,
  type ArcGISTestReferences,
} from './arcgis-scene';
import { CreekScene } from './scene';
import {
  bindRendererToggle,
  bindStageControls,
  hideLoadingOverlay,
  updateBasemapNote,
} from './ui';
import type { SceneBackend } from './scene-backend';
import type { NetworkData } from './types';

type RendererId = 'arcgis' | 'three';

interface TestModeApi {
  getState: () => Readonly<{ renderer: RendererId; stageOffsetM: number }>;
  getArcGISReferences: () => ArcGISTestReferences;
}

type TestModeWindow = Window & { __TNC_TEST__?: TestModeApi };

async function main(): Promise<void> {
  const arcgisContainer = document.getElementById('arcgis-view');
  const threeContainer = document.getElementById('three-view');
  if (!arcgisContainer || !threeContainer) {
    throw new Error('#arcgis-view or #three-view not found');
  }

  const response = await fetch('/data/reach.json');
  if (!response.ok) {
    throw new Error('reach.json missing. Run: npm run generate-data -w creek-visualization-browser');
  }

  const data = (await response.json()) as NetworkData;
  const testMode = import.meta.env.VITE_TEST_MODE === 'true';
  let activeRenderer: RendererId =
    testMode && import.meta.env.VITE_TEST_RENDERER === 'three' ? 'three' : 'arcgis';
  let activeScene: SceneBackend | null = null;
  let currentOffsetM = 0;

  if (testMode) {
    Object.defineProperty(window as TestModeWindow, '__TNC_TEST__', {
      value: Object.freeze({
        getState: () => Object.freeze({
          renderer: activeRenderer,
          stageOffsetM: currentOffsetM,
        }),
        getArcGISReferences: () => {
          if (!(activeScene instanceof ArcGISCreekScene)) {
            throw new Error('ArcGIS renderer is not active.');
          }
          return readArcGISTestReferences(activeScene);
        },
      } satisfies TestModeApi),
    });
  }

  const showRenderer = (id: RendererId): void => {
    const arcgisActive = id === 'arcgis';
    arcgisContainer.classList.toggle('is-active', arcgisActive);
    arcgisContainer.classList.toggle('is-inactive', !arcgisActive);
    threeContainer.classList.toggle('is-active', !arcgisActive);
    threeContainer.classList.toggle('is-inactive', arcgisActive);
  };

  const createScene = async (id: RendererId): Promise<SceneBackend> => {
    if (id === 'arcgis') {
      const scene = new ArcGISCreekScene(arcgisContainer as HTMLDivElement);
      await scene.load(data);
      updateBasemapNote(scene.basemapMode, scene.elevationSource);
      return scene;
    }

    updateBasemapNote('three-local');
    const scene = new CreekScene(threeContainer);
    scene.load(data);
    return scene;
  };

  const switchRenderer = async (id: RendererId): Promise<void> => {
    if (id === activeRenderer && activeScene) return;

    activeScene?.destroy();
    activeScene = null;
    showRenderer(id);
    activeScene = await createScene(id);
    activeScene.setStageOffsetM(currentOffsetM);
    activeRenderer = id;
  };

  bindStageControls(data, (offsetM) => {
    currentOffsetM = offsetM;
    activeScene?.setStageOffsetM(offsetM);
  });

  bindRendererToggle(activeRenderer, switchRenderer);

  await switchRenderer(activeRenderer);
  hideLoadingOverlay();
}

main().catch((err) => {
  console.error(err);
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
    overlay.classList.add('text-red-300');
  }
});
