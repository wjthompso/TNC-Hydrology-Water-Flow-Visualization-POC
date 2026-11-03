// Description of the selected modeled Dataset for the "About this data"
// dialog: a plain-language summary with links to the Publisher and a note on
// Drainage-Area Ratio Transfer water, then the compact catalog facts and the
// Time Series Derivation inside a collapsed "Technical details" disclosure.

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
  /** Two or three plain-language sentences about the flow data. */
  summary: string;
  /** Source name shown in parentheses after "Flow rate", e.g. "NOAA National Water Model v3.0 retrospective". */
  flowRateSourceName: string;
  /** What the flow-rate source is, in a sentence fragment; spells out any acronym on first use. */
  flowRateDescription: string;
  sources: readonly SourceLink[];
}

const ELEVATION_SOURCE_NAME = 'USGS 3DEP 1 m lidar';
const ELEVATION_DESCRIPTION =
  'an airborne laser survey of the ground, giving each creek segment its bed shape, cross-section, and slope. USGS is the U.S. Geological Survey; 3DEP is its 3D Elevation Program';

/** Numbered steps after the two inputs; identical for every modeled Dataset. */
const CALCULATION_STEPS: readonly string[] = [
  "Cut the preserve's creeks into short segments along The Nature Conservancy's creek lines.",
  "Scale each reach's flow rate by the segment's share of the drainage area.",
  "Build a flow-versus-water-level curve from each segment's lidar cross-section and slope using Manning's equation (an engineering formula that relates flow, channel shape, slope, and bed roughness; Manning, 1891; Chow, 1959). On steep creeks, roughness follows Jarrett's (1984) formula.",
  'Solve the curve for the water level that carries the scaled flow.',
];

const CALCULATION_LIMITS =
  'This is a simplified steady-flow estimate that ignores wood, bedrock steps, and culverts, and the lidar cannot see below the water line.';

const CALCULATION_REFERENCES: readonly { label: string; url?: string }[] = [
  {
    label: 'Chow, V.T. (1959). Open-Channel Hydraulics. McGraw-Hill.',
  },
  {
    label:
      'Manning, R. (1891). On the flow of water in open channels and pipes. Transactions of the Institution of Civil Engineers of Ireland, 20, 161–207.',
  },
  {
    label: 'Jarrett, R.D. (1984). Hydraulics of high-gradient streams. Journal of Hydraulic Engineering, 110(11), 1519–1539.',
    url: 'https://doi.org/10.1061/(ASCE)0733-9429(1984)110:11(1519)',
  },
];

/** Keyed by catalog datasetId. Written for a reader who is not a hydrologist. */
const DATASET_SUMMARIES: Readonly<Record<string, DatasetSummary>> = {
  'california-natural-flows-monthly': {
    summary:
      'California Natural Flows estimates the average flow each stream in California would carry every month if people did not divert or store water. It is a statistical model that learns from gauged streams and gives one flow per stream reach, not a water level. The water heights shown here were derived from those flows by the UCSB Spatial Center and have not been checked against measurements on this creek.',
    flowRateSourceName: 'California Natural Flows',
    flowRateDescription: 'a statistical model of the average monthly flow each California stream would carry without diversions or storage',
    sources: [
      { label: 'California Natural Flows', url: 'https://rivers.codefornature.org/' },
      { label: 'API docs', url: 'https://flow-api.codefornature.org/' },
    ],
  },
  'national-water-model-hourly': {
    summary:
      'The NOAA National Water Model is a nationwide computer simulation of rivers and streams driven by weather data. Its retrospective run gives an hourly flow for every stream reach but is not corrected to local gauges, so the timing of rises and falls is more trustworthy than the size of the flow. The water heights shown here were derived from those flows by the UCSB Spatial Center.',
    flowRateSourceName: 'NOAA National Water Model v3.0 retrospective',
    flowRateDescription:
      'an hourly computer simulation of flow for every stream reach in the US. NOAA is the National Oceanic and Atmospheric Administration',
    sources: [{ label: 'NOAA National Water Model retrospective', url: 'https://registry.opendata.aws/nwm-archive/' }],
  },
  'national-water-model-operational-hourly': {
    summary:
      'The NOAA National Water Model is a nationwide computer simulation of rivers and streams driven by weather data. Its operational run (the Analysis and Assimilation run) gives an hourly flow for every stream reach from September 2025 to October 2026, but is not corrected to local gauges, so the timing of rises and falls is more trustworthy than the size of the flow. The water heights shown here were derived from those flows by the UCSB Spatial Center.',
    flowRateSourceName: 'NOAA National Water Model operational Analysis and Assimilation run',
    flowRateDescription:
      'hourly flow estimates for every stream reach in the US. NOAA is the National Oceanic and Atmospheric Administration',
    sources: [{ label: 'NOAA National Water Model', url: 'https://www.nco.ncep.noaa.gov/pmb/products/nwm/' }],
  },
};

