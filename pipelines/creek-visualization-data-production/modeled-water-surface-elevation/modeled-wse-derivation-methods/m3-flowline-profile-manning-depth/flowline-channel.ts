import type { AdjacentCreekSegments } from '../../../creek-segment-adjacency.ts';
import type { NetworkCreekSegment } from '../../creek-segment-network.ts';
import type { CrossSectionRecord, DownstreamVertexDirection } from '../../stage-file-formats.ts';
import type { LidarWindow } from './lidar-mosaic.ts';
import { ANCHOR_POSITION_ALONG_SEGMENT, CHANNEL_PROFILE } from './method-config.ts';
import { fillGaps, gaussianSmooth } from './series-smoothing.ts';

/**
 * The channel of one run of joined Creek Segments of m3: a continuous, smooth centerline fitted to the valley bottom of the 1 m lidar,
 * the creek's lowest point across every station of it (the thalweg) with the raw lidar there as the bed, and the lateral ground profile
 * at any station. Everything is in flow order: station 0 is the upstream end, offsets are positive to the LEFT of the flow direction.
 * The centerline only orients the cross-sections; the bed is never smoothed, so steps and pools stay in it (Will: "keep the true shape
 * of the V"). Only tall, short barriers (road and railroad fills whose culverts the bare-earth lidar cannot see) are breached.
 *
 * The centerline is the TNC flowline, smoothed, then moved sideways at every station to the valley bottom by a dynamic-programming fit
 * (lowest ground with a penalty on sideways bends), so it always moves downstream and cannot loop. A first version traced a least-cost
 * path through the Stage 1 thalweg points; on 7% of segments those points sat in side gullies or on flat ground out of order, and the
 * traced line turned back on itself (see METHOD.md "Design rationale").
 *
 * Why a channel instead of per-segment chords: the five Stage 1 sections of a segment sit on a straight chord of the TNC flowline,
 * which can be 30 m off the real channel; a polygon cut from a raster flood-fill of the ground around them inherits every
 * stair-step and noise break of the 1 m cells. A smoothed centerline with cross-sections cut perpendicular to it gives edges that
 * are smooth functions of position along the creek. See DESIGN.md in `wse-polygon-generation-methods/flowline-channel-ribbon`.
 */

const PARAMETERS = CHANNEL_PROFILE;

export interface Point {
  x: number;
  y: number;
}

/** A Creek Segment turned into flow order: its upstream vertex first. */
export interface OrientedSegment {
  segmentId: string;
  /** Chord length between the two vertices, meters (the length every other stage uses for network distance). */
  chordLengthM: number;
  upstreamVertex: Point;
  downstreamVertex: Point;
  /** Stage 1 thalweg points in flow order. */
  thalwegPoints: Point[];
}

/**
 * Chains of Creek Segments joined at shared vertices, in vertex order: a run starts at a segment with no neighbour at its
 * start vertex and follows the shared end vertices. A multi-path flowline has one run per path.
 */
export function segmentRuns<Segment extends { segmentId: string }>(
  segments: readonly Segment[],
  adjacentById: ReadonlyMap<string, AdjacentCreekSegments>,
): Segment[][] {
  const segmentById = new Map(segments.map((segment) => [segment.segmentId, segment]));
  const runs: Segment[][] = [];
  for (const first of segments) {
    if (adjacentById.get(first.segmentId)?.atStart) continue;
    const run: Segment[] = [];
    for (let next: Segment | undefined = first; next; next = segmentById.get(adjacentById.get(next.segmentId)?.atEnd?.segmentId ?? '')) run.push(next);
    runs.push(run);
  }
  return runs;
}

/** One run of vertex-order segments as flow-order oriented segments (reversed when the vertex order runs upstream). */
export function orientRun(
  run: readonly NetworkCreekSegment[],
  recordById: ReadonlyMap<string, CrossSectionRecord>,
  direction: DownstreamVertexDirection,
): OrientedSegment[] {
  const oriented = run.map((segment): OrientedSegment => {
    const record = recordById.get(segment.segmentId);
    const points = (record?.sections ?? []).map((section) => ({ x: section.thalwegUtm.x, y: section.thalwegUtm.y }));
    return direction === 1
      ? { segmentId: segment.segmentId, chordLengthM: segment.preciseLengthM, upstreamVertex: segment.startUtm, downstreamVertex: segment.endUtm, thalwegPoints: points }
      : { segmentId: segment.segmentId, chordLengthM: segment.preciseLengthM, upstreamVertex: segment.endUtm, downstreamVertex: segment.startUtm, thalwegPoints: points.reverse() };
  });
  return direction === 1 ? oriented : oriented.reverse();
}

