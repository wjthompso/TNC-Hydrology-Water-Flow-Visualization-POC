// Drawing of the 29 fish barriers from the TNC Digital Catalog layer "Fish Passage Barriers
// Assessment". Every barrier is a dot and a label pin (fish-barrier-pins.ts); only a culvert (a pipe
// under a road) is also drawn as a solid 3D cylinder. A solid shape implies a size and a physical
// blocker the catalog does not record for most barriers, and for a natural waterfall or steep stretch
// it is the wrong picture, so the rest are a pointer only (drawsSolidShape in fish-barrier-sites.ts,
// which also says which sizes are assumed). Switched on by the sidebar checkbox in
// fish-barrier-toggle.ts; the Dev tools section lists and flies to the barriers.
//
// Where a barrier is drawn: the catalog puts every barrier exactly on the TNC stream flowline, and
// that line runs a median 6 m from the lowest ground of the channel the scene draws. So each barrier is
// moved sideways, across the creek, onto the channel, and its readout says how far and from what. Along
// the creek it stays where it was surveyed. Three position sources, best first:
//   a. The midline of the nearest drawn water polygon (creek-direction-from-water.ts). The water
//      polygons are traced from the 1 m bare-earth lidar, so their midline is the most faithful channel:
//      the barrier is centred on the blue water the reader sees.
//   b. The lowest ground the 3D scene's terrain shows across the creek (channel-thalweg-snap.ts). That
//      terrain (World Elevation plus USGS 3DEP) is coarser and smoother than the lidar, so its lowest
//      ground can sit a few metres off the water.
//   c. The catalog point itself, when neither of the above gives anything.
// Water draws only near the camera, so a far barrier starts on (b) and moves onto (a) when the camera
// comes near and the water draws. A barrier that has been centred on water stays there after the camera
// leaves; it does not slide back to the terrain guess.
//
// Each barrier gets the creek's downstream direction: a culvert is turned to lie along the flow, and the
// camera looks along it when it flies to any barrier. That direction is read (creek-direction-from-water.ts) from the water the scene
// draws at the barrier, else from the lowest ground across the creek, else from the TNC flowline, because
// the flowline can run well off the channel beside a bend. Water draws only near the camera, and small
// tributaries often draw none, so the lowest-ground reading is what turns the barriers on them; the
// water is read again whenever the camera comes to rest or the water layer changes.
// Labels are two-line pins like the creek name pins (fish-barrier-pins.ts).

