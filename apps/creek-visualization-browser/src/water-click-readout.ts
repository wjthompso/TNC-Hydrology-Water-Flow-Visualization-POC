// Dev tools water click inspector, math and wording: turns one click plus one
// segment's inspection (modeled-segment-inspection.ts) into the numbers and the
// labeled rows the Dev tools panel shows and copies. Pure functions, no map.
// All heights are meters NAVD88 (North American Vertical Datum of 1988).

import type { LidarGroundLookup } from './dev-lidar-ground-client';
import type { InfoTipSource } from './dev-tools-info-tip';
import type { ModeledSegmentInspection, PolygonBottomKind } from './modeled-segment-inspection';
import { toWaterLevelUnit, type WaterLevelUnit } from './water-level-units';

/** Where the browser terrain under a click is, as sampled from the map. */
export interface TerrainSample {
  /** Ground height the scene draws: `groundView.elevationSampler`, or `ground.queryElevation` when the sampler had no tile. */
  browserTerrainMeshM: number | null;
  browserTerrainSource: 'ground-view-elevation-sampler' | 'ground-query-elevation' | 'unavailable';
  /** `ground.queryElevation` at the finest resolution the elevation layers offer (3DEP is about 1.2 m cells), not the drawn mesh. */
  finestGroundQueryM: number | null;
}

/** The 1 m lidar ground at one point, as the readout and its copied JSON carry it. Heights are null unless `status` is 'found'. */
export interface LidarGroundReadout {
  status: LidarGroundLookup['status'];
  /** The 1 m cell the point lies in. */
  nearestCellM: number | null;
  bilinearM: number | null;
  /** Lowest and highest of the 5 × 5 cells around the nearest cell. */
  cellSpreadM: [number, number] | null;
}

/** The ground samples a readout adds to the segment's own numbers; the defaults mean "not sampled yet". */
export interface GroundSamples {
  /** 1 m lidar at the clicked point. */
  lidarAtClick: LidarGroundLookup;
  /** Browser terrain at the anchor point. */
  anchorTerrain: TerrainSample | null;
  /** 1 m lidar at the anchor point. */
  anchorLidar: LidarGroundLookup;
}

const NOTHING_SAMPLED: GroundSamples = {
  lidarAtClick: { status: 'pending' },
  anchorTerrain: null,
  anchorLidar: { status: 'pending' },
};

function lidarGroundReadout(lookup: LidarGroundLookup): LidarGroundReadout {
  return lookup.status === 'found'
    ? {
        status: 'found',
        nearestCellM: lookup.heights.nearestCellM,
        bilinearM: lookup.heights.bilinearM,
        cellSpreadM: lookup.heights.cellSpreadM,
      }
    : { status: lookup.status, nearestCellM: null, bilinearM: null, cellSpreadM: null };
}

/** `a − b`, or null when either is missing. */
function differenceM(a: number | null, b: number | null): number | null {
  return a !== null && b !== null ? a - b : null;
}

/**
 * The lidar height the differences use: the bilinear blend at the exact point (the pipeline reads its lidar the same way), else
 * the nearest cell where a neighbouring cell is NoData. The nearest cell alone can be decimeters off on steep ground.
 */
function lidarHeightForDifferencesM(lidar: LidarGroundReadout): number | null {
  return lidar.bilinearM ?? lidar.nearestCellM;
}

export interface ClickedPoint {
  longitude: number;
  latitude: number;
  landedOn: 'water-polygon' | 'ground-near-segment';
  /** Meters from the segment's center, when the click missed the water polygon. */
  distanceFromSegmentCenterM: number | null;
  /** Height ArcGIS reported where the click ray met the water graphic. Null when the click missed the water. */
  arcgisWaterHitZM: number | null;
}

export interface PolygonSample {
  waterSurfaceM: number;
  /** Polygon bottom at the point; null when the drawing has no per-vertex bottom. */
  bottomM: number | null;
  /** False when the point lies outside every ring, so the values extend the nearest water. */
  insideDrawnPolygon: boolean;
  /** Meters from the point to the closest polygon vertex. */
  nearestVertexM: number;
  /** Ribbon v2: the clearance lift (anchor blend and station drape) in the drawn water at the point; null without station lifts. */
  stationLiftM: number | null;
}

/** Everything the panel shows and copies for one click. Plain data, no ring arrays. */
export interface WaterClickReadout {
  clickedPoint: ClickedPoint;
  segment: Omit<ModeledSegmentInspection, 'drawnRingsWgs84' | 'drawnStationLiftsM' | 'bottomRingsWgs84' | 'revisionKey'>;
  atClickedPoint: {
    /**
     * The water's height at the click: where the click ray met the water graphic when it did (`map-hit`),
     * else interpolated from the polygon's vertices. Null when no water is drawn on the segment at this time.
     */
    waterSurfaceDrawnM: number | null;
    waterSurfaceSource: 'map-hit' | 'polygon-vertices' | null;
    /** The height the polygon's vertices give at the click point: what the pipeline and renderer intended. */
    waterSurfaceFromVerticesM: number | null;
    /**
     * Ribbon v2: how far the water drawn at the click was raised to clear the browser ground, the anchor clearance lift blended between
     * anchors or the station drape, whichever is larger (read from the polygon's stations). Null when the lift is off or not used.
     */
    stationClearanceLiftM: number | null;
    polygonBottomM: number | null;
    polygonBottomKind: PolygonBottomKind | null;
    /** `waterSurfaceDrawnM − polygonBottomM`. */
    drawnWaterDepthM: number | null;
    insideDrawnPolygon: boolean | null;
    nearestPolygonVertexM: number | null;
    browserTerrainMeshM: number | null;
    browserTerrainSource: TerrainSample['browserTerrainSource'] | 'not-sampled-yet';
    /** `waterSurfaceDrawnM − browserTerrainMeshM`; negative means the water is under the drawn ground. */
    waterAboveBrowserTerrainM: number | null;
    /** `browserTerrainMeshM − polygonBottomM`. */
    browserTerrainAbovePolygonBottomM: number | null;
    finestGroundQueryM: number | null;
    /** The 1 m lidar height the differences use (bilinear at the click); null without the dev lidar lookup (see `lidar1m.status`). */
    lidar1mM: number | null;
    /** The dev server's 1 m lidar answer at the click: nearest cell, bilinear, and 5 × 5 range. */
    lidar1m: LidarGroundReadout;
    /** `polygonBottomM − lidar1mM`, for polygon bottoms that are a creek-bed estimate; negative means the bed estimate is below the lidar ground. */
    polygonBottomMinusLidar1mM: number | null;
    /** `waterSurfaceDrawnM − lidar1mM`; negative means the water is drawn below the lidar ground. */
    waterDrawnMinusLidar1mM: number | null;
  };
  /** Drawn water, the pipeline's bed estimate, and the sampled ground at the segment's anchor point. */
  atAnchor: {
    /** The water drawn at the anchor; null without drawn water or an anchor position. */
    waterSurfaceDrawnM: number | null;
    drawnMinusTimeSeriesM: number | null;
    /** Browser terrain at the anchor longitude and latitude. */
    browserTerrainMeshM: number | null;
    browserTerrainSource: TerrainSample['browserTerrainSource'] | 'not-sampled-yet';
    finestGroundQueryM: number | null;
    /** The dev server's 1 m lidar answer at the anchor. */
    lidar1m: LidarGroundReadout;
    /** Pipeline bed estimate minus the bilinear 1 m lidar ground at the anchor; negative means the bed estimate is below the real ground. */
    bedMinusLidar1mM: number | null;
    bedMinusBrowserTerrainM: number | null;
    /** Water drawn at the anchor minus browser terrain; negative means the water is drawn underground. */
    waterDrawnMinusBrowserTerrainM: number | null;
    /** Ribbon v2: how far the drawn water was lifted at this anchor to clear the browser ground; null when the lift is off or not used. */
    anchorClearanceLiftM: number | null;
    /** Ribbon v2: the margin the lift keeps above the browser ground, m; null when the lift is off or not used. */
    anchorClearanceMarginM: number | null;
  };
}