/** Resamples a polyline to points `spacingM` apart along it, first and last point kept (the last step may be shorter). */
function resamplePolyline(points: readonly Point[], spacingM: number): Point[] {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1] as Point;
    const b = points[index] as Point;
    lengths.push((lengths[index - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const totalM = lengths[lengths.length - 1] as number;
  const count = Math.max(2, Math.round(totalM / spacingM) + 1);
  const resampled: Point[] = [];
  let piece = 0;
  for (let index = 0; index < count; index += 1) {
    const targetM = (index / (count - 1)) * totalM;
    while (piece < points.length - 2 && (lengths[piece + 1] as number) < targetM) piece += 1;
    const a = points[piece] as Point;
    const b = points[piece + 1] as Point;
    const pieceM = (lengths[piece + 1] as number) - (lengths[piece] as number);
    const fraction = pieceM === 0 ? 0 : (targetM - (lengths[piece] as number)) / pieceM;
    resampled.push({ x: a.x + fraction * (b.x - a.x), y: a.y + fraction * (b.y - a.y) });
  }
  return resampled;
}

// ---------------------------------------------------------------- the channel

/** Lateral sample offsets of a cross-section: fine near the centerline, coarse farther out, symmetric about 0, ascending. */
export function crossSectionOffsetsM(): number[] {
  const { fineStepM, fineHalfWidthM, coarseStepM, halfWidthM } = PARAMETERS.crossSection;
  const positive: number[] = [];
  for (let offset = fineStepM; offset <= fineHalfWidthM + 1e-9; offset += fineStepM) positive.push(offset);
  for (let offset = fineHalfWidthM + coarseStepM; offset <= halfWidthM + 1e-9; offset += coarseStepM) positive.push(offset);
  return [...positive.map((offset) => -offset).reverse(), 0, ...positive];
}

export interface RunChannel {
  window: LidarWindow;
  segments: readonly OrientedSegment[];
  /** Distance between table stations along the centerline, meters (about `tableSpacingM`, exact so the run is a whole number of steps). */
  spacingM: number;
  stationCount: number;
  /** Smoothed centerline (EPSG 32610) and its unit LEFT normal at every station. */
  x: Float64Array;
  y: Float64Array;
  normalX: Float64Array;
  normalY: Float64Array;
  /** Strongest heading change per meter (1/m, positive = turning left) within `curvatureWindowM` of every station; used to keep inner-bend edges from crossing. */
  curvature: Float64Array;
  /** Offset of the creek's lowest point across every station from the centerline (`localLowestGround`), m: the station's position is there. */
  thalwegOffsetM: Float64Array;
  /** Bilinear lidar at that lowest point, unsmoothed (m NAVD88). */
  thalwegM: Float64Array;
  /** The bed the water stands on: `thalwegM`, lowered along the breach line where a barrier is breached (m NAVD88). */
  bedM: Float64Array;
  /** Barriers breached in `bedM`, in the order they were breached. */
  breaches: BarrierBreach[];
  /** 1 where the valley-bottom fit ended at the edge of its search width at this station (the nearest fitted flowline station). */
  atSearchEdge: Uint8Array;
  /** Stations whose lowest point was followed downhill all the way to `descentLimitM` from the centerline. */
  stationsAtDescentLimit: number;
  /** Stations without lidar near the centerline; their bed is interpolated from the neighbours at offset 0. */
  stationsWithoutLidar: number;
  /** Station index of each segment boundary: segment k spans boundaries[k] to boundaries[k + 1]. Length segments + 1. */
  boundaries: number[];
  /** Stations whose valley-bottom fit ended at the edge of the search width (the flowline may be farther than that from the channel). */
  stationsAtSearchEdge: number;
  /** Mean distance the centerline was moved sideways from the smoothed flowline, meters. */
  meanOffsetFromFlowlineM: number;
  /** Lidar ground at the point `offsetM` to the left of station `index`, or null on NoData. */
  groundAt(index: number, offsetM: number): number | null;
}

/**
 * Sideways offset of the valley bottom at every station of the smoothed flowline: the offsets (−searchHalfWidthM…searchHalfWidthM) that
 * minimize, over the whole run, the ground elevation at each station plus `bendPenaltyPerSquareMeter` × (change of offset from the previous
 * station)² plus `offsetPenaltyPerMeter` × |offset| (which only decides ties on a flat floor). The offset changes by at most
 * `maximumLateralStepPerStationM` per station, and on the inside of a bend it never reaches the radius of curvature.
 */
function valleyBottomOffsets(
  window: LidarWindow,
  base: { x: Float64Array; y: Float64Array; normalX: Float64Array; normalY: Float64Array; curvature: Float64Array },
): { offsets: Float64Array; atSearchEdge: Uint8Array } {
  const fit = PARAMETERS.valleyBottomFit;
  const count = base.x.length;
  const steps = Math.round(fit.searchHalfWidthM / fit.lateralStepM);
  const states = 2 * steps + 1;
  const offsetOf = (state: number): number => (state - steps) * fit.lateralStepM;
  const reach = Math.round(fit.maximumLateralStepPerStationM / fit.lateralStepM);
  const unreachable = 1e9;
  const stationCost = (station: number): Float64Array => {
    const costs = new Float64Array(states);
    const turn = base.curvature[station] as number;
    for (let state = 0; state < states; state += 1) {
      const offset = offsetOf(state);
      // An offset beyond the radius on the inside of a bend would put this station behind its neighbours.
      if (offset * turn > fit.innerBendRadiusFraction) {
        costs[state] = unreachable;
        continue;
      }
      const ground = window.bilinear((base.x[station] as number) + (base.normalX[station] as number) * offset, (base.y[station] as number) + (base.normalY[station] as number) * offset);
      costs[state] = ground === null ? unreachable : ground + fit.offsetPenaltyPerMeter * Math.abs(offset);
    }
    return costs;
  };
  const total = new Float64Array(states);
  total.set(stationCost(0));
  const previousState = new Int16Array(count * states);
  for (let station = 1; station < count; station += 1) {
    const costs = stationCost(station);
    const next = new Float64Array(states);
    for (let state = 0; state < states; state += 1) {
      let best = Infinity;
      let bestFrom = state;
      for (let from = Math.max(0, state - reach); from <= Math.min(states - 1, state + reach); from += 1) {
        const change = offsetOf(state) - offsetOf(from);
        const candidate = (total[from] as number) + fit.bendPenaltyPerSquareMeter * change * change;
        if (candidate < best) {
          best = candidate;
          bestFrom = from;
        }
      }
      next[state] = best + (costs[state] as number);
      previousState[station * states + state] = bestFrom;
    }
    total.set(next);
  }
  let state = 0;
  for (let candidate = 1; candidate < states; candidate += 1) if ((total[candidate] as number) < (total[state] as number)) state = candidate;
  const offsets = new Float64Array(count);
  const atSearchEdge = new Uint8Array(count);
  for (let station = count - 1; station >= 0; station -= 1) {
    offsets[station] = offsetOf(state);
    if (state === 0 || state === states - 1) atSearchEdge[station] = 1;
    if (station > 0) state = previousState[station * states + state] as number;
  }
  return { offsets, atSearchEdge };
}

/** Unit left normals and the strongest signed heading change per meter within the curvature window, for an evenly spaced line. */
function normalsAndCurvature(x: Float64Array, y: Float64Array, spacingM: number): { normalX: Float64Array; normalY: Float64Array; curvature: Float64Array } {
  const count = x.length;
  const normalX = new Float64Array(count);
  const normalY = new Float64Array(count);
  const heading = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const before = Math.max(0, index - 1);
    const after = Math.min(count - 1, index + 1);
    const tangentX = (x[after] as number) - (x[before] as number);
    const tangentY = (y[after] as number) - (y[before] as number);
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    normalX[index] = -tangentY / tangentLength;
    normalY[index] = tangentX / tangentLength;
    heading[index] = Math.atan2(tangentY, tangentX);
  }
  // Heading change per meter over ±2 stations, then the strongest bend within ±curvatureWindowM keeping its sign, so a section
  // never reaches farther than the bends around it allow (sections cut perpendicular to a bending line cross each other).
  const localCurvature = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const before = Math.max(0, index - 2);
    const after = Math.min(count - 1, index + 2);
    let turn = (heading[after] as number) - (heading[before] as number);
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    localCurvature[index] = turn / (Math.max(1, after - before) * spacingM);
  }
  const curvature = new Float64Array(count);
  const reachStations = Math.round(PARAMETERS.curvatureWindowM / spacingM);
  for (let index = 0; index < count; index += 1) {
    let strongest = 0;
    for (let other = Math.max(0, index - reachStations); other <= Math.min(count - 1, index + reachStations); other += 1) {
      if (Math.abs(localCurvature[other] as number) > Math.abs(strongest)) strongest = localCurvature[other] as number;
    }
    curvature[index] = strongest;
  }
  return { normalX, normalY, curvature };
}

