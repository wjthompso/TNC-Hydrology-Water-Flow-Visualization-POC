// What each fish barrier in the TNC Digital Catalog layer "Fish Passage Barriers Assessment"
// (`jldp_fish_passage_barriers`, a Passage Assessment Database subset) is, how big it is, and
// whether it still stands. Pure data and rules, no map code; the drawing lives in
// fish-barrier-map.ts.
//
// The layer holds no dimensions. Sizes come from three places, and each drawn size says which:
//   documented: a number in the record's own Notes, or in a TNC / CalSalmon source (cited below);
//   assumed:    a default in this file, because nothing documents it.

import type { HostedFeatureRow } from './hosted-feature-service-query';

export const FISH_BARRIER_LAYER_URL =
  'https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_fish_passage_barriers/FeatureServer/0';
/** TNC NHD (National Hydrography Dataset) 1:24K streams; the barrier points sit on these lines. */
export const TNC_STREAM_FLOWLINE_LAYER_URL =
  'https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_nhd24kflowlines_streams/FeatureServer/7';

const FEET_TO_METERS = 0.3048;
const feet = (value: number): number => value * FEET_TO_METERS;

// --- Assumed sizes: used only where nothing documents the dimension -------------------------------

/** 4 ft pipe. Typical rural road culvert; no record gives a diameter. */
export const ASSUMED_CULVERT_DIAMETER_M = 1.2;
/** The two documented culverts (Cojo, Espada) are both "approximately 25-foot" long. */
export const ASSUMED_CULVERT_LENGTH_M = feet(25);
/** Channel width where a barrier spans the creek and no width is documented. */
export const ASSUMED_CREEK_SPAN_M = 5;
/** Thickness of a crossing-spanning slab or wall along the flow, where undocumented. */
export const ASSUMED_STRUCTURE_LENGTH_M = 1;
export const ASSUMED_WATERFALL_HEIGHT_M = 2;
/** The catalog gives one point for a steep stretch, not its extent; the drawn ramp is this long. */
export const ASSUMED_STEEP_STRETCH_LENGTH_M = 20;
/** Width of the drawn steep-stretch ramp, across the creek. */
export const ASSUMED_STEEP_STRETCH_WIDTH_M = 4;
/**
 * Pitch of the drawn ramp. A 10% slope is only 5.7 degrees, too shallow to read as a ramp from the air
 * against sloping ground, so the drawing exaggerates it. The ramp says "steep stretch here", not how steep.
 */
export const STEEP_STRETCH_DRAWN_PITCH_DEGREES = 20;
/**
 * Height of the drawn ramp's middle above the ground, m. The ramp is pitched more steeply than the ground,
 * so its low end would dip into the slope unless the middle floats at least half its rise (3.4 m) above it.
 */
export const STEEP_STRETCH_FLOAT_HEIGHT_M = 3.8;

export type BarrierStatus = 'Total' | 'Partial' | 'Unknown';

export interface FishBarrierRecord {
  readonly objectId: number;
  /** PAD (Passage Assessment Database) internal id. Null for the one record added locally. */
  readonly passageId: number | null;
  /** Catalog PAD_ID, the statewide database's record number. Null when the row has none. */
  readonly padId: number | null;
  readonly streamName: string;
  readonly siteName: string;
  readonly siteType: string;
  readonly status: BarrierStatus;
  readonly notes: string;
  /** Cut off at 255 characters in the TNC copy; fish-barrier-statewide.ts holds the full text. */
  readonly treatmentRecommendation: string;
  readonly surveyYear: string;
  readonly speciesBlocked: string;
  readonly protocol: string;
  readonly assessedBy: string;
  readonly landOwner: string;
  readonly longitude: number;
  readonly latitude: number;
}

export type BarrierShape =
  /** A pipe under a road. `perchM` is the drop from the creek bed up to the pipe's bottom edge at the outlet. */
  | { kind: 'culvert'; diameterM: number; lengthM: number; perchM: number }
  /** A wall or slab across the whole creek: a dam, weir, or concrete apron. */
  | { kind: 'crossing-structure'; spanM: number; heightM: number; lengthM: number }
  /** A natural bedrock drop. */
  | { kind: 'waterfall'; spanM: number; heightM: number }
  /**
   * A sustained steep stretch of creek or an estimated natural limit: terrain, not an object. Drawn as a
   * see-through ramp pitched up the creek, `lengthM` long, so it reads as a slope and not as a structure.
   */
  | { kind: 'steep-stretch'; lengthM: number; widthM: number };

