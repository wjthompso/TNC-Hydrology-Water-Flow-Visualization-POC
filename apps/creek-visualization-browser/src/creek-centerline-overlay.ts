// Creek centerline overlay: a thin white line along every TNC flowline plus a
// small dot on each original vertex of that flowline, so a reader can see where
// the Creek Segments run and where they meet. Off by default; the geometry is
// built from the Creek Segment paths the first time it is shown, so a reader
// who never turns it on pays nothing.
//
// Each Creek Segment path holds the two original flowline vertices it spans
// (upstream to downstream), so chaining a flowline's segments rebuilds the
// whole flowline and the segment end points are exactly its vertices.

import Graphic from '@arcgis/core/Graphic';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import IconSymbol3DLayer from '@arcgis/core/symbols/IconSymbol3DLayer';
import LineSymbol3D from '@arcgis/core/symbols/LineSymbol3D';
import LineSymbol3DLayer from '@arcgis/core/symbols/LineSymbol3DLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import type SceneView from '@arcgis/core/views/SceneView';
import type { LonLat } from './creek-data-contract';
import type { CreekSegmentPathRecord } from './modeled-water-data-store';

/** Sidebar checkbox label: a plain phrase first, the glossary term in parentheses. */
export const CREEK_CENTERLINE_TOGGLE_LABEL = 'Show creek centerlines and vertices (TNC flowline)';

/** Stays visible over the blue water and over satellite imagery. */
const CENTERLINE_COLOR = '#ffffff';
const CENTERLINE_WIDTH_PT = 2;
const VERTEX_FILL_COLOR = '#ffffff';
const VERTEX_OUTLINE_COLOR = '#0c4a6e';
const VERTEX_SIZE_PT = 7;
/**
 * The paths carry no heights, and water is drawn above the ground, so a line
 * draped on the ground would vanish under the water. Hovering this far above
 * the ground keeps it visible over the water.
 */
const HEIGHT_ABOVE_GROUND_M = 2;
/** A line at a height above ground follows the terrain only at its vertices, so segments are cut this short. */
const DENSIFY_STEP_M = 2.5;
const EARTH_RADIUS_M = 6378137;

const centerlineSymbol = new LineSymbol3D({
  symbolLayers: [
    new LineSymbol3DLayer({
      size: CENTERLINE_WIDTH_PT,
      material: { color: CENTERLINE_COLOR },
      cap: 'round',
      join: 'round',
    }),
  ],
});

const vertexSymbol = new PointSymbol3D({
  symbolLayers: [
    new IconSymbol3DLayer({
      resource: { primitive: 'circle' },
      size: VERTEX_SIZE_PT,
      material: { color: VERTEX_FILL_COLOR },
      outline: { color: VERTEX_OUTLINE_COLOR, size: 1.5 },
    }),
  ],
});

export interface CreekCenterlineOverlay {
  /** Shows or hides every centerline and vertex dot. The first show builds them. */
  setVisible(show: boolean): void;
  /** The layer holding the centerlines and vertex dots. */
  readonly layer: GraphicsLayer;
  /** Takes the layer off the map. The view itself stays. */
  dispose(): void;
}

export function createCreekCenterlineOverlay(
  view: SceneView,
  segmentPathsById: ReadonlyMap<string, CreekSegmentPathRecord>,
): CreekCenterlineOverlay {
  if (!view.map) throw new Error('SceneView has no map.');
  const layer = new GraphicsLayer({
    id: 'creek-centerlines',
    listMode: 'hide',
    visible: false,
    elevationInfo: { mode: 'relative-to-ground', offset: HEIGHT_ABOVE_GROUND_M },
  });
  view.map.add(layer);

  let built = false;
  const build = (): void => {
    if (built) return;
    built = true;
    const graphics: Graphic[] = [];
    for (const [tncComid, paths] of flowlinePathsByTncComid(segmentPathsById)) {
      graphics.push(
        new Graphic({
          geometry: new Polyline({
            paths: paths.map((path) => densify(path).map(([lon, lat]) => [lon, lat])),
            spatialReference: { wkid: 4326 },
          }),
          symbol: centerlineSymbol,
          attributes: { tncComid, kind: 'centerline' },
        }),
      );
      for (const [lon, lat] of uniqueVertices(paths)) {
        graphics.push(
          new Graphic({
            geometry: new Point({ longitude: lon, latitude: lat, spatialReference: { wkid: 4326 } }),
            symbol: vertexSymbol,
            attributes: { tncComid, kind: 'vertex' },
          }),
        );
      }
    }
    if (graphics.length > 0) layer.addMany(graphics);
  };

  return {
    setVisible(show) {
      if (show) build();
      layer.visible = show;
    },
    layer,
    dispose() {
      view.map?.remove(layer);
      layer.destroy();
    },
  };
}

/**
 * Each TNC flowline's Creek Segment paths, upstream to downstream. Segment ids
 * read `<TNC COMID>-<vertex number>`, so the vertex number orders a flowline.
 * Consecutive segments that share an end vertex are chained into one path.
 */
export function flowlinePathsByTncComid(
  segmentPathsById: ReadonlyMap<string, CreekSegmentPathRecord>,
): Map<string, LonLat[][]> {
  const segmentsByComid = new Map<string, { vertexNumber: number; path: readonly LonLat[] }[]>();
  for (const [segmentId, record] of segmentPathsById) {
    const [tncComid, vertexText] = segmentId.split('-');
    const segments = segmentsByComid.get(tncComid) ?? [];
    segments.push({ vertexNumber: Number(vertexText), path: record.path });
    segmentsByComid.set(tncComid, segments);
  }

  const pathsByComid = new Map<string, LonLat[][]>();
  for (const [tncComid, segments] of segmentsByComid) {
    segments.sort((a, b) => a.vertexNumber - b.vertexNumber);
    const chains: LonLat[][] = [];
    for (const { path } of segments) {
      const chain = chains[chains.length - 1];
      const last = chain?.[chain.length - 1];
      if (chain && last && sameVertex(last, path[0])) chain.push(...path.slice(1));
      else chains.push([...path]);
    }
    pathsByComid.set(tncComid, chains);
  }
  return pathsByComid;
}

function uniqueVertices(paths: readonly (readonly LonLat[])[]): LonLat[] {
  const seen = new Set<string>();
  const vertices: LonLat[] = [];
  for (const path of paths) {
    for (const vertex of path) {
      const key = `${vertex[0]},${vertex[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      vertices.push(vertex);
    }
  }
  return vertices;
}

function sameVertex(a: LonLat, b: LonLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Adds points along each leg so no leg is longer than the step; the original vertices stay. */
function densify(path: readonly LonLat[]): LonLat[] {
  const dense: LonLat[] = path.length > 0 ? [path[0]] : [];
  for (let index = 1; index < path.length; index += 1) {
    const [fromLon, fromLat] = path[index - 1];
    const [toLon, toLat] = path[index];
    const latRadians = (((fromLat + toLat) / 2) * Math.PI) / 180;
    const legM = Math.hypot(
      (((toLon - fromLon) * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(latRadians),
      (((toLat - fromLat) * Math.PI) / 180) * EARTH_RADIUS_M,
    );
    const pieces = Math.max(1, Math.ceil(legM / DENSIFY_STEP_M));
    for (let piece = 1; piece <= pieces; piece += 1) {
      const fraction = piece / pieces;
      dense.push([fromLon + (toLon - fromLon) * fraction, fromLat + (toLat - fromLat) * fraction]);
    }
  }
  return dense;
}