import { watch } from '@arcgis/core/core/reactiveUtils';
import Graphic from '@arcgis/core/Graphic';
import Multipoint from '@arcgis/core/geometry/Multipoint';
import Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import ObjectSymbol3DLayer from '@arcgis/core/symbols/ObjectSymbol3DLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import TextSymbol3DLayer from '@arcgis/core/symbols/TextSymbol3DLayer';
import type SceneView from '@arcgis/core/views/SceneView';
import { waitAtMost } from './bounded-startup-wait';
import {
  LATERAL_STEP_M,
  SAMPLES_PER_SECTION,
  SECTION_STATIONS_ALONG_M,
  THALWEG_SEARCH_HALF_WIDTH_M,
  findChannelOffset,
  lowestGroundOffsetM,
  sectionSamplePoints,
  type ChannelSnap,
} from './channel-thalweg-snap';
import {
  WATER_MIDLINE_MAX_DISTANCE_M,
  angularDifferenceDegrees,
  nearestPointOnRibbonMidline,
  resolveCreekDirection,
  ribbonMidline,
  type CreekDirection,
  type DrawnWaterPolygon,
  type ThalwegPoint,
} from './creek-direction-from-water';
import type { ExperienceLifetime } from './experience-lifetime';
import { createFishBarrierCard } from './fish-barrier-card';
import { createFishBarrierPins } from './fish-barrier-pins';
import { readStatewideBarrierDetails, type StatewideLookup } from './fish-barrier-statewide';
import {
  CULVERT_AXIS_TURN_FROM_CREEK_DEGREES,
  FISH_BARRIER_LAYER_URL,
  TNC_STREAM_FLOWLINE_LAYER_URL,
  barrierTopHeightM,
  describeFishBarrierSite,
  drawsSolidShape,
  parseFishBarrierRecord,
  type BarrierStatus,
  type BarrierSiteDescription,
  type CulvertShape,
  type FishBarrierRecord,
} from './fish-barrier-sites';
import { nearestPointOnPaths, offsetPoint, type LonLatPair } from './geographic-path-geometry';
import { queryAllRows } from './hosted-feature-service-query';
/** USGS 11120600 Jalama Creek near Lompoc, the observed gauge; sites are listed nearest first. */
const OBSERVED_GAUGE_LONLAT: LonLatPair = [-120.484894, 34.513686];
/** A barrier farther than this from every flowline gets no turn and no snap; its readout says so. */
const MAX_FLOWLINE_DISTANCE_M = 50;
/** The ground answer can stall (an unreachable elevation service); barriers then stay on the flowline. */
const GROUND_QUERY_WAIT_LIMIT_MS = 20_000;
/** Layer the modeled renderer draws the water polygons into (modeled-water-scene-renderer.ts). */
const WATER_LAYER_ID = 'water-surface-elevation-polygons';
/** Directions are read again this long after the last camera or water change, so a burst of tile and water loads costs one pass. */
const DIRECTION_REFRESH_PAUSE_MS = 400;
/** A barrier is not redrawn for a direction change smaller than this, degrees. */
const MIN_REDRAW_TURN_DEGREES = 0.5;
/** A barrier is not moved onto the water's midline when that is closer than this to where it is drawn, m. */
const MIN_MOVE_ONTO_WATER_M = 0.5;
const FLY_TO_SCALE = 350;
const FLY_TO_TILT_DEGREES = 62;
const FLY_TO_DURATION_MS = 900;
/** The creek's direction read after arrival must differ from the one flown with by more than this, degrees, to trigger a correction flight. */
const FLY_TO_CORRECTION_MIN_TURN_DEGREES = 10;
const FLY_TO_CORRECTION_DURATION_MS = 500;

export const BARRIER_STATUS_COLORS: Readonly<Record<BarrierStatus, readonly [number, number, number, number]>> = {
  Total: [220, 38, 38, 1],
  Partial: [245, 158, 11, 1],
  Unknown: [148, 163, 184, 1],
};
/** A culvert TNC has removed or bypassed: its old footprint, drawn see-through. */
const REMOVED_GHOST_COLOR = [34, 197, 94, 0.35] as const;
/**
 * Passage not determined: the same shape in the Unknown gray, drawn see-through. A solid structure would
 * claim a confidence the survey does not have; the ghost says "something is here, not yet judged".
 */
const UNKNOWN_GHOST_COLOR = [148, 163, 184, 0.35] as const;
/** The floating "?" over an Unknown culvert sits this far above the top of its shape, m. */
const UNKNOWN_MARK_RISE_M = 1.5;

/** Which of the three position sources (see the file header) put the barrier where it is drawn. */
export interface BarrierPlacement {
  source: 'water' | 'terrain' | 'catalog';
  /** One plain sentence, starting lower case, saying how the spot was found and how far it is from the catalog point. */
  detail: string;
}

