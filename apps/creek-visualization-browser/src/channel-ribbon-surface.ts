// Channel ribbon water (WSE Polygon Generation Method `flowline-channel-ribbon`, browserDrawing
// `channel-ribbon-depth`). A Creek Segment's buckets are depth rungs, and every bucket holds one
// ring with the same vertices in the same order: the left edge of the ribbon at stations
// 0…n−1 from upstream to downstream, then the right edge from n−1 back to 0, each vertex
// `[lon, lat, bedProfileM]`. At the selected time every station has its own water depth (the
// segment's junction depths, interpolated along the segment). This file slides each station's two
// edge vertices between the two rungs around that depth, at z = bed profile + depth, so the ribbon's
// width and height change continuously with time, and two neighbouring segments meet exactly
// because they share the boundary station and the junction depth.
//
// Display exaggeration (labeled, never stored in the data): on a steep segment the true depth is a
// few centimeters, thinner than the drawn terrain mesh is accurate (the mesh sits a median 0.13 m,
// 95th percentile 0.57 m, above the lidar on 20–40% slopes), so true-depth water hides. The method's
// declared display rule draws a steep segment at least `floor` deep (the width follows that depth) and
// lifts its surface by `lift`. Both ramp in with the bed slope between 3% and 8%, so neighbouring
// segments of similar slope get the same exaggeration and meet without a step. `?ribbonDisplayFloorM=`
// and `?ribbonDisplayLiftM=` set the full-ramp values; `0` for both draws true water. The Time Series
// and the chart keep true values.
//
// Version 2 (browserDrawing `channel-ribbon-pool-filled`) uses the same rings but draws them on the water
// surface pool-filled along the run (m3's `pool-filled-water-surface.ts` with m3's smoothing window, the same
// function and parameter Stage 3 writes the Time Series values with), so pools behind steps stand level, deep
// water drowns the bumps of the bed, and the chart equals the drawing at the anchor. Its display rule is off unless one of the two URL parameters is given.
//
// Anchor clearance lift (version 2 only, a drawing rule; the Time Series and the chart keep the model's value): the
// pipeline cannot know the ground the browser draws (a coarser, view-dependent 3DEP mesh that sits up to decimeters above
// the lidar on steep ground), so the browser lifts the drawn water at each WSE Anchor Point to at least that ground plus a
// margin: lift = max(0, browser ground + margin − drawn water at the anchor). Along a run the lift is linear between
// consecutive anchors, so every anchor gets exactly its own lift and neighbours still meet at the same height on their shared
// boundary station; beyond the first and last anchor of a wet stretch the end anchor's lift is held. `?ribbonAnchorClearanceM=`
// sets the margin (default 0.03 m: water drawn exactly at the ground flickers through it); `off` draws ribbon v2 without any
// clearance lift (anchor or station drape).
//
// Station drape (version 2, on top of the anchor lift): between anchors thin water is lifted the same way at every station, to
// at least the browser ground at the station's midline plus the margin, but only where the true depth (pool-filled surface − bed)
// is under a cap (`?ribbonDrapeDepthCapM=`, default 0.3 m; `off` turns the drape off), so deep water keeps its modeled surface. A
// station's lift tapers linearly to nothing over `?ribbonDrapeTaperM=` (default 5 m, about two and a half stations) on each side, so
// neighbouring stations do not jump; the taper stops at an anchor station and at deep water. A station's lift is the larger of the
// anchor blend and the drape, except at an anchor station, which keeps exactly its anchor lift.
//
// The map triangulates a whole ribbon ring with long thin triangles that can span many stations, which puts the drawn surface
// decimeters away from its stations' heights, so ribbon v2 is drawn as one quad ring per station interval: every triangle the map
// draws lies between two neighbouring stations and takes its height from them alone. `?ribbonStationIntervals=off` draws one ring,
// split at the anchor station when the anchor clearance lift is on (the anchor's cross-section is then an edge of the triangles).

import { POOL_FILLED_WATER_SURFACE } from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods/m3-flowline-profile-manning-depth/method-config.ts';
import { poolFilledRunSurfaces, type PoolFillSegment } from '../../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods/m3-flowline-profile-manning-depth/pool-filled-water-surface.ts';
import type { ElevationBucket, LonLat } from './creek-data-contract';
import type { BedParallelWaterDepth } from './sloped-water-surface';

/** `?ribbonDisplayFloorM=0.15`: drawn-depth floor (meters) of fully steep ribbon segments; 0 turns it off. */
export const RIBBON_DISPLAY_FLOOR_QUERY_PARAM = 'ribbonDisplayFloorM';
/** `?ribbonDisplayLiftM=0.3`: surface lift (meters) of fully steep ribbon segments; 0 turns it off. */
export const RIBBON_DISPLAY_LIFT_QUERY_PARAM = 'ribbonDisplayLiftM';