/** Builds the channel of one run. `window` must cover the run plus the search and cross-section half-widths. */
export function buildRunChannel(segments: readonly OrientedSegment[], window: LidarWindow): RunChannel {
  // 1. The run's flowline (its vertex chain), evenly resampled and smoothed in plan view.
  const chain: Point[] = [(segments[0] as OrientedSegment).upstreamVertex, ...segments.map((segment) => segment.downstreamVertex)];
  const chainArcM = [0];
  for (let index = 1; index < chain.length; index += 1) {
    chainArcM.push((chainArcM[index - 1] as number) + Math.hypot((chain[index] as Point).x - (chain[index - 1] as Point).x, (chain[index] as Point).y - (chain[index - 1] as Point).y));
  }
  const dense = resamplePolyline(chain, PARAMETERS.tableSpacingM);
  const denseSpacingM = (chainArcM[chainArcM.length - 1] as number) / (dense.length - 1);
  const sigmaPoints = PARAMETERS.planSmoothingSigmaM / denseSpacingM;
  const base = { x: gaussianSmooth(dense.map((point) => point.x), sigmaPoints), y: gaussianSmooth(dense.map((point) => point.y), sigmaPoints) };
  const baseFrame = normalsAndCurvature(base.x, base.y, denseSpacingM);

  // 2. Moved sideways to the valley bottom, offsets smoothed, then stations laid evenly along the result.
  const { offsets, atSearchEdge } = valleyBottomOffsets(window, { ...base, ...baseFrame });
  const smoothOffsets = gaussianSmooth(offsets, PARAMETERS.valleyBottomFit.offsetSmoothingSigmaM / denseSpacingM);
  const fitted = Array.from(smoothOffsets, (offset, index) => ({
    x: (base.x[index] as number) + (baseFrame.normalX[index] as number) * offset,
    y: (base.y[index] as number) + (baseFrame.normalY[index] as number) * offset,
  }));
  const fittedArcM = [0];
  for (let index = 1; index < fitted.length; index += 1) {
    fittedArcM.push((fittedArcM[index - 1] as number) + Math.hypot((fitted[index] as Point).x - (fitted[index - 1] as Point).x, (fitted[index] as Point).y - (fitted[index - 1] as Point).y));
  }
  const stations = resamplePolyline(fitted, PARAMETERS.tableSpacingM);
  const stationCount = stations.length;
  // The fitted line is point for point the dense flowline it was moved from, so a station's search-edge flag is that of the dense point nearest it along the line.
  const stationAtSearchEdge = new Uint8Array(stationCount);
  for (let station = 0, dense = 0; station < stationCount; station += 1) {
    const stationArcM = (station / Math.max(1, stationCount - 1)) * (fittedArcM[fittedArcM.length - 1] as number);
    while (dense < fittedArcM.length - 1 && Math.abs((fittedArcM[dense + 1] as number) - stationArcM) <= Math.abs((fittedArcM[dense] as number) - stationArcM)) dense += 1;
    stationAtSearchEdge[station] = atSearchEdge[dense] as number;
  }
  const x = Float64Array.from(stations, (point) => point.x);
  const y = Float64Array.from(stations, (point) => point.y);
  const lengthM = fittedArcM[fittedArcM.length - 1] as number;
  const spacingM = lengthM / (stationCount - 1);
  const { normalX, normalY, curvature } = normalsAndCurvature(x, y, spacingM);

  const channel: RunChannel = {
    window,
    segments,
    spacingM,
    stationCount,
    x,
    y,
    normalX,
    normalY,
    curvature,
    thalwegOffsetM: new Float64Array(stationCount),
    thalwegM: new Float64Array(stationCount),
    bedM: new Float64Array(stationCount),
    breaches: [],
    atSearchEdge: stationAtSearchEdge,
    stationsAtDescentLimit: 0,
    stationsWithoutLidar: 0,
    boundaries: [],
    stationsAtSearchEdge: stationAtSearchEdge.reduce((sum, flag) => sum + flag, 0),
    meanOffsetFromFlowlineM: smoothOffsets.reduce((sum, offset) => sum + Math.abs(offset), 0) / smoothOffsets.length,
    groundAt: (index, offsetM) => window.bilinear((x[index] as number) + (normalX[index] as number) * offsetM, (y[index] as number) + (normalY[index] as number) * offsetM),
  };

  // 3. Thalweg (the lowest point across every station) and the bed: the raw lidar there, breached only through tall, short barriers.
  const raw = new Float64Array(stationCount).fill(Number.NaN);
  for (let index = 0; index < stationCount; index += 1) {
    const lowest = localLowestGround(channel, index);
    if (!lowest) {
      channel.stationsWithoutLidar += 1;
      continue;
    }
    raw[index] = lowest.groundM;
    channel.thalwegOffsetM[index] = lowest.offsetM;
    if (Math.abs(lowest.offsetM) >= PARAMETERS.bed.descentLimitM - 1e-9) channel.stationsAtDescentLimit += 1;
  }
  if (!fillGaps(raw)) throw new Error(`Creek Segment run starting at ${segments[0]?.segmentId ?? '?'} has no lidar under its channel.`);
  channel.thalwegM.set(raw);
  const breached = breachBarriers(raw, spacingM);
  channel.bedM.set(breached.bedM);
  channel.breaches = breached.breaches;

  // 4. Segment boundaries: the station at the same fraction of the fitted line's length as the shared vertex is of the flowline's,
  // through the dense station it was moved from.
  for (const vertexArcM of chainArcM) {
    const denseIndex = Math.round(vertexArcM / denseSpacingM);
    const fraction = (fittedArcM[Math.min(fittedArcM.length - 1, denseIndex)] as number) / (lengthM || 1);
    const station = Math.round(fraction * (stationCount - 1));
    const previous = channel.boundaries[channel.boundaries.length - 1];
    channel.boundaries.push(previous === undefined ? 0 : Math.max(previous, station));
  }
  channel.boundaries[channel.boundaries.length - 1] = stationCount - 1;
  return channel;
}

