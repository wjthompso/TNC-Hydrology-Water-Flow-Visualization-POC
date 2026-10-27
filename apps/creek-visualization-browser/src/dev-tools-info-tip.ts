// Dev tools "(i)" info tips: a small keyboard-focusable "i" button per metric, and ONE shared
// popover that shows the metric's explanation while the button is hovered or focused.
//
// The left control panel's `.info-tip-*` classes (style.css) place a CSS-only bubble next to its
// button. That cannot work here: the HUD scrolls, so a bubble inside a row is clipped at the
// scroll area's edges, and its slate colors do not read on Flight's light-blue glass. So the
// popover is a child of the HUD root (which does not scroll) and is placed by measuring the button.
//
// Accessibility: each button points `aria-describedby` at a screen-reader-only copy of the text in
// its own wrapper, so the explanation is read on focus. The popover is `aria-hidden`, a visual copy.
// It stays open while the pointer moves from the button onto it (WCAG 1.4.13: hoverable,
// dismissible with Escape, persistent until the pointer or focus leaves).

/** Which idea a metric belongs to (model truth, what we draw, browser terrain, or measured lidar ground); shown as a tag above the explanation. */
export type InfoTipSource = 'model' | 'drawn' | 'browser-terrain' | 'lidar-ground';

export const INFO_TIP_SOURCE_LABELS: Record<InfoTipSource, string> = {
  model: 'Model truth · from the pipeline’s Time Series and saved polygons',
  drawn: 'What we draw · after the visibility boost',
  'browser-terrain': 'Browser terrain · what the 3D scene’s ground does',
  'lidar-ground': 'Measured ground (1 m lidar) · read from the pipeline’s local terrain tiles, dev server only',
};

export interface InfoTipOptions {
  /** The metric's name, used in the button's accessible name. */
  subject: string;
  /** One to three short plain-English sentences. */
  text: string;
  source?: InfoTipSource | null;
  /** Lets a caller that redraws its rows find this tip again, so keyboard focus survives the redraw. */
  focusKey?: string;
}

export interface DevToolsInfoTips {
  /** A new "(i)" button with its screen-reader description; append it next to the label it explains. */
  create(options: InfoTipOptions): HTMLElement;
  /** Closes the popover (call before the rows that hold its button are replaced). */
  hide(): void;
}

const POPOVER_MARGIN_PX = 8;
const POPOVER_GAP_PX = 6;
const HIDE_DELAY_MS = 150;

const BUTTON_CLASSES = [
  'inline-flex',
  'size-4',
  'shrink-0',
  'cursor-help',
  'items-center',
  'justify-center',
  'rounded-full',
  'border',
  'border-hud-label',
  'font-sans',
  'text-[10px]',
  'font-bold',
  'normal-case',
  'leading-none',
  'tracking-normal',
  'text-hud-label',
  'hover:border-hud-ink',
  'hover:text-hud-ink',
  'focus-visible:outline',
  'focus-visible:outline-2',
  'focus-visible:outline-offset-1',
  'focus-visible:outline-hud-focus',
];

/** Dark slate on both HUD styles: light text reads on Flight's light blue, and it matches the left panel's bubble. */
const POPOVER_CLASSES = [
  'absolute',
  'z-30',
  'hidden',
  'max-h-[70%]',
  'overflow-y-auto',
  'rounded-md',
  'border',
  'border-slate-500',
  'bg-slate-800',
  'px-3',
  'py-2',
  'font-sans',
  'text-xs',
  'font-normal',
  'normal-case',
  'leading-snug',
  'tracking-normal',
  'text-slate-100',
  'shadow-xl',
];

const SOURCE_TAG_CLASSES = ['mb-1', 'text-[10px]', 'font-bold', 'uppercase', 'tracking-wide', 'text-cyan-300'];