export interface BarrierRemoval {
  /**
   * `removed`: the structure is gone. `bypassed`: it still stands, but a built channel lets fish go
   * around it. Both stop blocking fish, so both draw as a see-through footprint.
   */
  readonly fate: 'removed' | 'bypassed';
  /** Past tense, ready to print: "Concrete dam demolished by TNC, 2023". */
  readonly summary: string;
  readonly source: string;
}

export interface PlainTerm {
  readonly term: string;
  readonly meaning: string;
}

export interface BarrierSiteDescription {
  readonly shape: BarrierShape;
  /** Plain type name for a label: "Culvert", "Concrete weir", "Waterfall (natural)". */
  readonly kindLabel: string;
  /** What stops fish here and why, in plain words, from the record's notes and structure type. */
  readonly whatBlocksFish: string;
  /** Words used in the label or the explanation that a reader may not know. */
  readonly plainTerms: readonly PlainTerm[];
  /** Set when the catalog files the record under the wrong type and the code corrects it; says how. */
  readonly catalogCorrection: string | null;
  /** Names of `shape` fields that are assumptions, not documented. Empty when every size is documented. */
  readonly assumedDimensions: readonly string[];
  /** One line saying where the sizes came from. */
  readonly sizeBasis: string;
  /** Set when TNC has since removed or bypassed the barrier. The survey record still lists it. */
  readonly removal: BarrierRemoval | null;
}

const TNC_JALAMA_TALK =
  'TNC "Explosives, Helicopters and Hard Work: Restoring Steelhead to Jalama Creek" (calsalmon.org/sites/default/files/fish_all.pdf)';
const TNC_ANNUAL_REPORT_2024 = 'TNC Dangermond Preserve Annual Report 2024';

/**
 * Barriers TNC has removed or bypassed, by PAD passage id. Both match a point of the catalog's own
 * "Removed Barriers Jalama Creek" layer within 30 m (JA_1 dam, JA_2 apron).
 */
const REMOVED_BARRIERS_BY_PASSAGE_ID: ReadonlyMap<number, BarrierRemoval> = new Map([
  [
    7844,
    {
      fate: 'removed',
      summary: 'Concrete irrigation dam (TNC barrier JA-1) demolished by TNC, 2023',
      source: `${TNC_JALAMA_TALK}; ${TNC_ANNUAL_REPORT_2024}`,
    },
  ],
  [
    7845,
    {
      fate: 'bypassed',
      summary:
        'Concrete apron (TNC barrier JA-2) left in place and bypassed by a 120 ft rock ramp built by TNC, 2024',
      source: TNC_ANNUAL_REPORT_2024,
    },
  ],
]);

/** Words a label or an explanation uses that a reader may not know. Shown on the info card. */
const PLAIN_TERMS = {
  culvert: { term: 'Culvert', meaning: 'A pipe or box that carries a creek under a road.' },
  perched: {
    term: 'Perched (or hanging)',
    meaning: 'The pipe\'s outlet sits above the creek bed, so fish must jump up into it.',
  },
  weir: { term: 'Weir', meaning: 'A low wall across a creek that holds the water back.' },
  apron: { term: 'Apron', meaning: 'A concrete slab on the creek bed at the foot of a bridge or pipe.' },
  steelhead: {
    term: 'Steelhead',
    meaning: 'Rainbow trout that migrate from the ocean up into creeks to spawn; the fish this survey is about.',
  },
} as const satisfies Record<string, PlainTerm>;

/** CDFW (California Department of Fish and Wildlife) 2002 culvert criteria: the most an adult steelhead can jump up into a pipe, ft. */
const ADULT_STEELHEAD_MAX_OUTLET_DROP_FT = 1;

interface ShapeOverride {
  shape: BarrierShape;
  label: string;
  assumed: readonly string[];
  basis: string;
  whatBlocksFish: string;
  terms: readonly PlainTerm[];
}

