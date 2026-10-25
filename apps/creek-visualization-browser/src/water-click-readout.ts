// Dev tools water click inspector, math and wording: turns one click plus one
// segment's inspection (modeled-segment-inspection.ts) into the numbers and the
// labeled rows the Dev tools panel shows and copies. Pure functions, no map.
// All heights are meters NAVD88 (North American Vertical Datum of 1988).

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
}

/** Everything the panel shows and copies for one click. Plain data, no ring arrays. */
export interface WaterClickReadout {
  clickedPoint: ClickedPoint;
  segment: Omit<ModeledSegmentInspection, 'drawnRingsWgs84' | 'bottomRingsWgs84' | 'revisionKey'>;
  atClickedPoint: {
    /**
     * The water's height at the click: where the click ray met the water graphic when it did (`map-hit`),
     * else interpolated from the polygon's vertices. Null when no water is drawn on the segment at this time.
     */
    waterSurfaceDrawnM: number | null;
    waterSurfaceSource: 'map-hit' | 'polygon-vertices' | null;
    /** The height the polygon's vertices give at the click point: what the pipeline and renderer intended. */
    waterSurfaceFromVerticesM: number | null;
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
    /** The 1 m lidar the pipeline reads is not loaded in the browser. */
    lidar1mM: null;
  };
  /** The water drawn at the segment's anchor point; null without drawn water or an anchor position. */
  atAnchor: { waterSurfaceDrawnM: number | null; drawnMinusTimeSeriesM: number | null };
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
 * Approximate between vertices: the map triangulates the polygon its own way.
 */
export function sampleDrawnPolygon(
  inspection: Pick<ModeledSegmentInspection, 'drawnRingsWgs84' | 'bottomRingsWgs84'>,
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

  const waterSurfaceM = weighted((item) => rings[item.ringIndex][item.vertexIndex][2]);
  if (waterSurfaceM === null) return null;
  return {
    waterSurfaceM,
    bottomM: inspection.bottomRingsWgs84 ? weighted((item) => bottomAt(item.ringIndex, item.vertexIndex)) : null,
    insideDrawnPolygon: insideAnyRing(rings, longitude, latitude),
    nearestVertexM: nearest[0].distanceM,
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

  return {
    clickedPoint,
    segment: withoutRings(inspection),
    atClickedPoint: {
      waterSurfaceDrawnM,
      waterSurfaceSource,
      waterSurfaceFromVerticesM,
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
      lidar1mM: null,
    },
    atAnchor: {
      waterSurfaceDrawnM: anchorSample?.waterSurfaceM ?? null,
      drawnMinusTimeSeriesM:
        anchorSample && inspection.timeSeriesWseM !== null ? anchorSample.waterSurfaceM - inspection.timeSeriesWseM : null,
    },
  };
}

/** The inspection without its vertex arrays, so the readout stays small enough to copy. */
function withoutRings(inspection: ModeledSegmentInspection): WaterClickReadout['segment'] {
  const copy: Partial<ModeledSegmentInspection> = { ...inspection };
  delete copy.drawnRingsWgs84;
  delete copy.bottomRingsWgs84;
  delete copy.revisionKey;
  return copy as WaterClickReadout['segment'];
}

// --- Rows -------------------------------------------------------------------

export type InspectorRowTone = 'normal' | 'alert' | 'muted';

export interface InspectorRow {
  label: string;
  value: string;
  /** One plain-words line: what the number means. Shown as the row's tooltip. */
  hint: string;
  tone: InspectorRowTone;
}

export interface InspectorGroup {
  heading: string;
  rows: InspectorRow[];
}

const BOTTOM_LABELS: Record<PolygonBottomKind, { label: string; hint: string }> = {
  'ribbon-bed-profile': {
    label: 'Bed profile under the ribbon',
    hint: 'Creek-bed height the ribbon was built on at this spot (smoothed lidar bed profile along the channel).',
  },
  'bed-reference': {
    label: 'Bed reference under the water',
    hint: 'Creek-bed height the polygon vertices carry here; the water is drawn this bed height plus the depth.',
  },
  'bucket-minimum-elevation': {
    label: 'Bucket minimum elevation',
    hint: 'This method has no bed under its water; the bottom is the lowest water height of the drawn elevation bucket.',
  },
};

const NOT_AVAILABLE = 'not available';

/** The labeled rows of the panel, grouped, for one readout in the chosen unit. */
export function readoutRowGroups(readout: WaterClickReadout, unit: WaterLevelUnit): InspectorGroup[] {
  const { clickedPoint, segment, atClickedPoint: at, atAnchor } = readout;
  const height = (valueM: number | null): string => formatLength(valueM, unit);
  const row = (label: string, value: string, hint: string, tone: InspectorRowTone = 'normal'): InspectorRow => ({
    label,
    value,
    hint,
    tone,
  });

  // --- The clicked point ---
  const bottomLabel = at.polygonBottomKind ? BOTTOM_LABELS[at.polygonBottomKind] : null;
  const landedOn =
    clickedPoint.landedOn === 'water-polygon'
      ? `water polygon of ${segment.segmentId}`
      : `ground ${(clickedPoint.distanceFromSegmentCenterM ?? 0).toFixed(0)} m from ${segment.segmentId}'s center (missed the water)`;
  const terrainPending = at.browserTerrainSource === 'not-sampled-yet';
  const buried = at.waterAboveBrowserTerrainM !== null && at.waterAboveBrowserTerrainM < 0;
  const clicked: InspectorRow[] = [
    row('Click landed on', landedOn, 'What the click hit: a water polygon, or bare ground near a segment.'),
    row(
      'Water surface drawn here',
      at.waterSurfaceDrawnM === null && at.insideDrawnPolygon === false
        ? 'no water: click is outside the polygon'
        : height(at.waterSurfaceDrawnM),
      at.waterSurfaceSource === 'map-hit'
        ? 'Height of the water graphic where the click met it (m above sea level, NAVD88), as the 3D scene reports it.'
        : 'Height of the water at the click (m above sea level, NAVD88), interpolated from the closest polygon vertices because the click missed the water.',
    ),
  ];
  if (at.waterSurfaceSource === 'map-hit') {
    clicked.push(
      row(
        'Water surface by polygon vertices',
        height(at.waterSurfaceFromVerticesM),
        'Height the polygon\'s own vertices give at the same spot: what the pipeline intended. A gap to the row above means the map triangulates the polygon differently.',
        'muted',
      ),
    );
  }
  clicked.push(
    row(
      bottomLabel?.label ?? 'Polygon bottom',
      height(at.polygonBottomM),
      bottomLabel?.hint ?? 'The bed (or lowest level) the water sits on at the click.',
    ),
    row('Drawn water depth', height(at.drawnWaterDepthM), 'Water surface minus polygon bottom at the click: how deep the drawn water is here.'),
    row(
      'Browser terrain (3DEP mesh as drawn)',
      terrainPending ? 'sampling…' : height(at.browserTerrainMeshM),
      'Ground height the 3D scene draws here, from the USGS 3DEP (3D Elevation Program) elevation layer. Not the 1 m lidar.',
    ),
    row(
      'Water above (+) / below (−) browser terrain',
      terrainPending ? 'sampling…' : `${formatSigned(at.waterAboveBrowserTerrainM, unit)}${buried ? '  ▼ BURIED' : ''}`,
      'Water surface minus drawn ground. Negative means the water is under the terrain mesh and is hidden.',
      buried ? 'alert' : 'normal',
    ),
    row(
      'Browser terrain above polygon bottom',
      terrainPending ? 'sampling…' : formatSigned(at.browserTerrainAbovePolygonBottomM, unit),
      'Drawn ground minus the polygon bottom: how much taller the terrain mesh is than the bed the water sits on.',
    ),
    row(
      '3DEP finest cells (query, not the mesh)',
      terrainPending ? 'sampling…' : height(at.finestGroundQueryM),
      'Ground height asked of the elevation layers at their finest resolution (about 1.2 m cells); shows how far the drawn mesh is from the finest 3DEP.',
      'muted',
    ),
    row(
      '1 m lidar ground',
      NOT_AVAILABLE,
      'The pipeline reads 1 m lidar offline; the browser has no copy of it, so no number can be sampled here.',
      'muted',
    ),
  );
  if (at.nearestPolygonVertexM !== null) {
    clicked.push(
      row(
        'Polygon vertices near the click',
        `closest ${at.nearestPolygonVertexM.toFixed(1)} m · ${at.insideDrawnPolygon ? 'inside' : 'outside'} the polygon`,
        'How far the closest polygon vertex is; a large distance makes the interpolated heights less exact.',
        'muted',
      ),
    );
  }

  // --- The segment's anchor ---
  const anchorPosition = describeAnchorPosition(segment);
  const trueDepth = segment.trueDepth;
  const drawnDepth = segment.drawnDepth;
  const anchor: InspectorRow[] = [
    row('Anchor point location', anchorPosition, 'Where on the creek bed the Time Series water-surface height applies (the WSE Anchor Point).'),
    row(
      'Anchor bed elevation',
      segment.anchor.bedElevationM === null ? `${NOT_AVAILABLE} (this method has no bed)` : height(segment.anchor.bedElevationM),
      'Creek-bed height at the anchor point.',
    ),
    row('Anchor WSE (Time Series, as on the chart)', height(segment.timeSeriesWseM), 'Modeled water-surface height at the anchor point at the selected time: the number the chart shows.'),
  ];
  if (segment.pinnedWseM !== null) {
    anchor.push(row('WSE override pinned', height(segment.pinnedWseM), 'The WSE override section pins this segment; the water is drawn from the pin, not the Time Series.', 'alert'));
  }
  if (trueDepth) {
    anchor.push(
      row('Anchor depth (true)', height(trueDepth.anchorM), 'Anchor WSE minus anchor bed: the modeled water depth at the anchor.'),
      row(
        'Junction depths up / down (true)',
        `${height(trueDepth.upstreamJunctionM)} / ${height(trueDepth.downstreamJunctionM)}`,
        'Modeled water depth at the segment\'s upstream and downstream ends; the drawing blends between them.',
      ),
    );
  }
  anchor.push(
    row('Water drawn at the anchor (by polygon vertices)', height(atAnchor.waterSurfaceDrawnM), 'Height the polygon\'s vertices give at the anchor point: where the pink flag\'s dot sits.'),
  );
  if (atAnchor.drawnMinusTimeSeriesM !== null) {
    anchor.push(
      row('Drawn minus chart at the anchor', formatSigned(atAnchor.drawnMinusTimeSeriesM, unit), 'How far the drawn water sits above (+) or below (−) the chart value at the anchor.'),
    );
  }
  if (segment.junctionWse) {
    anchor.push(
      row(
        'Junction WSE up / down',
        `${height(segment.junctionWse.upstreamM)} / ${height(segment.junctionWse.downstreamM)}`,
        'Modeled water-surface height at the segment\'s two ends; the water is drawn sloped between them.',
      ),
    );
  }
  anchor.push(
    row(
      'Bed slope (segment)',
      segment.bedSlope === null ? NOT_AVAILABLE : `${(segment.bedSlope * 100).toFixed(1)} %`,
      'Bed drop between the two junctions divided by the segment\'s straight length.',
    ),
  );
  if (segment.junctionBedUpstreamM !== null && segment.junctionBedDownstreamM !== null) {
    anchor.push(
      row(
        'Junction bed up / down',
        `${height(segment.junctionBedUpstreamM)} / ${height(segment.junctionBedDownstreamM)}`,
        'Creek-bed height at the segment\'s two ends.',
        'muted',
      ),
    );
  }

  // --- Methods and time ---
  const methods: InspectorRow[] = [
    row('WSE polygon method', segment.wsePolygonMethod, 'Which way of drawing water polygons is on the map.'),
    row('Modeled WSE version', segment.modeledWseVersionPath ?? NOT_AVAILABLE, 'Which Time Series folder the polygons were built from.'),
    row('Drawing', segment.browserDrawing, 'How the browser lifts the polygon vertices to a height.'),
    row('Selected time (UTC)', segment.selectedTimeUtc, 'The time on the timeline.'),
  ];

  const groups: InspectorGroup[] = [
    { heading: `At the clicked point · ${clickedPoint.longitude.toFixed(6)}, ${clickedPoint.latitude.toFixed(6)}`, rows: clicked },
    { heading: `Anchor point · segment ${segment.segmentId}`, rows: anchor },
  ];

  if (segment.ribbon) {
    const exaggeration = segment.ribbon;
    const depthExtraM = drawnDepth && trueDepth ? drawnDepth.anchorM - trueDepth.anchorM : null;
    const applied = (depthExtraM ?? 0) > 0.0005 || exaggeration.appliedLiftM > 0.0005;
    groups.push({
      heading: 'Ribbon display exaggeration',
      rows: [
        row(
          'Exaggeration applied to this segment',
          applied ? 'yes' : 'no (true water)',
          'On steep segments the ribbon is drawn deeper and lifted so it clears the terrain mesh; flat segments and ribbonDisplayFloorM=0&ribbonDisplayLiftM=0 draw true water.',
        ),
        row('Drawn minus true anchor depth', formatSigned(depthExtraM, unit), 'How much deeper than the model the water is drawn at the anchor.'),
        row('Lift added to the surface', formatSigned(exaggeration.appliedLiftM, unit), 'Meters the whole ribbon is raised above bed + depth.'),
        row(
          'Display rule at this bed slope (floor / lift)',
          `${height(exaggeration.ruleFloorM)} / ${height(exaggeration.ruleLiftM)}`,
          'The rule\'s minimum depth and lift for this segment\'s slope; the URL parameters ribbonDisplayFloorM and ribbonDisplayLiftM set the full values.',
          'muted',
        ),
        row(
          'Top width at anchor: true / drawn',
          `${formatPlain(exaggeration.trueTopWidthAtAnchorM, unit)} / ${formatPlain(exaggeration.displayTopWidthAtAnchorM, unit)}`,
          'Water width across the channel at the anchor: from the lidar at the true depth, and as drawn at the drawn depth.',
        ),
      ],
    });
  }
  groups.push({ heading: 'Methods and time', rows: methods });
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
  return unit === 'wse-navd88-m' ? `${valueM.toFixed(3)} m` : `${toWaterLevelUnit(valueM, unit).toFixed(2)} ft`;
}

function formatSigned(valueM: number | null, unit: WaterLevelUnit): string {
  if (valueM === null) return NOT_AVAILABLE;
  const sign = valueM < 0 ? '−' : '+';
  return `${sign}${formatLength(Math.abs(valueM), unit)}`;
}

/** A length without the not-available wording, for compact "a / b" cells. */
function formatPlain(valueM: number | null, unit: WaterLevelUnit): string {
  return valueM === null ? '—' : formatLength(valueM, unit);
}
