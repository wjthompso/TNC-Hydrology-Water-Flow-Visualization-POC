// The floating label button that hangs over a spot on the map: a rounded two-line pill in a
// color, a thin stem, and a dot at the spot, in a slate (creek) or warm brown (barrier) look. Used by the named creek pins
// (named-creek-navigation.ts) and the fish barrier pins (fish-barrier-pins.ts), so both read as
// one family. Position, fading, and click behavior belong to the caller; this only builds the
// element, and hands it back hidden.

const PIN_CLASS =
  'group pointer-events-auto absolute flex w-max -translate-x-1/2 -translate-y-full cursor-pointer flex-col items-center whitespace-nowrap rounded-full outline-none';
const PIN_LABEL_CLASS =
  'flex items-center gap-2 rounded-full border border-[color:var(--pin-color)] py-1 pl-2.5 pr-3.5 text-left shadow-lg shadow-black/50 backdrop-blur transition-colors group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-cyan-300';
/** Creek name pins: the slate of the sidebar. */
const PIN_LABEL_CREEK_CLASS = 'bg-slate-900/90 group-hover:bg-slate-800';
/** Fish barrier pins: a warm dark brown, so a barrier reads as a different kind of label at a glance. */
const PIN_LABEL_BARRIER_CLASS = 'bg-[#2b1a14]/90 group-hover:bg-[#3d2820]';
const PIN_STEM_CLASS = 'h-3 w-0.5 bg-[color:var(--pin-color)]';
const PIN_FOOT_CLASS = 'h-2.5 w-2.5 rounded-full bg-[color:var(--pin-color)] ring-2 ring-slate-900';
const PIN_PRIMARY_CLASS = 'text-sm font-semibold leading-tight text-slate-50';
const PIN_SECONDARY_CLASS = 'text-xs font-normal leading-tight tabular-nums text-slate-300';

export interface MapPinContent {
  /** `creek`: slate background. `barrier`: warm brown background. */
  variant: 'creek' | 'barrier';
  /** CSS color of the border, stem, dot, and icon. */
  color: string;
  /** Inline SVG for the left of the pill. Give it `text-[color:var(--pin-color)]` to take the pin's color. */
  iconSvg: string;
  /** First line, bold. */
  primary: string;
  /** Second line, smaller. */
  secondary: string;
  /** Spoken name and hover tip, e.g. "Zoom to Jalama Creek". */
  ariaLabel: string;
  /** Draw the dot at the foot of the stem. Default true. Off when the caller draws its own dot at the spot. */
  showFoot?: boolean;
}

export function createMapPinButton(content: MapPinContent): HTMLButtonElement {
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = PIN_CLASS;
  pin.style.setProperty('--pin-color', content.color);
  pin.setAttribute('aria-label', content.ariaLabel);
  pin.title = content.ariaLabel;

  const primary = document.createElement('span');
  primary.className = PIN_PRIMARY_CLASS;
  primary.textContent = content.primary;
  const secondary = document.createElement('span');
  secondary.className = PIN_SECONDARY_CLASS;
  secondary.textContent = content.secondary;
  const text = document.createElement('span');
  text.className = 'flex flex-col';
  text.append(primary, secondary);

  const label = document.createElement('span');
  label.className = `${PIN_LABEL_CLASS} ${content.variant === 'barrier' ? PIN_LABEL_BARRIER_CLASS : PIN_LABEL_CREEK_CLASS}`;
  label.insertAdjacentHTML('afterbegin', content.iconSvg);
  label.append(text);

  const stem = document.createElement('span');
  stem.className = PIN_STEM_CLASS;
  const foot = document.createElement('span');
  foot.className = PIN_FOOT_CLASS;

  pin.append(label, stem);
  if (content.showFoot !== false) pin.append(foot);
  // Hidden until the caller finds it a place on the screen.
  pin.classList.add('invisible');
  return pin;
}