/** Sizes documented for one record, by PAD passage id. Fields not listed fall back to the assumed sizes. */
const SHAPE_OVERRIDES_BY_PASSAGE_ID: ReadonlyMap<number, ShapeOverride> = new Map<number, ShapeOverride>([
  [
    7836, // Cojo Creek culvert
    {
      label: 'Culvert',
      shape: { kind: 'culvert', diameterM: ASSUMED_CULVERT_DIAMETER_M, lengthM: feet(25), perchM: 0 },
      assumed: ['diameterM'],
      basis: 'Length from the record\'s Notes ("app. 25-foot length of the narrow culvert"); diameter assumed.',
      whatBlocksFish:
        'A narrow pipe under a road, about 25 ft long. Water speeds up inside a pipe this long, which may let steelhead through only with great difficulty during migration flows.',
      terms: [PLAIN_TERMS.culvert, PLAIN_TERMS.steelhead],
    },
  ],
  [
    7844, // JA-1 dam, removed
    {
      label: 'Concrete dam',
      shape: { kind: 'crossing-structure', spanM: feet(38), heightM: feet(1), lengthM: feet(4.5) },
      assumed: [],
      basis: `${TNC_JALAMA_TALK}: 38 ft channel-spanning, 1 ft above the bed, 4.5 ft long along the stream.`,
      whatBlocksFish:
        'A low concrete irrigation dam across the whole creek (about 1 ft high, 38 ft wide). Fish had to jump over it, and surveyors saw no purpose for it.',
      terms: [PLAIN_TERMS.steelhead],
    },
  ],
  [
    7845, // JA-2 apron, bypassed
    {
      label: 'Bridge apron',
      shape: { kind: 'crossing-structure', spanM: ASSUMED_CREEK_SPAN_M, heightM: feet(2), lengthM: feet(13) },
      assumed: ['spanM'],
      basis: `${TNC_JALAMA_TALK}: 2 ft high, 13 ft long along the stream, spans the creek; the span width is assumed.`,
      whatBlocksFish:
        'A concrete apron at the foot of a bridge, about 2 ft high. Fish must jump onto it, and the thin sheet of water on top can stop them at low flow.',
      terms: [PLAIN_TERMS.apron, PLAIN_TERMS.steelhead],
    },
  ],
  [
    7851, // Espada culvert, perched
    {
      label: 'Perched culvert',
      shape: { kind: 'culvert', diameterM: ASSUMED_CULVERT_DIAMETER_M, lengthM: feet(25), perchM: feet(3.5) },
      assumed: ['diameterM'],
      basis:
        'Perch and length from the record\'s Notes ("approximately 3 to 4-foot jump into the perched culvert", "approximately 25-foot length"); the 3 to 4 ft range is drawn at 3.5 ft; diameter assumed.',
      whatBlocksFish:
        `A pipe under a road, about 25 ft long, whose outlet sits 3 to 4 ft above the creek (perched). Fish must jump up into it; adult steelhead can manage about ${ADULT_STEELHEAD_MAX_OUTLET_DROP_FT} ft (CDFW 2002 culvert criteria). Surveyors judged it would completely block adult steelhead.`,
      terms: [PLAIN_TERMS.culvert, PLAIN_TERMS.perched, PLAIN_TERMS.steelhead],
    },
  ],
  [
    7858, // Escondido hanging culvert
    {
      label: 'Perched culvert',
      shape: { kind: 'culvert', diameterM: ASSUMED_CULVERT_DIAMETER_M, lengthM: ASSUMED_CULVERT_LENGTH_M, perchM: feet(6) },
      assumed: ['diameterM', 'lengthM'],
      basis: 'Perch from the record\'s Notes ("Hanging culvert with estimated heigh of 6ft"); diameter and length assumed.',
      whatBlocksFish:
        'A pipe under a road whose outlet hangs about 6 ft above the creek bed (perched), with no pool below to jump from. Fish are unlikely to reach the opening.',
      terms: [PLAIN_TERMS.culvert, PLAIN_TERMS.perched],
    },
  ],
  [
    8970, // Escondido weir
    {
      label: 'Concrete weir',
      shape: { kind: 'crossing-structure', spanM: ASSUMED_CREEK_SPAN_M, heightM: feet(8), lengthM: ASSUMED_STRUCTURE_LENGTH_M },
      assumed: ['spanM', 'lengthM'],
      basis: 'Height from the record\'s Notes ("Vertical concrete dam spans width of the creek. Estimated heigh at 8 feet"); span and thickness assumed.',
      whatBlocksFish:
        'A vertical concrete wall across the whole creek, about 8 ft high, with no pool below to jump from. Surveyors judged it a total barrier.',
      terms: [PLAIN_TERMS.weir],
    },
  ],
]);

