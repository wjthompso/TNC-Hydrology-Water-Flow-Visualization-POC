// Sloped water surface for one Creek Segment. The pipeline writes a junction
// water-surface elevation at each end of a segment (`junctionWseUpstreamM`,
// `junctionWseDownstreamM`); the browser lifts every polygon vertex to the
// height interpolated between them by where the vertex sits between the
// segment's two junction boundaries, so neighbouring segments meet at one
// height along the whole shared boundary instead of stepping.
//
// The boundaries are the same lines Stage 4 cut the polygons at: at a vertex
// shared with a neighbour, the bisector of the two segments' directions; at a
// flowline end, the segment's own perpendicular. Measuring the slope between
// those lines (not by projecting onto the segment axis) matters at a bend: the
// bisector is slanted, so an axis projection would give the two neighbours
// different heights along the one line they share and leave a crack a tilted
// camera can see through.

import type { LonLat, LonLatRing } from './creek-data-contract';

export interface JunctionWaterSurface {
  /** Water-surface elevation at the segment's upstream end, m NAVD88. */
  upstreamM: number;
  /** Water-surface elevation at the segment's downstream end, m NAVD88. */
  downstreamM: number;
}

/** Lon/lat vertices of a Creek Segment's flowline, ordered upstream to downstream. */
export type SegmentFlowlinePath = readonly LonLat[];

/**
 * A Creek Segment's flowline path and the paths of the neighbours sharing its
 * two vertices (null at a flowline end), all ordered upstream to downstream.
 */
export interface SegmentSurfaceGeometry {
  path: SegmentFlowlinePath;
  upstreamNeighbourPath: SegmentFlowlinePath | null;
  downstreamNeighbourPath: SegmentFlowlinePath | null;
}

const EARTH_RADIUS_M = 6378137;
/** Two nearly opposite segment directions (a hairpin) have no usable bisector; same limit as Stage 4. */
const HAIRPIN_MEAN_LENGTH = 1e-6;

/**
 * Rings with a z on every vertex: `upstreamM` on the upstream boundary,
 * `downstreamM` on the downstream boundary, linear in between. Vertices that
 * fall past either boundary (the vector clip leaves a few within rounding) take
 * that boundary's height.
 */
export function slopedRingsWgs84(
  rings: readonly LonLatRing[],
  geometry: SegmentSurfaceGeometry,
  surface: JunctionWaterSurface,
): number[][][] {
  const projector = createSurfaceProjector(geometry);
  return rings.map((ring) =>
    ring.map(([lon, lat]) => {
      const fraction = projector.fractionAlong([lon, lat]);
      return [lon, lat, surface.upstreamM + (surface.downstreamM - surface.upstreamM) * fraction];
    }),
  );
}

interface SurfaceProjector {
  /** 0 on the upstream boundary, 1 on the downstream boundary, clamped. */
  fractionAlong(point: LonLat): number;
}

/**
 * Where a point sits between the two boundary lines: 0 on the upstream one, 1
 * on the downstream one, linear in between, clamped outside. Same rule as
 * Stage 4's `fractionBetweenBoundaries`.
 */
export function fractionBetweenBoundaries(distanceInsideUpstreamM: number, distanceInsideDownstreamM: number): number {
  if (distanceInsideUpstreamM <= 0) return 0;
  if (distanceInsideDownstreamM <= 0) return 1;
  return distanceInsideUpstreamM / (distanceInsideUpstreamM + distanceInsideDownstreamM);
}

/**
 * Builds the two boundary lines in a local equirectangular frame (meters,
 * centred on the segment's first vertex; good to well under a percent over a
 * segment, which is a few hundred meters at most) and measures points between
 * them. A segment is its chord from first to last vertex, as in Stage 4.
 */
export function createSurfaceProjector(geometry: SegmentSurfaceGeometry): SurfaceProjector {
  const { path } = geometry;
  if (path.length < 2) return { fractionAlong: () => 0 };
  const origin = path[0];
  const metersPerDegreeLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos((origin[1] * Math.PI) / 180);
  const toLocal = ([lon, lat]: LonLat): [number, number] => [
    (lon - origin[0]) * metersPerDegreeLon,
    (lat - origin[1]) * metersPerDegreeLat,
  ];
  const own = chordDirection(path, toLocal);
  if (!own) return { fractionAlong: () => 0 };
  const start = toLocal(path[0]);
  const end = toLocal(path[path.length - 1]);
  // Each boundary's direction points downstream; the start boundary is the
  // bisector with the upstream neighbour, the end boundary with the downstream one.
  const startDirection = boundaryDirection(own, geometry.upstreamNeighbourPath, toLocal);
  const endDirection = boundaryDirection(own, geometry.downstreamNeighbourPath, toLocal);
  return {
    fractionAlong(point) {
      const [px, py] = toLocal(point);
      const insideStart = (px - start[0]) * startDirection[0] + (py - start[1]) * startDirection[1];
      const insideEnd = (end[0] - px) * endDirection[0] + (end[1] - py) * endDirection[1];
      return fractionBetweenBoundaries(insideStart, insideEnd);
    },
  };
}

/** Unit vector from a path's first vertex to its last; null for a zero-length chord. */
function chordDirection(
  path: SegmentFlowlinePath,
  toLocal: (point: LonLat) => [number, number],
): [number, number] | null {
  const [ax, ay] = toLocal(path[0]);
  const [bx, by] = toLocal(path[path.length - 1]);
  const length = Math.hypot(bx - ax, by - ay);
  if (length === 0) return null;
  return [(bx - ax) / length, (by - ay) / length];
}

/**
 * Direction the boundary at a shared vertex faces: the mean of the two
 * segments' chord directions, so the boundary is the bisector of their two
 * perpendiculars. Without a neighbour, or at a hairpin, the segment's own
 * direction (the perpendicular). Mirrors Stage 4's `boundaryDirection`.
 */
function boundaryDirection(
  own: [number, number],
  neighbourPath: SegmentFlowlinePath | null,
  toLocal: (point: LonLat) => [number, number],
): [number, number] {
  const neighbour = neighbourPath && neighbourPath.length >= 2 ? chordDirection(neighbourPath, toLocal) : null;
  if (!neighbour) return own;
  const meanX = own[0] + neighbour[0];
  const meanY = own[1] + neighbour[1];
  const meanLength = Math.hypot(meanX, meanY);
  if (meanLength < HAIRPIN_MEAN_LENGTH) return own;
  return [meanX / meanLength, meanY / meanLength];
}