/**
 * The channel floor across one station: the lowest ground within `lateralSearchHalfWidthM` of the centerline, then downhill along the
 * section (one `lateralSearchStepM` at a time, while the next sample is lower) for at most `descentLimitM`. The descent matters where the
 * centerline sits a few meters up the side of a flat-floored channel: there the lowest nearby ground is on the bank, and depths measured
 * from it would put the whole floor under water at "zero depth". Null where the lidar has no data near the centerline.
 */
export function localLowestGround(channel: RunChannel, station: number): { offsetM: number; groundM: number } | null {
  const { lateralSearchHalfWidthM, lateralSearchStepM, descentLimitM } = PARAMETERS.bed;
  let best: { offsetM: number; groundM: number } | null = null;
  for (let offset = -lateralSearchHalfWidthM; offset <= lateralSearchHalfWidthM + 1e-9; offset += lateralSearchStepM) {
    const ground = channel.groundAt(station, offset);
    if (ground !== null && (!best || ground < best.groundM)) best = { offsetM: offset, groundM: ground };
  }
  if (!best) return null;
  for (;;) {
    let next: { offsetM: number; groundM: number } | null = null;
    for (const step of [-lateralSearchStepM, lateralSearchStepM]) {
      const offsetM: number = best.offsetM + step;
      if (Math.abs(offsetM) > descentLimitM + 1e-9) continue;
      const ground = channel.groundAt(station, offsetM);
      if (ground !== null && ground < (next ?? best).groundM) next = { offsetM, groundM: ground };
    }
    if (!next) return best;
    best = next;
  }
}

