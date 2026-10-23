// Description of the selected modeled Dataset, all inside one collapsed
// "Details and derivation" disclosure so the sidebar stays short. Opened, it
// shows a plain-language summary with links to the Publisher, a plain-language
// note on Drainage-Area Ratio Transfer water, then the compact catalog facts
// and the Time Series Derivation.

import {
  DRAINAGE_AREA_RATIO_TRANSFER_EXPLANATION,
  DRAINAGE_AREA_RATIO_TRANSFER_EXPLANATION_HEADING,
} from './drainage-area-ratio-transfer-labels';
import type { DerivationParameter, SelectedModeledDataset } from './modeled-water-catalog';

const SUMMARY_CLASS = 'space-y-2 pb-2 text-sm leading-snug text-slate-300';
const LINK_CLASS =
  'text-cyan-300 underline decoration-cyan-300/50 underline-offset-2 hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300';
const BODY_CLASS =
  'space-y-2 border-t border-slate-700 px-2 pb-2 pt-2 text-sm leading-snug text-slate-300';
const HEADING_CLASS = 'text-xs font-semibold uppercase tracking-wide text-slate-400';
const LIST_CLASS = 'mt-0.5 list-outside space-y-0.5 pl-4';

interface SourceLink {
  label: string;
  url: string;
}

interface DatasetSummary {
  /** Two or three plain-language sentences about the Dataset. */
  summary: string;
  sources: readonly SourceLink[];
}

/** Keyed by catalog datasetId. Written for a reader who is not a hydrologist. */
const DATASET_SUMMARIES: Readonly<Record<string, DatasetSummary>> = {
  'california-natural-flows-monthly': {
    summary:
      'California Natural Flows estimates the average flow each stream in California would carry every month if people did not divert or store water. It is a statistical model that learns from gauged streams and gives one flow per stream reach, not a water level. The water heights shown here were derived from those flows by the UCSB Spatial Center and have not been checked against measurements on this creek.',
    sources: [
      { label: 'California Natural Flows', url: 'https://rivers.codefornature.org/' },
      { label: 'API docs', url: 'https://flow-api.codefornature.org/' },
    ],
  },
  'national-water-model-hourly': {
    summary:
      'The NOAA National Water Model is a nationwide computer simulation of rivers and streams driven by weather data. Its retrospective run gives an hourly flow for every stream reach but is not corrected to local gauges, so the timing of rises and falls is more trustworthy than the size of the flow. The water heights shown here were derived from those flows by the UCSB Spatial Center.',
    sources: [{ label: 'NOAA National Water Model retrospective', url: 'https://registry.opendata.aws/nwm-archive/' }],
  },
};

export function renderModeledDatasetInfoPanel(
  container: HTMLElement,
  selected: SelectedModeledDataset,
): void {
  container.replaceChildren(detailsBlock(selected));
}

/** Plain-language summary, source links, and the borrowed-flow note. Sits at the top of the details. */
function summaryBlock(selected: SelectedModeledDataset): HTMLElement {
  const block = element('div', SUMMARY_CLASS);
  block.id = 'modeled-dataset-summary';
  const known = DATASET_SUMMARIES[selected.dataset.datasetId];
  const summary = element('p', 'text-slate-200');
  summary.textContent =
    known?.summary ??
    `${selected.publisher.name} publishes this ${selected.dataset.timeStep} modeled Dataset. The water heights shown here were derived from its flows by the UCSB Spatial Center.`;
  block.append(summary);

  if (known && known.sources.length > 0) {
    const sourceRow = element('p', '');
    const label = element('span', 'font-medium text-slate-200');
    label.textContent = 'Source: ';
    sourceRow.append(label);
    known.sources.forEach((source, index) => {
      if (index > 0) sourceRow.append(document.createTextNode(' · '));
      sourceRow.append(externalLink(source));
    });
    block.append(sourceRow);
  }

  const transferHeading = element('p', 'pt-1 font-medium text-slate-200');
  transferHeading.textContent = DRAINAGE_AREA_RATIO_TRANSFER_EXPLANATION_HEADING;
  const transferNote = element('p', '');
  transferNote.textContent = DRAINAGE_AREA_RATIO_TRANSFER_EXPLANATION;
  block.append(transferHeading, transferNote);
  return block;
}

