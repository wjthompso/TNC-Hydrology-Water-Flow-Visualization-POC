// The "more info" card for one fish barrier: what it is, what blocks fish and why, the catalog's own
// fields in a small table, the survey notes, how big the barrier is drawn and why, and the sources.
// Opens when a barrier's dot or label is clicked (fish-barrier-map.ts); one card at a time, and opening
// another barrier replaces it.
//
// The card is a column at the right edge, between the corner buttons and the legend, so it covers neither
// and leaves the middle of the map, where the camera puts the barrier, clear. Pins keep out of it
// (screen-box-layout.ts). It is not modal: the map stays live around it, and focus is never trapped. Escape or the close button
// closes it and returns focus to the dot or label that opened it.
//
// The card opens at once from the TNC catalog fields. The statewide database (fish-barrier-statewide.ts)
// adds the full survey notes and a few fields the catalog drops; when it answers, the open card fills
// them in, and when it never answers, the card says so.

import type { ExperienceLifetime } from './experience-lifetime';
import type { FishBarrierSite } from './fish-barrier-map';
import {
  STATEWIDE_PAD_INFO_URL,
  chooseSurveyNotes,
  chooseTreatmentRecommendation,
  type ChosenText,
  type StatewideBarrierDetails,
  type StatewideLookup,
} from './fish-barrier-statewide';
import {
  BARRIER_STATUS_CHIP_TEXT,
  FISH_BARRIER_LAYER_URL,
  barrierColorHex,
  barrierCreekName,
  type BarrierSiteDescription,
  type BarrierStatus,
} from './fish-barrier-sites';

/** The TNC Digital Catalog item that holds the barrier layer. */
const TNC_CATALOG_ITEM_URL = 'https://www.arcgis.com/home/item.html?id=c7530658353246e5ab7009014fb3e46f';
const NOT_RECORDED = 'Not recorded';
const CATALOG_NOTES_CUT_OFF_LENGTH = 255;

const CARD_CLASS =
  'scrollbar-autohide pointer-events-auto absolute right-3 top-28 z-20 hidden max-h-[calc(100vh-22rem)] w-80 overflow-y-auto rounded-lg border border-slate-700/80 bg-slate-900/90 p-4 text-sm leading-relaxed text-slate-200 shadow-xl outline-none backdrop-blur';
const SECTION_HEADING_CLASS = 'mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400';
const MUTED_CLASS = 'text-xs leading-relaxed text-slate-400';
const LINK_CLASS = 'text-cyan-300 underline underline-offset-2 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300';

const CHIP_CLASS_BY_STATE: Readonly<Record<BarrierStatus | 'no-longer-blocking', string>> = {
  Total: 'border-red-500/70 bg-red-600/25 text-red-100',
  Partial: 'border-amber-500/70 bg-amber-500/20 text-amber-100',
  Unknown: 'border-slate-400/70 bg-slate-500/25 text-slate-100',
  'no-longer-blocking': 'border-green-500/70 bg-green-600/25 text-green-100',
};

/** What each drawn size is called in the "how big" sentence, by field name of the barrier's shape. */
const DIMENSION_NAMES: Readonly<Record<string, string>> = {
  diameterM: 'pipe diameter',
  lengthM: 'length',
  perchM: 'drop up to the pipe',
  spanM: 'width across the creek',
  heightM: 'height',
  widthM: 'width',
};

export interface FishBarrierCard {
  /** Shows the card for `site`, replacing any open card. `trigger` gets focus back when the card is closed by the reader. */
  open(site: FishBarrierSite, trigger: HTMLElement): void;
  /** Takes the card off the page for good, without moving focus. Called when the barriers are hidden. */
  close(): void;
}

export function createFishBarrierCard(
  container: HTMLElement,
  statewide: Promise<StatewideLookup>,
  lifetime: ExperienceLifetime,
): FishBarrierCard {
  const card = document.createElement('section');
  card.id = 'fish-barrier-card';
  card.className = CARD_CLASS;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.tabIndex = -1;
  container.append(card);

  let current: { site: FishBarrierSite; trigger: HTMLElement } | null = null;
  let statewideLookup: StatewideLookup | 'pending' = 'pending';
  void statewide.then((lookup) => {
    statewideLookup = lookup;
    // The card may already be open on the TNC copy; fill in the statewide fields.
    if (current) render(current.site);
  });

  const render = (site: FishBarrierSite): void => {
    card.replaceChildren(...buildCardContent(site, statewideLookup, dismiss));
    card.setAttribute('aria-labelledby', 'fish-barrier-card-title');
  };

  const hide = (): void => {
    current = null;
    card.classList.add('hidden');
    card.replaceChildren();
  };
  // Each time the barriers are drawn they get a new card; this ends the old one's Escape listener with it.
  const removal = new AbortController();
  const remove = (): void => {
    hide();
    removal.abort();
    card.remove();
  };

  /** The reader closed the card: hand focus back to what opened it, unless focus already went elsewhere. */
  function dismiss(): void {
    const trigger = current?.trigger;
    const focusWasInCard = card.contains(document.activeElement) || document.activeElement === document.body;
    hide();
    if (focusWasInCard && trigger?.isConnected) trigger.focus();
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && current) dismiss();
    },
    { signal: removal.signal },
  );
  lifetime.onEnd(remove);

  return {
    open(site, trigger) {
      current = { site, trigger };
      render(site);
      card.classList.remove('hidden');
      card.scrollTop = 0;
      // Moves a keyboard reader into the card; the card itself takes focus, not a control inside it.
      card.focus({ preventScroll: true });
    },
    close: remove,
  };
}