const METERS_PER_DEGREE_LATITUDE = (Math.PI / 180) * 6378137;
/** The nearest polygon vertices that vote on a height between vertices. */
const NEAREST_VERTEX_COUNT = 8;
/** Closer than this to a vertex, the vertex's own height is the answer. */
const ON_VERTEX_M = 0.01;
/** The nearest vertices must spread at least this evenly in two directions (smaller to larger variance) to fit a tilted plane. */
const MIN_PLANE_FIT_SPREAD_RATIO = 1e-3;

/**
 * The drawn water height and polygon bottom at a point, from the polygon's vertices: a tilted plane
 * fitted to the closest eight (closer ones count more), read at the point, so a steep creek's
 * downhill slope is followed. Vertices that all lie on one line cannot fix a plane, so those fall back to
 * weighting each of the eight by 1 ÷ distance². A point on a vertex gets exactly that vertex's heights.
 * Approximate between vertices: the map triangulates the polygon its own way. Ribbon v2's station lifts are read the same way, each
 * edge vertex carrying its station's lift.
 */
export function sampleDrawnPolygon(
  inspection: Pick<ModeledSegmentInspection, 'drawnRingsWgs84' | 'bottomRingsWgs84' | 'drawnStationLiftsM'>,
  longitude: number,
  latitude: number,
): PolygonSample | null {
  const rings = inspection.drawnRingsWgs84;
  if (!rings) return null;
  const metersPerDegreeLongitude = METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
  const nearest: { distanceM: number; eastM: number; northM: number; ringIndex: number; vertexIndex: number }[] = [];
  rings.forEach((ring, ringIndex) => {
    ring.forEach((vertex, vertexIndex) => {
      const eastM = (vertex[0] - longitude) * metersPerDegreeLongitude;
      const northM = (vertex[1] - latitude) * METERS_PER_DEGREE_LATITUDE;
      const distanceM = Math.hypot(eastM, northM);
      if (!Number.isFinite(vertex[2]) || !Number.isFinite(distanceM)) return;
      if (nearest.length === NEAREST_VERTEX_COUNT && distanceM >= nearest[nearest.length - 1].distanceM) return;
      nearest.push({ distanceM, eastM, northM, ringIndex, vertexIndex });
      nearest.sort((a, b) => a.distanceM - b.distanceM);
      if (nearest.length > NEAREST_VERTEX_COUNT) nearest.pop();
    });
  });
  if (nearest.length === 0) return null;

  const bottomAt = (ringIndex: number, vertexIndex: number): number | null => {
    const ring = inspection.bottomRingsWgs84?.[ringIndex];
    // A drawn ring that the map closed repeats its first vertex, one past the bottom ring's end.
    const z = ring && ring.length > 0 ? ring[vertexIndex % ring.length]?.[2] : undefined;
    return typeof z === 'number' && Number.isFinite(z) ? z : null;
  };
  const weighted = (valueOf: (item: (typeof nearest)[number]) => number | null): number | null => {
    const first = nearest[0];
    if (first.distanceM < ON_VERTEX_M) return valueOf(first);
    const samples: { eastM: number; northM: number; weight: number; value: number }[] = [];
    for (const item of nearest) {
      const value = valueOf(item);
      if (value === null) return null;
      samples.push({ eastM: item.eastM, northM: item.northM, weight: 1 / (item.distanceM * item.distanceM), value });
    }
    return fittedPlaneValueAtOrigin(samples) ?? inverseDistanceSquaredValue(samples);
  };

  // The joined ribbon ring: left edge stations 0…n−1, right edge n−1…0, then the first vertex again.
  const stationLiftsM = inspection.drawnStationLiftsM;
  const stationCount = stationLiftsM?.length ?? 0;
  const liftAt = (ringIndex: number, vertexIndex: number): number | null => {
    if (!stationLiftsM || ringIndex !== 0 || rings.length !== 1 || rings[0].length !== 2 * stationCount + 1) return null;
    const station = vertexIndex < stationCount ? vertexIndex : vertexIndex < 2 * stationCount ? 2 * stationCount - 1 - vertexIndex : 0;
    return stationLiftsM[station] ?? null;
  };

  const waterSurfaceM = weighted((item) => rings[item.ringIndex][item.vertexIndex][2]);
  if (waterSurfaceM === null) return null;
  return {
    waterSurfaceM,
    bottomM: inspection.bottomRingsWgs84 ? weighted((item) => bottomAt(item.ringIndex, item.vertexIndex)) : null,
    insideDrawnPolygon: insideAnyRing(rings, longitude, latitude),
    nearestVertexM: nearest[0].distanceM,
    stationLiftM: stationLiftsM ? weighted((item) => liftAt(item.ringIndex, item.vertexIndex)) : null,
  };
}

interface WeightedHeightSample {
  /** Meters east and north of the point being read. */
  eastM: number;
  northM: number;
  weight: number;
  value: number;
}

/** Weights the samples by 1 ÷ distance², the weights already on each sample. */
function inverseDistanceSquaredValue(samples: readonly WeightedHeightSample[]): number {
  let weightSum = 0;
  let valueSum = 0;
  for (const sample of samples) {
    weightSum += sample.weight;
    valueSum += sample.weight * sample.value;
  }
  return valueSum / weightSum;
}

/**
 * Least-squares plane `value = a + b·east + c·north` through the samples, read at the point (east 0, north 0), which is `a`.
 * Null when the samples lie nearly on one line, so no plane is determined.
 */
