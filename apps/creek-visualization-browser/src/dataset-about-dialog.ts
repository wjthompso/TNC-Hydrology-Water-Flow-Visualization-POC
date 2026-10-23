// "About this data" button next to the Dataset picker. Opens a dialog that
// says how the active Dataset's water levels were made. The observed text is
// fixed here; the modeled content comes from modeled-dataset-info-panel.ts.

import { GAUGE_DATUM_FT } from './observed-gauge-readings';

const LINK_CLASS =
  'text-cyan-300 underline decoration-cyan-300/50 underline-offset-2 hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300';

/** Fills the dialog and wires the button. `fillBody` runs on every open, so late-loading content shows. */
export function bindDatasetAboutDialog(title: string, fillBody: (body: HTMLElement) => void): void {
  const button = document.getElementById('dataset-about-btn');
  const dialog = document.getElementById('dataset-about-dialog');
  const heading = document.getElementById('dataset-about-dialog-title');
  const body = document.getElementById('dataset-about-dialog-body');
  if (!(button instanceof HTMLButtonElement) || !(dialog instanceof HTMLDialogElement) || !heading || !body) {
    return;
  }
  button.addEventListener('click', () => {
    heading.textContent = title;
    fillBody(body);
    // showModal() traps focus, closes on Escape, and returns focus to the button.
    dialog.showModal();
  });
  // A click on the backdrop closes the dialog.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

export function fillObservedGaugeAbout(body: HTMLElement): void {
  const paragraphs = [
    'These are measured water levels from USGS (United States Geological Survey) stream gauge 11120600, Jalama Creek near Lompoc, recorded every 15 minutes.',
    `The gauge reports gauge height: the water level above the gauge's own zero point. Adding the gauge datum (${GAUGE_DATUM_FT} ft above the NAVD88 vertical datum) gives the water-surface elevation drawn on the map.`,
    "Only the gauge's creek segment is measured. Teal water on nearby segments is inferred: each segment's creek bed plus the gauge's water depth, not a measurement.",
    'Blank times are gaps in the gauge record. Recent readings may be provisional: USGS can still revise them.',
  ];
  const source = document.createElement('p');
  const link = document.createElement('a');
  link.className = LINK_CLASS;
  link.href = 'https://waterdata.usgs.gov/monitoring-location/11120600';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'USGS gauge 11120600 on waterdata.usgs.gov';
  source.append('Source: ', link);
  body.replaceChildren(
    ...paragraphs.map((text) => {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      return paragraph;
    }),
    source,
  );
}
