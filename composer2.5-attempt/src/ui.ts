import type { BasemapMode, ElevationSource } from './arcgis-scene';
import type { ReachData } from './types';
import {
  MAX_WATER_STAGE_FT,
  feetToMeters,
  formatStageLabel,
} from './water-stage';

type RendererId = 'arcgis' | 'three';

const RISE_CYCLE_SECONDS = 8;

export interface StageControls {
  getOffsetFeet: () => number;
  setOffsetFeet: (feet: number) => void;
}

export function bindStageControls(
  data: ReachData,
  onStageChange: (offsetM: number) => void,
): StageControls {
  const slider = document.getElementById('stage-slider') as HTMLInputElement;
  const stageValue = document.getElementById('stage-value');
  const reachStats = document.getElementById('reach-stats');
  const playBtn = document.getElementById('stage-play-btn') as HTMLButtonElement;

  if (!slider || !stageValue || !reachStats || !playBtn) {
    throw new Error('Required UI elements missing');
  }

  slider.min = '0';
  slider.max = String(MAX_WATER_STAGE_FT);
  slider.step = '0.05';
  slider.value = '0';

  let playing = false;
  let rafId = 0;
  let lastTime = 0;
  let currentFeet = 0;

  const setFeet = (feet: number, fromUser = false): void => {
    const clamped = Math.max(0, Math.min(MAX_WATER_STAGE_FT, feet));
    currentFeet = clamped;
    slider.value = String(clamped);
    const label = formatStageLabel(clamped);
    slider.setAttribute('aria-valuetext', label);
    stageValue.textContent = label;
    onStageChange(feetToMeters(clamped));

    if (fromUser && playing) {
      playing = false;
      playBtn.textContent = 'Play';
      playBtn.setAttribute('aria-pressed', 'false');
      cancelAnimationFrame(rafId);
    }
  };

  const tick = (time: number): void => {
    if (!playing) return;

    if (!lastTime) lastTime = time;
    const dt = (time - lastTime) / 1000;
    lastTime = time;

    const nextFeet = currentFeet + (MAX_WATER_STAGE_FT / RISE_CYCLE_SECONDS) * dt;
    if (nextFeet >= MAX_WATER_STAGE_FT) {
      setFeet(0);
      lastTime = time;
    } else {
      setFeet(nextFeet);
    }

    rafId = requestAnimationFrame(tick);
  };

  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-pressed', String(playing));

    if (playing) {
      lastTime = 0;
      rafId = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(rafId);
    }
  });

  slider.addEventListener('input', () => setFeet(Number(slider.value), true));

  reachStats.textContent = `${data.meta.reachLengthM} m reach · COMID ${data.meta.comid} · origin ${data.meta.originWgs84.lat.toFixed(5)}°N`;

  setFeet(0);

  return {
    getOffsetFeet: () => currentFeet,
    setOffsetFeet: (feet) => setFeet(feet),
  };
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
      'No API key — USGS 3DEP terrain is active in a 2 km creek area. Water uses offline valley-bottom elevations from reach.json and renders at absolute height on the terrain. Optional VITE_ARCGIS_API_KEY switches to Esri imagery + world elevation.';
    return;
  }

  subtitle.textContent = 'ArcGIS SceneView · USGS satellite imagery (key-free, flat ground)';
  note.textContent =
    'Terrain sampling was unavailable, so the map safely uses flat ground and ground-draped water. Set VITE_ARCGIS_API_KEY for Esri imagery + world elevation.';
}

export function hideLoadingOverlay(): void {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.remove();
}
