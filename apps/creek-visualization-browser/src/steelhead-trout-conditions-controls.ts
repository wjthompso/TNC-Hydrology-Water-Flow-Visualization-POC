// Sidebar controls for steelhead trout conditions (UCS-293): an on/off checkbox
// and a life-stage choice (Eggs, Juveniles, Adults). They also write the
// sidebar's range key and the map legend. The choice outlives a Dataset switch,
// like the water-level unit does, because the page keeps these elements while
// each Dataset's experience is rebuilt.

import type { ExperienceLifetime } from './experience-lifetime';
import {
  formatSteelheadSeason,
  REVIEW_CAVEAT,
  STEELHEAD_CONDITION_DISPLAY,
  STEELHEAD_LIFE_STAGE_RULES,
  STEELHEAD_LIFE_STAGES,
  type SteelheadDepthClass,
  type SteelheadLifeStage,
} from './steelhead-trout-conditions';

export interface SteelheadTroutConditionsState {
  readonly enabled: boolean;
  readonly lifeStage: SteelheadLifeStage;
}

export interface SteelheadTroutConditionsControls {
  readonly state: SteelheadTroutConditionsState;
  /** Calls the listener after the switch or life stage changes; ends with the lifetime. */
  onChange(listener: () => void): void;
  /** One line under the controls about the selected segment, such as why it has no chart bands. Empty clears it. */
  setSegmentNote(text: string): void;
}

const DEPTH_CLASSES: readonly SteelheadDepthClass[] = ['suitable', 'marginal', 'unsuitable'];

/** Tailwind swatch classes per condition; written out in full so Tailwind keeps them. */
const SWATCH_CLASS: Record<SteelheadDepthClass | 'out-of-season', string> = {
  suitable: 'bg-green-500',
  marginal: 'bg-yellow-400',
  unsuitable: 'bg-red-600',
  'out-of-season': 'bg-slate-500',
};

const NOT_RATED_LEGEND_TEXT = 'Standard blue: not rated (no bed elevation for this segment, or no depth band)';

let shared: { enabled: boolean; lifeStage: SteelheadLifeStage } = { enabled: false, lifeStage: 'adults' };

function byId<T extends HTMLElement>(id: string, type: new () => T): T | null {
  const element = document.getElementById(id);
  return element instanceof type ? element : null;
}

