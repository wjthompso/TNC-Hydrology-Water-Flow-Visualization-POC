// Sloped water surface for one Creek Segment. The pipeline writes a junction
// water-surface elevation at each end of a segment (`junctionWseUpstreamM`,
// `junctionWseDownstreamM`); the browser lifts every polygon vertex to the
// height interpolated between them by how far along the segment's flowline the
// vertex lies, so neighbouring segments meet at one height instead of stepping.

import type { LonLat, LonLatRing } from './creek-data-contract';

export interface JunctionWaterSurface {
  /** Water-surface elevation at the segment's upstream end, m NAVD88. */
  upstreamM: number;
  /** Water-surface elevation at the segment's downstream end, m NAVD88. */
  downstreamM: number;
}

/** Lon/lat vertices of a Creek Segment's flowline, ordered upstream to downstream. */
export type SegmentFlowlinePath = readonly LonLat[];

const EARTH_RADIUS_M = 6378137;

/**
 * Rings with a z on every vertex: `upstreamM` at the upstream end of the path,
 * `downstreamM` at the downstream end, linear in between. Vertices that
 * project past either end (the corridor is clipped at junction bisectors, so a
 * few do) take that end's height.
 */
export function slopedRingsWgs84(
  rings: readonly LonLatRing[],
  path: SegmentFlowlinePath,
  surface: JunctionWaterSurface,
): number[][][] {
  const projector = createPathProjector(path);
  return rings.map((ring) =>
    ring.map(([lon, lat]) => {
      const fraction = projector.fractionAlong([lon, lat]);
      return [lon, lat, surface.upstreamM + (surface.downstreamM - surface.upstreamM) * fraction];
    }),
  );
}

interface PathProjector {
  /** 0 at the first path vertex, 1 at the last, clamped. */
  fractionAlong(point: LonLat): number;
}

/**
 * Projects points onto a polyline in a local equirectangular frame (meters,
 * centred on the first vertex). Good to well under a percent over a segment,
 * which is a few hundred meters at most.
 */
export function createPathProjector(path: SegmentFlowlinePath): PathProjector {
  if (path.length < 2) return { fractionAlong: () => 0 };
  const origin = path[0];
  const metersPerDegreeLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos((origin[1] * Math.PI) / 180);
  const toLocal = ([lon, lat]: LonLat): [number, number] => [
    (lon - origin[0]) * metersPerDegreeLon,
    (lat - origin[1]) * metersPerDegreeLat,
  ];
  const vertices = path.map(toLocal);
  const cumulativeM: number[] = [0];
  for (let i = 1; i < vertices.length; i += 1) {
    cumulativeM.push(cumulativeM[i - 1] + Math.hypot(vertices[i][0] - vertices[i - 1][0], vertices[i][1] - vertices[i - 1][1]));
  }
  const totalM = cumulativeM[cumulativeM.length - 1];
  if (totalM === 0) return { fractionAlong: () => 0 };

  return {
    fractionAlong(point) {
      const [px, py] = toLocal(point);
      let bestDistanceSquared = Infinity;
      let bestAlongM = 0;
      for (let i = 1; i < vertices.length; i += 1) {
        const [ax, ay] = vertices[i - 1];
        const [bx, by] = vertices[i];
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        // Parameter of the closest point on this leg, clamped to the leg.
        const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
        const cx = ax + dx * t;
        const cy = ay + dy * t;
        const distanceSquared = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        if (distanceSquared < bestDistanceSquared) {
          bestDistanceSquared = distanceSquared;
          bestAlongM = cumulativeM[i - 1] + Math.sqrt(lengthSquared) * t;
        }
      }
      return Math.max(0, Math.min(1, bestAlongM / totalM));
    },
  };
}
