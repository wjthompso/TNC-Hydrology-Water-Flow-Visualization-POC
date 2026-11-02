import { CATALOG, NATIONAL_WATER_MODEL } from '../pipeline-configuration.ts';

/**
 * NOAA's operational National Water Model (NWM) Analysis and Assimilation run, the hourly Dataset that
 * overlaps the observed USGS gauge record the retrospective Dataset (`NATIONAL_WATER_MODEL`, ends
 * Feb 2023) cannot. Everything specific to it lives in this folder, not in `pipeline-configuration.ts`
 * or `discharge-records.ts`: those files are fingerprinted by m3 v2 (and so by m4 and m5), and a change
 * to one would make every saved m3 v2/m4 v1/m5 v1 look changed.
 */

/** Public Google Cloud bucket, no authentication. One file per valid hour. */
export const OPERATIONAL_NATIONAL_WATER_MODEL_BUCKET_URL = 'https://storage.googleapis.com/national-water-model';

export const OPERATIONAL_NATIONAL_WATER_MODEL = {
  /** The Publisher is the retrospective's: both are NOAA National Water Model output. */
  publisherId: NATIONAL_WATER_MODEL.publisherId,
  datasetId: 'national-water-model-operational-hourly',
  /** Written by the acquisition stage into `00-acquire/`, in the `NormalizedDischargeFile` shape. */
  dischargeFile: 'national-water-model-operational-hourly-discharge.json',
  /** Hour-by-hour read results (one small JSON per UTC day), kept at the output root and shared by every extent. */
  cacheDirectoryName: 'national-water-model-operational-hourly-streamflow-cache',
  /** `--operational-nwm-start=` and `--operational-nwm-end=` override these; both are valid hours, inclusive. */
  defaultFirstValidHourUtc: '2025-09-01T00:00:00Z',
  defaultLastValidHourUtc: '2026-10-29T23:00:00Z',
  /** Parallel day-workers of the Python reader. */
  downloadWorkers: 12,
  /** The file name pattern, for the normalization text and the report. */
  fileNamePattern: 'nwm.YYYYMMDD/analysis_assim/nwm.tHHz.analysis_assim.channel_rt.tm00.conus.nc',
} as const;

/** The normalization text of the Dataset's discharge file (`NormalizedDischargeFile.normalization`). */
export function operationalNormalizationText(input: { firstValidHourUtc: string; lastValidHourUtc: string; hours: number; missingHours: number }): string {
  return (
    'NOAA operational National Water Model (NWM) Analysis and Assimilation run, not the v3.0 retrospective: ' +
    `hourly channel_rt streamflow (int32 × scale_factor 0.01 → m³/s) at each valid hour from ${input.firstValidHourUtc} to ${input.lastValidHourUtc} ` +
    `(${input.hours} hours, ${input.missingHours} missing → null), read from ${OPERATIONAL_NATIONAL_WATER_MODEL_BUCKET_URL}/${OPERATIONAL_NATIONAL_WATER_MODEL.fileNamePattern}; fill value → null. ` +
    'It differs from the retrospective in three ways: it uses different rainfall inputs (the operational forcing, not the retrospective forcing), ' +
    'it assimilates USGS gauge flows (nudging) on any reach that has an assimilated gauge, and NOAA does not guarantee the same model version over time ' +
    '(the version of every file is recorded in the stage manifest).'
  );
}

/**
 * `MODELED_WSE_ACCURACY_NOTE` in `pipeline-configuration.ts` is not exported, and that file is fingerprinted, so it is mirrored here.
 * `operationalCatalogDataset` throws when the mirror stops matching the end of an existing Dataset's note.
 */
const SHARED_MODELED_WSE_ACCURACY_NOTE =
  "Water-surface elevation assumes steady, uniform flow (Manning's equation) on bare-earth terrain that cannot see the underwater channel bed.";

/** What is said about the operational Dataset alone, before the shared note. One gauge only; keep it factual. */
const OPERATIONAL_ACCURACY_NOTE =
  "NOAA operational analysis; checked against only one gauge (USGS 11120600, Sep 2025–Oct 2026): flows averaged about 5× the gauge's " +
  '(about 7× in Jan 2026), and the 2026-01-03 peak was about 45% too low; timing of rises and falls is more reliable than the values.';

/**
 * The catalog entry of the Dataset, kept out of `CATALOG` in `pipeline-configuration.ts` (fingerprinted). Stage 5 lists it next to
 * `CATALOG.datasets` for a modeled WSE version that carries it (m5 v2 and later).
 */
export function operationalCatalogDataset(): { datasetId: string; publisherId: string; kind: 'modeled'; timeStep: 'hourly'; accuracyNote: string } {
  for (const dataset of CATALOG.datasets) {
    if (!dataset.accuracyNote.endsWith(SHARED_MODELED_WSE_ACCURACY_NOTE)) {
      throw new Error(`CATALOG Dataset ${dataset.datasetId} no longer ends with the shared accuracy note; update SHARED_MODELED_WSE_ACCURACY_NOTE in ${import.meta.url}.`);
    }
  }
  return {
    datasetId: OPERATIONAL_NATIONAL_WATER_MODEL.datasetId,
    publisherId: OPERATIONAL_NATIONAL_WATER_MODEL.publisherId,
    kind: 'modeled',
    timeStep: 'hourly',
    accuracyNote: `${OPERATIONAL_ACCURACY_NOTE} ${SHARED_MODELED_WSE_ACCURACY_NOTE}`,
  };
}