// --- Content ---------------------------------------------------------------------------------------

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(href: string, text: string): HTMLAnchorElement {
  const anchor = element('a', LINK_CLASS, text);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function buildCardContent(site: FishBarrierSite, lookup: StatewideLookup | 'pending', dismiss: () => void): HTMLElement[] {
  const { record, description } = site;
  const details = lookup === 'pending' || lookup === null || record.passageId === null ? undefined : lookup.get(record.passageId);
  const state = description.removal ? 'no-longer-blocking' : record.status;

  return [
    buildHeader(site, state, dismiss),
    ...buildWhatBlocks(description),
    ...buildFieldTable(site, lookup, details),
    ...buildNotes(site, lookup, details),
    ...buildDrawnSize(site),
    ...buildPosition(site),
    buildSources(),
  ];
}

function buildHeader(site: FishBarrierSite, state: BarrierStatus | 'no-longer-blocking', dismiss: () => void): HTMLElement {
  const { record, description } = site;
  const header = element('div', 'flex items-start justify-between gap-3');

  const titles = element('div', 'min-w-0');
  const title = element('h2', 'text-base font-semibold leading-tight text-slate-50', description.kindLabel);
  title.id = 'fish-barrier-card-title';
  const creek = element('p', 'text-slate-300', barrierCreekName(record));
  const chip = element('span', `mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${CHIP_CLASS_BY_STATE[state]}`);
  const swatch = element('span', 'h-2.5 w-2.5 rounded-full');
  swatch.style.backgroundColor = barrierColorHex(record, description);
  swatch.setAttribute('aria-hidden', 'true');
  chip.append(swatch, document.createTextNode(BARRIER_STATUS_CHIP_TEXT[state]));
  titles.append(title, creek, chip);
  if (description.removal) {
    titles.append(
      element('p', 'mt-2 text-green-200', description.removal.summary),
      element('p', MUTED_CLASS, `Source: ${description.removal.source}. The survey below was done before this.`),
    );
  }

  const close = element(
    'button',
    'shrink-0 rounded-md p-1 text-slate-300 hover:bg-slate-700/60 hover:text-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300',
  );
  close.type = 'button';
  close.setAttribute('aria-label', 'Close barrier details');
  close.insertAdjacentHTML(
    'afterbegin',
    '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
  );
  close.addEventListener('click', dismiss);

  header.append(titles, close);
  return header;
}

function buildWhatBlocks(description: BarrierSiteDescription): HTMLElement[] {
  const nodes: HTMLElement[] = [element('h3', SECTION_HEADING_CLASS, 'What blocks fish'), element('p', 'mt-1', description.whatBlocksFish)];
  if (description.catalogCorrection) nodes.push(element('p', `mt-1 ${MUTED_CLASS}`, `Catalog correction: ${description.catalogCorrection}`));
  if (description.plainTerms.length > 0) {
    const terms = element('dl', `mt-1 ${MUTED_CLASS}`);
    for (const { term, meaning } of description.plainTerms) {
      const entry = element('div', '');
      entry.append(element('dt', 'inline font-semibold text-slate-300', `${term}: `), element('dd', 'inline', meaning));
      terms.append(entry);
    }
    nodes.push(terms);
  }
  return nodes;
}

function buildFieldTable(site: FishBarrierSite, lookup: StatewideLookup | 'pending', details: StatewideBarrierDetails | undefined): HTMLElement[] {
  const { record } = site;
  const statewideValue = (read: (value: StatewideBarrierDetails) => string): string => {
    if (lookup === 'pending') return 'Loading…';
    if (details === undefined) return lookup === null ? 'Statewide database not reachable' : NOT_RECORDED;
    return read(details) || NOT_RECORDED;
  };
  const treatment = chooseTreatmentRecommendation(record, details);

  const rows: [string, string][] = [
    ['Site name', record.siteName],
    ['Type', record.siteType],
    ['Passage status', record.status === 'Unknown' ? 'Unknown (visited, no conclusive passage information)' : record.status],
    ['Species blocked', record.speciesBlocked],
    ['Survey year', record.surveyYear],
    ['Surveyed by', record.assessedBy],
    ['Protocol', record.protocol],
    ['Land owner', record.landOwner],
    ['Structure owner (statewide)', statewideValue((value) => value.structureOwner)],
    ['Treatment recommended', treatment.text + (treatment.source === 'statewide' ? ' (statewide, full text)' : '')],
    ['Treatment status (statewide)', statewideValue((value) => value.treatmentStatus)],
  ];
  if (details?.milesUpstream != null) rows.push(['Habitat upstream (statewide)', `${details.milesUpstream} miles`]);
  rows.push(['PAD ID / Passage ID', `${record.padId ?? NOT_RECORDED} / ${record.passageId ?? NOT_RECORDED}`]);

  const table = element('dl', 'mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs');
  for (const [label, value] of rows) {
    table.append(element('dt', 'text-slate-400', label), element('dd', 'min-w-0 break-words text-slate-100', value || NOT_RECORDED));
  }
  return [element('h3', SECTION_HEADING_CLASS, 'What the catalog records'), table];
}

function notesSourceLabel(chosen: ChosenText, lookup: StatewideLookup | 'pending'): string {
  switch (chosen.source) {
    case 'statewide':
      return '(statewide database, full text)';
    case 'tnc-newer-survey':
      return '(TNC catalog copy, from a newer 2012 survey than the statewide database)';
    case 'tnc':
      if (lookup === 'pending') return '(TNC catalog copy; checking the statewide database for the full text)';
      if (lookup === null && chosen.text.length >= CATALOG_NOTES_CUT_OFF_LENGTH) {
        return '(TNC catalog copy, cut off at 255 characters; the statewide database could not be reached for the full text)';
      }
      return '(TNC catalog copy)';
  }
}

function buildNotes(site: FishBarrierSite, lookup: StatewideLookup | 'pending', details: StatewideBarrierDetails | undefined): HTMLElement[] {
  const notes = chooseSurveyNotes(site.record, details);
  return [
    element('h3', SECTION_HEADING_CLASS, 'Survey notes'),
    element('p', 'mt-1', notes.text || 'The survey recorded no notes for this site.'),
    element('p', MUTED_CLASS, notes.text ? notesSourceLabel(notes, lookup) : ''),
  ];
}

function buildDrawnSize(site: FishBarrierSite): HTMLElement[] {
  const { description, record } = site;
  const assumed = description.assumedDimensions.map((name) => DIMENSION_NAMES[name] ?? name);
  const nodes: HTMLElement[] = [
    element('h3', SECTION_HEADING_CLASS, 'How big it is drawn'),
    element('p', 'mt-1', description.sizeBasis),
    element(
      'p',
      MUTED_CLASS,
      assumed.length > 0
        ? `Assumed, not surveyed: ${assumed.join(', ')}. The catalog has no measurements for most barriers; sizes marked assumed are typical values, not surveyed.`
        : 'Every drawn size comes from a documented source.',
    ),
  ];
  if (record.status === 'Unknown' && !description.removal) {
    nodes.push(element('p', MUTED_CLASS, 'Drawn gray and see-through with a ? because the survey did not decide whether fish can pass.'));
  }
  return nodes;
}

function buildPosition(site: FishBarrierSite): HTMLElement[] {
  const snap = site.channelSnap;
  const text =
    snap.kind === 'channel'
      ? `Drawn ${Math.abs(snap.lateralOffsetM).toFixed(0)} m ${snap.lateralOffsetM < 0 ? 'left' : 'right'} of the catalog point, in the creek channel the 3D scene draws (the catalog puts every barrier on a map line that can sit beside the channel).`
      : `Drawn on the catalog point itself: ${snap.reason}.`;
  const direction = site.creekDirection;
  const directionText =
    direction.bearingDegrees === null
      ? `Not turned to the creek: ${direction.detail}.`
      : `Turned so it lies ${site.description.shape.kind === 'culvert' ? 'along' : 'across'} the creek: the creek runs toward ${Math.round(direction.bearingDegrees)}° here, ${direction.detail}.`;
  return [element('h3', SECTION_HEADING_CLASS, 'Position'), element('p', 'mt-1', text), element('p', 'mt-1', directionText)];
}

function buildSources(): HTMLElement {
  const footer = element('p', `mt-3 border-t border-slate-700 pt-2 ${MUTED_CLASS}`);
  footer.append(
    'Sources: ',
    link(TNC_CATALOG_ITEM_URL, 'TNC Digital Catalog, Fish Passage Barriers Assessment'),
    ' (a subset of the California Passage Assessment Database, layer ',
    link(FISH_BARRIER_LAYER_URL, 'service'),
    '); ',
    link(STATEWIDE_PAD_INFO_URL, 'CDFW Passage Assessment Database'),
    ' for the full text.',
  );
  return footer;
}