export function bindSteelheadTroutConditionsControls(lifetime: ExperienceLifetime): SteelheadTroutConditionsControls {
  const toggle = byId('trout-conditions-toggle', HTMLInputElement);
  const stageButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-steelhead-life-stage]')];
  const details = document.getElementById('trout-conditions-details');
  const seasonLine = document.getElementById('trout-conditions-season');
  const rangesList = document.getElementById('trout-conditions-ranges');
  const noBandLine = document.getElementById('trout-conditions-no-band');
  const segmentNote = document.getElementById('trout-conditions-segment-note');
  const caveat = document.getElementById('trout-conditions-caveat');
  if (caveat) caveat.textContent = REVIEW_CAVEAT;
  const basisList = document.getElementById('trout-conditions-basis');
  const sourceRows = document.getElementById('legend-source-rows');
  const legendBlock = document.getElementById('legend-trout-block');
  const legendTitle = document.getElementById('legend-trout-title');
  const legendRows = document.getElementById('legend-trout-rows');
  const listeners: (() => void)[] = [];
  lifetime.onEnd(() => (listeners.length = 0));

  const renderRows = (): void => {
    const rule = STEELHEAD_LIFE_STAGE_RULES[shared.lifeStage];
    const band = rule.depthBand;
    details?.classList.toggle('hidden', !shared.enabled);
    legendBlock?.classList.toggle('hidden', !shared.enabled);
    sourceRows?.classList.toggle('hidden', shared.enabled);
    for (const button of stageButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.steelheadLifeStage === shared.lifeStage));
      button.disabled = !shared.enabled;
    }
    if (toggle) toggle.checked = shared.enabled;
    if (!shared.enabled) return;

    if (seasonLine) seasonLine.textContent = `${rule.label}: ${rule.seasonText}`;
    noBandLine?.classList.toggle('hidden', band !== null);
    if (noBandLine) noBandLine.textContent = rule.noDepthBandText ?? '';
    rangesList?.classList.toggle('hidden', band === null);
    rangesList?.replaceChildren(
      ...(band ? DEPTH_CLASSES.map((condition) => rangeRow(condition, band.rangeText[condition])) : []),
    );
    basisList?.replaceChildren(...(band ? band.basis : [rule.noDepthBandText ?? '']).map(listItem));

    if (legendTitle) legendTitle.textContent = `Trout conditions · ${rule.label}`;
    legendRows?.replaceChildren(
      ...(band
        ? DEPTH_CLASSES.map((condition) => legendRow(condition, STEELHEAD_CONDITION_DISPLAY[condition].label, band.legendText[condition]))
        : []),
      ...(rule.seasonMonths
        ? [legendRow('out-of-season', 'Out of season', `${rule.label} are in the creek ${formatSteelheadSeason(shared.lifeStage)}`)]
        : []),
      notRatedRow(),
    );
  };

  const changed = (): void => {
    renderRows();
    for (const listener of listeners) listener();
  };

  toggle?.addEventListener('change', () => {
    shared = { ...shared, enabled: toggle.checked };
    changed();
  }, { signal: lifetime.signal });
  for (const button of stageButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.steelheadLifeStage;
      if (!isLifeStage(next) || next === shared.lifeStage) return;
      shared = { ...shared, lifeStage: next };
      changed();
    }, { signal: lifetime.signal });
  }
  renderRows();

  return {
    get state() {
      return shared;
    },
    onChange: (listener) => {
      listeners.push(listener);
    },
    setSegmentNote(text) {
      if (!segmentNote) return;
      segmentNote.textContent = text;
      segmentNote.classList.toggle('hidden', text === '');
    },
  };
}

function isLifeStage(value: unknown): value is SteelheadLifeStage {
  return STEELHEAD_LIFE_STAGES.includes(value as SteelheadLifeStage);
}

function swatch(condition: SteelheadDepthClass | 'out-of-season'): HTMLElement {
  const element = document.createElement('span');
  element.className = `inline-block h-3 w-6 shrink-0 rounded-sm ${SWATCH_CLASS[condition]}`;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function rangeRow(condition: SteelheadDepthClass, text: string): HTMLElement {
  const row = document.createElement('li');
  row.className = 'flex items-start gap-2';
  const label = document.createElement('span');
  const display = STEELHEAD_CONDITION_DISPLAY[condition];
  const strong = document.createElement('span');
  strong.className = 'font-medium text-slate-100';
  strong.textContent = `${display.glyph} ${display.label}. `;
  label.append(strong, text);
  const swatchWrapper = swatch(condition);
  swatchWrapper.classList.add('mt-1');
  row.append(swatchWrapper, label);
  return row;
}

function legendRow(condition: SteelheadDepthClass | 'out-of-season', name: string, detail: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'mt-1.5 flex items-center gap-2 text-xs leading-relaxed text-slate-300';
  const glyph = STEELHEAD_CONDITION_DISPLAY[condition].glyph;
  const text = document.createElement('span');
  text.textContent = `${glyph} ${name}: ${detail}`;
  row.append(swatch(condition), text);
  return row;
}

function notRatedRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'mt-1.5 flex items-center gap-2 text-xs leading-relaxed text-slate-300';
  const chip = document.createElement('span');
  chip.className = 'inline-block h-3 w-6 shrink-0 rounded-sm bg-[#1d9bf0]';
  chip.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = NOT_RATED_LEGEND_TEXT;
  row.append(chip, text);
  return row;
}

function listItem(text: string): HTMLElement {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}