/** A barrier breached in the bed: a stretch where the raw bed would hold a pool at least `minimumPoolDepthM` deep behind a short rise. */
export interface BarrierBreach {
  /** Station of the barrier's crest: the lip the pool would spill over. */
  crestStation: number;
  /** The breach line runs from the pool bottom to the first station downstream that is no higher (the run end when there is none). */
  firstStation: number;
  lastStation: number;
  /** Crest − pool bottom: the depth of the pool the breach avoids, m. */
  poolDepthM: number;
  /** Crest − the bed at the last station, m. */
  heightAboveDownstreamM: number;
  /** Along-channel length of the barrier where it stands more than half the pool depth above the pool bottom, m. */
  lengthAtHalfHeightM: number;
}

/**
 * The bed with tall, short barriers breached (see `barrierCarving` in method-config.ts). Each pass finds the depressions of the bed (stretches
 * below the highest bed at or downstream of them), takes the deepest one at least `minimumPoolDepthM` deep whose barrier is short enough, and
 * lowers the bed from the pool bottom to the first station downstream at or below it along a straight line (never raising a station).
 * A barrier too long to breach is left, and its pool fills.
 */
function breachBarriers(thalwegM: Float64Array, spacingM: number): { bedM: Float64Array; breaches: BarrierBreach[] } {
  const { minimumPoolDepthM, maximumLengthAtHalfHeightM } = PARAMETERS.barrierCarving;
  const bed = Float64Array.from(thalwegM);
  const count = bed.length;
  const breaches: BarrierBreach[] = [];
  const tooLongCrests = new Set<number>();
  for (let pass = 0; pass < count; pass += 1) {
    const level = new Float64Array(count);
    level[count - 1] = bed[count - 1] as number;
    for (let index = count - 2; index >= 0; index -= 1) level[index] = Math.max(bed[index] as number, level[index + 1] as number);
    let deepest: { bottom: number; crest: number; depthM: number } | null = null;
    for (let start = 0; start < count; ) {
      if ((level[start] as number) - (bed[start] as number) <= 1e-9) {
        start += 1;
        continue;
      }
      let crest = start;
      let bottom = start;
      for (; crest < count && (level[crest] as number) - (bed[crest] as number) > 1e-9; crest += 1) if ((bed[crest] as number) <= (bed[bottom] as number)) bottom = crest;
      const depthM = (level[start] as number) - (bed[bottom] as number);
      if (depthM >= minimumPoolDepthM && !tooLongCrests.has(crest) && (!deepest || depthM > deepest.depthM)) deepest = { bottom, crest, depthM };
      start = crest;
    }
    if (!deepest) return { bedM: bed, breaches };
    const { bottom, crest, depthM } = deepest;
    const bottomM = bed[bottom] as number;
    const halfHeightM = bottomM + depthM / 2;
    let upstreamFoot = crest;
    while (upstreamFoot > 0 && (bed[upstreamFoot - 1] as number) > halfHeightM) upstreamFoot -= 1;
    let downstreamFoot = crest;
    while (downstreamFoot < count - 1 && (bed[downstreamFoot + 1] as number) > halfHeightM) downstreamFoot += 1;
    const lengthAtHalfHeightM = (downstreamFoot - upstreamFoot + 1) * spacingM;
    if (lengthAtHalfHeightM > maximumLengthAtHalfHeightM) {
      tooLongCrests.add(crest);
      continue;
    }
    let outlet = crest + 1;
    while (outlet < count && (bed[outlet] as number) > bottomM) outlet += 1;
    const lastStation = Math.min(outlet, count - 1);
    const lastM = outlet < count ? (bed[outlet] as number) : bottomM;
    const crestM = bed[crest] as number;
    for (let index = bottom + 1; index <= lastStation; index += 1) {
      const lineM = bottomM + ((lastM - bottomM) * (index - bottom)) / (lastStation - bottom);
      bed[index] = Math.min(bed[index] as number, lineM);
    }
    breaches.push({
      crestStation: crest,
      firstStation: bottom,
      lastStation,
      poolDepthM: depthM,
      heightAboveDownstreamM: crestM - lastM,
      lengthAtHalfHeightM,
    });
  }
  throw new Error('Barrier breaching did not finish.');
}

