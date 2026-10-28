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
import type { SteelheadBasisNote } from './steelhead-trout-references';
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
export const REVIEW_CAVEAT = 'Expert review of these ranges is still under way, so they are provisional. Water depth only.';

interface DepthBand {
  /** Depth (m) below which the water is Unsuitable. */
  unsuitableBelowM: number;
  /** Depth (m) from which the water is Suitable; Marginal lies between. */
  suitableFromM: number;
  /** One line per class for the sidebar key. */
  rangeText: Record<SteelheadDepthClass, string>;
  /** The depth range alone, for the map legend. */
  legendText: Record<SteelheadDepthClass, string>;
  /** Where each edge comes from, shown under "Where the ranges come from", with links to the papers. */
  basis: readonly SteelheadBasisNote[];
}

interface LifeStageRule {
  label: string;
  /**
   * Months (1 = January) of the stage's typical season, first to last, wrapping the year end; null is year-round.
   * The months are the research's population-wide timing for Southern California steelhead. They are not an
   * observation that fish or eggs are in Jalama Creek, and the wording everywhere says "typical".
   */
  seasonMonths: readonly [number, number] | null;
  /** Names the season for the legend, such as "Typical steelhead spawning season". */
  seasonName: string;
  seasonText: string;
  /** Null when the research gives no defensible water-depth band for the stage. */
  depthBand: DepthBand | null;
  /** Shown instead of the ranges when `depthBand` is null. */
  noDepthBandText?: string;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const STEELHEAD_LIFE_STAGE_RULES: Readonly<Record<SteelheadLifeStage, LifeStageRule>> = {
  // Eggs are laid in the nest (redd) the adult builds, so the depth that matters for them is the spawning depth.
  // Research care sheet, "Spawning water depth": ~14 in (36 cm) optimum, range 6–36 in (Stoecker 2002, citing Bovee
  // 1978). The care sheet adds "too shallow prevents redd building", but none of the papers checked on 2026-10-28
  // says that, so the UI does not repeat it. Below 6 in (15 cm) is Unsuitable, 6–14 in is Marginal, and the 14 in
  // optimum is Suitable; the research gives 36 cm as the optimum edge in two places (inches in the care sheet,
  // "≥36 cm" in the water-centric table). Spawn timing is Jan–May (peak Feb–mid-Apr), so the band applies then and
  // is out of season otherwise.
  // This is a stand-in for the nest depth, not an incubation rule: "Egg incubation ... Still needs: temperature/DO,
  // not WSE alone." The "≥8 in" in the gravel row is gravel depth, not water depth, and is not used.
  eggs: {
    label: 'Eggs',
    seasonMonths: [1, 5],
    seasonName: 'Typical steelhead spawning season',
    seasonText: 'Typical steelhead spawning season: Jan–May',
    depthBand: {
      unsuitableBelowM: 0.15,
      suitableFromM: 0.36,
      rangeText: {
        suitable: '≥ 36 cm (14 in): the spawning optimum for a nest.',
        marginal: '15–36 cm: within the 6–36 in spawning range, below the optimum.',
        unsuitable: 'Under 15 cm (6 in): below the low end of the spawning range.',
      },
      legendText: { suitable: '≥ 36 cm deep', marginal: '15–36 cm', unsuitable: 'under 15 cm' },
      basis: [
        {
          text: 'Season: Hanson says spawning occurs in winter or spring, mostly January through March. The Jan–May window and the Feb to mid-April peak come from the CalTrout & UC Davis report. This is research timing for Southern California steelhead, not an observation at Jalama Creek.',
          citations: [
            { source: 'hanson2003', pdfPage: 2 },
            { source: 'caltrout2017', pdfPage: 2, caution: 'page not yet checked' },
          ],
        },
        { text: 'Eggs stay in the gravel after spawning, and the research gives no incubation length.' },
        {
          text: 'Good spawning depths: optimum about 14 in (36 cm), range about 6–36 in (Stoecker 2002, citing Bovee 1978).',
          citations: [
            { source: 'stoecker2002', pdfPage: 16, printedPage: 4 },
            { source: 'scrParkway', section: 'Spawning', textFragment: 'optimal water depth for steelhead spawning' },
          ],
        },
        {
          text: 'Depth over the nest is a stand-in for egg conditions. Incubation also needs cool, oxygenated water through the gravel (temperature and dissolved oxygen), which this app does not carry.',
        },
        { text: 'Marginal is the span between the 6 in minimum and the 14 in optimum (derived, not a published band).' },
      ],
    },
  },
  // Research care sheet, "Rearing pool depth": juveniles prefer 10–20 in (25–51 cm); deep pools critical; shallow warm
  // pools lose oxygen. Freshwater rearing lasts 1–3 years, so the stage is in the creek year-round; summer low flow is
  // the limiting season. The document gives no depth below which a juvenile is lost, so Unsuitable is only "no water
  // over the bed" (the app's own DRY_BELOW_DEPTH_M), not a research cutoff. Suitable starts at the 10 in preference
  // edge (10 in ≈ 25 cm; the document gives inches for this row). Deeper is not penalized: "deep pools critical".
  juveniles: {
    label: 'Juveniles',
    seasonMonths: null,
    seasonName: 'Year-round',
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
        {
          text: 'Suitable edge: juveniles show a preference for depths of 10–20 in (25–51 cm) (Bovee 1978, cited by the CalTrout petition).',
          citations: [{ source: 'caltrout2021Cesa', pdfPage: 12, printedPage: 11 }],
        },
        {
          text: 'Deep pools are important habitat for juveniles, and drought shrinks pool depth in late summer and fall.',
          citations: [{ source: 'hanson2003', pdfPage: 18 }],
        },
        {
          text: "Unsuitable edge: no water over the bed. The research gives no shallower-pool cutoff, so this is the app's dry threshold, not a research value.",
        },
      ],
    },
  },
  // Research care sheet, "Migration water depth": ≥ 7 in (18 cm) minimum for upstream migration. "Spawning water
  // depth": ~14 in (36 cm) optimum, range 6–36 in. The document also says "≥36 cm over clean gravel" in the
  // water-centric table, so 36 cm is the spawning edge. Adults are migration plus spawning, so Marginal is
  // the span between the two research values: passable (≥ 18 cm) but under the spawning optimum. That span is derived
  // from the two numbers, not a published band. Passage is a depth across a riffle; the app's depth is at one anchor
  // point, so it can overstate passability. Season: upstream run Dec–May (peak Jan–Mar); spawn Jan–May.
  // December is migration-only, so Marginal there is stricter than the research requires.
  adults: {
    label: 'Adults',
    seasonMonths: [12, 5],
    seasonName: 'Typical steelhead run season',
    seasonText: 'Typical steelhead run season: Dec–May (upstream run peaks Jan–Mar; spawning Jan–May)',
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
        {
          text: 'Season: upstream migration seldom begins before December and may extend into May, with most migration and spawning January through March (Hanson). The Jan–May spawning window comes from the CalTrout & UC Davis report. This is research timing for Southern California steelhead, not an observation at Jalama Creek.',
          citations: [
            { source: 'hanson2003', pdfPage: 2 },
            { source: 'caltrout2017', pdfPage: 2, caution: 'page not yet checked' },
          ],
        },
        {
          text: 'Unsuitable edge: successful upstream migration needs at least 7 in (18 cm) of water.',
          citations: [
            { source: 'scrParkway', section: 'Adult migration', textFragment: 'minimum depth of 7 in' },
            { source: 'caltrout2021Cesa', pdfPage: 12, printedPage: 11 },
          ],
        },
        {
          text: 'Suitable edge: spawning optimum about 14 in (36 cm), range about 6–36 in (Stoecker 2002, citing Bovee 1978).',
          citations: [
            { source: 'stoecker2002', pdfPage: 16, printedPage: 4 },
            { source: 'scrParkway', section: 'Spawning', textFragment: 'optimal water depth for steelhead spawning' },
          ],
        },
        {
          text: 'Marginal is the span between those two values (derived, not a published band). December is migration-only, so Marginal there is stricter than the research requires.',
        },
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
  'out-of-season': { label: 'Outside typical season', glyph: '–', colorHex: '#64748b' },
};

