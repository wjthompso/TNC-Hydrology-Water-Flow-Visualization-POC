// Accuracy notice for a modeled Dataset, shown as a modal dialog when that
// Dataset becomes active (UCS-285). This is the plain-language UI wording.
// The catalog's per-Dataset `accuracyNote` stays the technical record and
// still appears in the modeled panel's "Details and derivation" disclosure.
// The notice does not depend on the catalog, which may load late or wait on
// sign-in.

import type { ModeledDatasetId } from './modeled-water-catalog';

export interface ModeledDatasetAccuracyNotice {
  readonly title: string;
  readonly body: string;
  /** Label of the dialog's only button. */
  readonly acknowledgeLabel: string;
}

/** Keyed by catalog datasetId. Edit the wording here; the Dataset's public name stays in the picker label. */
export const MODELED_DATASET_ACCURACY_NOTICES: Readonly<Partial<Record<ModeledDatasetId, ModeledDatasetAccuracyNotice>>> = {
  'national-water-model-hourly': {
    title: 'Estimated values, not measurements',
    body: "These modeled water levels (water-surface elevation, WSE: the water's height above sea level, NAVD88) are calculated from modeled flow rates (NOAA National Water Model v3.0) and USGS 3DEP terrain using Manning's equation. The modeled flows are not corrected against gauge readings and can be off by a factor of 2 to 5 on small creeks like these, so the timing of rises and falls is more reliable than the exact heights.",
    acknowledgeLabel: 'I understand',
  },
};

/**
 * Opens the accuracy notice dialog for `datasetOptionId` and resolves once
 * the reader closes it ("I understand" or Escape). Focus returns to
 * `returnFocusTo`. Resolves at once when the Dataset has no notice or the
 * dialog markup is missing.
 */
export function showModeledDatasetAccuracyNotice(datasetOptionId: string, returnFocusTo: HTMLElement): Promise<void> {
  const notice = MODELED_DATASET_ACCURACY_NOTICES[datasetOptionId as ModeledDatasetId];
  const dialog = document.getElementById('dataset-accuracy-dialog');
  const title = document.getElementById('dataset-accuracy-dialog-title-text');
  const body = document.getElementById('dataset-accuracy-dialog-body');
  const acknowledge = document.getElementById('dataset-accuracy-dialog-acknowledge');
  if (
    !notice ||
    !(dialog instanceof HTMLDialogElement) ||
    !title ||
    !body ||
    !(acknowledge instanceof HTMLButtonElement)
  ) {
    return Promise.resolve();
  }

  title.textContent = notice.title;
  body.textContent = notice.body;
  acknowledge.textContent = notice.acknowledgeLabel;

  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        returnFocusTo.focus();
        resolve();
      },
      { once: true },
    );
    // showModal() traps focus, makes the page behind inert, and closes on Escape.
    dialog.showModal();
    acknowledge.focus();
  });
}