/** `?ribbonAnchorClearanceM=0.03`: ribbon v2's drawn water clears the browser ground at each anchor by this (meters); `off` turns the lift off. */
export const RIBBON_ANCHOR_CLEARANCE_QUERY_PARAM = 'ribbonAnchorClearanceM';
const DEFAULT_ANCHOR_CLEARANCE_M = 0.03;

/** `?ribbonDrapeDepthCapM=0.3`: ribbon v2's station drape lifts only stations whose true depth is under this (meters); `off` turns the drape off. */
export const RIBBON_DRAPE_DEPTH_CAP_QUERY_PARAM = 'ribbonDrapeDepthCapM';
const DEFAULT_DRAPE_DEPTH_CAP_M = 0.3;
/** `?ribbonDrapeTaperM=5`: a draped station's lift fades to nothing over this distance along the creek (meters) on each side; 0 lifts each station alone. */
export const RIBBON_DRAPE_TAPER_QUERY_PARAM = 'ribbonDrapeTaperM';
const DEFAULT_DRAPE_TAPER_M = 5;

/** `?ribbonStationIntervals=off`: ribbon v2 drawn as one ring (split at the anchor station when the lift is on) instead of one quad per station interval. */
export const RIBBON_STATION_INTERVALS_QUERY_PARAM = 'ribbonStationIntervals';

/** The method's declared display rule (`DISPLAY_RULE` in flowline-channel-ribbon/method-config.ts): keep the two in step. */
const DEFAULT_FLOOR_M = 0.15;
const DEFAULT_LIFT_M = 0.3;
const RAMP_START_SLOPE = 0.03;
const RAMP_FULL_SLOPE = 0.08;

function requestedMeters(parameter: string, fallbackM: number): number {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(parameter);
  const requested = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(requested) && requested >= 0 ? requested : fallbackM;
}

/**
 * The full-ramp floor and lift: the URL parameters when given, else the method's defaults when its rule is on by
 * default (ribbon v1), else 0 (ribbon v2 draws true water unless asked).
 */
function fullRampMeters(onByDefault: boolean): { floorM: number; liftM: number } {
  return {
    floorM: requestedMeters(RIBBON_DISPLAY_FLOOR_QUERY_PARAM, onByDefault ? DEFAULT_FLOOR_M : 0),
    liftM: requestedMeters(RIBBON_DISPLAY_LIFT_QUERY_PARAM, onByDefault ? DEFAULT_LIFT_M : 0),
  };
}

/** The display floor and lift for a segment with this bed slope (m/m): 0 below 3%, the full values above 8%, smooth in between. */
export function ribbonDisplayAdjustmentForSlope(bedSlope: number, onByDefault = true): { floorM: number; liftM: number } {
  const t = Math.min(1, Math.max(0, (bedSlope - RAMP_START_SLOPE) / (RAMP_FULL_SLOPE - RAMP_START_SLOPE)));
  const ramp = t * t * (3 - 2 * t);
  const { floorM, liftM } = fullRampMeters(onByDefault);
  return { floorM: ramp * floorM, liftM: ramp * liftM };
}

/** One line for the dev tools: what the display rule is doing. */
export function ribbonDisplayRuleDescription(onByDefault = true): string {
  const { floorM, liftM } = fullRampMeters(onByDefault);
  if (floorM === 0 && liftM === 0) return 'channel ribbon drawn at true depth (no display exaggeration)';
  return (
    `display exaggeration on steep segments (ramping in from ${RAMP_START_SLOPE * 100}% to ${RAMP_FULL_SLOPE * 100}% bed slope): ` +
    `drawn at least ${floorM} m deep and lifted ${liftM} m; chart and data keep true values`
  );
}

/** Ribbon v2's anchor clearance margin from the URL (meters, the default when absent or unreadable), or null when `off`. */
export function anchorClearanceMarginM(): number | null {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(RIBBON_ANCHOR_CLEARANCE_QUERY_PARAM);
  if (raw?.trim().toLowerCase() === 'off') return null;
  return requestedMeters(RIBBON_ANCHOR_CLEARANCE_QUERY_PARAM, DEFAULT_ANCHOR_CLEARANCE_M);
}

