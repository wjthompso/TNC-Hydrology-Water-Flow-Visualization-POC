import type { WsePolygonGenerationMethodConfig } from '../wse-polygon-generation-method.ts';

/**
 * WSE Polygon Generation Method `flowline-channel-ribbon`: the water of a creek drawn as ONE continuous ribbon along the flowline's
 * smoothed channel centerline (the channel of `m3-flowline-profile-manning-depth`) instead of a raster flood-fill footprint per Creek
 * Segment. Read METHOD.md for the full description and DESIGN.md for why it replaced the flood fill.
 *
 * The data model is a LADDER OF MORPH TARGETS: per Creek Segment one bucket per depth rung, and every bucket holds one ring with the same
 * vertices in the same order (the left edge of the ribbon at stations 0…n−1 from upstream to downstream, then the right edge from n−1 back to 0),
 * each vertex `[longitude, latitude, bedM]`. The browser (`browserDrawing: 'channel-ribbon-pool-filled'`) pool-fills the water surface along
 * the run from the junction depths and the stations' distances along it (m3's `pool-filled-water-surface.ts`, the rule Stage 3 writes the Time
 * Series with: the water smoothed over a window scaled by its depth, then pool-filled), picks the two rungs
 * around each station's depth (surface − bed), and slides that station's two edge vertices between them, at z = the surface. Width and depth
 * therefore change continuously with time, and neighbouring Creek Segments meet exactly because they share the same boundary station and
 * surface. The polygons do not depend on the modeled depths. Needs an m3 Time Series.
 *
 * Changing anything in this folder or a parameter below changes the output, so bump `version` with it.
 */

const PIPELINE_CODE_FOLDER = 'pipelines/creek-visualization-data-production';
const MODELED_WSE_CODE_FOLDER = `${PIPELINE_CODE_FOLDER}/modeled-water-surface-elevation`;
const M3_FOLDER = `${MODELED_WSE_CODE_FOLDER}/modeled-wse-derivation-methods/m3-flowline-profile-manning-depth`;

/**
 * The display rule the browser can apply on top of the true data, declared here so the version's manifest records it. Version 1 drew with it on;
 * from version 2 it is off unless the URL parameters ask for it (Will: phase 4 replaces it with a clearance lift at the anchor). On 38 sampled segments
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
  /** URL parameters that set the two full-ramp values (0 and 0 draws true water). */
  urlParameters: ['ribbonDisplayFloorM', 'ribbonDisplayLiftM'],
  /** Whether the browser applies the rule when neither URL parameter is given. */
  onByDefault: false,
} as const;