/** `host` is the HUD root: positioned, not scrolling, and the element whose edges bound the popover. */
export function createDevToolsInfoTips(host: HTMLElement): DevToolsInfoTips {
  const popover = document.createElement('div');
  popover.className = POPOVER_CLASSES.join(' ');
  popover.setAttribute('aria-hidden', 'true');
  host.appendChild(popover);

  let activeButton: HTMLElement | null = null;
  let hideTimer: number | undefined;
  let nextId = 1;

  const cancelHide = (): void => {
    window.clearTimeout(hideTimer);
  };
  const hide = (): void => {
    cancelHide();
    activeButton = null;
    popover.classList.add('hidden');
  };
  const hideSoon = (): void => {
    cancelHide();
    hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
  };

  /** Full width of the HUD (so the right edge never clips it), below the button, or above it when there is no room. */
  const place = (button: HTMLElement): void => {
    const hostBox = host.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    popover.style.left = `${POPOVER_MARGIN_PX}px`;
    popover.style.width = `${host.clientWidth - 2 * POPOVER_MARGIN_PX}px`;
    const height = popover.offsetHeight;
    const buttonTop = buttonBox.top - hostBox.top - host.clientTop;
    const buttonBottom = buttonBox.bottom - hostBox.top - host.clientTop;
    let top = buttonBottom + POPOVER_GAP_PX;
    if (top + height > host.clientHeight - POPOVER_MARGIN_PX) top = buttonTop - POPOVER_GAP_PX - height;
    const lowest = host.clientHeight - POPOVER_MARGIN_PX - height;
    popover.style.top = `${Math.max(POPOVER_MARGIN_PX, Math.min(top, lowest))}px`;
  };

  const show = (button: HTMLElement, text: string, source: InfoTipSource | null): void => {
    cancelHide();
    activeButton = button;
    const children: HTMLElement[] = [];
    if (source) {
      const tag = document.createElement('p');
      tag.className = SOURCE_TAG_CLASSES.join(' ');
      tag.textContent = INFO_TIP_SOURCE_LABELS[source];
      children.push(tag);
    }
    const body = document.createElement('p');
    body.textContent = text;
    children.push(body);
    popover.replaceChildren(...children);
    popover.classList.remove('hidden');
    place(button);
  };

  popover.addEventListener('mouseenter', cancelHide);
  popover.addEventListener('mouseleave', hideSoon);
  // The rows scroll under a popover that does not (focusing a button also scrolls it into view), so follow the
  // button, and close once it has scrolled out of the HUD.
  host.addEventListener(
    'scroll',
    () => {
      if (!activeButton) return;
      const hostBox = host.getBoundingClientRect();
      const buttonBox = activeButton.getBoundingClientRect();
      if (buttonBox.bottom < hostBox.top || buttonBox.top > hostBox.bottom) hide();
      else place(activeButton);
    },
    true,
  );
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeButton) hide();
  });

  return {
    hide,
    create({ subject, text, source = null, focusKey }) {
      const description = document.createElement('span');
      description.id = `dev-tools-info-tip-${nextId}`;
      nextId += 1;
      description.className = 'sr-only';
      description.setAttribute('role', 'tooltip');
      description.textContent = `${source ? `${INFO_TIP_SOURCE_LABELS[source]}. ` : ''}${text}`;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = BUTTON_CLASSES.join(' ');
      button.textContent = 'i';
      button.setAttribute('aria-label', `What “${subject}” means`);
      button.setAttribute('aria-describedby', description.id);
      if (focusKey) button.dataset.infoTipFocusKey = focusKey;
      const open = (): void => show(button, text, source);
      button.addEventListener('mouseenter', open);
      button.addEventListener('mouseleave', hideSoon);
      button.addEventListener('focus', open);
      button.addEventListener('blur', hide);

      const wrapper = document.createElement('span');
      wrapper.className = 'ml-1 inline-flex align-middle';
      wrapper.append(button, description);
      return wrapper;
    },
  };
}
