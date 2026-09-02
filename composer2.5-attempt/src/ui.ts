import type { BasemapMode, ElevationSource } from './arcgis-scene';
import type { ReachData } from './types';

type RendererId = 'arcgis' | 'three';

export function bindStageControls(
  data: ReachData,
  onStageChange: (stageId: string) => void,
): void {
  const slider = document.getElementById('stage-slider') as HTMLInputElement;
  const stageValue = document.getElementById('stage-value');
  const reachStats = document.getElementById('reach-stats');

  if (!slider || !stageValue || !reachStats) {
    throw new Error('Required UI elements missing');
  }

  slider.max = String(data.meta.stages.length - 1);

  const update = (index: number) => {
    const stage = data.meta.stages[index];
    slider.value = String(index);
    slider.setAttribute('aria-valuetext', stage.label);
    stageValue.textContent = stage.label;
    onStageChange(stage.id);
  };

  slider.addEventListener('input', () => update(Number(slider.value)));

  reachStats.textContent = `${data.meta.reachLengthM} m reach · COMID ${data.meta.comid} · origin ${data.meta.originWgs84.lat.toFixed(5)}°N`;

  update(0);
}

export function bindRendererToggle(
  initial: RendererId,
  onRendererChange: (id: RendererId) => void | Promise<void>,
): void {
  const arcgisBtn = document.getElementById('renderer-arcgis-btn') as HTMLButtonElement;
  const threeBtn = document.getElementById('renderer-three-btn') as HTMLButtonElement;

  if (!arcgisBtn || !threeBtn) {
    throw new Error('Renderer toggle buttons missing');
  }

  const setActive = (id: RendererId) => {
    const arcgisActive = id === 'arcgis';
    arcgisBtn.setAttribute('aria-pressed', String(arcgisActive));
    threeBtn.setAttribute('aria-pressed', String(!arcgisActive));
    arcgisBtn.classList.toggle('bg-cyan-600', arcgisActive);
    arcgisBtn.classList.toggle('text-white', arcgisActive);
    arcgisBtn.classList.toggle('bg-slate-800', !arcgisActive);
    arcgisBtn.classList.toggle('text-slate-300', !arcgisActive);
    threeBtn.classList.toggle('bg-cyan-600', !arcgisActive);
    threeBtn.classList.toggle('text-white', !arcgisActive);
    threeBtn.classList.toggle('bg-slate-800', arcgisActive);
    threeBtn.classList.toggle('text-slate-300', arcgisActive);
  };

  const handleClick = (id: RendererId) => {
    setActive(id);
    void onRendererChange(id);
  };

  arcgisBtn.addEventListener('click', () => handleClick('arcgis'));
  threeBtn.addEventListener('click', () => handleClick('three'));
  setActive(initial);
}

export function updateBasemapNote(
  mode: BasemapMode | 'three-local',
  elevationSource: ElevationSource = 'none',
): void {
  const note = document.getElementById('api-key-note');
  const subtitle = document.getElementById('panel-subtitle');
  if (!note || !subtitle) return;

  if (mode === 'three-local') {
    subtitle.textContent = 'Three.js local sloped mesh (no basemap)';
    note.textContent = 'Fallback renderer — local meters scene, no geographic basemap.';
    return;
  }

  if (mode === 'arcgis-imagery') {
    subtitle.textContent = 'ArcGIS SceneView · Esri World Imagery + world elevation';
    note.textContent =
      'Using VITE_ARCGIS_API_KEY for Esri imagery and world-elevation 3D terrain.';
    return;
  }

  if (elevationSource === 'usgs-3dep') {
    subtitle.textContent = 'ArcGIS SceneView · USGS imagery + 3DEP elevation (key-free)';
    note.textContent =
      'No API key — validated USGS 3DEP GeoTIFF terrain is active in a 2 km creek area. Water uses absolute heights aligned to the sampled ground; navigation remains unconstrained. Optional VITE_ARCGIS_API_KEY switches to Esri imagery + world elevation.';
    return;
  }

  subtitle.textContent = 'ArcGIS SceneView · USGS satellite imagery (key-free, flat ground)';
  note.textContent =
    'USGS 3DEP preflight did not return a usable tile, so the map safely uses flat ground and ground-draped mock water. Set VITE_ARCGIS_API_KEY for Esri imagery + world elevation.';
}

export function hideLoadingOverlay(): void {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.remove();
}