/** Ribbon v2's station drape from the URL: the depth cap and taper (meters, the defaults when absent or unreadable), or null when `off`. */
export function stationDrapeSettings(): { depthCapM: number; taperM: number } | null {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(RIBBON_DRAPE_DEPTH_CAP_QUERY_PARAM);
  if (raw?.trim().toLowerCase() === 'off') return null;
  return {
    depthCapM: requestedMeters(RIBBON_DRAPE_DEPTH_CAP_QUERY_PARAM, DEFAULT_DRAPE_DEPTH_CAP_M),
    taperM: requestedMeters(RIBBON_DRAPE_TAPER_QUERY_PARAM, DEFAULT_DRAPE_TAPER_M),
  };
}

/** Whether ribbon v2 is drawn one quad per station interval (the default) rather than as one ring (`?ribbonStationIntervals=off`). */
export function ribbonDrawnByStationInterval(): boolean {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(RIBBON_STATION_INTERVALS_QUERY_PARAM);
  return raw?.trim().toLowerCase() !== 'off';
}

/** One line for the dev tools: what the anchor clearance lift, the station drape and the drawing form are doing. */
export function anchorClearanceRuleDescription(): string {
  const marginM = anchorClearanceMarginM();
  const drape = stationDrapeSettings();
  const form = ribbonDrawnByStationInterval()
    ? 'drawn one quad per station interval'
    : `drawn as one ring (${RIBBON_STATION_INTERVALS_QUERY_PARAM}=off)`;
  if (marginM === null) return `no anchor clearance lift or station drape (${RIBBON_ANCHOR_CLEARANCE_QUERY_PARAM}=off); ${form}`;
  const anchorRule = `at each WSE Anchor Point the water is drawn at least ${marginM} m above the map's ground (lift linear between neighbouring anchors)`;
  const drapeRule = drape
    ? `between anchors, water under ${drape.depthCapM} m deep is draped to at least ${marginM} m above the map's ground at every station (tapering over ${drape.taperM} m)`
    : `no station drape (${RIBBON_DRAPE_DEPTH_CAP_QUERY_PARAM}=off)`;
  return `${anchorRule}; ${drapeRule}; ${form}; the chart keeps the model value`;
}

type Vertex = readonly number[];

/** The ring of a bucket when it is a usable ribbon rung: one ring, an even number of vertices (n left + n right), n ≥ 2. */
function rungVertices(bucket: ElevationBucket): readonly Vertex[] | null {
  const ring = bucket.ringsWgs84[0] as readonly Vertex[] | undefined;
  if (!ring || bucket.ringsWgs84.length !== 1 || ring.length < 4 || ring.length % 2 !== 0) return null;
  return ring;
}

/** A segment's rungs, lowest first, when its buckets are vertex-aligned ribbon rungs; null otherwise. */
function ribbonRungs(buckets: readonly ElevationBucket[]): { depthM: number; ring: readonly Vertex[] }[] | null {
  const rungs: { depthM: number; ring: readonly Vertex[] }[] = [];
  for (const bucket of buckets) {
    const ring = rungVertices(bucket);
    if (!ring) return null;
    rungs.push({ depthM: bucket.minWaterSurfaceElevationM, ring });
  }
  const first = rungs[0];
  if (!first || rungs.some((rung) => rung.ring.length !== first.ring.length)) return null;
  return rungs;
}

/**
 * The ribbon of one segment as a closed ring with z on every vertex. Station `station` sits at `depthAt(station)` above
 * its bed and at height `zAt(station, bedM, depthM)`. Between rungs the edge vertices move linearly with depth. Below the
 * first rung (1 cm) the ribbon tapers to the midline of that rung; a station with no depth collapses onto it. Above the
 * top rung the top rung's width is kept.
 */
