// Drawing of the 29 fish barriers from the TNC Digital Catalog layer "Fish Passage Barriers
// Assessment", each built to the size the record or a TNC source documents (fish-barrier-sites.ts
// says which sizes are assumed). Switched on by the sidebar checkbox in fish-barrier-toggle.ts; the
// Dev tools section lists and flies to the barriers.
//
// Where a barrier is drawn: the catalog puts every barrier exactly on the TNC stream flowline, and
// that line runs a median 6 m from the lowest ground of the channel the scene draws. So each barrier is
// moved sideways, across the creek, onto that channel (channel-thalweg-snap.ts), and its readout says by
// how much. Along the creek it stays where it was surveyed.
//
// Each barrier is turned to the creek's downstream direction, so a culvert lies along the flow and a
// dam lies across it. That direction is read from the water the scene draws at the barrier
// (creek-direction-from-water.ts), because the TNC flowline can run well off the channel beside a bend;
// the flowline's direction is the fallback where no water is drawn. Water draws only near the camera, so
// the directions are read again whenever the camera comes to rest or the water layer changes.
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
  sectionSamplePoints,
  type ChannelSnap,
} from './channel-thalweg-snap';
import {
  WATER_SEARCH_RADIUS_M,
  angularDifferenceDegrees,
  resolveCreekDirection,
  type CreekDirection,
} from './creek-direction-from-water';
import type { ExperienceLifetime } from './experience-lifetime';
import { createFishBarrierCard } from './fish-barrier-card';
import { createFishBarrierPins } from './fish-barrier-pins';
import { readStatewideBarrierDetails, type StatewideLookup } from './fish-barrier-statewide';
import {
  FISH_BARRIER_LAYER_URL,
  STEEP_STRETCH_DRAWN_PITCH_DEGREES,
  STEEP_STRETCH_FLOAT_HEIGHT_M,
  TNC_STREAM_FLOWLINE_LAYER_URL,
  barrierTopHeightM,
  describeFishBarrierSite,
  parseFishBarrierRecord,
  type BarrierShape,
  type BarrierStatus,
  type BarrierSiteDescription,
  type FishBarrierRecord,
} from './fish-barrier-sites';
import { nearestPointOnPaths, offsetPoint, type LonLatPair } from './geographic-path-geometry';
import { queryAllRows } from './hosted-feature-service-query';
import { sidebarRightPx } from './screen-box-layout';

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
const FLY_TO_SCALE = 350;
const FLY_TO_TILT_DEGREES = 62;
const FLY_TO_DURATION_MS = 900;
const METERS_PER_INCH = 0.0254;
const CSS_PIXELS_PER_INCH = 96;

export const BARRIER_STATUS_COLORS: Readonly<Record<BarrierStatus, readonly [number, number, number, number]>> = {
  Total: [220, 38, 38, 1],
  Partial: [245, 158, 11, 1],
  Unknown: [148, 163, 184, 1],
};
/** A barrier TNC has removed or bypassed: its old footprint, drawn see-through. */
const REMOVED_GHOST_COLOR = [34, 197, 94, 0.35] as const;
/**
 * Passage not determined: the same shape in the Unknown gray, drawn see-through. A solid structure would
 * claim a confidence the survey does not have; the ghost says "something is here, not yet judged".
 */
const UNKNOWN_GHOST_COLOR = [148, 163, 184, 0.35] as const;
/** A steep stretch is terrain, so it is drawn lighter than a structure even when its status is known. */
const STEEP_STRETCH_ALPHA = 0.55;
/** The floating "?" over an Unknown barrier sits this far above the top of its shape, m. */
const UNKNOWN_MARK_RISE_M = 1.5;
/** Camera heading offset from the creek's axis, degrees. A pipe seen along its length looks like an upright can. */
const FLY_TO_HEADING_OFFSET_DEGREES_BY_SHAPE: Readonly<Record<BarrierShape['kind'], number>> = {
  culvert: 70,
  'crossing-structure': 25,
  waterfall: 25,
  'steep-stretch': 45,
};