/** The creek's lowest point across a table station (where its bed was measured), EPSG 32610. */
export function thalwegPoint(channel: RunChannel, station: number): Point {
  const offsetM = channel.thalwegOffsetM[station] as number;
  return { x: (channel.x[station] as number) + (channel.normalX[station] as number) * offsetM, y: (channel.y[station] as number) + (channel.normalY[station] as number) * offsetM };
}

/** True where a breach lowered the bed below the lidar at the station's lowest point. */
export function isBreachedStation(channel: RunChannel, station: number): boolean {
  return (channel.bedM[station] as number) < (channel.thalwegM[station] as number) - 1e-6;
}

/**
 * The water-surface stations of the segment between table stations `first` and `last` (see `waterSurfaceStations` in method-config.ts):
 * table station indices from `first` to `last`, which of them is the WSE Anchor Point, and each one's distance from `first` along the
 * centerline (rounded to cm, as the ribbon saves it, so Stage 3 and the browser smooth the water over the same positions). The anchor is the
 * table station nearest the middle, or, when that one is breached, the nearest station of the segment that is not.
 */
export function waterSurfaceStations(
  channel: RunChannel,
  first: number,
  last: number,
): { stations: number[]; anchorStation: number; stationDistancesM: number[] } {
  let anchor = Math.round(first + (last - first) * ANCHOR_POSITION_ALONG_SEGMENT);
  if (isBreachedStation(channel, anchor)) {
    for (let distance = 1; distance <= last - first; distance += 1) {
      const candidate = [anchor - distance, anchor + distance].find((station) => station >= first && station <= last && !isBreachedStation(channel, station));
      if (candidate !== undefined) {
        anchor = candidate;
        break;
      }
    }
  }
  const stepsAlong = (from: number, to: number): number[] => {
    const span = to - from;
    if (span === 0) return [];
    const steps = Math.min(span, Math.ceil((span * channel.spacingM) / PARAMETERS.waterSurfaceStations.targetSpacingM));
    return Array.from({ length: steps }, (_, step) => from + Math.round(((step + 1) * span) / steps));
  };
  const towardAnchor = stepsAlong(first, anchor);
  const stations = [first, ...towardAnchor, ...stepsAlong(anchor, last)];
  const stationDistancesM = stations.map((station) => Math.round((station - first) * channel.spacingM * 100) / 100);
  return { stations, anchorStation: towardAnchor.length, stationDistancesM };
}

