/** Playback speeds in menu order, top to bottom. 1× is one slot per 100 ms. */
export const PLAYBACK_SPEEDS = [0.1, 0.2, 0.5, 1, 2, 5, 10] as const;

export const DEFAULT_PLAYBACK_SPEED = 1;

/** The button that shows the current speed and the listbox it opens. */
export interface PlaybackSpeedMenuElements {
  button: HTMLButtonElement;
  menu: HTMLElement;
}

const OPTION_CLASS =
  'flex cursor-pointer items-center gap-2 py-1.5 pl-3 pr-2 text-slate-100 hover:bg-slate-800 focus-visible:bg-slate-800 focus-visible:outline-none';

function speedLabel(speed: number): string {
  return `${speed}×`;
}

function createOption(speed: number): HTMLLIElement {
  const option = document.createElement('li');
  option.setAttribute('role', 'option');
  option.tabIndex = -1;
  option.className = OPTION_CLASS;
  option.dataset.speed = String(speed);
  // The visible "0.2×" and the check mark are not a good spoken name, so the name is spelled out.
  option.setAttribute('aria-label', `${speed} times speed`);

  const label = document.createElement('span');
  label.textContent = speedLabel(speed);
  // A fixed-width slot, filled only on the current option, keeps the labels from shifting.
  const check = document.createElement('span');
  check.className = 'w-3 text-cyan-300';
  check.setAttribute('aria-hidden', 'true');
  option.append(label, check);
  return option;
}

/**
 * Wires the speed button to its listbox. The button shows the current speed.
 * The menu lists every speed, marks the current one with aria-selected and a check mark,
 * and closes after a pick, a click outside, or Escape. Arrow keys, Home, End,
 * Enter, and Space operate it. Ending `signal` removes every listener.
 */
export function bindPlaybackSpeedMenu(
  elements: PlaybackSpeedMenuElements,
  initialSpeed: number,
  onSpeedChosen: (speed: number) => void,
  signal: AbortSignal,
): void {
  const { button, menu } = elements;
  const listening = { signal };
  const options = PLAYBACK_SPEEDS.map(createOption);
  let currentSpeed = initialSpeed;

  menu.replaceChildren(...options);
  button.setAttribute('aria-haspopup', 'listbox');

  const optionSpeed = (option: HTMLElement): number => Number(option.dataset.speed);
  const isOpen = (): boolean => !menu.hidden;

  const drawCurrentSpeed = (): void => {
    button.textContent = speedLabel(currentSpeed);
    for (const option of options) {
      const current = optionSpeed(option) === currentSpeed;
      option.setAttribute('aria-selected', current ? 'true' : 'false');
      const check = option.lastElementChild;
      if (check) check.textContent = current ? '✓' : '';
    }
  };

  const focusOption = (index: number): void => {
    options[Math.max(0, Math.min(options.length - 1, index))]?.focus();
  };

  const open = (): void => {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    focusOption(PLAYBACK_SPEEDS.indexOf(currentSpeed as (typeof PLAYBACK_SPEEDS)[number]));
  };

  const close = (returnFocusToButton: boolean): void => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocusToButton) button.focus();
  };

  const choose = (speed: number): void => {
    currentSpeed = speed;
    drawCurrentSpeed();
    close(true);
    onSpeedChosen(speed);
  };

  button.addEventListener('click', () => (isOpen() ? close(false) : open()), listening);

  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!isOpen()) open();
  }, listening);

  menu.addEventListener('click', (event) => {
    const option = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="option"]') : null;
    if (option) choose(optionSpeed(option));
  }, listening);

  menu.addEventListener('keydown', (event) => {
    const focusedIndex = options.findIndex((option) => option === document.activeElement);
    switch (event.key) {
      case 'ArrowDown':
        focusOption(focusedIndex + 1);
        break;
      case 'ArrowUp':
        focusOption(focusedIndex - 1);
        break;
      case 'Home':
        focusOption(0);
        break;
      case 'End':
        focusOption(options.length - 1);
        break;
      case 'Enter':
      case ' ': {
        const focused = options[focusedIndex];
        if (focused) choose(optionSpeed(focused));
        break;
      }
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  }, listening);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) close(true);
  }, listening);

  document.addEventListener('click', (event) => {
    if (!isOpen() || !(event.target instanceof Node)) return;
    if (!menu.contains(event.target) && !button.contains(event.target)) close(false);
  }, listening);

  drawCurrentSpeed();
}
