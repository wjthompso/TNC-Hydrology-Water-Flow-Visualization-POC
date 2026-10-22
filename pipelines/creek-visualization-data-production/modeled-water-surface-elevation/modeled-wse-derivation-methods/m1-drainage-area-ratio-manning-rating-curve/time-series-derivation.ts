import type { TimeSeriesDerivation } from '../../stage-file-formats.ts';
import {
  CROSS_SECTION,
  DRAINAGE_AREA_RATIO_TRANSFER,
  MANNING_ROUGHNESS_BASIS,
  MAXIMUM_TRANSFER_DISTANCE_M,
  RATING_CURVE,
} from './method-config.ts';

/**
 * The machine-readable description of this method that Stage 5 writes into `catalog.json` for each
 * modeled WSE Time Series, and that a frozen Data-Product Version carries in `version.json`
 * (`derivation`). METHOD.md is the prose version; keep the two in step.
 */

const DRAINAGE_AREA_RATIO_CITATIONS = [
  'https://pubs.usgs.gov/tm/2006/tm4a6/', // Ries (2007), The National Streamflow Statistics Program, USGS TM 4-A6
  'https://pubs.usgs.gov/sir/2005/5017/', // Emerson, Vecchia, and Dahl (2005), USGS SIR 2005-5017
];

/** Every Dataset shares this method; only the discharge Publisher differs. */
export function timeSeriesDerivation(dischargePublisherName: string, derivedBy: string): TimeSeriesDerivation {
  return {
    derivedFrom: 'discharge',
    method:
      `Manning's equation (normal depth, divided channel) on USGS 3DEP 1 m cross-sections, ` +
      `n = ${RATING_CURVE.manningRoughnessN} main channel, ${RATING_CURVE.floodplainManningRoughnessN} floodplain; ` +
      'reach discharge scaled to each Creek Segment by the USGS drainage-area ratio method ' +
      '(segment drainage area ÷ NHDPlusV2 reach drainage area, capped at 1)',
    derivedBy,
    inputs: [
      { role: 'discharge', source: `${dischargePublisherName} modeled discharge per NHDPlusV2 reach` },
      { role: 'terrain', source: 'USGS 3DEP 1 m bare-earth lidar terrain' },
      { role: 'segment drainage area', source: 'Dangermond Preserve 2018 flow-accumulation raster (JLDP_Flow_Accumulation_2018, 2 m cells)' },
      { role: 'reach drainage area', source: 'NHDPlusV2 TotDASqKm from the EPA NHDPlus flowline service' },
    ],
    steps: [
      'Map each Creek Segment to the NHDPlusV2 reach whose catchment contains it (reviewed crosswalk).',
      `Mark a segment on a creek with no NHDPlusV2 reach of its own as ${DRAINAGE_AREA_RATIO_TRANSFER.fieldName}: it borrows the nearest ` +
        `reach of a neighbouring creek, or gets no discharge when that reach is more than ${MAXIMUM_TRANSFER_DISTANCE_M} m away.`,
      'Scale the reach discharge by the drainage-area ratio, segment area ÷ reach area, capped at 1.',
      'Build a divided-channel Manning rating curve (main channel plus left and right floodplain) from 3DEP cross-sections.',
      'Look up the water-surface elevation that carries each discharge on that rating curve.',
      'Clamp any discharge above the rating-curve top to the top water-surface elevation.',
    ],
    parameters: [
      {
        name: "main-channel Manning's n",
        value: RATING_CURVE.manningRoughnessN,
        unit: '',
        ...MANNING_ROUGHNESS_BASIS.mainChannel,
      },
      {
        name: "floodplain Manning's n",
        value: RATING_CURVE.floodplainManningRoughnessN,
        unit: '',
        ...MANNING_ROUGHNESS_BASIS.floodplain,
      },
      {
        name: 'cross-section half-width',
        value: CROSS_SECTION.halfWidthM,
        unit: 'm',
        basis: 'Sampled each side of the TNC flowline, far enough to include floodplain; each side is then trimmed at its valley edge.',
        citations: [],
      },
      {
        name: 'minimum bed slope',
        value: CROSS_SECTION.minimumSlope,
        unit: 'm/m',
        basis: 'Floor for the least-squares bed slope, so a flat or noisy reach still has a finite rating curve.',
        citations: [],
      },
      {
        name: 'drainage-area ratio cap',
        value: 1,
        unit: '',
        basis: 'USGS drainage-area ratio method; the cap means a Creek Segment never gets more flow than its reach.',
        citations: DRAINAGE_AREA_RATIO_CITATIONS,
      },
      {
        name: 'maximum transfer distance',
        value: MAXIMUM_TRANSFER_DISTANCE_M,
        unit: 'm',
        basis:
          `A ${DRAINAGE_AREA_RATIO_TRANSFER.label} segment whose midpoint is farther than this from the borrowed NHDPlusV2 reach ` +
          'gets no discharge, because a reach that far away is not a credible stand-in for the creek.',
        citations: DRAINAGE_AREA_RATIO_CITATIONS,
      },
    ],
    assumptions: [
      'Steady, uniform flow (normal depth) on one representative cross-section per Creek Segment.',
      'Bare-earth lidar cannot see the underwater bed, so the modeled bed is the water surface on the survey date and true depths are larger.',
      "Runoff per unit area is the same across a reach's catchment (the drainage-area ratio assumption), " +
        `and for a ${DRAINAGE_AREA_RATIO_TRANSFER.label} segment also across the neighbouring creek's catchment it borrows from.`,
      'The divided channel ignores momentum exchange between the main channel and the floodplains.',
    ],
    sensitivity:
      'Depth scales with n^(3/5), so ±25% roughness changes depth by about ±15%, smaller than the 2–5× discharge uncertainty.',
  };
}
