import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import ObjectSymbol3DLayer from '@arcgis/core/symbols/ObjectSymbol3DLayer';

/**
 * 3D models that could mark a fish barrier from the TNC Fish Passage Barriers Assessment layer
 * (`jldp_fish_passage_barriers`, 29 points). Developer-only for now: they appear in the dev tools
 * "Fish barrier models" section.
 *
 * Files and licenses: public/barrier-marker-models/LICENSES.md. The barrier layer carries no
 * dimensions, so every size below is a visual guess, not a survey.
 */
export interface BarrierMarkerModel {
  id: string;
  label: string;
  /** The `SiteType` / `SiteName` values in the barrier layer that this model stands for. */
  standsFor: string;
  href: string;
  /**
   * Drawn size in meters. Set one dimension to scale the model evenly; set several to stretch it.
   * The Kenney pieces are 1 m modules, so they need explicit sizes.
   */
  sizeM: { width?: number; height?: number; depth?: number };
  /**
   * `origin`: the model's origin is its ground point. `bottom`: anchor at the bounding-box bottom
   * center, for models whose origin is not on the ground.
   */
  anchor: 'origin' | 'bottom';
  /**
   * Degrees added to the creek's downstream bearing so the model lines up with the channel. Each
   * model has its own forward axis, so this is found by looking at it on the map.
   */
  headingOffsetDegrees: number;
  /** How many copies sit side by side across the creek (a weir needs several wall sections). */
  copiesAcrossCreek: number;
  /** Distance between copies' centers across the creek, m. */
  copySpacingM: number;
  credit: string;
}

/** `BASE_URL` keeps the models reachable when the app is built under a sub-path, e.g. inside the Digital Twin. */
const MODELS = `${import.meta.env.BASE_URL}barrier-marker-models`;

export const BARRIER_MARKER_GALLERY_MODELS: readonly BarrierMarkerModel[] = [
  {
    id: 'road-culvert',
    label: 'Road culvert',
    standsFor: 'Road crossing — 17 of 29 barriers',
    href: `${MODELS}/road-culvert-polyfork.glb`,
    sizeM: { height: 2.9 },
    anchor: 'origin',
    headingOffsetDegrees: 0,
    copiesAcrossCreek: 1,
    copySpacingM: 0,
    credit: 'Polyfork "Highway Culvert", Polyfork license (not CC0), 912 triangles',
  },
  {
    id: 'concrete-weir',
    label: 'Concrete weir (3 wall sections)',
    standsFor: 'Dam / weir — 3 of 29 barriers',
    href: `${MODELS}/concrete-wall-innerscene-cc0.glb`,
    sizeM: { height: 1.55 },
    anchor: 'bottom',
    headingOffsetDegrees: 0,
    copiesAcrossCreek: 3,
    copySpacingM: 2.4,
    credit: 'Innerscene "Concrete retaining wall section", CC0, 696 triangles',
  },
  {
    id: 'bedrock-waterfall',
    label: 'Bedrock waterfall (rock)',
    standsFor: 'Non-structural, Bedrock Waterfall — 2 of 29 barriers',
    href: `${MODELS}/waterfall-rock-kenney-cc0.glb`,
    sizeM: { width: 6, height: 2.5, depth: 1.5 },
    anchor: 'bottom',
    headingOffsetDegrees: 0,
    copiesAcrossCreek: 1,
    copySpacingM: 0,
    credit: 'Kenney Nature Kit "cliff_waterfall_rock", CC0, 34 triangles',
  },
  {
    id: 'bedrock-waterfall-stone',
    label: 'Bedrock waterfall (stone)',
    standsFor: 'Non-structural, Bedrock Waterfall — alternate look',
    href: `${MODELS}/waterfall-stone-kenney-cc0.glb`,
    sizeM: { width: 6, height: 2.5, depth: 1.5 },
    anchor: 'bottom',
    headingOffsetDegrees: 0,
    copiesAcrossCreek: 1,
    copySpacingM: 0,
    credit: 'Kenney Nature Kit "cliff_waterfall_stone", CC0, 68 triangles',
  },
  {
    id: 'steep-ledge',
    label: 'Steep reach ledge',
    standsFor: 'Non-structural, Gradient > 10% — 5 of 29 barriers',
    href: `${MODELS}/cliff-ledge-kenney-cc0.glb`,
    sizeM: { width: 6, height: 1.8, depth: 2 },
    anchor: 'bottom',
    headingOffsetDegrees: 0,
    copiesAcrossCreek: 1,
    copySpacingM: 0,
    credit: 'Kenney Nature Kit "cliff_large_rock", CC0, 32 triangles',
  },
];

export interface BarrierMarkerSymbolOptions {
  /** Multiplies the model colors. Null keeps the model's own colors. */
  color?: readonly [number, number, number, number] | null;
  /** Clockwise from north, in degrees. */
  headingDegrees?: number;
}

export function barrierMarkerSymbol(
  model: BarrierMarkerModel,
  options: BarrierMarkerSymbolOptions = {},
): PointSymbol3D {
  const objectLayer = new ObjectSymbol3DLayer({
    resource: { href: model.href },
    anchor: model.anchor,
    castShadows: true,
    ...model.sizeM,
  });
  if (options.headingDegrees !== undefined) objectLayer.heading = options.headingDegrees;
  if (options.color) objectLayer.material = { color: [...options.color] };
  return new PointSymbol3D({ symbolLayers: [objectLayer] });
}
