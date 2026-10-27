// Floating imagery chooser at the top-right of the map, styled like an Esri
// basemap gallery: a square button that shows a preview of the current imagery
// and opens a list of imagery choices, each with its own preview of the same
// spot. It replaces the sidebar's imagery dropdown. A choice swaps the imagery in
// place, so the camera, time, and water stay put.

import type SceneView from '@arcgis/core/views/SceneView';
import { showSceneImagery, writeSceneImageryToUrl } from './scene-imagery';
import {
  readSceneImageryId,
  sceneImageryCredit,
  sceneImageryOption,
  SCENE_IMAGERY_OPTIONS,
  type SceneImageryId,
} from './scene-imagery-options';

const OPTION_CLASS =
  'group flex cursor-pointer items-center gap-2.5 rounded-md p-1.5 text-xs leading-snug text-slate-200 hover:bg-slate-800 has-[:checked]:bg-cyan-950/70 has-[:checked]:text-cyan-100 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-cyan-300';
/** The preview square carries the selected state, so the radio itself stays screen-reader only. */
const RADIO_CLASS = 'sr-only';
const THUMBNAIL_CLASS =
  'h-16 w-16 shrink-0 rounded-md object-cover ring-1 ring-slate-600 group-hover:ring-slate-400 group-has-[:checked]:ring-2 group-has-[:checked]:ring-cyan-400';
/** Previews are 128 px images for a 64 px square, sharp on high-density screens. `BASE_URL` keeps them reachable under a sub-path. */
const THUMBNAIL_ROOT = `${import.meta.env.BASE_URL}imagery-thumbnails`;
const THUMBNAIL_SIZE_PX = 64;

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
  setButtonPreview(button, selectedId);

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
        setButtonPreview(button, option.id);
      });
      // Decorative: the label text already names the choice.
      const thumbnail = document.createElement('img');
      thumbnail.src = thumbnailUrl(option.id);
      thumbnail.alt = '';
      thumbnail.width = THUMBNAIL_SIZE_PX;
      thumbnail.height = THUMBNAIL_SIZE_PX;
      thumbnail.draggable = false;
      thumbnail.className = THUMBNAIL_CLASS;
      const text = document.createElement('span');
      text.textContent = option.label;
      label.append(radio, thumbnail, text);
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

function thumbnailUrl(id: SceneImageryId): string {
  return `${THUMBNAIL_ROOT}/${id}.jpg`;
}

/** The button wears the current imagery's preview, and its tooltip names it. */
function setButtonPreview(button: HTMLButtonElement, id: SceneImageryId): void {
  const preview = button.querySelector('img');
  if (preview) preview.src = thumbnailUrl(id);
  button.title = `Imagery: ${sceneImageryOption(id).label}`;
}

function setSceneNote(imageryId: SceneImageryId): void {
  const note = document.getElementById('scene-note');
  if (!note) return;
  note.textContent = `Imagery: ${sceneImageryCredit(imageryId)}. Terrain: USGS 3DEP, with Esri World Elevation beyond the creek.`;
}
