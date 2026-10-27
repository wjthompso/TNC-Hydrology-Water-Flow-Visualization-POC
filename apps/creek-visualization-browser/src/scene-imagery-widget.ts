// Floating imagery chooser at the top-right of the map, styled like an Esri
// map widget: a square button that opens a list of imagery choices. It
// replaces the sidebar's imagery dropdown. A choice swaps the imagery in
// place, so the camera, time, and water stay put.

import type SceneView from '@arcgis/core/views/SceneView';
import { showSceneImagery, writeSceneImageryToUrl } from './scene-imagery';
import {
  readSceneImageryId,
  sceneImageryCredit,
  SCENE_IMAGERY_OPTIONS,
  type SceneImageryId,
} from './scene-imagery-options';

const OPTION_CLASS =
  'flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-xs leading-snug text-slate-200 hover:bg-slate-800 has-[:checked]:bg-cyan-950/70 has-[:checked]:text-cyan-100 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-cyan-300';
const RADIO_CLASS = 'mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-cyan-400 focus-visible:outline-none';

/** When Dev tools are enabled, that button occupies the corner and this widget sits below it. */
const BELOW_DEV_TOOLS_CLASS = 'top-14';

export function bindSceneImageryWidget(view: SceneView, options: { belowDevTools: boolean }): void {
  const widget = document.getElementById('imagery-widget');
  const button = document.getElementById('imagery-widget-btn');
  const panel = document.getElementById('imagery-widget-panel');
  const list = document.getElementById('imagery-widget-options');
  if (!widget || !(button instanceof HTMLButtonElement) || !panel || !list) return;

  if (options.belowDevTools) widget.classList.replace('top-4', BELOW_DEV_TOOLS_CLASS);

  const selectedId = readSceneImageryId(location.search);
  setSceneNote(selectedId);

  list.replaceChildren(
    ...SCENE_IMAGERY_OPTIONS.map((option) => {
      const label = document.createElement('label');
      label.className = OPTION_CLASS;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'scene-imagery';
      radio.value = option.id;
      radio.checked = option.id === selectedId;
      radio.className = RADIO_CLASS;
      radio.addEventListener('change', () => {
        if (!radio.checked || !view.map) return;
        showSceneImagery(view.map, option.id);
        writeSceneImageryToUrl(option.id);
        setSceneNote(option.id);
      });
      const text = document.createElement('span');
      text.textContent = option.label;
      label.append(radio, text);
      return label;
    }),
  );

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };

  button.addEventListener('click', () => {
    const opening = panel.hidden;
    setOpen(opening);
    if (opening) list.querySelector<HTMLInputElement>('input:checked')?.focus();
  });
  // Escape and clicks elsewhere close the list, like a menu.
  widget.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    setOpen(false);
    button.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !widget.contains(event.target as Node)) setOpen(false);
  });
}

function setSceneNote(imageryId: SceneImageryId): void {
  const note = document.getElementById('scene-note');
  if (!note) return;
  note.textContent = `Imagery: ${sceneImageryCredit(imageryId)}. Terrain: USGS 3DEP, with Esri World Elevation beyond the creek.`;
}
