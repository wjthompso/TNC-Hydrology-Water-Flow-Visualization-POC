// Steelhead trout conditions (UCS-293): classifies one Creek Segment's water
// depth at one time against one steelhead life stage (eggs, juveniles, or
// adults), as Suitable (green), Marginal (yellow), or Unsuitable (red). The
// same rule colors the Water-Surface Elevation Chart bands and the creek water
// on the map.
//
// !! UNDER HUMAN REVIEW (AI generated) !!
// Every threshold and season below comes from the Linear document "Steelhead
// Trout Conditions Research Result" (28d07104-ee40-46cc-bcf0-c8a553a5ebf6),
// which is marked "UNDER HUMAN REVIEW (The following is AI generated)". Treat
// the numbers as provisional, transferable reference ranges from the Santa
// Ynez / Ventura proxy watersheds, not Jalama Creek measurements. A fisheries
// biologist should confirm them before any published claim. The UI says so
// (REVIEW_CAVEAT below). Replace the constants here and nothing else changes.
//
// Scope: water depth only. The app has water-surface elevation (WSE), not
// temperature, dissolved oxygen, velocity, or gravel, so none of those feed
// the classes. Depth = WSE − bed elevation at the segment's WSE anchor point;
// a segment without a bed elevation in the dataset is "not rated" rather than
// guessed.

import { DRY_BELOW_DEPTH_M } from './display-depth-floor';
import type { WaterSurfaceConditionBands } from './water-surface-elevation-chart';

export type SteelheadLifeStage = 'eggs' | 'juveniles' | 'adults';

export type SteelheadDepthClass = 'suitable' | 'marginal' | 'unsuitable';

/** What a segment shows on the map: a depth class, or why it has none. */
export type SteelheadCondition =
  | SteelheadDepthClass
  /** The life stage is not in the water at this time of year (research timing). */
  | 'out-of-season'
  /** No depth band for the life stage, or no bed elevation for the segment. */
  | 'not-rated';

export const STEELHEAD_LIFE_STAGES: readonly SteelheadLifeStage[] = ['eggs', 'juveniles', 'adults'];

/** Short, always-visible caveat; the long form lives in the research document and the code comment above. */
export const REVIEW_CAVEAT = 'Research under human review (AI generated). Ranges are provisional; water depth only.';

interface DepthBand {
  /** Depth (m) below which the water is Unsuitable. */
  unsuitableBelowM: number;
  /** Depth (m) from which the water is Suitable; Marginal lies between. */
  suitableFromM: number;
  /** One line per class for the sidebar key. */
  rangeText: Record<SteelheadDepthClass, string>;
  /** The depth range alone, for the map legend. */
  legendText: Record<SteelheadDepthClass, string>;
  /** Where each edge comes from, shown under "Where the ranges come from". */
  basis: readonly string[];
}