export interface FishBarrierSite {
  readonly record: FishBarrierRecord;
  readonly description: BarrierSiteDescription;
  /**
   * Creek's downstream direction at the site, degrees clockwise from north: from the drawn water when it
   * shows a clear axis, else from the lowest ground across the creek, else from the flowline. Null when none
   * gives one. It changes as the camera moves and water draws, so read it when you need it.
   */
  readonly downstreamBearingDegrees: number | null;
  /** Where that direction came from, with the numbers behind it. */
  readonly creekDirection: CreekDirection;
  readonly distanceToFlowlineM: number | null;
  readonly distanceToObservedGaugeM: number;
  /** Where the barrier is drawn: the catalog point moved sideways onto the channel when that was found. It moves onto the drawn water's midline when the water draws, so read it when you need it. */
  readonly drawnLonLat: LonLatPair;
  /** What the terrain alone found at the open: the lowest ground across the creek, or why none. Fixed once read. */
  readonly channelSnap: ChannelSnap;
  /** Which source put the barrier at `drawnLonLat`, and how far from the catalog point that is. */
  readonly placement: BarrierPlacement;
  /** Ground height under the drawn spot, m, or null when the terrain did not answer. */
  readonly groundM: number | null;
}

export interface FishBarrierMap {
  readonly sites: readonly FishBarrierSite[];
  /** Flies the camera to one site, looking upstream. */
  flyTo(site: FishBarrierSite): Promise<void>;
  /**
   * The statewide database's record of each barrier, by PassageID (full notes, structure owner, and
   * more), or null when it did not answer. Drawing never waits for it; the info card does.
   */
  readonly statewideDetails: Promise<StatewideLookup>;
  /** Removes every barrier, its pin, and its info card. The camera stays where it is. */
  close(): void;
}

export interface OpenFishBarrierMapOptions {
  /** Full-map container the barrier pins are added to. It must not take pointer events itself. */
  pinContainer: HTMLElement;
  lifetime: ExperienceLifetime;
}