/**
 * The same content for the "About this data" dialog: the plain-language
 * summary open, the technical catalog facts and Derivation in a collapsed
 * "Technical details" disclosure.
 */
export function renderModeledDatasetAbout(container: HTMLElement, selected: SelectedModeledDataset): void {
  const details = detailsBlock(selected);
  const body = details.lastElementChild;
  const summary = body?.firstElementChild;
  if (!(body instanceof HTMLElement) || !(summary instanceof HTMLElement)) {
    container.replaceChildren(details);
    return;
  }
  summary.remove();
  summary.removeAttribute('id');
  summary.className = 'space-y-2 text-sm leading-relaxed text-slate-300';
  details.removeAttribute('id');
  details.className = 'mt-3 rounded-md border border-slate-700 bg-slate-950/60 text-xs';
  const label = details.querySelector('summary');
  if (label) label.textContent = 'Technical details';
  container.replaceChildren(summary, details);
}

/** Plain-language summary, source links, and the borrowed-flow note. Sits at the top of the details. */
function summaryBlock(selected: SelectedModeledDataset): HTMLElement {
  const block = element('div', SUMMARY_CLASS);
  block.id = 'modeled-dataset-summary';
  const known = DATASET_SUMMARIES[selected.dataset.datasetId];
  if (known) block.append(calculationBlock(known));

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

/** "How the water heights are calculated": the two inputs by name in parentheses, the shared steps, the limits, the references. */
function calculationBlock(known: DatasetSummary): HTMLElement {
  const block = element('div', 'space-y-1.5');
  block.append(heading('How the water heights are calculated'));
  block.append(
    paragraph('Water level = Manning\'s equation applied to two public data sources, split into creek segments:'),
    labeledList([
      { label: `Flow rate (${known.flowRateSourceName})`, text: known.flowRateDescription },
      { label: `Elevation (${ELEVATION_SOURCE_NAME})`, text: ELEVATION_DESCRIPTION },
    ]),
    list('ol', CALCULATION_STEPS),
    paragraph(CALCULATION_LIMITS),
    referencesBlock(),
  );
  return block;
}

function paragraph(text: string): HTMLElement {
  const node = element('p', '');
  node.textContent = text;
  return node;
}

function labeledList(entries: readonly { label: string; text: string }[]): HTMLElement {
  const node = element('ul', `${LIST_CLASS} list-disc`);
  for (const entry of entries) {
    const item = element('li', '');
    const label = element('span', 'font-medium text-slate-200');
    label.textContent = `${entry.label}: `;
    item.append(label, document.createTextNode(`${entry.text}.`));
    node.append(item);
  }
  return node;
}

function referencesBlock(): HTMLElement {
  const block = element('div', 'pt-1');
  block.append(heading('References'));
  const items = element('ul', `${LIST_CLASS} list-disc`);
  for (const reference of CALCULATION_REFERENCES) {
    const item = element('li', '');
    if (reference.url) {
      item.append(externalLink({ label: reference.label, url: reference.url }));
    } else {
      item.textContent = reference.label;
    }
    items.append(item);
  }
  block.append(items);
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