function ribbonRingAtStationDepths(
  rungs: readonly { depthM: number; ring: readonly Vertex[] }[],
  depthAt: (station: number, stationCount: number) => number,
  zAt: (station: number, bedM: number, depthM: number) => number,
): number[][] {
  const first = rungs[0] as (typeof rungs)[number];
  const vertexCount = first.ring.length;
  const stationCount = vertexCount / 2;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let station = 0; station < stationCount; station += 1) {
    const depthM = Math.max(0, depthAt(station, stationCount));
    const leftIndex = station;
    const rightIndex = vertexCount - 1 - station;
    const firstLeft = first.ring[leftIndex] as Vertex;
    const firstRight = first.ring[rightIndex] as Vertex;
    const bedM = firstLeft[2] as number;
    // The two rungs around this depth and the way between them; below the first rung the lower "rung" is the midline.
    let lowerLeft: Vertex;
    let lowerRight: Vertex;
    let upperLeft: Vertex;
    let upperRight: Vertex;
    let t: number;
    if (depthM < first.depthM) {
      const midLon = ((firstLeft[0] as number) + (firstRight[0] as number)) / 2;
      const midLat = ((firstLeft[1] as number) + (firstRight[1] as number)) / 2;
      lowerLeft = lowerRight = [midLon, midLat];
      upperLeft = firstLeft;
      upperRight = firstRight;
      t = first.depthM > 0 ? depthM / first.depthM : 1;
    } else {
      let rung = 0;
      while (rung + 1 < rungs.length && (rungs[rung + 1] as (typeof rungs)[number]).depthM <= depthM) rung += 1;
      const lower = rungs[rung] as (typeof rungs)[number];
      const upper = rungs[Math.min(rungs.length - 1, rung + 1)] as (typeof rungs)[number];
      lowerLeft = lower.ring[leftIndex] as Vertex;
      lowerRight = lower.ring[rightIndex] as Vertex;
      upperLeft = upper.ring[leftIndex] as Vertex;
      upperRight = upper.ring[rightIndex] as Vertex;
      t = upper === lower ? 0 : Math.min(1, (depthM - lower.depthM) / (upper.depthM - lower.depthM));
    }
    const z = zAt(station, bedM, depthM);
    left.push([
      (lowerLeft[0] as number) + t * ((upperLeft[0] as number) - (lowerLeft[0] as number)),
      (lowerLeft[1] as number) + t * ((upperLeft[1] as number) - (lowerLeft[1] as number)),
      z,
    ]);
    right.push([
      (lowerRight[0] as number) + t * ((upperRight[0] as number) - (lowerRight[0] as number)),
      (lowerRight[1] as number) + t * ((upperRight[1] as number) - (lowerRight[1] as number)),
      z,
    ]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push([...(ring[0] as number[])]);
  return ring;
}

/**
 * The ribbon of one segment at the given depths (`channel-ribbon-depth`), as rings with z on every vertex (closed). Null when
 * the buckets are not vertex-aligned rungs, so the caller can fall back to the plain bed-parallel drawing. Each station's depth
 * is linear between the junction depths; its z is the bed plus that depth plus the lift.
 */
export function channelRibbonRingsWgs84(
  buckets: readonly ElevationBucket[],
  depth: BedParallelWaterDepth,
  /** Display lift added to every vertex's z (0 for true water). */
  liftM = 0,
): number[][][] | null {
  const rungs = ribbonRungs(buckets);
  if (!rungs) return null;
  const junction = depth.junctionDepth;
  const ring = ribbonRingAtStationDepths(
    rungs,
    (station, stationCount) => {
      const fraction = stationCount === 1 ? 0 : station / (stationCount - 1);
      return junction ? junction.upstreamM + (junction.downstreamM - junction.upstreamM) * fraction : depth.anchorDepthM;
    },
    (_station, bedM, depthM) => bedM + depthM + liftM,
  );
  return [ring];
}

/** The bed under each of a ribbon segment's stations, upstream to downstream (the z its rungs carry); null when the buckets are not rungs. */
export function channelRibbonStationBedsM(buckets: readonly ElevationBucket[]): number[] | null {
  const rungs = ribbonRungs(buckets);
  if (!rungs) return null;
  const ring = (rungs[0] as (typeof rungs)[number]).ring;
  return ring.slice(0, ring.length / 2).map((vertex) => vertex[2] as number);
}

/**
 * The midline point of each of a ribbon segment's stations, upstream to downstream: halfway between the first rung's two edge vertices,
 * where the ribbon narrows to as its depth goes to 0. Fixed for the segment, so a ground sample there can be kept across time steps.
 */
export function channelRibbonStationMidpointsLonLat(buckets: readonly ElevationBucket[]): LonLat[] | null {
  const rungs = ribbonRungs(buckets);
  if (!rungs) return null;
  const ring = (rungs[0] as (typeof rungs)[number]).ring;
  const stationCount = ring.length / 2;
  return Array.from({ length: stationCount }, (_, station): LonLat => {
    const left = ring[station] as Vertex;
    const right = ring[ring.length - 1 - station] as Vertex;
    return [((left[0] as number) + (right[0] as number)) / 2, ((left[1] as number) + (right[1] as number)) / 2];
  });
}

/** What the run walk needs to know about one ribbon segment of a flowline. */
export interface PoolFillRibbonSegment {
  buckets: readonly ElevationBucket[];
  /** The next segment of the run in flow order (`channelRibbon.downstreamSegmentId`), null at the run end. */
  downstreamSegmentId: string | null;
  /** Each station's distance from the segment's upstream boundary (`channelRibbon.stationDistancesM`), where the water is smoothed. */
  stationDistancesM: readonly number[];
}

/**
 * The pool-filled water surface at every station of every wet ribbon segment of one flowline (`channel-ribbon-pool-filled`).
 * Runs are rebuilt from each segment's `downstreamSegmentId`; a segment missing from `segments` ends the run above it, as a
 * segment without a value does in Stage 3. `junctionDepthsOf` returns the segment's held junction depths, or null without a value.
 */
export function poolFilledStationSurfacesBySegmentId(
  segments: ReadonlyMap<string, PoolFillRibbonSegment>,
  junctionDepthsOf: (segmentId: string) => { upstreamM: number; downstreamM: number } | null,
): Map<string, readonly number[]> {
  const surfaces = new Map<string, readonly number[]>();
  for (const runIds of ribbonRunIds(segments)) {
    const run = runIds.map((id): PoolFillSegment => {
      const segment = segments.get(id) as PoolFillRibbonSegment;
      const bedsM = channelRibbonStationBedsM(segment.buckets) ?? [];
      // A segment whose stations cannot be placed has no value here, so it ends the run's wet stretch as a null segment does in Stage 3.
      const depths = bedsM.length > 0 && bedsM.length === segment.stationDistancesM.length ? junctionDepthsOf(id) : null;
      return {
        stationBedsM: bedsM,
        stationDistancesM: segment.stationDistancesM,
        upstreamDepthM: depths?.upstreamM ?? null,
        downstreamDepthM: depths?.downstreamM ?? null,
      };
    });
    poolFilledRunSurfaces(run, POOL_FILLED_WATER_SURFACE).forEach((surface, position) => {
      if (surface && surface.length > 0) surfaces.set(runIds[position] as string, surface);
    });
  }
  return surfaces;
}

/**
 * The runs of one flowline's ribbon segments, each in flow order, rebuilt from `downstreamSegmentId`. A segment missing from
 * `segments` ends the run above it.
 */
function ribbonRunIds(segments: ReadonlyMap<string, PoolFillRibbonSegment>): string[][] {
  const hasUpstreamNeighbour = new Set<string>();
  for (const segment of segments.values()) {
    if (segment.downstreamSegmentId !== null && segments.has(segment.downstreamSegmentId)) hasUpstreamNeighbour.add(segment.downstreamSegmentId);
  }
  const runs: string[][] = [];
  const visited = new Set<string>();
  for (const headId of segments.keys()) {
    if (hasUpstreamNeighbour.has(headId)) continue;
    const runIds: string[] = [];
    for (let id: string | null = headId; id !== null && segments.has(id) && !visited.has(id); id = segments.get(id)?.downstreamSegmentId ?? null) {
      visited.add(id);
      runIds.push(id);
    }
    runs.push(runIds);
  }
  return runs;
}

/** One wet segment's own anchor clearance lift: at its anchor station, in meters. */
export interface AnchorLift {
  anchorStation: number;
  liftM: number;
}

/** The station drape for one flowline: its two settings, and what it needs to know about each wet segment's stations. */
export interface StationDrape {
  depthCapM: number;
  taperM: number;
  /** A segment's stations, or null to leave the segment undraped. */
  stationsOf: (segmentId: string) => {
    /** True water depth at each station, pool-filled surface − bed, m. */
    trueDepthsM: readonly number[];
    /** The lift each station needs to clear the browser ground by the margin, max(0, ground + margin − drawn before the lift); null where the map has no ground yet. */
    neededLiftsM: readonly (number | null)[];
  } | null;
}

/** The clearance lift at every station of one segment, and what the drape did there. */
export interface StationClearanceLifts {
  /** Lift added to each station's drawn height, m: the anchor blend, or the drape where that is larger. */
  stationLiftsM: number[];
  /** Stations the drape raised above the anchor blend. */
  drapedStationCount: number;
  /** Stations whose true depth is at or above the drape's depth cap, so they keep the anchor blend alone. */
  cappedStationCount: number;
}

/**
 * The clearance lift at every station of every wet ribbon segment of one flowline, keyed like `stationSurfacesM` (the segments with a
 * pool-filled surface). Along each wet stretch of a run the anchor lift is linear in distance between consecutive anchors and held
 * beyond the first and last; a shared boundary station gets one value for both neighbours. `anchorLiftOf` gives a segment's own lift,
 * or null when it has none (no anchor station); two anchors on one station keep the larger lift. With a `drape`, every other station
 * whose true depth is under the cap gets at least the lift it needs, tapering linearly to nothing over `taperM` on each side; the
 * taper stops at anchor stations and at stations as deep as the cap, and an anchor station keeps exactly its anchor lift.
 */
export function anchorClearanceStationLiftsBySegmentId(
  segments: ReadonlyMap<string, PoolFillRibbonSegment>,
  stationSurfacesM: ReadonlyMap<string, readonly number[]>,
  anchorLiftOf: (segmentId: string) => AnchorLift | null,
  drape: StationDrape | null = null,
): Map<string, StationClearanceLifts> {
  const liftsBySegmentId = new Map<string, StationClearanceLifts>();
  const addStretch = (stretchIds: readonly string[]): void => {
    // Station positions along the stretch; a segment's last station takes the next segment's first position, so both get one lift.
    const positionsBySegment: number[][] = [];
    let segmentStartM = 0;
    for (const id of stretchIds) {
      const distancesM = (segments.get(id) as PoolFillRibbonSegment).stationDistancesM;
      positionsBySegment.push(distancesM.map((distanceM) => segmentStartM + distanceM));
      segmentStartM += distancesM[distancesM.length - 1] as number;
    }
    positionsBySegment.forEach((positionsM, index) => {
      const next = positionsBySegment[index + 1];
      if (next) positionsM[positionsM.length - 1] = next[0] as number;
    });
    const anchors: { positionM: number; liftM: number }[] = [];
    stretchIds.forEach((id, index) => {
      const anchor = anchorLiftOf(id);
      const positionM = anchor ? positionsBySegment[index]?.[anchor.anchorStation] : undefined;
      if (!anchor || positionM === undefined) return;
      const previous = anchors[anchors.length - 1];
      if (previous && previous.positionM === positionM) previous.liftM = Math.max(previous.liftM, anchor.liftM);
      else anchors.push({ positionM, liftM: anchor.liftM });
    });
    anchors.sort((a, b) => a.positionM - b.positionM);
    const blendBySegment = positionsBySegment.map((positionsM) => positionsM.map((positionM) => liftBetweenAnchors(anchors, positionM)));
    const anchorPositionsM = new Set(anchors.map((anchor) => anchor.positionM));
    const drapeBySegment = drape ? stretchDrapeLiftsM(stretchIds, positionsBySegment, anchorPositionsM, drape) : null;
    stretchIds.forEach((id, index) => {
      const blendM = blendBySegment[index] as number[];
      const drapeM = drapeBySegment?.liftsBySegment[index];
      // The drape is 0 at anchor stations, so they keep exactly their anchor lift.
      const stationLiftsM = blendM.map((liftM, station) => (drapeM ? Math.max(liftM, drapeM[station] as number) : liftM));
      liftsBySegmentId.set(id, {
        stationLiftsM,
        drapedStationCount: stationLiftsM.filter((liftM, station) => liftM > (blendM[station] as number)).length,
        cappedStationCount: drapeBySegment?.cappedBySegment[index] ?? 0,
      });
    });
  };
  for (const runIds of ribbonRunIds(segments)) {
    let stretchIds: string[] = [];
    for (const id of runIds) {
      if (stationSurfacesM.has(id)) {
        stretchIds.push(id);
        continue;
      }
      if (stretchIds.length > 0) addStretch(stretchIds);
      stretchIds = [];
    }
    if (stretchIds.length > 0) addStretch(stretchIds);
  }
  return liftsBySegmentId;
}

/** Linear between the anchors around the position, the end anchor's lift beyond them; exactly an anchor's own lift at its position. */
function liftBetweenAnchors(anchors: readonly { positionM: number; liftM: number }[], positionM: number): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (!first || !last) return 0;
  if (positionM <= first.positionM) return first.liftM;
  if (positionM >= last.positionM) return last.liftM;
  let index = 0;
  while ((anchors[index + 1] as (typeof anchors)[number]).positionM <= positionM) index += 1;
  const lower = anchors[index] as (typeof anchors)[number];
  const upper = anchors[index + 1] as (typeof anchors)[number];
  return lower.liftM + ((positionM - lower.positionM) / (upper.positionM - lower.positionM)) * (upper.liftM - lower.liftM);
}