export const FLOWLINE_CHANNEL_RIBBON_METHOD = {
  id: 'flowline-channel-ribbon',
  label: 'Flowline channel ribbon',
  version: 2,
  description:
    'One continuous ribbon of water along the channel of each flowline, on the raw 1 m lidar bed at the creek’s lowest point of every station (no bed smoothing; road and railroad fills breached). At every station a 1-D cross-section flood gives the water ' +
    'edges for a ladder of depths; the edges are smoothed along the creek and kept monotone with depth. The browser smooths the water surface over ±5 × its depth and pool-fills it along the run (pools behind steps stand level, deep water drowns the bumps of the bed) ' +
    'and morphs between the depth rungs at each station’s own depth below that surface, so width changes continuously with time and neighbouring Creek Segments meet exactly. ' +
    `True water by default; ?${DISPLAY_RULE.urlParameters[0]}=0.15&${DISPLAY_RULE.urlParameters[1]}=0.3 turns on version 1’s steep-reach display exaggeration. The Time Series and the chart keep true values. Built on m3-v2.`,
  browserDrawing: 'channel-ribbon-pool-filled',
  sharedCodeFiles: [
    ...['flowline-channel.ts', 'lidar-mosaic.ts', 'series-smoothing.ts', 'method-config.ts'].map((fileName) => `${M3_FOLDER}/${fileName}`),
    `${MODELED_WSE_CODE_FOLDER}/modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts`,
    ...['creek-segment-network.ts', 'stage-file-formats.ts'].map((fileName) => `${MODELED_WSE_CODE_FOLDER}/${fileName}`),
    ...['utm-geometry.ts', 'creek-segment-adjacency.ts', 'water-surface-polygon-generation.ts'].map((fileName) => `${PIPELINE_CODE_FOLDER}/${fileName}`),
  ],
  parameters: {
    changeNote:
      'version 2: built on m3-v2. Stations sit on the creek’s lowest point with the raw lidar (breached through tall short barriers) as ring z and the flood level; m3’s water-surface stations (shared with Stage 3); ' +
      'anchor at the lowest point with anchorStation, downstreamSegmentId and stationDistancesM saved; drawn pool-filled (browserDrawing channel-ribbon-pool-filled, the water smoothed over ±5 × its depth first) with the display rule off by default',
    bucketUnits:
      'DEPTH in meters above the station’s bed: minWaterSurfaceElevationM / maxWaterSurfaceElevationM hold depths for this method, not elevations. Bucket r spans rung r to rung r + 1; the last bucket spans to 100 m. ' +
      'A depth below the first rung (1 cm) is dry and has no bucket. The browser tapers the ribbon to its midline between depth 0 and the first rung.',
    /**
     * Depth rungs, meters above the station’s bed. Finer near the bottom, where a few centimeters change the width of a steep stream by
     * a factor of two, and coarser above 1 m, where width follows the valley walls slowly. The top rung (8 m) is above the largest depth
     * modeled on the Preserve (7.1 m at the Jalama peak); deeper water is drawn at the top rung's width.
     */
    rungDepthsM: [0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8],
    topBucketMaximumDepthM: 100,
    crossSectionFlood:
      'per station, ground sampled along the line perpendicular to the smoothed centerline (0.5 m apart within 12 m, 1 m out to 100 m), seeded at the station’s lowest point (where its bed was measured); ' +
      'each side walks outward while the ground is below bed + rung depth and stops at the first sample at or above it (linear interpolation) or at NoData; a station whose lowest point is above the level (every rung below the fill on a breached barrier) has no flood and takes its width from the neighbours',
    edgeSmoothing: {
      rule: 'per rung and side along the creek: gaps filled by interpolation, median filter, then Gaussian; the two sides are smoothed independently; after the width cap and floor (both centred on the lowest point as far as the flood allows), one more Gaussian, then each edge kept thalwegInsideMarginM outside the lowest point; then the rungs are made monotone with depth and the inside-of-bend cap applied',
      medianWindowM: 7,
      gaussianSigmaM: 3,
      /** After the width floor and cap, both edges are smoothed once more with this Gaussian, so floored thin water does not wiggle. */
      finalGaussianSigmaM: 3,
    },
    minimumTopWidthM: 1,
    /**
     * Every rung's edges keep the station's lowest point (where its bed was measured) at least this far inside: the width cap and the width
     * floor are centred on it as far as the flood allows, and after the last smoothing an edge that crossed it is widened. Without it 29% of
     * stations (28% of anchors) had their lowest point outside the 1 cm rung, up to 49 m where the cap re-centred a wide flood.
     */
    thalwegInsideMarginM: 0.25,
    maximumTopWidth: {
      rule: 'a film of water a few centimeters deep does not spread over a flat valley floor: top width ≤ baseM + perMeterOfDepthM × rung depth',
      baseM: 3,
      perMeterOfDepthM: 80,
    },
    innerBendRadiusFraction: 0.7,
    innerBendRule: 'on the inside of a bend an edge reaches at most this fraction of the radius of curvature (strongest bend within the curvature window), so cross-sections do not cross',
    monotoneWithDepth: 'a deeper rung is never narrower than the one below, on either side',
    stationSpacing: 'm3’s waterSurfaceStations (channelProfile.waterSurfaceStations in its method-config.ts): table stations of the segment, the anchor station among them, about 2 m apart',
    ringVertex:
      '[longitude, latitude, bedM]: 7 decimals for longitude and latitude, 3 for the station’s bed (m NAVD88; the lidar at its lowest point, or the breach line on a breached barrier), the same rounded beds Stage 3 pool-fills. One closed-by-the-renderer ring per bucket: left edge stations 0…n−1, then right edge stations n−1…0 (clockwise)',
    channelRibbonFields:
      'each polygon set also carries channelRibbon: { stationCount, lengthM, anchorLonLat (8 decimals, the anchor station’s lowest point), anchorBedElevationM (the lidar there), anchorStation, downstreamSegmentId (next segment of the run, null at its end), breachedStations, ' +
      'stationDistancesM[station] (distance from the segment’s upstream boundary station along the centerline, m, 2 decimals; m3 smooths the water surface over these positions), trueTopWidthAtAnchorM[rung], displayTopWidthAtAnchorM[rung] } — true is the smoothed lidar flood width before the display floors, display is the drawn width',
    displayRule: DISPLAY_RULE,
    displayRuleNote:
      'applied in the browser only when a URL parameter asks for it, never stored in the data: with ramp = smoothstep of the segment bed slope between rampStartSlope and rampFullSlope, drawn depth at a station = max(surface − bed, ramp × minimumDrawnDepthM), drawn width = the ribbon width at the drawn depth, drawn z = bed + drawn depth + ramp × surfaceLiftM',
    ladderSummary:
      'bedElevationM = the lidar at the anchor point; maxModeledWaterSurfaceElevationM = ceilingM = anchor bed + the top rung depth (the ribbon ladder does not depend on the modeled depths)',
    fileLayout: 'one compact JSON file per TNC flowline: water-surface-polygon-sets/<tncComid>.json',
  },
} as const satisfies WsePolygonGenerationMethodConfig;