/** Draws every barrier in the channel nearest its surveyed spot. Does not move the camera. */
export async function openFishBarrierMap(view: SceneView, options: OpenFishBarrierMapOptions): Promise<FishBarrierMap> {
  const barrierRowsRequest = queryAllRows({
    layerUrl: FISH_BARRIER_LAYER_URL,
    returnGeometry: true,
    outSpatialReferenceWkid: 4326,
  });
  // Started the moment the barrier ids are known and never awaited here: it cannot slow or fail the drawing.
  const statewideDetails = barrierRowsRequest
    .then((rows) =>
      readStatewideBarrierDetails(
        rows.flatMap((row) => (typeof row.attributes.PassageID === 'number' ? [row.attributes.PassageID] : [])),
      ),
    )
    .catch((): StatewideLookup => null);
  const [barrierRows, flowlineRows] = await Promise.all([
    barrierRowsRequest,
    queryAllRows({
      layerUrl: TNC_STREAM_FLOWLINE_LAYER_URL,
      outFields: ['COMID'],
      returnGeometry: true,
      outSpatialReferenceWkid: 4326,
    }),
  ]);

  const flowlinePaths = flowlineRows.flatMap((row) => {
    const paths = (row.geometry as { paths?: number[][][] } | undefined)?.paths ?? [];
    return paths.map((path) => path.map(([longitude, latitude]): LonLatPair => [longitude, latitude]));
  });

  const records = barrierRows.flatMap((row) => {
    const record = parseFishBarrierRecord(row);
    return record ? [record] : [];
  });
  const beside = records.map((record) => {
    const nearest = nearestPointOnPaths([record.longitude, record.latitude], flowlinePaths);
    return nearest !== null && nearest.distanceM <= MAX_FLOWLINE_DISTANCE_M ? nearest : null;
  });
  const groundBySite = await readGroundAcrossCreeks(
    view,
    records.map((record, index): [LonLatPair, number] | null => {
      const near = beside[index];
      return near ? [[record.longitude, record.latitude], near.bearingDegrees] : null;
    }),
  );

  const sites = records
    .map((record, index): MutableSite => {
      const near = beside[index];
      const catalogPoint: LonLatPair = [record.longitude, record.latitude];
      const ground = groundBySite[index];
      const channelSnap: ChannelSnap = !near
        ? { kind: 'none', reason: `no stream flowline within ${MAX_FLOWLINE_DISTANCE_M} m` }
        : !ground
          ? { kind: 'none', reason: 'the terrain did not answer' }
          : findChannelOffset(ground.sections);
      const lateralOffsetM = channelSnap.kind === 'channel' ? channelSnap.lateralOffsetM : 0;
      const drawnLonLat =
        near && lateralOffsetM !== 0 ? offsetPoint(catalogPoint, (near.bearingDegrees + 90) % 360, lateralOffsetM) : catalogPoint;
      const movedM = metersBetween(catalogPoint, drawnLonLat).toFixed(0);
      const placement: BarrierPlacement =
        channelSnap.kind === 'channel'
          ? {
              source: 'terrain',
              detail: `placed on the lowest ground the 3D terrain shows across the creek, ${movedM} m from the catalog point; no water is drawn here yet`,
            }
          : { source: 'catalog', detail: `left on the catalog point because ${channelSnap.reason}; no water is drawn here yet` };
      return {
        record,
        description: describeFishBarrierSite(record),
        downstreamBearingDegrees: near?.bearingDegrees ?? null,
        creekDirection: flowlineDirection(near?.bearingDegrees ?? null),
        flowlineBearingDegrees: near?.bearingDegrees ?? null,
        thalwegPoints: ground ? thalwegPointsOf(ground.sections) : [],
        waterDirection: null,
        distanceToFlowlineM: near?.distanceM ?? null,
        distanceToObservedGaugeM: metersBetween(OBSERVED_GAUGE_LONLAT, catalogPoint),
        drawnLonLat,
        channelSnap,
        placement,
        groundM: ground ? groundAtOffset(ground.stationZeroGroundM, lateralOffsetM) : null,
      };
    })
    .sort((a, b) => a.distanceToObservedGaugeM - b.distanceToObservedGaugeM);

  const layer = new GraphicsLayer({
    id: 'fish-barrier-map',
    listMode: 'hide',
    elevationInfo: { mode: 'relative-to-ground' },
  });
  view.map?.add(layer);
  // Only a culvert has graphics here (its body first, then the "?" of an Unknown one); every other barrier
  // is a pointer with nothing to move or turn.
  const graphicsBySite = new Map<MutableSite, Graphic[]>();
  for (const site of sites) {
    const graphics = siteGraphics(site);
    if (graphics.length > 0) graphicsBySite.set(site, graphics);
    layer.addMany(graphics);
  }

  // Centres each barrier on the drawn water's midline when that water is within reach (see the file
  // header), and moves its culvert graphics with it. Without water the barrier stays where it is: on the
  // terrain's guess the first time, on the water's midline ever after.
  const moveOntoWater = (site: MutableSite, water: ReturnType<typeof readDrawnWater>): void => {
    const foot = nearestPointOnRibbonMidline(site.drawnLonLat, water.polygonsNear(site.drawnLonLat));
    if (!foot) return;
    const moved = foot.distanceM >= MIN_MOVE_ONTO_WATER_M;
    if (!moved && site.placement.source === 'water') return;
    if (moved) {
      site.drawnLonLat = foot.point;
      // The ground under the new spot; a small error only shifts the label's foot, so the old height stays when the sampler has none.
      site.groundM = drawnGroundAt(view, foot.point) ?? site.groundM;
      for (const graphic of graphicsBySite.get(site) ?? []) {
        const z = (graphic.geometry as Point).z;
        graphic.geometry = new Point({ longitude: foot.point[0], latitude: foot.point[1], z, spatialReference: { wkid: 4326 } });
      }
    }
    site.placement = {
      source: 'water',
      detail: `centred on the middle line of the drawn water polygon, ${metersBetween([site.record.longitude, site.record.latitude], site.drawnLonLat).toFixed(0)} m from the catalog point`,
    };
  };

  // Moves each barrier onto the water now drawn, turns it to the creek as that water shows it, and redraws the ones that turned.
  const refreshDirections = (): void => {
    const water = readDrawnWater(view);
    for (const site of sites) {
      moveOntoWater(site, water);
      const reading = resolveCreekDirection(
        site.drawnLonLat,
        site.flowlineBearingDegrees,
        water.polygonsNear(site.drawnLonLat),
        site.thalwegPoints,
      );
      // Water draws only near the camera, so a barrier the camera has left reads no water. It keeps the
      // last water reading instead of falling back to a weaker source and turning back toward the flowline.
      if (reading.source === 'water') site.waterDirection = reading;
      const direction = site.waterDirection ?? reading;
      const turned =
        direction.bearingDegrees !== null &&
        (site.downstreamBearingDegrees === null ||
          angularDifferenceDegrees(direction.bearingDegrees, site.downstreamBearingDegrees) >= MIN_REDRAW_TURN_DEGREES);
      site.creekDirection = direction;
      site.downstreamBearingDegrees = direction.bearingDegrees;
      const body = graphicsBySite.get(site)?.[0];
      if (turned && body && drawsSolidShape(site.description.shape)) {
        body.symbol = shapeSymbol(site.description.shape, bodyColor(site), direction.bearingDegrees ?? 0).symbol;
      }
    }
  };
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshSoon = (): void => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshDirections();
    }, DIRECTION_REFRESH_PAUSE_MS);
  };
  const watchHandles: __esri.Handle[] = [watch(() => view.stationary, (stationary) => stationary && refreshSoon())];
  const waterLayer = view.map?.findLayerById(WATER_LAYER_ID) as GraphicsLayer | undefined;
  if (waterLayer) watchHandles.push(waterLayer.graphics.on('change', refreshSoon));
  refreshDirections();

  const flyTo = (site: FishBarrierSite): Promise<void> => flyToSite(view, site);
  const card = createFishBarrierCard(options.pinContainer, statewideDetails, options.lifetime);
  // Clicking a barrier flies to it and opens its card; the Dev tools picker only flies.
  const select = (site: FishBarrierSite, trigger: HTMLElement): void => {
    void flyTo(site);
    card.open(site, trigger);
  };
  const pins = createFishBarrierPins(view, sites, { pinContainer: options.pinContainer, select }, options.lifetime);

  return {
    sites,
    flyTo,
    statewideDetails,
    close() {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      for (const handle of watchHandles) handle.remove();
      card.close();
      pins.dispose();
      view.map?.remove(layer);
      layer.destroy();
    },
  };
}