/**
 * The station drape along one wet stretch, per segment and station. Each station under the depth cap that needs a lift spreads it to
 * its neighbours as a tent, need × (1 − distance ÷ taper), and every station takes the largest tent over it. Anchor stations (at
 * `anchorPositionsM`), stations as deep as the cap and segments without drape input get 0 and stop the tents. A shared boundary
 * station is one station of the stretch with the larger of its two needs, so both neighbours get the same lift there.
 */
function stretchDrapeLiftsM(
  stretchIds: readonly string[],
  positionsBySegment: readonly (readonly number[])[],
  anchorPositionsM: ReadonlySet<number>,
  drape: StationDrape,
): { liftsBySegment: number[][]; cappedBySegment: number[] } {
  const stations: { positionM: number; drapeable: boolean; neededM: number; members: [segmentIndex: number, station: number][] }[] = [];
  const cappedBySegment = stretchIds.map(() => 0);
  stretchIds.forEach((id, segmentIndex) => {
    const input = drape.stationsOf(id);
    (positionsBySegment[segmentIndex] as readonly number[]).forEach((positionM, station) => {
      const depthM = input?.trueDepthsM[station];
      const underCap = depthM !== undefined && depthM < drape.depthCapM;
      if (input && !underCap) cappedBySegment[segmentIndex] = (cappedBySegment[segmentIndex] as number) + 1;
      const drapeable = underCap && !anchorPositionsM.has(positionM);
      const neededM = input?.neededLiftsM[station] ?? 0;
      const shared = station === 0 ? stations[stations.length - 1] : undefined;
      if (shared && shared.positionM === positionM) {
        shared.drapeable = shared.drapeable && drapeable;
        shared.neededM = Math.max(shared.neededM, neededM);
        shared.members.push([segmentIndex, station]);
      } else {
        stations.push({ positionM, drapeable, neededM, members: [[segmentIndex, station]] });
      }
    });
  });
  const liftsM = stations.map(() => 0);
  stations.forEach((source, sourceIndex) => {
    if (!source.drapeable || source.neededM <= 0) return;
    liftsM[sourceIndex] = Math.max(liftsM[sourceIndex] as number, source.neededM);
    for (const step of [-1, 1]) {
      for (let index = sourceIndex + step; stations[index]?.drapeable; index += step) {
        const share = 1 - Math.abs((stations[index] as (typeof stations)[number]).positionM - source.positionM) / drape.taperM;
        if (!(share > 0)) break;
        liftsM[index] = Math.max(liftsM[index] as number, source.neededM * share);
      }
    }
  });
  const liftsBySegment = positionsBySegment.map((positionsM) => positionsM.map(() => 0));
  stations.forEach((station, index) => {
    for (const [segmentIndex, stationIndex] of station.members) (liftsBySegment[segmentIndex] as number[])[stationIndex] = liftsM[index] as number;
  });
  return { liftsBySegment, cappedBySegment };
}