/**
 * Records the catalog files under the wrong type, by PAD passage id. The record's own site name says what
 * it is, so the name wins over the type.
 */
const CORRECTED_KIND_BY_PASSAGE_ID: ReadonlyMap<number, { kind: 'steep-stretch'; correction: string }> = new Map([
  [
    7860, // "Steep Stream Reach", filed as a road crossing, status Unknown, no notes
    { kind: 'steep-stretch', correction: 'Filed as a road crossing, but its site name is "Steep Stream Reach", so it is drawn as a steep stretch.' },
  ],
]);

const STEEP_STRETCH_SIZE_BASIS =
  `A stretch of creek, not a structure: the catalog gives one point and no length. The ramp is drawn ${ASSUMED_STEEP_STRETCH_LENGTH_M} m long and ${ASSUMED_STEEP_STRETCH_WIDTH_M} m wide, tilted ${STEEP_STRETCH_DRAWN_PITCH_DEGREES} degrees to read as a slope; none of that is measured.`;

const STEEP_STRETCH_SHAPE: BarrierShape = {
  kind: 'steep-stretch',
  lengthM: ASSUMED_STEEP_STRETCH_LENGTH_M,
  widthM: ASSUMED_STEEP_STRETCH_WIDTH_M,
};

export function describeFishBarrierSite(record: FishBarrierRecord): BarrierSiteDescription {
  const removal = record.passageId === null ? null : (REMOVED_BARRIERS_BY_PASSAGE_ID.get(record.passageId) ?? null);
  const override = record.passageId === null ? undefined : SHAPE_OVERRIDES_BY_PASSAGE_ID.get(record.passageId);
  if (override) {
    return {
      shape: override.shape,
      kindLabel: override.label,
      whatBlocksFish: override.whatBlocksFish,
      plainTerms: override.terms,
      catalogCorrection: null,
      assumedDimensions: override.assumed,
      sizeBasis: override.basis,
      removal,
    };
  }
  return { ...describeByKind(record), removal };
}