/** Collapsed details: summary first, then catalog facts and the full Derivation. */
function detailsBlock(selected: SelectedModeledDataset): HTMLElement {
  const details = element('details', 'rounded-md border border-slate-700 bg-slate-950/60 text-sm');
  details.id = 'modeled-dataset-details';
  const summary = element(
    'summary',
    'cursor-pointer select-none px-2 py-1.5 font-medium text-slate-200 hover:text-cyan-100',
  );
  summary.textContent = 'Details and derivation';
  details.append(summary);

  const body = element('div', BODY_CLASS);
  body.append(summaryBlock(selected));

  const facts = element('div', 'space-y-1 border-t border-slate-800 pt-2');
  facts.append(
    factRow('Publisher', selected.publisher.name),
    factRow('Dataset', selected.dataset.datasetId),
    factRow('Time step', selected.dataset.timeStep),
    factRow('Accuracy', selected.dataset.accuracyNote ?? 'No accuracy note published.'),
  );
  body.append(facts);

  const derivation = selected.timeSeries.derivation;
  if (derivation) {
    const section = element('section', 'space-y-1.5 border-t border-slate-800 pt-1.5');
    section.append(heading('Derivation'));
    const lead = element('p', '');
    lead.textContent = [
      derivation.derivedFrom ? `Derived from ${derivation.derivedFrom}` : 'Derived',
      derivation.derivedBy ? ` by ${derivation.derivedBy}` : '',
      '.',
    ].join('');
    section.append(lead);
    if (derivation.method) {
      const method = element('p', 'text-slate-400');
      method.textContent = derivation.method;
      section.append(method);
    }
    if (derivation.inputs.length > 0) {
      section.append(
        heading('Inputs'),
        list('ul', derivation.inputs.map((input) => `${input.role}: ${input.source}`)),
      );
    }
    if (derivation.steps.length > 0) {
      section.append(heading('Steps'), list('ol', derivation.steps));
    }
    if (derivation.parameters.length > 0) {
      section.append(heading('Parameters'), parameterList(derivation.parameters));
    }
    if (derivation.assumptions.length > 0) {
      section.append(heading('Assumptions'), list('ul', derivation.assumptions));
    }
    if (derivation.sensitivity) {
      const sensitivity = element('p', '');
      sensitivity.textContent = derivation.sensitivity;
      section.append(heading('Sensitivity'), sensitivity);
    }
    body.append(section);
  }

  const counts = Object.entries(selected.timeSeries.counts);
  if (counts.length > 0) {
    body.append(
      heading('Counts'),
      list('ul', counts.map(([key, value]) => `${key}: ${value}`)),
    );
  }

  details.append(body);
  return details;
}

function externalLink(source: SourceLink): HTMLAnchorElement {
  const link = element('a', LINK_CLASS);
  link.href = source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = source.label;
  return link;
}

function parameterList(parameters: readonly DerivationParameter[]): HTMLElement {
  const items = element('ul', `${LIST_CLASS} list-disc`);
  for (const parameter of parameters) {
    const item = element('li', '');
    const valueText =
      parameter.value === null ? '' : `${parameter.value}${parameter.unit ? ` ${parameter.unit}` : ''}`;
    const rangeText = parameter.publishedRange
      ? ` (published ${parameter.publishedRange[0]}–${parameter.publishedRange[1]})`
      : '';
    const headline = element('span', 'text-slate-200');
    headline.textContent = `${parameter.name}: ${valueText}${rangeText}`;
    item.append(headline);
    if (parameter.basis) {
      const basis = element('span', 'block text-slate-400');
      basis.textContent = parameter.basis;
      item.append(basis);
    }
    items.append(item);
  }
  return items;
}

function factRow(label: string, value: string): HTMLElement {
  const row = element('p', '');
  const term = element('span', 'font-medium text-slate-200');
  term.textContent = `${label}: `;
  row.append(term, document.createTextNode(value));
  return row;
}

function heading(text: string): HTMLElement {
  const node = element('p', HEADING_CLASS);
  node.textContent = text;
  return node;
}

function list(tag: 'ul' | 'ol', entries: readonly string[]): HTMLElement {
  const node = element(tag, `${LIST_CLASS} ${tag === 'ol' ? 'list-decimal' : 'list-disc'}`);
  for (const entry of entries) {
    const item = element('li', '');
    item.textContent = entry;
    node.append(item);
  }
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