/** What the anchor clearance lift and the station drape add to one segment's pool-filled ribbon. */
export interface RibbonAnchorClearance {
  /** The lift at each station, m (`anchorClearanceStationLiftsBySegmentId`). */
  stationLiftsM: readonly number[];
  /** The segment's anchor station, where a ribbon drawn as one ring is split; null keeps one ring. */
  anchorStation: number | null;
}

/**
 * The ribbon of one segment on its pool-filled surface (`channel-ribbon-pool-filled`), as rings with z on every vertex (closed).
 * Each station's depth is surface − bed, raised to `floorM` by the optional display rule, and its z is the bed plus that depth plus
 * the lift, plus the station's clearance lift when given. With `byStationInterval` the ribbon is one quad ring per station interval;
 * otherwise one ring, split at the anchor station when a clearance is given. Null when the buckets are not rungs or the surfaces do
 * not match the stations.
 */
export function poolFilledChannelRibbonRingsWgs84(
  buckets: readonly ElevationBucket[],
  stationSurfacesM: readonly number[],
  floorM = 0,
  liftM = 0,
  clearance: RibbonAnchorClearance | null = null,
  byStationInterval = false,
): number[][][] | null {
  const rungs = ribbonRungs(buckets);
  if (!rungs || (rungs[0] as (typeof rungs)[number]).ring.length !== 2 * stationSurfacesM.length) return null;
  if (clearance && clearance.stationLiftsM.length !== stationSurfacesM.length) return null;
  const bedsM = channelRibbonStationBedsM(buckets) as number[];
  const ring = ribbonRingAtStationDepths(
    rungs,
    (station) => Math.max((stationSurfacesM[station] as number) - (bedsM[station] as number), floorM),
    (station, bedM, depthM) => bedM + depthM + liftM + (clearance ? (clearance.stationLiftsM[station] as number) : 0),
  );
  if (byStationInterval) return ribbonRingAsStationIntervals(ring);
  const halves = clearance && clearance.anchorStation !== null ? ribbonRingSplitAtStation(ring, clearance.anchorStation) : null;
  return halves ?? [ring];
}