const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric' });

/** True when this time falls in the stage's typical season (Pacific time, like the rest of the app's dates). */
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

/**
 * Chart bands for one segment, or null when the stage has no depth band.
 * `zeroDepthChartValueM` is the charted value that means zero depth over the bed: 0 when the chart
 * plots depth above the bed, and the bed's height above the gauge datum for the observed gauge
 * segment, whose chart plots gauge height. Classes use depth over the bed, same as the map.
 */
export function steelheadChartBands(
  stage: SteelheadLifeStage,
  zeroDepthChartValueM: number,
): WaterSurfaceConditionBands | null {
  const rule = STEELHEAD_LIFE_STAGE_RULES[stage];
  const band = rule.depthBand;
  if (!band) return null;
  return {
    stageLabel: rule.label,
    zeroDepthChartValueM,
    marginalFromDepthM: band.unsuitableBelowM,
    suitableFromDepthM: band.suitableFromM,
    isOutOfSeason: (timeUtcMs) => !isSteelheadStageInSeason(stage, timeUtcMs),
    describe(chartValueM, timeUtcMs) {
      // Zero depth maps to a bed of 0 here, so the chart value minus its zero point is the depth.
      const condition = classifySteelheadCondition(stage, chartValueM - zeroDepthChartValueM, 0, timeUtcMs);
      if (condition === 'not-rated') return '';
      const display = STEELHEAD_CONDITION_DISPLAY[condition];
      return `${display.glyph} ${display.label} for ${rule.label.toLowerCase()}`;
    },
  };
}