export interface FishBarrierSite {
  readonly record: FishBarrierRecord;
  readonly description: BarrierSiteDescription;
  /**
   * Creek's downstream direction at the site, degrees clockwise from north: from the drawn water when it
   * shows a clear axis, else from the flowline. Null when neither gives one. It changes as the camera
   * moves and water draws, so read it when you need it.
   */
  readonly downstreamBearingDegrees: number | null;
  /** Where that direction came from, with the numbers behind it. */
  readonly creekDirection: CreekDirection;
  readonly distanceToFlowlineM: number | null;
  readonly distanceToObservedGaugeM: number;
  /** Where the barrier is drawn: the catalog point moved sideways onto the channel when that was found. */
  readonly drawnLonLat: LonLatPair;
  /** How the drawn spot was found, and how far it moved from the catalog point. */
  readonly channelSnap: ChannelSnap;
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
      return {
        record,
        description: describeFishBarrierSite(record),
        downstreamBearingDegrees: near?.bearingDegrees ?? null,
        creekDirection: flowlineDirection(near?.bearingDegrees ?? null),
        flowlineBearingDegrees: near?.bearingDegrees ?? null,
        distanceToFlowlineM: near?.distanceM ?? null,
        distanceToObservedGaugeM: metersBetween(OBSERVED_GAUGE_LONLAT, catalogPoint),
        drawnLonLat:
          near && lateralOffsetM !== 0 ? offsetPoint(catalogPoint, (near.bearingDegrees + 90) % 360, lateralOffsetM) : catalogPoint,
        channelSnap,
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
  const bodyGraphicBySite = new Map<MutableSite, Graphic>();
  for (const site of sites) {
    const graphics = siteGraphics(site);
    bodyGraphicBySite.set(site, graphics[0]);
    layer.addMany(graphics);
  }

  // Turns each barrier to the creek as the water now drawn shows it, and redraws the ones that turned.
  const refreshDirections = (): void => {
    const water = readDrawnWater(view);
    for (const site of sites) {
      const direction = resolveCreekDirection(site.drawnLonLat, site.flowlineBearingDegrees, water.verticesNear(site.drawnLonLat));
      const turned =
        direction.bearingDegrees !== null &&
        (site.downstreamBearingDegrees === null ||
          angularDifferenceDegrees(direction.bearingDegrees, site.downstreamBearingDegrees) >= MIN_REDRAW_TURN_DEGREES);
      site.creekDirection = direction;
      site.downstreamBearingDegrees = direction.bearingDegrees;
      const body = bodyGraphicBySite.get(site);
      if (turned && body) body.symbol = shapeSymbol(site.description.shape, bodyColor(site), direction.bearingDegrees ?? 0).symbol;
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
};

function flowlineDirection(flowlineBearingDegrees: number | null): CreekDirection {
  return flowlineBearingDegrees === null
    ? { bearingDegrees: null, source: 'none', detail: 'no map line near enough, and no water read yet' }
    : { bearingDegrees: flowlineBearingDegrees, source: 'flowline', detail: 'read from the map line; no water read yet' };
}

// --- Drawn water -----------------------------------------------------------------------------------

/**
 * The vertices of the water the scene draws right now. A segment with no water to draw is hidden by the
 * renderer and does not count. Water draws only for the creeks near the camera, so far barriers read none.
 */
function readDrawnWater(view: SceneView): { verticesNear(point: LonLatPair): number[][] } {
  const layer = view.map?.findLayerById(WATER_LAYER_ID) as GraphicsLayer | undefined;
  const polygons: { rings: number[][][]; west: number; east: number; south: number; north: number }[] = [];
  for (const graphic of layer?.graphics ?? []) {
    const geometry = graphic.geometry;
    if (!graphic.visible || geometry?.type !== 'polygon') continue;
    const extent = geometry.extent;
    if (!extent) continue;
    polygons.push({ rings: (geometry as __esri.Polygon).rings, west: extent.xmin, east: extent.xmax, south: extent.ymin, north: extent.ymax });
  }
  return {
    verticesNear([longitude, latitude]) {
      const reachLat = WATER_SEARCH_RADIUS_M / 110540;
      const reachLon = WATER_SEARCH_RADIUS_M / (111320 * Math.cos((latitude * Math.PI) / 180));
      const vertices: number[][] = [];
      for (const polygon of polygons) {
        if (longitude < polygon.west - reachLon || longitude > polygon.east + reachLon) continue;
        if (latitude < polygon.south - reachLat || latitude > polygon.north + reachLat) continue;
        for (const ring of polygon.rings) vertices.push(...ring);
      }
      return vertices;
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

/** Ground height at a sideways offset on the line across the creek through the barrier. */
function groundAtOffset(acrossCreekGroundM: readonly (number | null)[], lateralOffsetM: number): number | null {
  const index = Math.round((lateralOffsetM + THALWEG_SEARCH_HALF_WIDTH_M) / LATERAL_STEP_M);
  return acrossCreekGroundM[index] ?? null;
}

// --- Camera ----------------------------------------------------------------------------------------

export function flyToSite(view: SceneView, site: FishBarrierSite): Promise<void> {
  // The camera looks upstream, off the creek's axis so the shape reads in 3D. A pipe lies along the creek,
  // so looking along it foreshortens it into an upright can: a pipe is viewed from nearly the side.
  const offset = FLY_TO_HEADING_OFFSET_DEGREES_BY_SHAPE[site.description.shape.kind];
  const heading = ((site.downstreamBearingDegrees ?? 0) + 180 + offset) % 360;
  // The camera looks at the middle of the whole window, and the sidebar covers its left part. Looking
  // at a spot left of the barrier puts the barrier in the middle of the clear part instead, so its
  // pin clears the sidebar. The camera's "right" is 90 degrees clockwise of its heading.
  const shiftM = (sidebarRightPx(view) / 2) * (FLY_TO_SCALE * METERS_PER_INCH) / CSS_PIXELS_PER_INCH;
  const [longitude, latitude] = offsetPoint(site.drawnLonLat, (heading + 270) % 360, shiftM);
  return view
    .goTo(
      {
        target: new Point({ longitude, latitude, spatialReference: { wkid: 4326 } }),
        scale: FLY_TO_SCALE,
        tilt: FLY_TO_TILT_DEGREES,
        heading,
      },
      { duration: FLY_TO_DURATION_MS },
    )
    .catch((error: unknown) => {
      // Grabbing the map or picking another barrier mid-flight cancels this flight; that is not a failure.
      if (!(error instanceof Error && error.name === 'AbortError')) console.error('[fish-barrier-map] could not fly to a barrier', error);
    });
}

// --- Drawing ---------------------------------------------------------------------------------------

/** The barrier's 3D shape at its drawn spot, plus a floating "?" when its passage status is unknown. */
function siteGraphics(site: FishBarrierSite): Graphic[] {
  const { record, description } = site;
  const heading = site.downstreamBearingDegrees ?? 0;
  const body = shapeSymbol(description.shape, bodyColor(site), heading);
  const at = (z: number): Point =>
    new Point({ longitude: site.drawnLonLat[0], latitude: site.drawnLonLat[1], z, spatialReference: { wkid: 4326 } });
  const graphics = [new Graphic({ geometry: at(body.baseHeightM), symbol: body.symbol })];
  if (record.status === 'Unknown' && !description.removal) {
    graphics.push(
      new Graphic({
        geometry: at(barrierTopHeightM(description.shape) + UNKNOWN_MARK_RISE_M),
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
  const [red, green, blue] = BARRIER_STATUS_COLORS[record.status];
  return description.shape.kind === 'steep-stretch' ? [red, green, blue, STEEP_STRETCH_ALPHA] : BARRIER_STATUS_COLORS[record.status];
}

/**
 * Each shape is an Esri 3D primitive (cylinder, cube) at its real size, so a viewer can judge how big the
 * barrier is against the creek. `baseHeightM` is where the shape's anchor sits above the ground.
 *
 * Rotation order in an ObjectSymbol3DLayer: tilt (about east-west) first, then heading (about vertical).
 * A cylinder is vertical by default, so tilt 90 lays it flat along north-south, and the heading then
 * turns it to lie along the creek. A cube's depth runs north-south before the heading, so after it the
 * depth runs along the creek and the width across it.
 */
function shapeSymbol(
  shape: BarrierShape,
  color: readonly [number, number, number, number],
  downstreamBearingDegrees: number,
): { symbol: PointSymbol3D; baseHeightM: number } {
  const material = { color: [...color] };
  switch (shape.kind) {
    case 'culvert':
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
              heading: downstreamBearingDegrees,
              anchor: 'center',
              material,
              castShadows: true,
            }),
          ],
        }),
      };
    case 'crossing-structure':
      return {
        baseHeightM: 0,
        symbol: new PointSymbol3D({
          symbolLayers: [
            new ObjectSymbol3DLayer({
              resource: { primitive: 'cube' },
              // Width runs across the creek, depth along it.
              width: shape.spanM,
              depth: shape.lengthM,
              height: shape.heightM,
              heading: downstreamBearingDegrees,
              anchor: 'bottom',
              material,
              castShadows: true,
            }),
          ],
        }),
      };
    case 'waterfall':
      return {
        baseHeightM: 0,
        symbol: new PointSymbol3D({
          symbolLayers: [
            new ObjectSymbol3DLayer({
              resource: { primitive: 'cube' },
              width: shape.spanM,
              depth: shape.spanM / 3,
              height: shape.heightM,
              heading: downstreamBearingDegrees,
              anchor: 'bottom',
              material,
              castShadows: true,
            }),
          ],
        }),
      };
    case 'steep-stretch':
      return {
        baseHeightM: STEEP_STRETCH_FLOAT_HEIGHT_M,
        symbol: new PointSymbol3D({
          symbolLayers: [
            new ObjectSymbol3DLayer({
              // A thin slab along the creek, raised at its upstream end: a ramp that reads as "steep here".
              resource: { primitive: 'cube' },
              width: shape.widthM,
              depth: shape.lengthM,
              height: 0.4,
              // Measured in the running app: a positive tilt raises the downstream end of a slab turned to the
              // creek, so the sign is negative to raise the upstream end, as the creek bed does.
              tilt: -STEEP_STRETCH_DRAWN_PITCH_DEGREES,
              heading: downstreamBearingDegrees,
              anchor: 'center',
              material,
              castShadows: false,
            }),
          ],
        }),
      };
  }
}

function metersBetween(from: LonLatPair, to: LonLatPair): number {
  const metersPerDegreeLon = 111320 * Math.cos((from[1] * Math.PI) / 180);
  return Math.hypot((to[0] - from[0]) * metersPerDegreeLon, (to[1] - from[1]) * 110540);
}