/**
 * A closed ribbon ring (left edge stations 0…n−1, right edge n−1…0, first vertex repeated) as n − 1 closed quad rings, one per station
 * interval k: left k, left k + 1, right k + 1, right k. A quad that winds the other way than the whole ring (where the ribbon folds on a
 * tight bend) is reversed, because the map draws a ring wound the other way as a hole; it starts at left k either way.
 */
export function ribbonRingAsStationIntervals(ring: readonly number[][]): number[][][] {
  const stationCount = (ring.length - 1) / 2;
  const winding = Math.sign(signedAreaDegrees(ring));
  const quads: number[][][] = [];
  for (let station = 0; station + 1 < stationCount; station += 1) {
    const left = ring[station] as number[];
    const nextLeft = ring[station + 1] as number[];
    const nextRight = ring[2 * stationCount - 2 - station] as number[];
    const right = ring[2 * stationCount - 1 - station] as number[];
    const quad = [left, nextLeft, nextRight, right, left];
    quads.push(Math.sign(signedAreaDegrees(quad)) === -winding && winding !== 0 ? [left, right, nextRight, nextLeft, left] : quad);
  }
  return quads;
}

/**
 * The one ring `ribbonRingAsStationIntervals` cut into quads, or null when the rings are not such quads of `stationCount` stations.
 * Every quad k has left k first and right k + 1 third; its other two corners (left k + 1 and right k, in either order) are told apart
 * by the neighbouring quads, which share them.
 */
