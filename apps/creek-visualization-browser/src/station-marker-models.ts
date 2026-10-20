import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import ObjectSymbol3DLayer from '@arcgis/core/symbols/ObjectSymbol3DLayer';
import WebStyleSymbol from '@arcgis/core/symbols/WebStyleSymbol';

/**
 * 3D models that can mark where monitoring equipment is installed (UCS-261).
 * Custom GLB files come from scripts/generate-station-marker-candidates.ts.
 * Downloaded GLB files and their licenses are in
 * public/station-marker-models/downloaded/LICENSES.md.
 */
export interface StationMarkerModel {
  id: string;
  label: string;
  /** Drawn height in meters at true scale. */
  heightM: number;
  source:
    | { kind: 'glb'; href: string }
    | { kind: 'esri-web-style'; styleName: string; name: string };
  /**
   * `origin`: the model's origin is its ground point (custom models).
   * `bottom`: anchor at the bounding-box bottom center, for downloaded models
   * whose origin is not on the ground.
   */
  anchor: 'origin' | 'bottom';
  credit: string;
}

const MODELS = '/station-marker-models';
const DOWNLOADED = `${MODELS}/downloaded`;

/** Chosen marker for a stream gauge. Its radar arm points along heading + 90°. */
export const STREAM_GAUGE_MAST: StationMarkerModel = {
  id: 'stream-gauge-mast',
  label: 'Stream gauge mast',
  heightM: 4,
  source: { kind: 'glb', href: `${MODELS}/stream-gauge-mast.glb` },
  anchor: 'origin',
  credit: 'Custom, 192 triangles',
};

export const STATION_MARKER_GALLERY_MODELS: readonly StationMarkerModel[] = [
  STREAM_GAUGE_MAST,
  {
    id: 'trail-camera-post',
    label: 'Trail camera + view wedge',
    heightM: 1.5,
    source: { kind: 'glb', href: `${MODELS}/trail-camera-post.glb` },
    anchor: 'origin',
    credit: 'Custom, 92 triangles',
  },
  {
    id: 'staff-gauge-board',
    label: 'Staff gauge board',
    heightM: 1.9,
    source: { kind: 'glb', href: `${MODELS}/staff-gauge-board.glb` },
    anchor: 'origin',
    credit: 'Custom, 216 triangles',
  },
  {
    id: 'location-beacon-pin',
    label: 'Location beacon pin',
    heightM: 3.25,
    source: { kind: 'glb', href: `${MODELS}/location-beacon-pin.glb` },
    anchor: 'origin',
    credit: 'Custom, 224 triangles',
  },
  {
    id: 'esri-radio-antenna',
    label: 'Esri Radio Antenna',
    heightM: 6,
    source: { kind: 'esri-web-style', styleName: 'EsriInfrastructureStyle', name: 'Radio_Antenna' },
    anchor: 'origin',
    credit: 'Esri built-in web style',
  },
  {
    id: 'esri-pushpin',
    label: 'Esri Pushpin',
    heightM: 3,
    source: { kind: 'esri-web-style', styleName: 'EsriIconsStyle', name: 'Pushpin 1' },
    anchor: 'origin',
    credit: 'Esri built-in web style',
  },
  {
    id: 'roof-antenna-mast',
    label: 'Roof antenna mast',
    heightM: 4,
    source: { kind: 'glb', href: `${DOWNLOADED}/roof-antenna-mast-quaternius-cc0.glb` },
    anchor: 'bottom',
    credit: 'Quaternius, CC0, 492 triangles',
  },
  {
    id: 'security-camera',
    label: 'Security camera',
    heightM: 1,
    source: { kind: 'glb', href: `${DOWNLOADED}/security-camera-wall-mount-j-toastie-cc-by.glb` },
    anchor: 'bottom',
    credit: 'J-Toastie, CC-BY 3.0, 568 triangles',
  },
  {
    id: 'utility-post',
    label: 'Utility post',
    heightM: 3,
    source: { kind: 'glb', href: `${DOWNLOADED}/utility-post-quaternius-cc0.glb` },
    anchor: 'bottom',
    credit: 'Quaternius, CC0, 524 triangles',
  },
  {
    id: 'satellite-dish',
    label: 'Satellite dish',
    heightM: 1.5,
    source: { kind: 'glb', href: `${DOWNLOADED}/satellite-dish-kenney-cc0.glb` },
    anchor: 'bottom',
    credit: 'Kenney, CC0, 390 triangles',
  },
  {
    id: 'ground-solar-panel',
    label: 'Ground solar panel',
    heightM: 1.2,
    source: { kind: 'glb', href: `${DOWNLOADED}/solar-panel-ground-quaternius-cc0.glb` },
    anchor: 'bottom',
    credit: 'Quaternius, CC0, 372 triangles',
  },
  {
    id: 'power-box-logger',
    label: 'Power box (logger)',
    heightM: 1.2,
    source: { kind: 'glb', href: `${DOWNLOADED}/power-box-enclosure-j-toastie-cc-by.glb` },
    anchor: 'bottom',
    credit: 'J-Toastie, CC-BY 3.0, 201 triangles',
  },
];

export interface StationMarkerSymbolOptions {
  /** Multiplies the model colors. White parts take this color exactly. */
  color?: readonly [number, number, number, number] | null;
  /** Clockwise from north, in degrees. */
  headingDegrees?: number;
}

export async function stationMarkerSymbol(
  model: StationMarkerModel,
  options: StationMarkerSymbolOptions = {},
): Promise<PointSymbol3D> {
  const symbol =
    model.source.kind === 'glb'
      ? new PointSymbol3D({
          symbolLayers: [new ObjectSymbol3DLayer({ resource: { href: model.source.href } })],
        })
      : ((await new WebStyleSymbol({
          styleName: model.source.styleName,
          name: model.source.name,
        }).fetchSymbol()) as PointSymbol3D);
  const objectLayer = symbol.symbolLayers.getItemAt(0) as ObjectSymbol3DLayer;
  objectLayer.height = model.heightM;
  objectLayer.anchor = model.anchor;
  objectLayer.castShadows = true;
  if (options.headingDegrees !== undefined) objectLayer.heading = options.headingDegrees;
  if (options.color) objectLayer.material = { color: [...options.color] };
  return symbol;
}
