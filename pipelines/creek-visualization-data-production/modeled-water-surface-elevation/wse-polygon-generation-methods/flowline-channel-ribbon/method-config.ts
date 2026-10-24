import type { WsePolygonGenerationMethodConfig } from '../wse-polygon-generation-method.ts';

/**
 * WSE Polygon Generation Method `flowline-channel-ribbon`: the water of a creek drawn as ONE continuous ribbon along the flowline's
 * smoothed channel centerline (the channel of `m3-flowline-profile-manning-depth`) instead of a raster flood-fill footprint per Creek
 * Segment. Read METHOD.md for the full description and DESIGN.md for why it replaced the flood fill.
 *
 * The data model is a LADDER OF MORPH TARGETS: per Creek Segment one bucket per depth rung, and every bucket holds one ring with the same
 * vertices in the same order (the left edge of the ribbon at stations 0…n−1 from upstream to downstream, then the right edge from n−1 back to 0),
 * each vertex `[longitude, latitude, bedProfileElevationM]`. The browser (`browserDrawing: 'channel-ribbon-depth'`) takes the water depth at
 * every station (the junction depths interpolated between the segment's two ends), picks the two rungs around it, and slides each station's
 * two edge vertices between them, at z = bed profile + depth. Width and depth therefore change continuously with time, and neighbouring
 * Creek Segments meet exactly because they share the same boundary station and the same junction depth. Needs an m3 Time Series.
 *
 * Changing anything in this folder or a parameter below changes the output, so bump `version` with it.
 */

const PIPELINE_CODE_FOLDER = 'pipelines/creek-visualization-data-production';
const MODELED_WSE_CODE_FOLDER = `${PIPELINE_CODE_FOLDER}/modeled-water-surface-elevation`;
const M3_FOLDER = `${MODELED_WSE_CODE_FOLDER}/modeled-wse-derivation-methods/m3-flowline-profile-manning-depth`;

/**
 * The display rule the browser applies on top of the true data, declared here so the version's manifest records it. On 38 sampled segments
 * against the emulated browser terrain mesh, true-depth ribbons on 10–40% slopes were a median 51–55% visible; floor 0.25 m alone 65–67%;
 * floor 0.15 m plus lift 0.3 m 86–88% (METHOD.md "Evidence"). The rule ramps in with the bed slope so neighbours of similar slope meet without a step.
 */
export const DISPLAY_RULE = {
  /** Drawn depth is at least this on a fully steep segment; the drawn width follows the drawn depth. */
  minimumDrawnDepthM: 0.15,
  /** The drawn surface is raised this much on a fully steep segment. */
  surfaceLiftM: 0.3,
  /** Both scale with smoothstep((bed slope − rampStartSlope) / (rampFullSlope − rampStartSlope)). */
  rampStartSlope: 0.03,
  rampFullSlope: 0.08,
  /** URL parameters that override the two full-ramp values (0 and 0 draws true water). */
  urlParameters: ['ribbonDisplayFloorM', 'ribbonDisplayLiftM'],
} as const;