/** A site as this module keeps it: the direction is re-read as water draws. Everyone else sees `FishBarrierSite`. */
type MutableSite = { -readonly [Key in keyof FishBarrierSite]: FishBarrierSite[Key] } & {
  /** The nearest TNC flowline leg's downstream direction: the fallback, and the way to tell which end of the water's axis is downstream. */
  flowlineBearingDegrees: number | null;
  /** The lowest ground on each usable line across the creek, in the frame of that flowline leg: the terrain's own trace of the channel. */
  thalwegPoints: ThalwegPoint[];
  /** The last direction read from drawn water, kept while the camera is elsewhere and the water is gone; null until water was seen. */
  waterDirection: CreekDirection | null;
};

function flowlineDirection(flowlineBearingDegrees: number | null): CreekDirection {
  return flowlineBearingDegrees === null
    ? { bearingDegrees: null, source: 'none', detail: 'no map line near enough, and no water read yet' }
    : { bearingDegrees: flowlineBearingDegrees, source: 'flowline', detail: 'read from the map line; no water read yet' };
}

/** Where each line across the creek found the channel low, as points along and across the flowline leg the lines were laid on. */
function thalwegPointsOf(sections: readonly (readonly (number | null)[])[]): ThalwegPoint[] {
  return sections.flatMap((groundM, index) => {
    const acrossM = lowestGroundOffsetM(groundM);
    return acrossM === null ? [] : [{ alongM: SECTION_STATIONS_ALONG_M[index], acrossM }];
  });
}

