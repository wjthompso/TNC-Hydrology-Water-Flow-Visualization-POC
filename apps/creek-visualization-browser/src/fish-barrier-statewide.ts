// The statewide copy of each fish barrier's record, from CDFW (California Department of Fish and Wildlife)
// and its Passage Assessment Database (PAD). The TNC Digital Catalog layer is a subset of this database,
// with the same PassageIDs, but cuts the Notes and treatment text at 255 characters and drops the
// structure owner, treatment status, fishway, and miles of habitat upstream. The info card reads those
// from here.
//
// Best-effort by design: the card has to open with the TNC fields when this service is slow or down, so
// the lookup never throws and the barriers never wait for it.

import { queryAllRows } from './hosted-feature-service-query';
import type { FishBarrierRecord } from './fish-barrier-sites';

export const STATEWIDE_PAD_LAYER_URL =
  'https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds69_fmu/FeatureServer/0';
/** Where CDFW describes the Passage Assessment Database, for the card's source line. */
export const STATEWIDE_PAD_INFO_URL = 'https://wildlife.ca.gov/Conservation/Fishes/Passage-Assessment';

export interface StatewideBarrierDetails {
  /** Full text; the TNC copy stops at 255 characters. */
  readonly notes: string;
  readonly treatmentRecommendation: string;
  readonly structureOwner: string;
  readonly treatmentStatus: string;
  readonly treatmentNeeded: string;
  readonly fishwayType: string;
  /** Miles of fish habitat upstream of the barrier, or null when not filled in (about half the records). */
  readonly milesUpstream: number | null;
}

/** Statewide details by PassageID, or null when the statewide service did not answer. */
export type StatewideLookup = ReadonlyMap<number, StatewideBarrierDetails> | null;

/**
 * Records whose TNC text is the newer survey. TNC updated these two with a 2012 WRA survey, so the
 * statewide notes (the 2002 survey) describe an older visit and must not replace them.
 */
const NEWER_TNC_NOTES_PASSAGE_IDS: ReadonlySet<number> = new Set([
  7845, // Downstream-most Jalama Road Bridge: concrete apron
  7858, // Escondido culvert: hanging culvert
]);

/** Reads the statewide record of every listed barrier in one query. Resolves to null on any failure. */
export async function readStatewideBarrierDetails(passageIds: readonly number[]): Promise<StatewideLookup> {
  if (passageIds.length === 0) return new Map();
  try {
    const rows = await queryAllRows({
      layerUrl: STATEWIDE_PAD_LAYER_URL,
      where: `PassageID IN (${passageIds.join(',')})`,
      outFields: ['PassageID', 'Notes', 'TrtRecom', 'StructOwner', 'TrtStatus', 'TrtNeeded', 'FishWayType', 'Miles_Upst'],
      returnGeometry: false,
      // The layer allows at least this many rows a request; naming it saves the metadata request.
      pageSize: 2000,
    });
    const details = new Map<number, StatewideBarrierDetails>();
    for (const { attributes } of rows) {
      if (typeof attributes.PassageID !== 'number') continue;
      const text = (key: string): string => (typeof attributes[key] === 'string' ? (attributes[key] as string).trim() : '');
      details.set(attributes.PassageID, {
        notes: text('Notes'),
        treatmentRecommendation: text('TrtRecom'),
        structureOwner: text('StructOwner'),
        treatmentStatus: text('TrtStatus'),
        treatmentNeeded: text('TrtNeeded'),
        fishwayType: text('FishWayType'),
        milesUpstream: typeof attributes.Miles_Upst === 'number' ? attributes.Miles_Upst : null,
      });
    }
    return details;
  } catch (error) {
    console.warn('[fish-barrier-statewide] the statewide database did not answer; the info card shows the TNC copy only', error);
    return null;
  }
}

export interface ChosenText {
  readonly text: string;
  /** `tnc-newer-survey`: TNC's 2012 survey text, kept over the statewide text of the older 2002 survey. */
  readonly source: 'tnc' | 'tnc-newer-survey' | 'statewide';
}

/**
 * The statewide text when it is the TNC text carried on to its end (the TNC copy was cut at 255
 * characters), otherwise the TNC text. A statewide text that does not start with the TNC text is a
 * different survey, so it is not used.
 */
function fullerText(tncText: string, statewideText: string | undefined): ChosenText {
  const extended = statewideText !== undefined && statewideText.length > tncText.length && statewideText.startsWith(tncText);
  return extended ? { text: statewideText, source: 'statewide' } : { text: tncText, source: 'tnc' };
}

export function chooseSurveyNotes(record: FishBarrierRecord, statewide: StatewideBarrierDetails | undefined): ChosenText {
  if (record.passageId !== null && NEWER_TNC_NOTES_PASSAGE_IDS.has(record.passageId)) {
    return { text: record.notes, source: 'tnc-newer-survey' };
  }
  return fullerText(record.notes, statewide?.notes);
}

export function chooseTreatmentRecommendation(
  record: FishBarrierRecord,
  statewide: StatewideBarrierDetails | undefined,
): ChosenText {
  return fullerText(record.treatmentRecommendation, statewide?.treatmentRecommendation);
}