function fittedPlaneValueAtOrigin(samples: readonly WeightedHeightSample[]): number | null {
  const weightSum = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const meanEast = samples.reduce((sum, sample) => sum + sample.weight * sample.eastM, 0) / weightSum;
  const meanNorth = samples.reduce((sum, sample) => sum + sample.weight * sample.northM, 0) / weightSum;
  const meanValue = samples.reduce((sum, sample) => sum + sample.weight * sample.value, 0) / weightSum;
  let eastEast = 0;
  let eastNorth = 0;
  let northNorth = 0;
  let eastValue = 0;
  let northValue = 0;
  for (const sample of samples) {
    const east = sample.eastM - meanEast;
    const north = sample.northM - meanNorth;
    const value = sample.value - meanValue;
    eastEast += sample.weight * east * east;
    eastNorth += sample.weight * east * north;
    northNorth += sample.weight * north * north;
    eastValue += sample.weight * east * value;
    northValue += sample.weight * north * value;
  }
  const determinant = eastEast * northNorth - eastNorth * eastNorth;
  const trace = eastEast + northNorth;
  // The smaller variance of the two directions is at most determinant ÷ (trace ÷ 2); compare it with the larger.
  if (!(trace > 0) || determinant < MIN_PLANE_FIT_SPREAD_RATIO * trace * trace) return null;
  const slopeEast = (northNorth * eastValue - eastNorth * northValue) / determinant;
  const slopeNorth = (eastEast * northValue - eastNorth * eastValue) / determinant;
  return meanValue - slopeEast * meanEast - slopeNorth * meanNorth;
}