function describeByKind(record: FishBarrierRecord): Omit<BarrierSiteDescription, 'removal'> {
  const name = record.siteName.toLowerCase();
  const notes = record.notes.toLowerCase();
  const corrected = record.passageId === null ? undefined : CORRECTED_KIND_BY_PASSAGE_ID.get(record.passageId);

  // A steep stretch or an upstream limit is terrain, not an object.
  if (corrected || name.includes('gradient') || name.includes('natural upstream limit')) {
    const isLimit = name.includes('natural upstream limit');
    return {
      shape: STEEP_STRETCH_SHAPE,
      kindLabel: isLimit ? 'Estimated steep limit' : 'Steep stretch of creek',
      whatBlocksFish: isLimit
        ? 'The most downstream point where the creek is expected to stay 10 to 15% steep, estimated from topographic maps and not measured on the ground. Steelhead are not expected to climb past it. There is no structure; this is natural terrain.'
        : corrected
          ? 'Surveyors marked a steep stretch of creek here but did not decide whether fish can pass. Stretches steeper than 10% (more than 10 m of drop per 100 m) are normally too steep for steelhead to climb. There is no structure; this is natural terrain.'
          : 'The creek stays steeper than 10% here (more than 10 m of drop per 100 m). Steelhead cannot climb a stretch this steep. There is no structure; this is natural terrain.',
      plainTerms: [PLAIN_TERMS.steelhead],
      catalogCorrection: corrected?.correction ?? null,
      assumedDimensions: ['lengthM', 'widthM'],
      sizeBasis: STEEP_STRETCH_SIZE_BASIS,
    };
  }
  if (name.includes('waterfall')) {
    return {
      shape: { kind: 'waterfall', spanM: ASSUMED_CREEK_SPAN_M, heightM: ASSUMED_WATERFALL_HEIGHT_M },
      kindLabel: 'Waterfall (natural)',
      whatBlocksFish:
        'A natural drop in the creek\'s bedrock, not a built structure. Fish have to leap it' +
        (notes ? '; the survey notes below describe it.' : '; the survey recorded no notes about its height.'),
      plainTerms: [PLAIN_TERMS.steelhead],
      catalogCorrection: null,
      assumedDimensions: ['spanM', 'heightM'],
      sizeBasis: 'No drop height or width is recorded for this waterfall: both are assumed.',
    };
  }
  // "Dam Site Canyon" is filed as a dam, but its Notes describe a perched culvert under a road.
  if (record.siteType === 'Dam' && !notes.includes('culvert')) {
    return {
      shape: {
        kind: 'crossing-structure',
        spanM: ASSUMED_CREEK_SPAN_M,
        heightM: ASSUMED_WATERFALL_HEIGHT_M,
        lengthM: ASSUMED_STRUCTURE_LENGTH_M,
      },
      kindLabel: 'Dam',
      whatBlocksFish: 'A dam across the creek. Its height is not recorded; fish must jump over it.',
      plainTerms: [PLAIN_TERMS.steelhead],
      catalogCorrection: null,
      assumedDimensions: ['spanM', 'heightM', 'lengthM'],
      sizeBasis: 'No dimensions are recorded for this dam: all are assumed.',
    };
  }
  const perched = notes.includes('perched');
  const filedAsDam = record.siteType === 'Dam';
  const mentionsCulvert = notes.includes('culvert') || name.includes('culvert');
  return {
    shape: {
      kind: 'culvert',
      diameterM: ASSUMED_CULVERT_DIAMETER_M,
      lengthM: ASSUMED_CULVERT_LENGTH_M,
      perchM: perched ? 1 : 0,
    },
    kindLabel: perched ? 'Perched culvert' : mentionsCulvert ? (name.includes('road crossing') ? 'Road crossing (culvert)' : 'Culvert') : 'Road crossing',
    whatBlocksFish: perched
      ? 'A pipe under a road whose outlet sits above the creek bed (perched), so fish must jump up into it. The notes give no height.'
      : notes
        ? 'A pipe under a road. A pipe stops fish when the water inside is too fast or too shallow, or when its outlet is above the creek; the survey notes below say what was seen here.'
        : 'A road crossing. The survey visited it but recorded no notes on what, if anything, stops fish here.',
    plainTerms: perched ? [PLAIN_TERMS.culvert, PLAIN_TERMS.perched] : [PLAIN_TERMS.culvert],
    catalogCorrection: filedAsDam ? 'Filed as a dam, but its notes describe a perched culvert under a road, so it is drawn as one.' : null,
    assumedDimensions: perched ? ['diameterM', 'lengthM', 'perchM'] : ['diameterM', 'lengthM'],
    sizeBasis: perched
      ? 'Notes say the culvert is perched but give no drop: diameter, length, and a 1 m perch are assumed.'
      : mentionsCulvert
        ? 'No culvert dimensions are recorded: diameter and length are assumed, and the pipe sits at bed level.'
        : 'The record does not say what the crossing is: a pipe is drawn as a typical stand-in, with assumed size, at bed level.',
  };
}

/** Reads one row of the barrier layer queried with `outSR=4326`. Null when the row has no point. */
export function parseFishBarrierRecord(row: HostedFeatureRow): FishBarrierRecord | null {
  const geometry = row.geometry as { x?: number; y?: number } | undefined;
  if (typeof geometry?.x !== 'number' || typeof geometry.y !== 'number') return null;
  const attributes = row.attributes;
  const text = (key: string): string => {
    const value = attributes[key];
    return typeof value === 'string' && value.trim() !== 'None' ? value.trim() : '';
  };
  const status = text('BarStatus');
  return {
    objectId: Number(attributes.OBJECTID),
    passageId: typeof attributes.PassageID === 'number' ? attributes.PassageID : null,
    padId: typeof attributes.PAD_ID === 'number' ? attributes.PAD_ID : null,
    streamName: text('StreamName'),
    siteName: text('SiteName'),
    siteType: text('SiteType'),
    status: status === 'Total' || status === 'Partial' ? status : 'Unknown',
    notes: text('Notes'),
    treatmentRecommendation: text('TrtRecom'),
    surveyYear: text('SurveyDate'),
    speciesBlocked: text('SpeciesBlocked'),
    protocol: text('Protocol'),
    assessedBy: text('AssessedBy'),
    landOwner: text('LandOwner'),
    longitude: geometry.x,
    latitude: geometry.y,
  };
}

