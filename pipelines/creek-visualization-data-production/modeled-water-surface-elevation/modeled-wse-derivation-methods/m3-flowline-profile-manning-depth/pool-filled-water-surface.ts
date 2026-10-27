/**
 * The pool-filled water surface of m3 ("smooth the water, not the ground"), shared by Stage 3 (the Time Series `values`) and the browser
 * (the drawn `flowline-channel-ribbon` water), so the chart and the drawing apply the identical rule. Pure: no imports, no I/O.
 *
 * A run is a chain of Creek Segments of one flowline joined at shared vertices, in flow order. Each segment has water-surface stations
 * from its upstream boundary to its downstream boundary (the ribbon's stations; neighbours share the boundary station) with a bed at each
 * (`bedM`), and a flowing depth at its two ends (the junction depths). The flowing depth at station j of n is linear between the ends,
 * up + (down − up) × j ÷ (n − 1).
 *
 * 1. Depth-scaled smoothing: the flowing surface (bed + flowing depth) at each station is averaged over the stations within ±k × its
 *    flowing depth along the run (k = `smoothingHalfWindowDepthMultiple`). Thin steep water keeps its own value (its window is shorter
 *    than the station spacing), while deep flat water averages over tens of meters and drowns the bumps of the raw bed. The bed stays raw.
 *    A smoothed station keeps at least `minimumSmoothedDepthM` above its bed (or its own flowing depth, if less), because a mean taken
 *    across a sharp drop can fall below the lip.
 * 2. Pool fill: walking the run from its downstream end upstream, the surface at a station is the higher of its smoothed flowing surface
 *    and the surface just downstream, so water behind a step stands level up to the lip (a pool) and water on a smooth ramp follows the ramp.
 *
 * A dry segment (a junction depth of 0) or one without a value (null) has no water: its stations get no surface, and both steps start
 * again above it, so neither a window nor a pool reaches across a dry segment. Each wet stretch (consecutive wet segments) is one list of
 * stations in which a boundary station shared by two neighbours is one station, so both neighbours get the identical surface there. Near the
 * ends of a wet stretch the window shrinks to the same distance on both sides (down to the station alone at the end), so a sloping
 * surface is not pulled up or down there. Breached stations (bed on the breach line through a fill) are stations like any other.
 */

export interface PoolFillSegment {
  /** Bed at each water-surface station, upstream to downstream, m NAVD88. At least one station. */
  stationBedsM: readonly number[];
  /** Distance of each station from the segment's upstream boundary station along the channel centerline, m (0 first, the segment's length last). */
  stationDistancesM: readonly number[];
  /** Flowing water depth at the upstream and downstream end, m; 0 is dry, null has no value. */
  upstreamDepthM: number | null;
  downstreamDepthM: number | null;
}

/** Whether the segment carries water at this time: both junction depths known and above 0. */
export function isWetPoolFillSegment(segment: PoolFillSegment): boolean {
  return segment.upstreamDepthM !== null && segment.downstreamDepthM !== null && segment.upstreamDepthM > 0 && segment.downstreamDepthM > 0;
}

/** The smoothing parameters (m3's `POOL_FILLED_WATER_SURFACE` in method-config.ts). */
export interface WaterSurfaceSmoothing {
  /** k of the depth-scaled smoothing: the window is ±k × the station's flowing depth (0 turns it off). */
  smoothingHalfWindowDepthMultiple: number;
  /** A smoothed station's surface is at least its bed plus this, or plus its own flowing depth where that is less, m. */
  minimumSmoothedDepthM: number;
}

/** The water surface at every station of every segment of one run (flow order), or null for a segment without water. */
export function poolFilledRunSurfaces(segments: readonly PoolFillSegment[], smoothing: WaterSurfaceSmoothing): (number[] | null)[] {
  const surfaces: (number[] | null)[] = segments.map(() => null);
  let first = 0;
  while (first < segments.length) {
    if (!isWetPoolFillSegment(segments[first] as PoolFillSegment)) {
      first += 1;
      continue;
    }
    let last = first;
    while (last + 1 < segments.length && isWetPoolFillSegment(segments[last + 1] as PoolFillSegment)) last += 1;
    wetStretchSurfaces(segments.slice(first, last + 1), smoothing).forEach((surface, position) => {
      surfaces[first + position] = surface;
    });
    first = last + 1;
  }
  return surfaces;
}

interface StretchStation {
  /** Distance from the stretch's first station along the centerline, m. */
  positionM: number;
  bedM: number;
  flowingDepthM: number;
  flowingSurfaceM: number;
}

/** The surfaces of consecutive wet segments, smoothed and pool-filled as one list of stations. */
function wetStretchSurfaces(segments: readonly PoolFillSegment[], smoothing: WaterSurfaceSmoothing): number[][] {
  const stations: StretchStation[] = [];
  // Each segment's stations as indices into `stations`. A segment's last station is the next segment's first, so it is listed once,
  // by the next segment, at the index that segment's first station will take.
  const stationIndicesBySegment: number[][] = [];
  let segmentStartM = 0;
  segments.forEach((segment, position) => {
    const upstreamM = segment.upstreamDepthM as number;
    const downstreamM = segment.downstreamDepthM as number;
    const count = segment.stationBedsM.length;
    const indices: number[] = [];
    for (let station = 0; station < count; station += 1) {
      indices.push(stations.length);
      if (station === count - 1 && position < segments.length - 1) continue;
      const fraction = count === 1 ? 0 : station / (count - 1);
      const flowingDepthM = upstreamM + (downstreamM - upstreamM) * fraction;
      const bedM = segment.stationBedsM[station] as number;
      stations.push({ positionM: segmentStartM + (segment.stationDistancesM[station] as number), bedM, flowingDepthM, flowingSurfaceM: bedM + flowingDepthM });
    }
    stationIndicesBySegment.push(indices);
    segmentStartM += segment.stationDistancesM[count - 1] as number;
  });

  const startM = (stations[0] as StretchStation).positionM;
  const endM = (stations[stations.length - 1] as StretchStation).positionM;
  const smoothedM = stations.map((station, index) => {
    const halfWindowM = Math.min(smoothing.smoothingHalfWindowDepthMultiple * station.flowingDepthM, station.positionM - startM, endM - station.positionM);
    let sum = station.flowingSurfaceM;
    let count = 1;
    for (let other = index - 1; other >= 0 && station.positionM - (stations[other] as StretchStation).positionM <= halfWindowM; other -= 1) {
      sum += (stations[other] as StretchStation).flowingSurfaceM;
      count += 1;
    }
    for (let other = index + 1; other < stations.length && (stations[other] as StretchStation).positionM - station.positionM <= halfWindowM; other += 1) {
      sum += (stations[other] as StretchStation).flowingSurfaceM;
      count += 1;
    }
    return Math.max(sum / count, station.bedM + Math.min(smoothing.minimumSmoothedDepthM, station.flowingDepthM));
  });

  const surfaceM = new Array<number>(stations.length);
  let downstreamSurfaceM = Number.NEGATIVE_INFINITY;
  for (let index = stations.length - 1; index >= 0; index -= 1) {
    downstreamSurfaceM = Math.max(smoothedM[index] as number, downstreamSurfaceM);
    surfaceM[index] = downstreamSurfaceM;
  }
  return stationIndicesBySegment.map((indices) => indices.map((index) => surfaceM[index] as number));
}
