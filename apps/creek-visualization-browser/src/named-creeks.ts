// Named creeks: the official creek names for the TNC flowlines that have one, and
// the grouping that turns many flowlines into one creek a person can talk about
// ("Jalama Creek" is 20 flowlines). Pure data and geometry; the map and the
// buttons live in named-creek-navigation.ts.

import type { LonLat } from './creek-data-contract';

/**
 * GNIS (Geographic Names Information System, the USGS registry of official US place names)
 * name of each TNC flowline that has one, keyed by the flowline's NHD (National Hydrography
 * Dataset) 1:24K COMID, the number before the dash in a Creek Segment id.
 *
 * Source: the `GNIS_NAME` field of `data/source-inputs/tnc-flowlines-dangermond-preserve.json`.
 * Two thirds of the preserve's flowlines (small tributaries) carry no GNIS name and are left out.
 * Four flowlines (27714693 Escondido; 27714697, 27714701, 27714703 Espada) have the name but an
 * empty `GNIS_ID`; they are kept because the name matches the creek their neighbours belong to.
 */
export const CREEK_NAME_BY_TNC_COMID: Readonly<Record<string, string>> = {
  '27714647': 'Escondido Creek',
  '27714681': 'Escondido Creek',
  '27714693': 'Escondido Creek',
  '27714695': 'Escondido Creek',
  '27714713': 'Escondido Creek',
  '27714715': 'Escondido Creek',
  '27714635': 'Espada Creek',
  '27714669': 'Espada Creek',
  '27714697': 'Espada Creek',
  '27714699': 'Espada Creek',
  '27714701': 'Espada Creek',
  '27714703': 'Espada Creek',
  '27714705': 'Espada Creek',
  '27714723': 'Espada Creek',
  '27714725': 'Espada Creek',
  '27714727': 'Gasper Creek',
  '27714729': 'Gasper Creek',
  '27714597': 'Jalama Creek',
  '27714599': 'Jalama Creek',
  '27714603': 'Jalama Creek',
  '27714611': 'Jalama Creek',
  '27714615': 'Jalama Creek',
  '27714617': 'Jalama Creek',
  '27714619': 'Jalama Creek',
  '27714621': 'Jalama Creek',
  '27714625': 'Jalama Creek',
  '27714627': 'Jalama Creek',
  '27714629': 'Jalama Creek',
  '27714633': 'Jalama Creek',
  '27714637': 'Jalama Creek',
  '27714639': 'Jalama Creek',
  '27714641': 'Jalama Creek',
  '27714645': 'Jalama Creek',
  '27714711': 'Jalama Creek',
  '27714731': 'Jalama Creek',
  '27716975': 'Jalama Creek',
  '27716981': 'Jalama Creek',
};

export type LonLatBbox = readonly [minLon: number, minLat: number, maxLon: number, maxLat: number];

/** Every TNC flowline that carries one creek name, gathered. */
export interface NamedCreek {
  name: string;
  /** The flowlines that make up this creek. */
  tncComids: readonly string[];
  /** One vertex chain per run of connected flowline segments, upstream to downstream. */
  pathsWgs84: readonly (readonly LonLat[])[];
  bboxWgs84: LonLatBbox;
  /**
   * Places on the creek where its floating label can hang: evenly spaced along every branch. The map
   * hangs the label on the spot nearest the middle of the part of the creek that is in view. Never empty.
   */
  labelSpotsWgs84: readonly LonLat[];
  /** Sum of the chains' leg lengths, m. */
  lengthM: number;
}

const EARTH_RADIUS_M = 6378137;

/**
 * Groups flowlines by creek name, alphabetical by name. A flowline whose COMID has no name is
 * left out. `pathsByTncComid` is what `flowlinePathsByTncComid` returns for the Creek Segment paths.
 */
export function groupNamedCreeks(
  pathsByTncComid: ReadonlyMap<string, readonly (readonly LonLat[])[]>,
  nameByTncComid: Readonly<Record<string, string>> = CREEK_NAME_BY_TNC_COMID,
): NamedCreek[] {
  const comidsByName = new Map<string, string[]>();
  for (const tncComid of pathsByTncComid.keys()) {
    const name = nameByTncComid[tncComid];
    if (!name) continue;
    comidsByName.set(name, [...(comidsByName.get(name) ?? []), tncComid]);
  }

  const creeks: NamedCreek[] = [];
  for (const [name, tncComids] of comidsByName) {
    const pathsWgs84 = tncComids.flatMap((tncComid) => pathsByTncComid.get(tncComid) ?? []);
    const vertices = pathsWgs84.flat();
    if (vertices.length === 0) continue;
    const lengthM = pathsWgs84.reduce((sum, path) => sum + pathLengthM(path), 0);
    creeks.push({
      name,
      tncComids,
      pathsWgs84,
      bboxWgs84: bboxOf(vertices),
      labelSpotsWgs84: labelSpots(pathsWgs84),
      lengthM,
    });
  }
  return creeks.sort((a, b) => a.name.localeCompare(b.name));
}

function bboxOf(vertices: readonly LonLat[]): LonLatBbox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of vertices) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Distance between neighbouring label spots, m. Close enough that the label can follow a short visible
 * stretch of a creek, far enough apart that a 16 km creek stays near 160 spots.
 */
const LABEL_SPOT_SPACING_M = 100;

/**
 * Evenly spaced spots along every path, in meters rather than per vertex, since the flowlines' vertices
 * bunch up on bends.
 */
function labelSpots(paths: readonly (readonly LonLat[])[]): LonLat[] {
  const spacingM = LABEL_SPOT_SPACING_M;
  const along: LonLat[] = [];
  for (const path of paths) {
    if (path.length === 1) along.push(path[0]);
    // Distance from the start of the current leg to the next spot; 0 puts a spot on the path's first vertex.
    let toNextSpotM = 0;
    for (let index = 1; index < path.length; index += 1) {
      const [fromLon, fromLat] = path[index - 1];
      const [toLon, toLat] = path[index];
      const legM = distanceM(path[index - 1], path[index]);
      let atM = toNextSpotM;
      while (atM <= legM) {
        const fraction = legM === 0 ? 0 : atM / legM;
        along.push([fromLon + (toLon - fromLon) * fraction, fromLat + (toLat - fromLat) * fraction]);
        atM += spacingM;
      }
      toNextSpotM = atM - legM;
    }
  }
  return along;
}

function pathLengthM(path: readonly LonLat[]): number {
  let lengthM = 0;
  for (let index = 1; index < path.length; index += 1) lengthM += distanceM(path[index - 1], path[index]);
  return lengthM;
}

/** Straight-line meters between two lon/lat points; good to well under a percent over a few kilometers. */
function distanceM([lonA, latA]: LonLat, [lonB, latB]: LonLat): number {
  const latRadians = (((latA + latB) / 2) * Math.PI) / 180;
  const dx = (((lonB - lonA) * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(latRadians);
  const dy = (((latB - latA) * Math.PI) / 180) * EARTH_RADIUS_M;
  return Math.hypot(dx, dy);
}
