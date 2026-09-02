import '@arcgis/core/assets/esri/themes/dark/main.css';
import './style.css';
import { ArcGISCreekScene } from './arcgis-scene';
import { CreekScene } from './scene';
import {
  bindRendererToggle,
  bindStageControls,
  hideLoadingOverlay,
  updateBasemapNote,
} from './ui';
import type { SceneBackend } from './scene-backend';
import type { ReachData } from './types';

type RendererId = 'arcgis' | 'three';

async function main(): Promise<void> {
  const arcgisContainer = document.getElementById('arcgis-view');
  const threeContainer = document.getElementById('three-view');
  if (!arcgisContainer || !threeContainer) {
    throw new Error('#arcgis-view or #three-view not found');
  }

  const response = await fetch('/data/reach.json');
  if (!response.ok) {
    throw new Error('reach.json missing. Run: npm run generate-data');
  }

  const data = (await response.json()) as ReachData;
  let activeRenderer: RendererId = 'arcgis';
  let activeScene: SceneBackend | null = null;
  let currentStageId = data.meta.stages[0].id;

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
    activeScene.setStage(currentStageId);
    activeRenderer = id;
  };

  bindStageControls(data, (stageId) => {
    currentStageId = stageId;
    activeScene?.setStage(stageId);
  });

  bindRendererToggle(activeRenderer, switchRenderer);

  await switchRenderer('arcgis');
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