/** Fill color of a barrier by its passage status, as CSS hex. A removed or bypassed barrier is green. */
export const BARRIER_COLOR_HEX: Readonly<Record<BarrierStatus | 'no-longer-blocking', string>> = {
  Total: '#dc2626',
  Partial: '#f59e0b',
  Unknown: '#94a3b8',
  'no-longer-blocking': '#22c55e',
};

export function barrierColorHex(record: FishBarrierRecord, description: BarrierSiteDescription): string {
  return BARRIER_COLOR_HEX[description.removal ? 'no-longer-blocking' : record.status];
}

/** How tall the drawn barrier stands above the ground, m. A pin's stem ends here. */
export function barrierTopHeightM(shape: BarrierShape): number {
  switch (shape.kind) {
    case 'culvert':
      return shape.perchM + shape.diameterM;
    case 'crossing-structure':
    case 'waterfall':
      return shape.heightM;
    case 'steep-stretch':
      return STEEP_STRETCH_FLOAT_HEIGHT_M + (shape.lengthM / 2) * Math.sin((STEEP_STRETCH_DRAWN_PITCH_DEGREES * Math.PI) / 180);
  }
}

/** Creek name for a label: the catalog's "Gasper Creek (Gaspar Creek)" becomes "Gasper Creek"; a blank name is called unnamed. */
export function barrierCreekName(record: FishBarrierRecord): string {
  return record.streamName.replace(/ \(.*\)$/, '') || 'Unnamed creek';
}

/**
 * Longest label line, characters (about 34; two creek names land on 36). A longer pill crowds its
 * neighbors, and the label pins only show where no other label is in the way.
 */
export const BARRIER_PIN_MAX_LINE_CHARACTERS = 36;

/** The creek name cut to fit beside `suffix` on one label line: "East Fork" becomes "E. Fork", then " Creek" goes. The card keeps the full name. */
function creekNameThatFits(creek: string, suffix: string): string {
  const fits = (name: string): boolean => name.length + suffix.length <= BARRIER_PIN_MAX_LINE_CHARACTERS;
  if (fits(creek)) return creek;
  const abbreviated = creek.replace(/^East Fork /, 'E. Fork ').replace(/^North Fork /, 'N. Fork ');
  if (fits(abbreviated)) return abbreviated;
  return abbreviated.replace(/ Creek$/, '');
}

/** What the status says in a label's second line. */
const BLOCKING_PHRASE: Readonly<Record<BarrierStatus, string>> = {
  Total: 'blocks all fish',
  Partial: 'blocks some fish',
  Unknown: 'passage unknown',
};

/** The two lines of a barrier's map label. Line one says what blocks fish, line two where and how much. */
export function barrierPinText(
  record: FishBarrierRecord,
  description: BarrierSiteDescription,
): { primary: string; secondary: string } {
  const fullCreek = barrierCreekName(record);
  if (description.removal) {
    const suffix = ' · fish can pass now';
    return {
      primary: `${description.kindLabel} (${description.removal.fate})`,
      secondary: `${creekNameThatFits(fullCreek, suffix)}${suffix}`,
    };
  }
  const suffix = ` · ${BLOCKING_PHRASE[record.status]}`;
  return { primary: description.kindLabel, secondary: `${creekNameThatFits(fullCreek, suffix)}${suffix}` };
}

/** The status in plain words for the info card's chip. */
export const BARRIER_STATUS_CHIP_TEXT: Readonly<Record<BarrierStatus | 'no-longer-blocking', string>> = {
  Total: 'Blocks all fish',
  Partial: 'Blocks some fish or some flows',
  Unknown: 'Passage not determined',
  'no-longer-blocking': 'No longer blocking',
};