// --- Drawn water -----------------------------------------------------------------------------------

/**
 * The water the scene draws right now, one polygon per creek segment. A segment with no water to draw is
 * hidden by the renderer and does not count. Water draws only for the creeks near the camera, so far
 * barriers read none. A polygon's extent keeps a barrier from looking at segments it is nowhere near, and
 * a polygon's ribbon midline is worked out once for all the barriers that ask for it in one pass.
 */
function readDrawnWater(view: SceneView): { polygonsNear(point: LonLatPair): DrawnWaterPolygon[] } {
  const layer = view.map?.findLayerById(WATER_LAYER_ID) as GraphicsLayer | undefined;
  const polygons: (DrawnWaterPolygon & { west: number; east: number; south: number; north: number })[] = [];
  for (const graphic of layer?.graphics ?? []) {
    const geometry = graphic.geometry;
    if (!graphic.visible || geometry?.type !== 'polygon') continue;
    const extent = geometry.extent;
    if (!extent) continue;
    const rings = (geometry as __esri.Polygon).rings;
    let midline: readonly LonLatPair[] | null | undefined;
    polygons.push({
      rings,
      midline: () => (midline === undefined ? (midline = ribbonMidline(rings)) : midline),
      west: extent.xmin,
      east: extent.xmax,
      south: extent.ymin,
      north: extent.ymax,
    });
  }
  return {
    polygonsNear([longitude, latitude]) {
      const reachLat = WATER_MIDLINE_MAX_DISTANCE_M / 110540;
      const reachLon = WATER_MIDLINE_MAX_DISTANCE_M / (111320 * Math.cos((latitude * Math.PI) / 180));
      return polygons.filter(
        (polygon) =>
          longitude >= polygon.west - reachLon &&
          longitude <= polygon.east + reachLon &&
          latitude >= polygon.south - reachLat &&
          latitude <= polygon.north + reachLat,
      );
    },
  };
}

// --- Terrain ---------------------------------------------------------------------------------------

interface GroundAcrossCreek {
  /** One list of ground heights per station along the creek, each running across the creek; null where missing. */
  sections: (number | null)[][];
  /** The ground across the creek at the station on the barrier itself. */
  stationZeroGroundM: (number | null)[];
}

/**
 * Reads the terrain the scene draws (Esri World Elevation with the USGS 3DEP layer on top) along
 * several lines across the creek at each barrier, in one request. An entry is null for a barrier with no
 * flowline, and every entry is null when the terrain does not answer.
 */
async function readGroundAcrossCreeks(
  view: SceneView,
  placements: readonly ([LonLatPair, number] | null)[],
): Promise<(GroundAcrossCreek | null)[]> {
  const points: LonLatPair[] = [];
  for (const placement of placements) if (placement) points.push(...sectionSamplePoints(...placement));
  const none = placements.map(() => null);
  const ground = view.map?.ground;
  if (!ground || points.length === 0) return none;

  try {
    const answer = await waitAtMost(
      ground.queryElevation(
        new Multipoint({ points: points.map(([longitude, latitude]) => [longitude, latitude]), spatialReference: { wkid: 4326 } }),
        { demResolution: 'finest-contiguous' },
      ),
      GROUND_QUERY_WAIT_LIMIT_MS,
    );
    if (!answer.settled || answer.value.geometry.type !== 'multipoint') return none;
    const heights = answer.value.geometry.points.map((point) => (Number.isFinite(point[2]) ? point[2] : null));
    if (heights.length !== points.length) return none;

    let next = 0;
    return placements.map((placement) => {
      if (!placement) return null;
      const sections = SECTION_STATIONS_ALONG_M.map(() => {
        const section = heights.slice(next, next + SAMPLES_PER_SECTION);
        next += SAMPLES_PER_SECTION;
        return section;
      });
      return { sections, stationZeroGroundM: sections[SECTION_STATIONS_ALONG_M.indexOf(0)] };
    });
  } catch (error) {
    console.warn('[fish-barrier-map] terrain query failed; barriers stay on the catalog points', error);
    return none;
  }
}

