// Development-only corner button that opens and closes the dev tools HUD.
// Mounted by creek-experience-main.ts when `import.meta.env.DEV` is true, in
// both the observed and the modeled experiences. Vite replaces that flag with
// `false` in production builds, so this module is never bundled there. The
// yellow ring tracks clicks from the moment the toggle mounts, including
// clicks made while the panel is closed. The HUD panel itself is imported the
// first time it is opened. The open state is remembered in localStorage;
// `?devtools` still opens the HUD on load.

import type SceneView from '@arcgis/core/views/SceneView';
import type { CreekVisualizationAttachment } from './creek-visualization-library-interface';
import { createDevToolsClickMarker } from './dev-tools-click-marker';
import type { DevToolsHudHandle } from './dev-tools-hud';

const DEV_TOOLS_OPEN_STORAGE_KEY = 'tnc-dev-tools-open';

interface DevToolsToggleOptions {
  view: SceneView;
  attachment: CreekVisualizationAttachment;
  container: HTMLElement;
  /** Open the HUD on mount regardless of the remembered state (`?devtools`). */
  openOnLoad: boolean;
}

export function installDevToolsToggle(options: DevToolsToggleOptions): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'dev-tools-toggle';
  button.setAttribute('aria-controls', 'dev-tools-hud');
  button.setAttribute('aria-expanded', 'false');
  button.className = [
    'pointer-events-auto',
    'absolute',
    'right-4',
    'top-4',
    'z-30',
    'flex',
    'cursor-pointer',
    'items-center',
    'gap-1.5',
    'rounded-full',
    'border',
    'border-slate-600/80',
    'bg-slate-900/85',
    'px-3',
    'py-1.5',
    'text-[11px]',
    'font-semibold',
    'uppercase',
    'tracking-wide',
    'text-slate-200',
    'shadow-lg',
    'shadow-black/40',
    'backdrop-blur',
    'transition-colors',
    'hover:bg-slate-800',
    'hover:text-cyan-100',
    'focus-visible:outline',
    'focus-visible:outline-2',
    'focus-visible:outline-offset-2',
    'focus-visible:outline-cyan-300',
    'aria-expanded:border-cyan-400/70',
    'aria-expanded:bg-cyan-950/80',
    'aria-expanded:text-cyan-100',
  ].join(' ');

  const glyph = document.createElement('span');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.className = 'font-mono text-xs font-bold leading-none';
  glyph.textContent = '</>';
  const label = document.createElement('span');
  label.textContent = 'Dev tools';
  const chevron = document.createElement('span');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.className = 'text-[9px] leading-none';
  button.append(glyph, label, chevron);
  options.container.appendChild(button);

  let hud: DevToolsHudHandle | null = null;
  let open = false;
  let mounting: Promise<void> | null = null;
  // The latest click that landed before the HUD panel finished loading.
  let pendingScreen: { x: number; y: number } | null = null;
  const clickMarker = createDevToolsClickMarker(options.view);

  options.view.on('click', (event) => {
    clickMarker.noteClick(event.mapPoint);
    const screen = { x: event.x, y: event.y };
    if (hud) hud.captureScreenClick(screen);
    else pendingScreen = screen;
  });

  const render = (): void => {
    button.setAttribute('aria-expanded', String(open));
    button.title = open ? 'Hide dev tools' : 'Show dev tools';
    chevron.textContent = open ? '▴' : '▾';
  };

  const ensureHud = (): Promise<void> => {
    mounting ??= import('./dev-tools-hud').then(({ installDevToolsHud }) => {
      hud = installDevToolsHud({
        view: options.view,
        attachment: options.attachment,
        container: options.container,
        placement: 'below-dev-tools-toggle',
        clickMarker,
      });
      const queued = pendingScreen;
      pendingScreen = null;
      if (queued && hud) hud.captureScreenClick(queued);
    });
    return mounting;
  };

  const setOpen = async (next: boolean, remember: boolean): Promise<void> => {
    open = next;
    render();
    if (remember) saveOpenState(next);
    // The panel stays unloaded until the first open. Clicks before that are
    // already on the marker layer, and the queued screen point fills the readout.
    if (next) await ensureHud();
    if (hud) hud.setOpen(open);
    else clickMarker.setVisible(false);
  };

  button.addEventListener('click', () => {
    void setOpen(!open, true);
  });

  render();
  void setOpen(options.openOnLoad || readOpenState(), false);
}

function readOpenState(): boolean {
  try {
    return localStorage.getItem(DEV_TOOLS_OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveOpenState(open: boolean): void {
  try {
    localStorage.setItem(DEV_TOOLS_OPEN_STORAGE_KEY, String(open));
  } catch {
    // Storage can be blocked (private mode); the toggle still works for this session.
  }
}
