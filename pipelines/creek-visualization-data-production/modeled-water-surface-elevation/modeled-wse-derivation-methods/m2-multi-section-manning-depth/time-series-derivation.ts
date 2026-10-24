import type { TimeSeriesDerivation } from '../../stage-file-formats.ts';
import {
  CROSS_SECTION,
  DRAINAGE_AREA_RATIO_TRANSFER,
  MANNING_ROUGHNESS_BASIS,
  MAXIMUM_TRANSFER_DISTANCE_M,
  RATING_CURVE,
} from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { ANCHOR_POSITION_ALONG_SEGMENT, JUNCTION_DEPTH, LOCAL_BED_SLOPE } from './method-config.ts';

/**
 * The machine-readable description of m2 for `catalog.json` and a frozen `version.json`
 * (`derivation`), in the same shape as m1's. METHOD.md is the prose version; keep the two in step.
 */

const DRAINAGE_AREA_RATIO_CITATIONS = [
  'https://pubs.usgs.gov/tm/2006/tm4a6/', // Ries (2007), The National Streamflow Statistics Program, USGS TM 4-A6
  'https://pubs.usgs.gov/sir/2005/5017/', // Emerson, Vecchia, and Dahl (2005), USGS SIR 2005-5017
];

const HEIGHT_ABOVE_NEAREST_DRAINAGE_CITATIONS = [
  'https://doi.org/10.1016/j.jhydrol.2011.03.051', // Nobre et al. (2011), Height Above the Nearest Drainage
  'https://doi.org/10.1111/1752-1688.12474', // Zheng, Tarboton, Maidment et al. (2018), HAND flood inundation mapping, JAWRA
];

export function timeSeriesDerivation(dischargePublisherName: string, derivedBy: string): TimeSeriesDerivation {
  return {
    derivedFrom: 'discharge',
    method:
      `Manning's equation (normal depth, divided channel) at the mid-segment (anchor) USGS 3DEP 1 m cross-section of each Creek Segment, with its own bed and a ` +
      `local bed slope, n = ${RATING_CURVE.manningRoughnessN} main channel, ${RATING_CURVE.floodplainManningRoughnessN} floodplain; ` +
      `the water depth at each junction is the mean of the neighbouring raw anchor depths within ±${JUNCTION_DEPTH.smoothingHalfWindowM} m along the flowline, ` +
      'and the WSE of a segment is the WSE of that smoothed surface at the segment’s anchor point (the raw Manning WSE at the anchor is kept as rawAnchorWseM); ' +
      'reach discharge scaled to each Creek Segment by the USGS drainage-area ratio method (segment drainage area ÷ NHDPlusV2 reach drainage area, capped at 1)',
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
      `Fit a local bed slope at the middle (anchor) one of the segment's ${CROSS_SECTION.sectionsPerSegment} cross-sections from every section bed within ±${LOCAL_BED_SLOPE.halfWindowM} m along the flowline.`,
      'Build a divided-channel Manning rating curve at the anchor section, on its own valley-edge-trimmed 3DEP profile and bed.',
      'Look up the WSE that carries each discharge at the anchor section (the raw Manning anchor WSE, saved as rawAnchorWseM; raw anchor depth = WSE − anchor bed).',
      `At each shared vertex, give both neighbouring segments one depth: the length-weighted mean of the wet raw anchor depths within ±${JUNCTION_DEPTH.smoothingHalfWindowM} m along the flowline. ` +
        'A flowline end, or a vertex next to a dry or missing segment, keeps the segment’s own raw anchor depth, and a dry segment stays 0.',
      'Give both neighbouring segments the mean of their end-section beds at each shared vertex.',
      `Set the segment’s WSE (the Time Series value) to the WSE of the smoothed surface at its anchor point: anchor bed + the junction depths interpolated to ${ANCHOR_POSITION_ALONG_SEGMENT} of the way along the segment, ` +
        'so the chart shows the water that is drawn there. A dry segment has depth 0 and a WSE equal to its anchor bed.',
      'Clamp any discharge above a rating-curve top to the top water-surface elevation.',
    ],
    parameters: [
      { name: "main-channel Manning's n", value: RATING_CURVE.manningRoughnessN, unit: '', ...MANNING_ROUGHNESS_BASIS.mainChannel },
      { name: "floodplain Manning's n", value: RATING_CURVE.floodplainManningRoughnessN, unit: '', ...MANNING_ROUGHNESS_BASIS.floodplain },
      {
        name: 'local bed slope half-window',
        value: LOCAL_BED_SLOPE.halfWindowM,
        unit: 'm',
        basis: 'Short enough to keep a steep drop within one Creek Segment (median length 30.5 m) from being averaged with the flatter reach around it.',
        citations: [],
      },
      {
        name: 'junction depth smoothing half-window',
        value: JUNCTION_DEPTH.smoothingHalfWindowM,
        unit: 'm',
        basis:
          'Independent Manning solves at neighbouring sections disagree by metres on flat reaches, so the junction depth averages the raw anchor depths along the flowline. ' +
          '100 m is the widest window that leaves steep reaches no worse than the end-section solves of m2-v1.',
        citations: [],
      },
      {
        name: 'minimum bed slope',
        value: LOCAL_BED_SLOPE.minimumSlope,
        unit: 'm/m',
        basis: 'Floor for the least-squares bed slope, so a flat or noisy reach still has a finite rating curve (same as m1).',
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
      'Steady, uniform flow (normal depth) at each solved cross-section, with the local bed slope standing in for the energy slope.',
      "Manning's equation is weak on slopes above about 4–10% and in step-pool channels, where much of the energy is lost at steps.",
      'Bare-earth lidar cannot see the underwater bed, so the modeled bed is the water surface on the survey date and true depths are larger.',
      "Runoff per unit area is the same across a reach's catchment (the drainage-area ratio assumption), " +
        `and for a ${DRAINAGE_AREA_RATIO_TRANSFER.label} segment also across the neighbouring creek's catchment it borrows from.`,
      'Water is drawn at a depth above the local bed (height above nearest drainage), so the surface runs parallel to the bed instead of flat.',
      'The water surface follows the junction bed plus a smoothed depth, so it keeps the bed slope instead of the section-to-section jumps of independent normal depths. ' +
        'The WSE of a segment (`values`) is that smoothed surface at the anchor point; the raw Manning WSE at the anchor section (`rawAnchorWseM`) can differ from it by up to the depth change along the smoothing window.',
    ],
    sensitivity:
      'Depth scales with n^(3/5) and slope^(−3/10), so ±25% roughness changes depth by about ±15% and a 2× slope error by about ±19%, both smaller than the 2–5× discharge uncertainty. ' +
      `Height-above-nearest-drainage drawing: ${HEIGHT_ABOVE_NEAREST_DRAINAGE_CITATIONS.join(', ')}.`,
  };
}