/** The ground the scene draws under a point, m, or null while the ground view has no answer there (same read as anchor-ground-cache.ts). */
function drawnGroundAt(view: SceneView, [longitude, latitude]: LonLatPair): number | null {
  const sampler = view.groundView?.elevationSampler;
  const sampled = sampler?.queryElevation(new Point({ longitude, latitude, spatialReference: { wkid: 4326 } }));
  const z = sampled?.type === 'point' ? (sampled as Point).z : null;
  return typeof z === 'number' && Number.isFinite(z) && z !== sampler?.noDataValue ? z : null;
}

/** Ground height at a sideways offset on the line across the creek through the barrier. */
function groundAtOffset(acrossCreekGroundM: readonly (number | null)[], lateralOffsetM: number): number | null {
  const index = Math.round((lateralOffsetM + THALWEG_SEARCH_HALF_WIDTH_M) / LATERAL_STEP_M);
  return acrossCreekGroundM[index] ?? null;
}

// --- Camera ----------------------------------------------------------------------------------------

export async function flyToSite(view: SceneView, site: FishBarrierSite): Promise<void> {
  // The camera sits downstream of the barrier, on the creek's axis, and looks straight upstream at it, so
  // the creek runs away from the viewer instead of across the screen. goTo puts the camera on the side of
  // the target opposite its heading, so heading = downstream bearing + 180 gives that position.
  // The target is the barrier itself, not a point shifted sideways to clear the sidebar: a sideways shift
  // slides the camera off the creek's axis and the barrier is seen from the side. The sidebar is
  // translucent and covers only the left part of the window, so a barrier at the window's horizontal
  // centre stays visible, and the info card opens at the right edge, clear of the centre. (view.padding
  // would clear the sidebar too, but it also moves the map's centre for every other feature.)
  const target = new Point({ longitude: site.drawnLonLat[0], latitude: site.drawnLonLat[1], spatialReference: { wkid: 4326 } });
  const flyAlongCreek = async (downstreamBearingDegrees: number, durationMs: number): Promise<boolean> => {
    try {
      await view.goTo(
        { target, scale: FLY_TO_SCALE, tilt: FLY_TO_TILT_DEGREES, heading: (downstreamBearingDegrees + 180) % 360 },
        { duration: durationMs },
      );
      return true;
    } catch (error: unknown) {
      // Grabbing the map or picking another barrier mid-flight cancels this flight; that is not a failure.
      if (!(error instanceof Error && error.name === 'AbortError')) console.error('[fish-barrier-map] could not fly to a barrier', error);
      return false;
    }
  };

  const flownBearing = site.downstreamBearingDegrees ?? 0;
  const arrived = await flyAlongCreek(flownBearing, FLY_TO_DURATION_MS);
  // Water draws only near the camera, so the creek's direction is re-read once the camera rests here and
  // can differ from the one flown with. One short correction, once, keeps the camera straight on the
  // creek's axis. Not after a cancelled flight, and not without a direction to correct toward.
  const settledBearing = site.downstreamBearingDegrees;
  if (!arrived || settledBearing === null) return;
  const turnDegrees = Math.abs(((settledBearing - flownBearing + 540) % 360) - 180);
  if (turnDegrees > FLY_TO_CORRECTION_MIN_TURN_DEGREES) await flyAlongCreek(settledBearing, FLY_TO_CORRECTION_DURATION_MS);
}

// --- Drawing ---------------------------------------------------------------------------------------

/**
 * A culvert's 3D shape at its drawn spot, first, plus a floating "?" when its passage status is unknown.
 * Any other barrier has no graphic here: its dot and label pin (fish-barrier-pins.ts) are its whole mark.
 */
