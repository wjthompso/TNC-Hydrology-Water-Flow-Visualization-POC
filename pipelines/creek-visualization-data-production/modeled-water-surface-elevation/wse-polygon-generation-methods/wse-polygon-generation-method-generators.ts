import type { ElevationGrid } from '../../water-surface-polygon-generation.ts';
import type { NetworkCreekSegment } from '../creek-segment-network.ts';
import type { CrossSectionsFile, PolygonLaddersFile, WaterSurfacePolygonSetsFile } from '../stage-file-formats.ts';
import { generateHeightAboveNearestDrainageFillPolygons } from './height-above-nearest-drainage-fill/generate-water-surface-polygons.ts';
import { HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD } from './height-above-nearest-drainage-fill/method-config.ts';
import { generateJunctionSlopedTerrainFillPolygons } from './junction-sloped-terrain-fill/generate-water-surface-polygons.ts';
import { JUNCTION_SLOPED_TERRAIN_FILL_METHOD } from './junction-sloped-terrain-fill/method-config.ts';

/**
 * The code half of every WSE Polygon Generation Method, keyed by method id. Stage 4 loads the
 * shared Stage 0–3 inputs once, hands them to the selected method, and writes what it returns.
 * Kept apart from the config registry because this file loads pipeline code.
 */

/** Shared Stage 0–3 inputs every method receives. */
export interface WsePolygonMethodInputs {
  segmentNetworkVersion: string;
  segments: readonly NetworkCreekSegment[];
  /** Stage 1 output: bed elevation, thalweg points, and vertex direction per Creek Segment. */
  crossSections: CrossSectionsFile;
  /** Absolute paths of every Stage 3 Time Series file, sorted. */
  timeSeriesFilePaths: readonly string[];
  /** Every Stage 0 USGS 3DEP terrain tile, loaded. */
  terrainTiles: readonly ElevationGrid[];
}

/**
 * What every method returns. Stage 4 writes the polygon sets one file per TNC flowline and the
 * ladder summary; Stage 5 validates both (every Creek Segment has one polygon set, and every
 * modeled value is at or below its ladder's ceiling).
 */
export interface WsePolygonMethodResult {
  polygonSets: WaterSurfacePolygonSetsFile['waterSurfacePolygonSets'];
  ladders: PolygonLaddersFile;
  counts: Record<string, number>;
  warnings: string[];
  summaryLines: string[];
}

export type WsePolygonMethodGenerator = (inputs: WsePolygonMethodInputs) => Promise<WsePolygonMethodResult>;

export const WSE_POLYGON_METHOD_GENERATORS: Readonly<Record<string, WsePolygonMethodGenerator>> = {
  [JUNCTION_SLOPED_TERRAIN_FILL_METHOD.id]: generateJunctionSlopedTerrainFillPolygons,
  [HEIGHT_ABOVE_NEAREST_DRAINAGE_FILL_METHOD.id]: generateHeightAboveNearestDrainageFillPolygons,
};

export function wsePolygonMethodGenerator(methodId: string): WsePolygonMethodGenerator {
  const generator = WSE_POLYGON_METHOD_GENERATORS[methodId];
  if (!generator) throw new Error(`WSE Polygon Generation Method ${methodId} has a config but no generator in wse-polygon-generation-method-generators.ts.`);
  return generator;
}