export function ribbonRingJoinedFromStationIntervals(rings: readonly (readonly number[][])[], stationCount: number): number[][] | null {
  if (stationCount < 2 || rings.length !== stationCount - 1 || rings.some((quad) => quad.length !== 5)) return null;
  const quad = (interval: number): readonly number[][] => rings[interval] as readonly number[][];
  const left = rings.map((_, interval) => quad(interval)[0] as number[]);
  const right = [null, ...rings.map((_, interval) => quad(interval)[2] as number[])];
  const last = stationCount - 2;
  if (stationCount === 2) {
    left.push(quad(0)[1] as number[]);
    right[0] = quad(0)[3] as number[];
  } else {
    const [firstA, firstB] = [quad(0)[1] as number[], quad(0)[3] as number[]];
    right[0] = sameVertex(firstA, left[1] as number[]) ? firstB : firstA;
    const [lastA, lastB] = [quad(last)[1] as number[], quad(last)[3] as number[]];
    left.push(sameVertex(lastB, right[last] as number[]) ? lastA : lastB);
  }
  const rightEdge = (right as number[][]).slice().reverse();
  return [...left, ...rightEdge, left[0] as number[]];
}

function sameVertex(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A closed ribbon ring (left edge stations 0…n−1, right edge n−1…0, first vertex repeated) as two closed rings sharing the
 * cross-section at `station`: upstream (stations 0…station) and downstream (station…n−1), both in the ring's own direction.
 * Null at an end station (its cross-section is already an edge) and when a half winds the other way than the whole ring (a fold),
 * because the map draws a ring wound the other way as a hole.
 */
export function ribbonRingSplitAtStation(ring: readonly number[][], station: number): [number[][], number[][]] | null {
  const stationCount = (ring.length - 1) / 2;
  if (!Number.isInteger(stationCount) || station <= 0 || station >= stationCount - 1) return null;
  const first = ring[0] as number[];
  const anchorLeft = ring[station] as number[];
  const upstream = [...ring.slice(0, station + 1), ...ring.slice(2 * stationCount - 1 - station, 2 * stationCount), first];
  const downstream = [...ring.slice(station, stationCount), ...ring.slice(stationCount, 2 * stationCount - station), anchorLeft];
  const winding = Math.sign(signedAreaDegrees(ring));
  if (winding === 0 || Math.sign(signedAreaDegrees(upstream)) !== winding || Math.sign(signedAreaDegrees(downstream)) !== winding) return null;
  return [upstream, downstream];
}

/** The one ring `ribbonRingSplitAtStation` split, or null when the rings are not such a split of `stationCount` stations. */
export function ribbonRingJoinedFromSplit(rings: readonly (readonly number[][])[], station: number, stationCount: number): number[][] | null {
  const [upstream, downstream] = rings;
  if (rings.length !== 2 || !upstream || !downstream) return null;
  if (upstream.length !== 2 * (station + 1) + 1 || downstream.length !== 2 * (stationCount - station) + 1) return null;
  const downstreamLeftCount = stationCount - station;
  return [
    ...upstream.slice(0, station + 1),
    ...downstream.slice(1, downstreamLeftCount),
    ...downstream.slice(downstreamLeftCount, 2 * downstreamLeftCount),
    ...upstream.slice(station + 2, 2 * station + 2),
    upstream[0] as number[],
  ];
}

/** Shoelace area in square degrees; its sign is the ring's winding. */
function signedAreaDegrees(ring: readonly (readonly number[])[]): number {
  let twiceArea = 0;
  for (let index = 0; index + 1 < ring.length; index += 1) {
    const [x1, y1] = ring[index] as readonly number[];
    const [x2, y2] = ring[index + 1] as readonly number[];
    twiceArea += (x1 as number) * (y2 as number) - (x2 as number) * (y1 as number);
  }
  return twiceArea / 2;
}