/** Arc length along the centerline from the run's first station to `index`, meters. */
export function arcLengthM(channel: RunChannel, index: number): number {
  return index * channel.spacingM;
}

/** Index of the station nearest an arc length, clamped to the run. */
export function stationAtArcLength(channel: RunChannel, arcM: number): number {
  return Math.max(0, Math.min(channel.stationCount - 1, Math.round(arcM / channel.spacingM)));
}

/** Bed at a fractional station index (linear interpolation; exact at a table station). */
export function bedAt(channel: RunChannel, stationIndex: number): number {
  const clamped = Math.max(0, Math.min(channel.stationCount - 1, stationIndex));
  const low = Math.floor(clamped);
  const high = Math.min(channel.stationCount - 1, low + 1);
  return (channel.bedM[low] as number) + (clamped - low) * ((channel.bedM[high] as number) - (channel.bedM[low] as number));
}

/**
 * Least-squares slope of the bed over `halfWindowM` either side of a station, positive where the bed falls downstream
 * (the stations run downstream). Fewer than 3 stations in the window uses the 3 nearest.
 */
export function bedSlopeAt(channel: RunChannel, stationIndex: number, halfWindowM: number): number {
  const reach = Math.max(1, Math.round(halfWindowM / channel.spacingM));
  const first = Math.max(0, stationIndex - reach);
  const last = Math.min(channel.stationCount - 1, stationIndex + reach);
  const count = last - first + 1;
  if (count < 3) return 0;
  let meanX = 0;
  let meanY = 0;
  for (let index = first; index <= last; index += 1) {
    meanX += index * channel.spacingM;
    meanY += channel.bedM[index] as number;
  }
  meanX /= count;
  meanY /= count;
  let covariance = 0;
  let variance = 0;
  for (let index = first; index <= last; index += 1) {
    covariance += (index * channel.spacingM - meanX) * ((channel.bedM[index] as number) - meanY);
    variance += (index * channel.spacingM - meanX) ** 2;
  }
  return variance === 0 ? 0 : -covariance / variance;
}