function siteGraphics(site: FishBarrierSite): Graphic[] {
  const { record, description } = site;
  const shape = description.shape;
  if (!drawsSolidShape(shape)) return [];
  const heading = site.downstreamBearingDegrees ?? 0;
  const body = shapeSymbol(shape, bodyColor(site), heading);
  const at = (z: number): Point =>
    new Point({ longitude: site.drawnLonLat[0], latitude: site.drawnLonLat[1], z, spatialReference: { wkid: 4326 } });
  const graphics = [new Graphic({ geometry: at(body.baseHeightM), symbol: body.symbol })];
  if (record.status === 'Unknown' && !description.removal) {
    graphics.push(
      new Graphic({
        geometry: at(barrierTopHeightM(shape) + UNKNOWN_MARK_RISE_M),
        symbol: new PointSymbol3D({
          symbolLayers: [
            new TextSymbol3DLayer({
              text: '?',
              size: 18,
              font: { weight: 'bold' },
              material: { color: [248, 250, 252, 1] },
              halo: { color: [15, 23, 42, 1], size: 2 },
            }),
          ],
        }),
      }),
    );
  }
  return graphics;
}

function bodyColor(site: FishBarrierSite): readonly [number, number, number, number] {
  const { record, description } = site;
  if (description.removal) return REMOVED_GHOST_COLOR;
  if (record.status === 'Unknown') return UNKNOWN_GHOST_COLOR;
  return BARRIER_STATUS_COLORS[record.status];
}

/**
 * A culvert is an Esri 3D cylinder lying flat, turned from the creek by CULVERT_AXIS_TURN_FROM_CREEK_DEGREES
 * (across the creek at 90, along it at 0). `baseHeightM` is where its anchor sits above
 * the ground. Only a culvert is solid (drawsSolidShape in fish-barrier-sites.ts says why).
 *
 * Rotation order in an ObjectSymbol3DLayer: tilt (about east-west) first, then heading (about vertical).
 * The API documents heading as the clockwise rotation about the vertical axis, tilt as rotation about the
 * east-west (x) axis, and depth as the north-south extent (ObjectSymbol3DLayer in @arcgis/core
 * interfaces.d.ts). The order is the one the SceneView builds: computeObjectRotation in
 * views/3d/layers/graphics/graphicUtils.js multiplies rotateZ(-heading), then rotateX(tilt), then
 * rotateY(roll), so a point is rolled, then tilted, then turned by the heading last. A cylinder is
 * vertical by default, so tilt 90 lays its long axis flat along north-south, and the heading then turns
 * that axis clockwise onto the creek's downstream bearing plus the culvert axis turn (an axis has no end,
 * so which end is which does not matter).
 */
function shapeSymbol(
  shape: CulvertShape,
  color: readonly [number, number, number, number],
  downstreamBearingDegrees: number,
): { symbol: PointSymbol3D; baseHeightM: number } {
  return {
    baseHeightM: shape.perchM + shape.diameterM / 2,
    symbol: new PointSymbol3D({
      symbolLayers: [
        new ObjectSymbol3DLayer({
          resource: { primitive: 'cylinder' },
          width: shape.diameterM,
          depth: shape.diameterM,
          height: shape.lengthM,
          tilt: 90,
          heading: (downstreamBearingDegrees + CULVERT_AXIS_TURN_FROM_CREEK_DEGREES) % 360,
          anchor: 'center',
          material: { color: [...color] },
          castShadows: true,
        }),
      ],
    }),
  };
}

function metersBetween(from: LonLatPair, to: LonLatPair): number {
  const metersPerDegreeLon = 111320 * Math.cos((from[1] * Math.PI) / 180);
  return Math.hypot((to[0] - from[0]) * metersPerDegreeLon, (to[1] - from[1]) * 110540);
}