export const FLOWLINE_CHANNEL_RIBBON_METHOD = {
  id: 'flowline-channel-ribbon',
  label: 'Flowline channel ribbon',
  version: 1,
  description:
    'One continuous ribbon of water along the channel centerline of each flowline (the TNC flowline smoothed and moved sideways to the lidar valley bottom). At every station a 1-D cross-section flood gives the water ' +
    'edges for a ladder of depths; the edges are smoothed along the creek and kept monotone with depth, and the browser morphs between the depth rungs at the ' +
    'true water depth of each station, so width changes continuously with time and neighbouring Creek Segments meet exactly. ' +
    `Display exaggeration on steep reaches (ramping in between ${DISPLAY_RULE.rampStartSlope * 100}% and ${DISPLAY_RULE.rampFullSlope * 100}% bed slope): drawn at least ${DISPLAY_RULE.minimumDrawnDepthM} m deep and lifted ${DISPLAY_RULE.surfaceLiftM} m so it clears the drawn terrain mesh; ` +
    `add ?${DISPLAY_RULE.urlParameters[0]}=0&${DISPLAY_RULE.urlParameters[1]}=0 for true water. The Time Series and the chart keep true values. Built on m3-v1.`,
  browserDrawing: 'channel-ribbon-depth',
  sharedCodeFiles: [
    ...['flowline-channel.ts', 'lidar-mosaic.ts', 'series-smoothing.ts', 'method-config.ts'].map((fileName) => `${M3_FOLDER}/${fileName}`),
    `${PIPELINE_CODE_FOLDER}/utm-geometry.ts`,
  ],
  parameters: {
    changeNote: 'first version',
    bucketUnits:
      'DEPTH in meters above the local thalweg: minWaterSurfaceElevationM / maxWaterSurfaceElevationM hold depths for this method, not elevations. Bucket r spans rung r to rung r + 1; the last bucket spans to 100 m. ' +
      'A depth below the first rung (1 cm) is dry and has no bucket. The browser tapers the ribbon to its midline between depth 0 and the first rung.',
    /**
     * Depth rungs, meters above the local thalweg. Finer near the bottom, where a few centimeters change the width of a steep stream by
     * a factor of two, and coarser above 1 m, where width follows the valley walls slowly. The top rung (8 m) is above the largest depth
     * modeled on the Preserve (7.1 m at the Jalama peak); deeper water is drawn at the top rung's width.
     */
    rungDepthsM: [0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8],
    topBucketMaximumDepthM: 100,
    crossSectionFlood:
      'per station, ground sampled along the line perpendicular to the smoothed centerline (0.5 m apart within 12 m, 1 m out to 100 m), seeded at the lowest ground within the thalweg search width of the centerline; ' +
      'each side walks outward while the ground is below thalweg + rung depth and stops at the first sample at or above it (linear interpolation) or at NoData; a station whose centerline ground is above the level has no flood and takes its width from the neighbours',
    edgeSmoothing: {
      rule: 'per rung and side along the creek: gaps filled by interpolation, median filter, then Gaussian; the two sides are smoothed independently; after the width cap and floor, one more Gaussian; then the rungs are made monotone with depth and the inside-of-bend cap applied',
      medianWindowM: 7,
      gaussianSigmaM: 3,
      /** After the width floor and cap, both edges are smoothed once more with this Gaussian, so floored thin water does not wiggle. */
      finalGaussianSigmaM: 3,
    },
    minimumTopWidthM: 1,
    maximumTopWidth: {
      rule: 'a film of water a few centimeters deep does not spread over a flat valley floor: top width ≤ baseM + perMeterOfDepthM × rung depth',
      baseM: 3,
      perMeterOfDepthM: 80,
    },
    innerBendRadiusFraction: 0.7,
    innerBendRule: 'on the inside of a bend an edge reaches at most this fraction of the radius of curvature (strongest bend within the curvature window), so cross-sections do not cross',
    monotoneWithDepth: 'a deeper rung is never narrower than the one below, on either side',
    stationSpacing: {
      targetM: 2,
      rule: 'each Creek Segment gets n = 2 × ceil(length ÷ (2 × targetM)) + 1 stations (odd, at least 3), evenly spaced from its upstream boundary to its downstream boundary, so the middle station is exactly the WSE Anchor Point',
    },
    ringVertex:
      '[longitude, latitude, bedProfileElevationM]: 7 decimals for longitude and latitude, 3 for the bed profile elevation (m NAVD88) at the station. One closed-by-the-renderer ring per bucket: left edge stations 0…n−1, then right edge stations n−1…0 (clockwise)',
    channelRibbonFields:
      'each polygon set also carries channelRibbon: { stationCount, lengthM, anchorLonLat, anchorBedElevationM, trueTopWidthAtAnchorM[rung], displayTopWidthAtAnchorM[rung] } — true is the smoothed lidar flood width before the display floors, display is the drawn width',
    displayRule: DISPLAY_RULE,
    displayRuleNote:
      'applied in the browser, never stored in the data: with ramp = smoothstep of the segment bed slope between rampStartSlope and rampFullSlope, drawn depth = max(true depth, ramp × minimumDrawnDepthM) (a true depth under 1 cm stays dry), drawn width = the ribbon width at the drawn depth, drawn z = bed profile + drawn depth + ramp × surfaceLiftM',
    ladderSummary:
      'bedElevationM = bed profile elevation at the anchor point; maxModeledWaterSurfaceElevationM = ceilingM = anchor bed + the top rung depth (the ribbon ladder does not depend on the modeled depths)',
    fileLayout: 'one compact JSON file per TNC flowline: water-surface-polygon-sets/<tncComid>.json',
  },
} as const satisfies WsePolygonGenerationMethodConfig;
