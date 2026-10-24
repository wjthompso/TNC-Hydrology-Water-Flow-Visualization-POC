import { FLOWLINE_CHANNEL_RIBBON_METHOD } from './flowline-channel-ribbon/method-config.ts';
import { HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD } from './height-above-nearest-drainage-fill/method-config.ts';
import { JUNCTION_SLOPED_TERRAIN_FILL_METHOD } from './junction-sloped-terrain-fill/method-config.ts';
import type { WsePolygonGenerationMethodConfig } from './wse-polygon-generation-method.ts';

/**
 * Every WSE Polygon Generation Method Stage 4 can run, in the order the dev tools list them.
 * Configs only: no pipeline code is loaded here, so the browser dev server can import it.
 * Add a method by adding its folder and config, then registering it here and in
 * `wse-polygon-generation-method-generators.ts`.
 */
export const WSE_POLYGON_GENERATION_METHODS: readonly WsePolygonGenerationMethodConfig[] = [
  JUNCTION_SLOPED_TERRAIN_FILL_METHOD,
  HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD,
  FLOWLINE_CHANNEL_RIBBON_METHOD,
];

/** Stage 4 runs this method without `--wse-polygon-method=`; the browser opens its newest version. */
export const DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID = JUNCTION_SLOPED_TERRAIN_FILL_METHOD.id;

export function wsePolygonGenerationMethodById(methodId: string): WsePolygonGenerationMethodConfig {
  const method = WSE_POLYGON_GENERATION_METHODS.find((candidate) => candidate.id === methodId);
  if (!method) {
    throw new Error(
      `Unknown WSE Polygon Generation Method "${methodId}". Use one of: ${WSE_POLYGON_GENERATION_METHODS.map((candidate) => candidate.id).join(', ')}.`,
    );
  }
  return method;
}

/** `--wse-polygon-method=<id>` selects the method; without it the default method runs. */
export function requestedWsePolygonGenerationMethod(argv: readonly string[]): WsePolygonGenerationMethodConfig {
  const prefix = '--wse-polygon-method=';
  const flag = argv.find((argument) => argument.startsWith(prefix));
  return wsePolygonGenerationMethodById(flag ? flag.slice(prefix.length) : DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID);
}