/** Even-odd ray test in longitude and latitude over every ring. */
function insideAnyRing(rings: readonly (readonly (readonly number[])[])[], longitude: number, latitude: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
      const [x1, y1] = ring[current];
      const [x2, y2] = ring[previous];
      if (y1 > latitude !== y2 > latitude && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** The readout for one click on one segment. `terrain` null means the ground has not been sampled yet. */
export function buildWaterClickReadout(
  inspection: ModeledSegmentInspection,
  clickedPoint: ClickedPoint,
  terrain: TerrainSample | null,
  ground: GroundSamples = NOTHING_SAMPLED,
): WaterClickReadout {
  const polygonSample = sampleDrawnPolygon(inspection, clickedPoint.longitude, clickedPoint.latitude);
  // Outside the polygon there is no water, so extending the nearest vertices would only invent numbers. A click the
  // map says met the water counts as inside (the polygon's edge can be a pixel off). Terrain rows still apply.
  const sample = polygonSample && (polygonSample.insideDrawnPolygon || clickedPoint.arcgisWaterHitZM !== null) ? polygonSample : null;
  // Elevation buckets have no per-vertex bottom; the bucket minimum stands in.
  const bottomM = sample ? (sample.bottomM ?? inspection.drawnBucketMinElevationM) : null;  // The map's own height where the ray met the water is the literal drawn height; the vertices are the fallback.
  const waterSurfaceFromVerticesM = sample?.waterSurfaceM ?? null;
  const waterSurfaceDrawnM = clickedPoint.arcgisWaterHitZM ?? waterSurfaceFromVerticesM;
  const waterSurfaceSource =
    clickedPoint.arcgisWaterHitZM !== null ? 'map-hit' : waterSurfaceFromVerticesM !== null ? 'polygon-vertices' : null;
  const meshM = terrain?.browserTerrainMeshM ?? null;

  const anchorLonLat = inspection.anchor.lonLat;
  const anchorSample = anchorLonLat ? sampleDrawnPolygon(inspection, anchorLonLat[0], anchorLonLat[1]) : null;
  const lidarAtClick = lidarGroundReadout(ground.lidarAtClick);
  const lidarAtAnchor = lidarGroundReadout(ground.anchorLidar);
  const anchorMeshM = ground.anchorTerrain?.browserTerrainMeshM ?? null;
  const anchorBedM = inspection.anchor.bedElevationM;
  // Ribbon v2 knows its anchor station, so the drawn height there is read exactly; otherwise the polygon is sampled at the anchor.
  const anchorWaterDrawnM = inspection.anchor.waterDrawnAtStationM ?? anchorSample?.waterSurfaceM ?? null;
  const bottomIsBedEstimate = inspection.bottomKind === 'ribbon-bed-profile' || inspection.bottomKind === 'bed-reference';

  return {
    clickedPoint,
    segment: withoutRings(inspection),
    atClickedPoint: {
      waterSurfaceDrawnM,
      waterSurfaceSource,
      waterSurfaceFromVerticesM,
      stationClearanceLiftM: sample?.stationLiftM ?? null,
      polygonBottomM: bottomM,
      polygonBottomKind: inspection.bottomKind,
      drawnWaterDepthM: waterSurfaceDrawnM !== null && bottomM !== null ? waterSurfaceDrawnM - bottomM : null,
      insideDrawnPolygon: polygonSample?.insideDrawnPolygon ?? null,
      nearestPolygonVertexM: polygonSample?.nearestVertexM ?? null,
      browserTerrainMeshM: meshM,
      browserTerrainSource: terrain?.browserTerrainSource ?? 'not-sampled-yet',
      waterAboveBrowserTerrainM: waterSurfaceDrawnM !== null && meshM !== null ? waterSurfaceDrawnM - meshM : null,
      browserTerrainAbovePolygonBottomM: meshM !== null && bottomM !== null ? meshM - bottomM : null,
      finestGroundQueryM: terrain?.finestGroundQueryM ?? null,
      lidar1mM: lidarHeightForDifferencesM(lidarAtClick),
      lidar1m: lidarAtClick,
      polygonBottomMinusLidar1mM: bottomIsBedEstimate ? differenceM(bottomM, lidarHeightForDifferencesM(lidarAtClick)) : null,
      waterDrawnMinusLidar1mM: differenceM(waterSurfaceDrawnM, lidarHeightForDifferencesM(lidarAtClick)),
    },
    atAnchor: {
      waterSurfaceDrawnM: anchorWaterDrawnM,
      drawnMinusTimeSeriesM:
        anchorWaterDrawnM !== null && inspection.timeSeriesWseM !== null ? anchorWaterDrawnM - inspection.timeSeriesWseM : null,
      browserTerrainMeshM: anchorMeshM,
      browserTerrainSource: ground.anchorTerrain?.browserTerrainSource ?? 'not-sampled-yet',
      finestGroundQueryM: ground.anchorTerrain?.finestGroundQueryM ?? null,
      lidar1m: lidarAtAnchor,
      bedMinusLidar1mM: differenceM(anchorBedM, lidarHeightForDifferencesM(lidarAtAnchor)),
      bedMinusBrowserTerrainM: differenceM(anchorBedM, anchorMeshM),
      waterDrawnMinusBrowserTerrainM: differenceM(anchorWaterDrawnM, anchorMeshM),
      anchorClearanceLiftM: inspection.ribbon?.anchorClearance?.liftM ?? null,
      anchorClearanceMarginM: inspection.ribbon?.anchorClearance?.marginM ?? null,
    },
  };
}

/** The inspection without its vertex arrays, so the readout stays small enough to copy. */
function withoutRings(inspection: ModeledSegmentInspection): WaterClickReadout['segment'] {
  const copy: Partial<ModeledSegmentInspection> = { ...inspection };
  delete copy.drawnRingsWgs84;
  delete copy.drawnStationLiftsM;
  delete copy.bottomRingsWgs84;
  delete copy.revisionKey;
  return copy as WaterClickReadout['segment'];
}

// --- Rows -------------------------------------------------------------------

export type InspectorRowTone = 'normal' | 'alert' | 'muted';

export interface InspectorRow {
  label: string;
  value: string;
  /** One to three plain-English sentences: what the number is, how it is computed, how it relates to its neighbors. Shown as the row's tooltip. */
  hint: string;
  /** Which of the three ideas the row belongs to: model truth, what we draw, or the browser terrain. Null for rows that are none of them. */
  source: InfoTipSource | null;
  tone: InspectorRowTone;
}

export interface InspectorGroup {
  heading: string;
  /** The group's tooltip. */
  hint: string;
  /** A short plain-English line under the heading, before the rows. */
  intro?: string;
  rows: InspectorRow[];
  /** Labeled blocks nested in the group, after its rows. */
  subGroups?: InspectorSubGroup[];
}

export interface InspectorSubGroup {
  heading: string;
  hint: string;
  rows: InspectorRow[];
}

const BOTTOM_LABELS: Record<PolygonBottomKind, { label: string; hint: string; source: InfoTipSource }> = {
  'ribbon-bed-profile': {
    label: 'Bed under the ribbon (pipeline estimate)',
    hint: 'The pipeline’s ESTIMATE of the creek-bed height the ribbon was built on at this spot, derived from the 1 m lidar (laser-scanned ground heights) and saved in the polygon data: ribbon v1 uses a smoothed bed profile along the channel; ribbon v2 uses the raw lidar at the creek’s lowest point across each station (a straight breach line through a road or railroad fill). Between stations it is blended, and the lowest point is usually beside the clicked spot, so it is not the ground height measured at this longitude and latitude (see the ground rows). The ribbon is drawn at this height plus the water depth plus any lift.',
    source: 'model',
  },
  'bed-reference': {
    label: 'Bed reference under the water (pipeline estimate)',
    hint: 'The pipeline’s ESTIMATE of the creek-bed height the saved polygon vertices carry here. It is not a measured ground height (see the ground rows). The water is drawn at this bed height plus the water depth.',
    source: 'model',
  },
  'bucket-minimum-elevation': {
    label: 'Bucket minimum elevation',
    hint: 'This method has no creek bed under its water. The bottom shown is the lowest water height of the elevation bucket (the pre-built polygon for one water level) that is drawn.',
    source: 'drawn',
  },
};

const NOT_AVAILABLE = 'not available';

const GROUP_HINTS = {
  clicked:
    'Everything measured at the exact spot you clicked: the water we draw there, the pipeline’s creek-bed estimate under it, and the ground the browser draws and the 1 m lidar measures. Heights are above sea level on NAVD88 (North American Vertical Datum of 1988).',
  anchor:
    'Each Creek Segment (the creek stretch between two adjacent centerline vertices) is modeled with one water level at its WSE Anchor Point, and the chart plots that level. This group lists the modeled values (model truth) and compares them with the water we draw, then with the ground sampled at the same longitude and latitude.',
  anchorGround:
    'Ground heights sampled at the anchor’s own longitude and latitude, next to the pipeline’s bed ESTIMATE there. They show whether the estimated bed, and the water above it, sit above or below the real ground. Differences are signed: negative means the first height is below the second.',
  exaggeration:
    'On steep creeks the true water is so thin that the browser terrain would bury it, so ribbon v1 is drawn deeper (the floor) and raised (the lift). Only the drawing changes; stored data and the chart keep true values. Add ribbonDisplayFloorM=0&ribbonDisplayLiftM=0 to the URL to turn it off. Ribbon v2 draws true water unless those parameters are set; its anchor clearance lift is a separate rule, listed in the Anchor point group.',
  methods:
    'Which drawing method, which saved Time Series version, and which moment these numbers belong to.',
};

/** Shown at the top of the Anchor group: "bed", "ground", and "water" each mean one thing in these rows. */
const ANCHOR_HEIGHT_KINDS_INTRO =
  'Three kinds of height: bed = the pipeline’s estimate of the creek bottom; ground = a measured or sampled terrain surface (1 m lidar, browser terrain); water = modeled (the chart) or drawn (after any visibility boost, anchor clearance lift or station drape).';

/** Where the anchor's position came from decides how far to trust it. */
const ANCHOR_POSITION_HINTS: Record<ModeledSegmentInspection['anchor']['positionSource'], string> = {
  'ribbon-polygon-file':
    'Where the segment’s modeled water level applies (the WSE Anchor Point), saved with the ribbon polygons: ribbon v1 puts it on the smoothed creek centerline at the segment’s middle; ribbon v2 on the creek’s lowest point across the segment’s middle station, so it can sit a few meters to one side of the centerline.',
  'chord-midpoint-estimate':
    'Where the segment’s modeled water level applies (the WSE Anchor Point). This method never saved it, so it is estimated as the midpoint of the straight line between the segment’s two end points.',
  'not-saved':
    'Where the segment’s modeled water level applies (the WSE Anchor Point). This method never saved it, so no position can be shown and there is no pink flag.',
};

/** The labeled rows of the panel, grouped, for one readout in the chosen unit. */
export function readoutRowGroups(readout: WaterClickReadout, unit: WaterLevelUnit): InspectorGroup[] {
  const { clickedPoint, segment, atClickedPoint: at, atAnchor } = readout;
  const height = (valueM: number | null): string => formatLength(valueM, unit);
  /** Negative as shown: a difference that rounds to zero in this unit is neither signed nor flagged as below. */
  const negativeAsShown = (valueM: number | null): boolean => valueM !== null && valueM < 0 && roundsAboveZero(Math.abs(valueM), unit);
  const row = (
    label: string,
    value: string,
    source: InfoTipSource | null,
    hint: string,
    tone: InspectorRowTone = 'normal',
  ): InspectorRow => ({
    label,
    value,
    source,
    hint,
    tone,
  });

  /** A 1 m lidar height, or why there is none: still asking, no dev server, or no lidar at the point. */
  const lidarText = (lidar: LidarGroundReadout, valueM: number | null): string => {
    if (lidar.status === 'pending') return 'sampling…';
    if (lidar.status === 'endpoint-absent') return `${NOT_AVAILABLE} (hosted data has no lidar)`;
    if (lidar.status === 'no-lidar-here') return `${NOT_AVAILABLE} (no lidar at this point)`;
    return height(valueM);
  };
  const lidarSpreadText = (lidar: LidarGroundReadout): string =>
    `${height(lidar.nearestCellM)} · ${lidar.cellSpreadM ? `${formatPlain(lidar.cellSpreadM[0], unit)} to ${formatPlain(lidar.cellSpreadM[1], unit)}` : '—'}`;
  /** A signed difference against the lidar, with the loud suffix when negative. */
  const lidarDifferenceText = (lidar: LidarGroundReadout, differenceM: number | null, negativeNote: string): string => {
    if (lidar.status !== 'found') return lidarText(lidar, null);
    return `${formatSigned(differenceM, unit)}${negativeAsShown(differenceM) ? `  ▼ ${negativeNote}` : ''}`;
  };
  const LIDAR_GROUND_HINT = (where: string): string =>
    `MEASURED ground height from the 1 m lidar (USGS 3DEP 1 m laser-scanned bare earth, the terrain the pipeline reads) at ${where}, blended between the four 1 m cell centers around the exact point (bilinear, read at full coordinate precision), the way the pipeline reads it; the difference rows use this value (the nearest cell only where a neighbouring cell has no data). The browser has no lidar, so the dev server reads it from the local pipeline tiles; hosted data cannot show it. It is the ground, not the pipeline’s bed estimate.`;
  const LIDAR_SPREAD_HINT = (where: string): string =>
    `Context for the row above: the same lidar’s 1 m cell that ${where} lies in, then the lowest to highest of the 5 × 5 cells around it. A wide range means steep or rough ground, where the cell alone can be a decimeter or more off the value at the exact point.`;

  // --- The clicked point ---
  const bottomLabel = at.polygonBottomKind ? BOTTOM_LABELS[at.polygonBottomKind] : null;
  const landedOn =
    clickedPoint.landedOn === 'water-polygon'
      ? `water polygon of ${segment.segmentId}`
      : `ground ${(clickedPoint.distanceFromSegmentCenterM ?? 0).toFixed(0)} m from ${segment.segmentId}'s center (missed the water)`;
  const terrainPending = at.browserTerrainSource === 'not-sampled-yet';
  const buried = negativeAsShown(at.waterAboveBrowserTerrainM);
  const clicked: InspectorRow[] = [
    row(
      'Click landed on',
      landedOn,
      null,
      'What the click hit: the water polygon of a Creek Segment, or bare ground near one. A click on bare ground reports the nearest segment within about 60 m.',
    ),
    row(
      'Water surface drawn here',
      at.waterSurfaceDrawnM === null && at.insideDrawnPolygon === false
        ? 'no water: click is outside the polygon'
        : height(at.waterSurfaceDrawnM),
      'drawn',
      at.waterSurfaceSource === 'map-hit'
        ? 'Height of the water we draw at the click, as the 3D scene reports it where your click met the water. It is a WSE (water-surface elevation: the water’s height above sea level, NAVD88) and includes the visibility boost.'
        : 'Height of the water we draw at the click, interpolated from the closest polygon vertices because the click missed the water. It is a WSE (water-surface elevation: the water’s height above sea level, NAVD88) and includes the visibility boost.',
    ),
  ];
  if (at.waterSurfaceSource === 'map-hit') {
    clicked.push(
      row(
        'Water surface by polygon vertices',
        height(at.waterSurfaceFromVerticesM),
        'drawn',
        'The same height worked out from the polygon’s own vertices: what the pipeline and renderer intended. A gap to the row above means the 3D scene triangulates the polygon differently from this estimate.',
        'muted',
      ),
    );
  }
  if (segment.browserDrawing === 'channel-ribbon-pool-filled') {
    const drape = segment.ribbon?.stationDrape ?? null;
    const liftOff = segment.ribbon?.anchorClearance == null;
    clicked.push(
      row(
        'Lift to clear the map’s ground here',
        segment.pinnedWseM !== null
          ? 'none (pinned water is drawn as typed)'
          : liftOff
            ? 'off (ribbonAnchorClearanceM=off)'
            : at.stationClearanceLiftM === null
              ? NOT_AVAILABLE
              : `${formatSigned(at.stationClearanceLiftM, unit)} · ${drape ? `drape under ${height(drape.depthCapM)} deep, taper ${height(drape.taperM)}` : 'anchor blend only (ribbonDrapeDepthCapM=off)'}`,
        'drawn',
        'How far we raise the water we draw at this spot so the ground the browser draws does not hide it; the water surface rows above include it. At every ribbon station it is the larger of two lifts: the anchor clearance lift, blended linearly between neighbouring anchors (see the Anchor point group), and the station drape, which raises water whose true depth is under the depth cap (0.3 m unless ribbonDrapeDepthCapM in the URL sets it) to at least the margin above the browser terrain at the station’s midline, fading to nothing over the taper (5 m unless ribbonDrapeTaperM sets it) on each side so neighbouring stations do not jump. Deeper water keeps its modeled surface, and each anchor keeps exactly its own anchor lift. Between stations the value is blended from the closest vertices. The 3D scene’s ground is a coarser 3DEP mesh the pipeline cannot know, so the browser does this itself; the chart and the Time Series keep the model’s value. ribbonDrapeDepthCapM=off turns the drape off; ribbonAnchorClearanceM=off turns every lift off.',
      ),
    );
    if (drape) {
      clicked.push(
        row(
          'Station drape on this segment',
          `${drape.drapedStationCount} station${drape.drapedStationCount === 1 ? '' : 's'} draped · ${drape.cappedStationCount} at or over the depth cap · largest lift ${formatSigned(drape.maxStationLiftM, unit)}`,
          'drawn',
          'Across this segment’s ribbon stations: how many the station drape raised above the anchor blend, how many are too deep for it (true depth at or over the cap, so they keep the modeled surface plus the anchor blend), and the largest lift at any station. A station on the boundary with a neighbouring segment counts for both.',
          'muted',
        ),
      );
    }
  }
  clicked.push(
    row(
      bottomLabel?.label ?? 'Polygon bottom',
      height(at.polygonBottomM),
      bottomLabel?.source ?? null,
      bottomLabel?.hint ?? 'The pipeline’s bed estimate (or lowest water level) under the water at the click. Not available where no water is drawn.',
    ),
    row(
      'Drawn water depth',
      height(at.drawnWaterDepthM),
      'drawn',
      'Water surface drawn here minus polygon bottom: how deep the water we draw is at the click. On steep creeks it includes the visibility boost (floor and lift), so it can exceed the true depth.',
    ),
    row(
      'Browser terrain (3DEP mesh as drawn)',
      terrainPending ? 'sampling…' : height(at.browserTerrainMeshM),
      'browser-terrain',
      'Ground height the 3D scene actually draws here, from the USGS 3DEP (3D Elevation Program) layer as a coarse mesh. It is not the 1 m lidar the pipeline uses, and on steep ground it can sit decimeters above the lidar, which is why water can look buried.',
    ),
    row(
      'Water above (+) / below (−) browser terrain',
      terrainPending ? 'sampling…' : `${formatSigned(at.waterAboveBrowserTerrainM, unit)}${buried ? '  ▼ BURIED' : ''}`,
      'browser-terrain',
      'Water surface drawn here minus browser terrain, which also equals drawn water depth minus the next row. Negative (red, BURIED) means the drawn ground covers the water, so it is hidden.',
      buried ? 'alert' : 'normal',
    ),
    row(
      'Browser terrain above polygon bottom',
      terrainPending ? 'sampling…' : formatSigned(at.browserTerrainAbovePolygonBottomM, unit),
      'browser-terrain',
      'Browser terrain minus polygon bottom: how much taller the drawn ground is than the pipeline’s bed estimate the water sits on. When it exceeds the drawn water depth, the water is buried.',
    ),
    row(
      '3DEP finest cells (query, not the mesh)',
      terrainPending ? 'sampling…' : height(at.finestGroundQueryM),
      'browser-terrain',
      'Ground height the elevation service reports at the finest resolution it offers at this point (3DEP cells of about 1.2 m), for comparison with the coarser mesh the scene draws. A large gap to “Browser terrain” shows the mesh is smoothing the ground.',
      'muted',
    ),
    row('1 m lidar ground', lidarText(at.lidar1m, at.lidar1mM), 'lidar-ground', LIDAR_GROUND_HINT('the click'), 'muted'),
  );
  if (at.lidar1m.status === 'found') {
    clicked.push(
      row('1 m lidar ground, nearest cell · 5 × 5 range', lidarSpreadText(at.lidar1m), 'lidar-ground', LIDAR_SPREAD_HINT('the click'), 'muted'),
    );
  }
  if (bottomLabel && (at.polygonBottomKind === 'ribbon-bed-profile' || at.polygonBottomKind === 'bed-reference')) {
    const bedBelowGround = negativeAsShown(at.polygonBottomMinusLidar1mM);
    clicked.push(
      row(
        `${bottomLabel.label} minus 1 m lidar ground`,
        lidarDifferenceText(at.lidar1m, at.polygonBottomMinusLidar1mM, 'BED BELOW GROUND'),
        'lidar-ground',
        'The pipeline’s bed ESTIMATE under the water at the click minus the measured 1 m lidar ground (bilinear at the exact point) at the same longitude and latitude. Negative (red) means the estimated bed is below the real ground there, which can make the water look underground. Near zero means the estimate follows the ground. Between ribbon stations the bed is blended, so a few centimeters off is expected on steep ground.',
        bedBelowGround ? 'alert' : 'normal',
      ),
    );
  }
  const waterBelowLidar = negativeAsShown(at.waterDrawnMinusLidar1mM);
  clicked.push(
    row(
      'Water drawn minus 1 m lidar ground',
      lidarDifferenceText(at.lidar1m, at.waterDrawnMinusLidar1mM, 'WATER BELOW GROUND'),
      'lidar-ground',
      'Water surface drawn at the click minus the measured 1 m lidar ground (bilinear at the exact point). Negative (red) means the water is drawn below the real ground there. Compare it with the browser-terrain row above, which uses the coarser mesh the scene draws.',
      waterBelowLidar ? 'alert' : 'normal',
    ),
  );
  if (at.nearestPolygonVertexM !== null) {
    clicked.push(
      row(
        'Polygon vertices near the click',
        `closest ${at.nearestPolygonVertexM.toFixed(1)} m · ${at.insideDrawnPolygon ? 'inside' : 'outside'} the polygon`,
        'drawn',
        'Distance to the closest polygon vertex, and whether the click is inside the polygon. Heights between vertices are estimated, so a larger distance means a less exact value.',
        'muted',
      ),
    );
  }

  // --- The segment's anchor ---
  const anchorPosition = describeAnchorPosition(segment);
  const trueDepth = segment.trueDepth;
  const drawnDepth = segment.drawnDepth;
  /** Extra depth the display floor gives at the anchor; the lift is counted separately. */
  const depthExtraM = drawnDepth && trueDepth ? drawnDepth.anchorM - trueDepth.anchorM : null;
  const drawnMinusChartBreakdown = (): string => {
    if (!segment.ribbon || segment.pinnedWseM !== null || depthExtraM === null || atAnchor.drawnMinusTimeSeriesM === null) return '';
    const liftM = segment.ribbon.appliedLiftM;
    const clearanceLiftM = atAnchor.anchorClearanceLiftM;
    const leftoverM = atAnchor.drawnMinusTimeSeriesM - depthExtraM - liftM - (clearanceLiftM ?? 0);
    const addend = (valueM: number, name: string): string =>
      `${valueM < 0 ? '−' : '+'} ${formatLength(Math.abs(valueM), unit)} ${name}`;
    const clearance = clearanceLiftM === null ? '' : ` ${addend(clearanceLiftM, 'anchor clearance lift')}`;
    return ` Here: ${formatSigned(atAnchor.drawnMinusTimeSeriesM, unit)} ≈ ${formatLength(depthExtraM, unit)} floor ${addend(liftM, 'lift')}${clearance} ${addend(leftoverM, 'leftover')}.`;
  };
  const anchor: InspectorRow[] = [
    row('Anchor point location', anchorPosition, 'model', ANCHOR_POSITION_HINTS[segment.anchor.positionSource]),
    row(
      'Anchor bed elevation (pipeline estimate)',
      segment.anchor.bedElevationM === null ? `${NOT_AVAILABLE} (this method has no bed)` : height(segment.anchor.bedElevationM),
      'model',
      'The pipeline’s ESTIMATE of the creek-bed height at the anchor, as saved in the Time Series (m3 v1 smooths it along the channel; m3 v2 takes the 1 m lidar at the anchor point itself, so it should match the lidar row below); for v1 it is not the ground height measured at the anchor’s longitude/latitude (see the ground rows below). Anchor depth is Anchor WSE minus this.',
    ),
    row(
      'Anchor WSE (Time Series, as on the chart)',
      height(segment.timeSeriesWseM),
      'model',
      'WSE (water-surface elevation: the water’s height above sea level, NAVD88) of the modeled water at the anchor point at the selected time. It is the number the chart plots, with no visibility boost.',
    ),
  ];
  if (segment.pinnedWseM !== null) {
    anchor.push(
      row(
        'WSE override pinned',
        height(segment.pinnedWseM),
        'drawn',
        'The WSE override section pins this segment, so its water is drawn from this typed value instead of the Time Series. A pinned ribbon is drawn without the visibility boost.',
        'alert',
      ),
    );
  }
  if (trueDepth) {
    anchor.push(
      row(
        'Anchor depth (true)',
        height(trueDepth.anchorM),
        'model',
        'Anchor WSE minus anchor bed elevation (never below zero): the modeled water depth at the anchor, before any visibility boost. The drawn depth can be larger.',
      ),
      row(
        'Water depth at upstream end / downstream end (true)',
        `${height(trueDepth.upstreamJunctionM)} / ${height(trueDepth.downstreamJunctionM)}`,
        'model',
        'Modeled water depth at the segment’s two ends, where it meets its upstream and downstream neighbors (a junction). Neighbors share the same end depth, so their water joins without a step, and the drawing blends between the ends. For m3 data the anchor depth is the average of the two.',
      ),
    );
  }
  anchor.push(
    row(
      'Water drawn at the anchor (by polygon vertices)',
      height(atAnchor.waterSurfaceDrawnM),
      'drawn',
      'Height the polygon’s vertices give at the anchor point, including the visibility boost and the anchor clearance lift: where the pink flag stands. Compare it with Anchor WSE, the chart value.',
    ),
  );
  if (segment.browserDrawing === 'channel-ribbon-pool-filled') {
    anchor.push(
      row(
        'Lift to clear the map’s ground at the anchor',
        atAnchor.anchorClearanceLiftM === null || atAnchor.anchorClearanceMarginM === null
          ? segment.pinnedWseM !== null
            ? 'none (pinned water is drawn as typed)'
            : 'off (ribbonAnchorClearanceM=off)'
          : `${formatSigned(atAnchor.anchorClearanceLiftM, unit)} · margin ${height(atAnchor.anchorClearanceMarginM)}`,
        'drawn',
        'How far we raise the water we draw at this anchor so it sits at least the margin above the ground the browser draws there: max(0, browser terrain + margin − water drawn before the lift). The 3D scene’s ground is a coarser 3DEP mesh the pipeline cannot know, often decimeters above the 1 m lidar on steep ground, so the browser enforces this itself; the margin (0.03 m unless ribbonAnchorClearanceM in the URL sets it) keeps water drawn exactly at ground level from flickering through it. Between anchors the lift blends linearly, so neighbours still meet, and thin water there can be lifted more by the station drape (see “Lift to clear the map’s ground here” in the clicked-point group); the anchor itself keeps exactly this lift. The chart and the Time Series keep the model’s value; ribbonAnchorClearanceM=off in the URL draws without it.',
      ),
    );
  }
  if (atAnchor.drawnMinusTimeSeriesM !== null) {
    anchor.push(
      row(
        'Drawn minus chart at the anchor',
        formatSigned(atAnchor.drawnMinusTimeSeriesM, unit),
        'drawn',
        `Water drawn at the anchor minus Anchor WSE. On the ribbon method it is the extra depth from the minimum-depth floor, plus the lift, plus a small leftover where the polygon’s bed profile differs slightly from the Time Series anchor bed. Ribbon v2 draws true water at its anchor station by default, so it is its anchor clearance lift (the row above) plus rounding (under 1 mm).${drawnMinusChartBreakdown()}`,
      ),
    );
  }
  if (segment.junctionWse) {
    anchor.push(
      row(
        'Water height at upstream end / downstream end',
        `${height(segment.junctionWse.upstreamM)} / ${height(segment.junctionWse.downstreamM)}`,
        'model',
        'Modeled WSE (water-surface elevation: the water’s height above sea level, NAVD88) at the segment’s two ends, from the Time Series. Methods that draw elevation buckets slope the water between them.',
      ),
    );
  }
  anchor.push(
    row(
      'Bed slope (segment)',
      segment.bedSlope === null ? NOT_AVAILABLE : `${(segment.bedSlope * 100).toFixed(1)} %`,
      'model',
      'Difference between the pipeline’s bed estimates at the segment’s two ends (always shown as positive) divided by the segment’s straight-line length. On the ribbon method the visibility boost fades in from 3% to 8% slope.',
    ),
  );
  if (segment.junctionBedUpstreamM !== null && segment.junctionBedDownstreamM !== null) {
    anchor.push(
      row(
        'Bed height at upstream end / downstream end (pipeline estimate)',
        `${height(segment.junctionBedUpstreamM)} / ${height(segment.junctionBedDownstreamM)}`,
        'model',
        'The pipeline’s ESTIMATE of the creek-bed height at the segment’s two ends, from the Time Series. Their difference divided by the segment’s length is the bed slope.',
        'muted',
      ),
    );
  }

  // --- Ground at the anchor, for comparison ---
  const anchorTerrainPending = atAnchor.browserTerrainSource === 'not-sampled-yet';
  const anchorBedM = segment.anchor.bedElevationM;
  const bedBelowLidar = negativeAsShown(atAnchor.bedMinusLidar1mM);
  const bedBelowBrowserTerrain = negativeAsShown(atAnchor.bedMinusBrowserTerrainM);
  const waterBelowBrowserTerrain = negativeAsShown(atAnchor.waterDrawnMinusBrowserTerrainM);
  const anchorGround: InspectorRow[] = [
    row(
      'Ground at the anchor · 1 m lidar (3DEP)',
      lidarText(atAnchor.lidar1m, lidarHeightForDifferencesM(atAnchor.lidar1m)),
      'lidar-ground',
      LIDAR_GROUND_HINT('the anchor’s longitude and latitude'),
    ),
  ];
  if (atAnchor.lidar1m.status === 'found') {
    anchorGround.push(
      row(
        'Ground at the anchor · 1 m lidar, nearest cell · 5 × 5 range',
        lidarSpreadText(atAnchor.lidar1m),
        'lidar-ground',
        LIDAR_SPREAD_HINT('the anchor'),
        'muted',
      ),
    );
  }
  anchorGround.push(
    row(
      'Ground at the anchor · browser terrain (3DEP mesh as drawn)',
      anchorTerrainPending ? 'sampling…' : height(atAnchor.browserTerrainMeshM),
      'browser-terrain',
      'Ground height the 3D scene draws at the anchor’s longitude and latitude, from the USGS 3DEP (3D Elevation Program) layer as a coarse mesh, read again at every click. It is not the 1 m lidar, and the mesh can change as the camera moves and finer tiles load, so click again after the scene settles.',
    ),
    row(
      'Ground at the anchor · 3DEP finest cells (query)',
      anchorTerrainPending ? 'sampling…' : height(atAnchor.finestGroundQueryM),
      'browser-terrain',
      'Ground height the elevation service reports at the anchor at the finest resolution it offers (3DEP cells of about 1.2 m), for comparison with the coarser mesh the scene draws. It is the same query used at the click.',
      'muted',
    ),
  );
  if (anchorBedM !== null) {
    anchorGround.push(
      row(
        'Pipeline bed estimate minus 1 m lidar ground at the anchor',
        lidarDifferenceText(atAnchor.lidar1m, atAnchor.bedMinusLidar1mM, 'BED BELOW GROUND'),
        'lidar-ground',
        'Anchor bed elevation (the pipeline’s estimate) minus the measured 1 m lidar ground at the anchor (bilinear at the exact anchor, the way the pipeline reads the lidar). Negative (red) means our estimated bed is below the real ground there; the water, which sits on that bed, can then look underground. Near zero means the estimate follows the ground: m3 v2 takes its anchor bed from this lidar, so it reads 0.000 within a millimeter or two.',
        bedBelowLidar ? 'alert' : 'normal',
      ),
      row(
        'Pipeline bed estimate minus browser terrain at the anchor',
        anchorTerrainPending ? 'sampling…' : `${formatSigned(atAnchor.bedMinusBrowserTerrainM, unit)}${bedBelowBrowserTerrain ? '  ▼ BED BELOW GROUND' : ''}`,
        'browser-terrain',
        'Anchor bed elevation (the pipeline’s estimate) minus the browser terrain at the anchor. Negative (red) means the estimated bed is below the ground the 3D scene draws.',
        bedBelowBrowserTerrain ? 'alert' : 'normal',
      ),
    );
  }
  anchorGround.push(
    row(
      'Water drawn at the anchor minus browser terrain at the anchor',
      anchorTerrainPending
        ? 'sampling…'
        : `${formatSigned(atAnchor.waterDrawnMinusBrowserTerrainM, unit)}${waterBelowBrowserTerrain ? '  ▼ BURIED' : ''}`,
      'browser-terrain',
      'Water drawn at the anchor (by polygon vertices) minus the browser terrain there, read again at this click. Negative (red, BURIED) means the water is drawn underground in the browser, so the pink dot is under the ground. With ribbon v2’s anchor clearance lift it reads at least the margin; the lift follows the terrain a moment after finer tiles load.',
      waterBelowBrowserTerrain ? 'alert' : 'normal',
    ),
  );

  // --- Methods and time ---
  const methods: InspectorRow[] = [
    row(
      'WSE polygon method',
      segment.wsePolygonMethod,
      null,
      'Which WSE Polygon Generation Method (way of turning modeled water levels into drawn water polygons) is on the map, for example flowline-channel-ribbon draws a ribbon along the creek centerline. Switch it under Derived data products.',
    ),
    row(
      'Modeled WSE version',
      segment.modeledWseVersionPath ?? NOT_AVAILABLE,
      null,
      'Which saved Time Series version (a published run of the pipeline’s modeled water levels) the polygons were built from and the chart values come from. Not available for hosted data and older manifests.',
    ),
    row(
      'Drawing',
      segment.browserDrawing,
      null,
      'The browser’s rule for lifting polygon vertices to a height, set by the polygon method. For example the ribbon sits at bed profile plus water depth plus lift.',
    ),
    row(
      'Selected time (UTC)',
      segment.selectedTimeUtc,
      null,
      'The moment selected on the timeline, in UTC (Coordinated Universal Time). Each Time Series value used is the latest one at or before it, held for at most one time step.',
    ),
  ];

  const groups: InspectorGroup[] = [
    {
      heading: `At the clicked point · ${clickedPoint.longitude.toFixed(6)}, ${clickedPoint.latitude.toFixed(6)}`,
      hint: GROUP_HINTS.clicked,
      rows: clicked,
    },
    {
      heading: `Anchor point · segment ${segment.segmentId}`,
      hint: GROUP_HINTS.anchor,
      intro: ANCHOR_HEIGHT_KINDS_INTRO,
      rows: anchor,
      subGroups: segment.anchor.lonLat
        ? [
            {
              heading: 'Ground at the anchor, for comparison',
              hint:
                segment.anchor.positionSource === 'ribbon-polygon-file'
                  ? GROUP_HINTS.anchorGround
                  : `${GROUP_HINTS.anchorGround} This anchor position is an estimate (the chord midpoint), which can fall off the channel, so the ground here may not be the creek’s.`,
              rows: anchorGround,
            },
          ]
        : undefined,
    },
  ];

  if (segment.ribbon) {
    const exaggeration = segment.ribbon;
    const applied = (depthExtraM ?? 0) > 0.0005 || exaggeration.appliedLiftM > 0.0005;
    groups.push({
      heading: 'Ribbon display exaggeration',
      hint: GROUP_HINTS.exaggeration,
      rows: [
        row(
          'Exaggeration applied to this segment',
          applied
            ? 'yes'
            : (exaggeration.anchorClearance?.liftM ?? 0) > 0.0005 || (exaggeration.stationDrape?.maxStationLiftM ?? 0) > 0.0005
              ? 'no (true water, plus the clearance lift)'
              : 'no (true water)',
          'drawn',
          'Whether this segment is drawn deeper or higher than the modeled water so it clears the browser terrain. Flat segments are drawn true, and ribbonDisplayFloorM=0&ribbonDisplayLiftM=0 in the URL draws every segment true.',
        ),
        row(
          'Drawn minus true anchor depth',
          formatSigned(depthExtraM, unit),
          'drawn',
          'The floor’s effect: drawn anchor depth minus true anchor depth. The floor is the minimum depth water is drawn at on steep reaches (0.15 m = 0.49 ft at full effect). The lift is counted in the next row, not here.',
        ),
        row(
          'Lift added to the surface',
          formatSigned(exaggeration.appliedLiftM, unit),
          'drawn',
          'How far the whole drawn surface is raised above bed plus depth (0.3 m = 0.98 ft at full effect). It raises the water we draw and the drawn water depth, not the chart.',
        ),
        row(
          'Display rule at this bed slope (floor / lift)',
          `${height(exaggeration.ruleFloorM)} / ${height(exaggeration.ruleLiftM)}`,
          'drawn',
          'The floor and lift the rule gives at this segment’s bed slope: none below 3% slope, full values at 8% and above, smooth in between. The URL parameters ribbonDisplayFloorM and ribbonDisplayLiftM set the full values.',
          'muted',
        ),
        row(
          'Top width at anchor: true / drawn',
          `${formatPlain(exaggeration.trueTopWidthAtAnchorM, unit)} / ${formatPlain(exaggeration.displayTopWidthAtAnchorM, unit)}`,
          'drawn',
          'Water width across the channel at the anchor. True is from the 1 m lidar at the true depth; drawn is at the drawn depth, so it is wider when the floor deepens the water.',
        ),
      ],
    });
  }
  groups.push({ heading: 'Methods and time', hint: GROUP_HINTS.methods, rows: methods });
  return groups;
}

function describeAnchorPosition(segment: WaterClickReadout['segment']): string {
  const lonLat = segment.anchor.lonLat;
  if (!lonLat) return `${NOT_AVAILABLE} (this method never saved it)`;
  const position = `${lonLat[0].toFixed(7)}, ${lonLat[1].toFixed(7)}`;
  return segment.anchor.positionSource === 'ribbon-polygon-file'
    ? `${position} (saved with the ribbon)`
    : `${position} (estimate: chord midpoint; exact spot not saved)`;
}

function formatLength(valueM: number | null, unit: WaterLevelUnit): string {
  if (valueM === null) return NOT_AVAILABLE;
  return unit === 'm' ? `${valueM.toFixed(3)} m` : `${toWaterLevelUnit(valueM, unit).toFixed(2)} ft`;
}

function formatSigned(valueM: number | null, unit: WaterLevelUnit): string {
  if (valueM === null) return NOT_AVAILABLE;
  const sign = valueM < 0 && roundsAboveZero(Math.abs(valueM), unit) ? '−' : '+';
  return `${sign}${formatLength(Math.abs(valueM), unit)}`;
}

/** True when a non-negative length shows as more than zero in this unit (not 0.000 m or 0.00 ft). */
function roundsAboveZero(lengthM: number, unit: WaterLevelUnit): boolean {
  return /[1-9]/.test(formatLength(lengthM, unit));
}

/** A length without the not-available wording, for compact "a / b" cells. */
function formatPlain(valueM: number | null, unit: WaterLevelUnit): string {
  return valueM === null ? '—' : formatLength(valueM, unit);
}