interface LifeStageRule {
  label: string;
  /** Months (1 = January) the stage is in the creek, first to last, wrapping the year end; null is year-round. */
  seasonMonths: readonly [number, number] | null;
  seasonText: string;
  /** Null when the research gives no defensible water-depth band for the stage. */
  depthBand: DepthBand | null;
  /** Shown instead of the ranges when `depthBand` is null. */
  noDepthBandText?: string;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const STEELHEAD_LIFE_STAGE_RULES: Readonly<Record<SteelheadLifeStage, LifeStageRule>> = {
  // Research: "Egg incubation: cool oxygenated intragravel flow ... stable WSE keeping redds wetted ... Still needs:
  // temperature/DO, not WSE alone." The "≥8 in" in the gravel row is gravel depth, not water depth. No water-depth
  // cutoff exists for eggs, so none is invented here. Spawn timing (Jan–May) is the egg-laying window; the
  // document gives no separate incubation window, so eggs are not graded out of season.
  eggs: {
    label: 'Eggs',
    seasonMonths: null,
    seasonText: 'Spawning Jan–May (peak Feb–mid-Apr). The research gives no separate incubation window.',
    depthBand: null,
    noDepthBandText:
      'The research gives no water-depth band for eggs. Incubation depends on cool, oxygenated water through the gravel (temperature and dissolved oxygen), which this app does not carry. Water level alone can only hint whether nests stay wet.',
  },
  // Research care sheet, "Rearing pool depth": juveniles prefer 10–20 in (25–51 cm); deep pools critical; shallow warm
  // pools lose oxygen. Freshwater rearing lasts 1–3 years, so the stage is in the creek year-round; summer low flow is
  // the limiting season. The document gives no depth below which a juvenile is lost, so Unsuitable is only "no water
  // over the bed" (the app's own DRY_BELOW_DEPTH_M), not a research cutoff. Suitable starts at the 10 in preference
  // edge (10 in ≈ 25 cm; the document gives inches for this row). Deeper is not penalized: "deep pools critical".
  juveniles: {
    label: 'Juveniles',
    seasonMonths: null,
    seasonText: 'Year-round (1–3 years in freshwater). Summer low flow is the limiting season.',
    depthBand: {
      unsuitableBelowM: DRY_BELOW_DEPTH_M,
      suitableFromM: 0.25,
      rangeText: {
        suitable: '≥ 25 cm (10 in). Preferred pool depth 10–20 in; deeper pools are not penalized.',
        marginal: 'Under 25 cm: shallower than preferred; shallow pools lose oxygen.',
        unsuitable: 'No water over the bed (under 1 cm).',
      },
      legendText: { suitable: '≥ 25 cm deep', marginal: 'under 25 cm', unsuitable: 'no water over the bed' },
      basis: [
        'Suitable edge: juveniles prefer 10–20 in (25–51 cm) pools (Hanson 2003; CalTrout CESA petition 2021).',
        'Unsuitable edge: no water over the bed. The research gives no shallower-pool cutoff, so this is the app\'s dry threshold, not a research value.',
      ],
    },
  },
  // Research care sheet, "Migration water depth": ≥ 7 in (18 cm); shallower blocks passage. "Spawning water depth":
  // ~14 in (36 cm) optimum, range 6–36 in; too shallow prevents redd building. The document also says "≥36 cm over clean
  // gravel" in the water-centric table, so 36 cm is the spawning edge. Adults are migration plus spawning, so Marginal is
  // the span between the two research values: passable (≥ 18 cm) but under the spawning optimum. That span is derived
  // from the two numbers, not a published band. Passage is a depth across a riffle; the app's depth is at one anchor
  // point, so it can overstate passability. Season: upstream run Dec–May (peak Jan–Mar); spawn Jan–May.
  // December is migration-only, so Marginal there is stricter than the research requires.
  adults: {
    label: 'Adults',
    seasonMonths: [12, 5],
    seasonText: 'In the creek Dec–May (upstream run peaks Jan–Mar; spawning Jan–May).',
    depthBand: {
      unsuitableBelowM: 0.18,
      suitableFromM: 0.36,
      rangeText: {
        suitable: '≥ 36 cm (14 in): meets the spawning optimum.',
        marginal: '18–36 cm: passable, below the spawning optimum.',
        unsuitable: 'Under 18 cm (7 in): blocks upstream passage.',
      },
      legendText: { suitable: '≥ 36 cm deep', marginal: '18–36 cm', unsuitable: 'under 18 cm' },
      basis: [
        'Unsuitable edge: migration needs ≥ 7 in (18 cm); shallower blocks passage (SCR Parkway adult migration; Hanson 2003).',
        'Suitable edge: spawning optimum ~14 in (36 cm), range 6–36 in (SCR Parkway spawning; Stoecker 2002).',
        'Marginal is the span between those two values (derived, not a published band). December is migration-only, so Marginal there is stricter than the research requires.',
      ],
    },
  },
};

/** Display colors per condition. Hex values feed the map; the matching Tailwind shades are in index.html and the chart. */
export const STEELHEAD_CONDITION_DISPLAY: Readonly<
  Record<Exclude<SteelheadCondition, 'not-rated'>, { label: string; glyph: string; colorHex: string }>
> = {
  suitable: { label: 'Suitable', glyph: '✓', colorHex: '#22c55e' },
  marginal: { label: 'Marginal', glyph: '!', colorHex: '#facc15' },
  unsuitable: { label: 'Unsuitable', glyph: '✕', colorHex: '#dc2626' },
  'out-of-season': { label: 'Out of season', glyph: '–', colorHex: '#64748b' },
};

const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric' });

/** True when the stage is in the creek at this time (Pacific time, like the rest of the app's dates). */
export function isSteelheadStageInSeason(stage: SteelheadLifeStage, timeUtcMs: number): boolean {
  const months = STEELHEAD_LIFE_STAGE_RULES[stage].seasonMonths;
  if (!months) return true;
  const month = Number(monthFormatter.format(timeUtcMs));
  const [first, last] = months;
  return first <= last ? month >= first && month <= last : month >= first || month <= last;
}

export function formatSteelheadSeason(stage: SteelheadLifeStage): string {
  const months = STEELHEAD_LIFE_STAGE_RULES[stage].seasonMonths;
  return months ? `${MONTH_NAMES[months[0] - 1]}–${MONTH_NAMES[months[1] - 1]}` : 'Year-round';
}

/** Depth class for a depth in meters; assumes the stage has a depth band. */
function classifyDepth(band: DepthBand, depthM: number): SteelheadDepthClass {
  if (depthM < band.unsuitableBelowM) return 'unsuitable';
  return depthM < band.suitableFromM ? 'marginal' : 'suitable';
}

/**
 * The condition of one segment at one time. Season is checked first: out of
 * season shows gray even when the depth would be Suitable. A missing reading,
 * a missing bed elevation, or a stage without a depth band is "not rated".
 */
export function classifySteelheadCondition(
  stage: SteelheadLifeStage,
  waterSurfaceElevationM: number | null,
  bedElevationM: number | null,
  timeUtcMs: number,
): SteelheadCondition {
  const rule = STEELHEAD_LIFE_STAGE_RULES[stage];
  if (!rule.depthBand || waterSurfaceElevationM === null || bedElevationM === null) return 'not-rated';
  if (!isSteelheadStageInSeason(stage, timeUtcMs)) return 'out-of-season';
  return classifyDepth(rule.depthBand, waterSurfaceElevationM - bedElevationM);
}

/** Chart bands for one segment, or null when the stage has no depth band. */
export function steelheadChartBands(
  stage: SteelheadLifeStage,
  bedElevationM: number,
): WaterSurfaceConditionBands | null {
  const rule = STEELHEAD_LIFE_STAGE_RULES[stage];
  const band = rule.depthBand;
  if (!band) return null;
  return {
    stageLabel: rule.label,
    bedElevationM,
    marginalFromDepthM: band.unsuitableBelowM,
    suitableFromDepthM: band.suitableFromM,
    isOutOfSeason: (timeUtcMs) => !isSteelheadStageInSeason(stage, timeUtcMs),
    describe(waterSurfaceElevationM, timeUtcMs) {
      const condition = classifySteelheadCondition(stage, waterSurfaceElevationM, bedElevationM, timeUtcMs);
      if (condition === 'not-rated') return '';
      const display = STEELHEAD_CONDITION_DISPLAY[condition];
      return `${display.glyph} ${display.label} for ${rule.label.toLowerCase()}`;
    },
  };
}
