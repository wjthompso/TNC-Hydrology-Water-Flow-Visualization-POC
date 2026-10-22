import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { readJson, writeCompactJson } from '../json-files.ts';
import { repositoryRoot } from '../constants.ts';
import { readElevationGrid, type ElevationGrid } from '../water-surface-polygon-generation.ts';
import { loadCreekSegmentNetwork } from './creek-segment-network.ts';
import { MODELED_EXTENT, stageDirectory } from './pipeline-configuration.ts';
import { writeReadableJson } from './readable-json.ts';
import {
  CROSS_SECTIONS_FILE,
  POLYGON_LADDERS_FILE,
  WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME,
  groupByTncComid,
  listTimeSeriesFiles,
  type CrossSectionsFile,
  type WaterSurfacePolygonSetsFile,
} from './stage-file-formats.ts';
import { formatBytes, runStage, runStageEntryPoint, type StageResult } from './stage-manifest.ts';
import { CURRENT_MODELED_WSE_VERSION_LABEL, requireSavedCurrentModeledWseVersion } from './modeled-wse-version.ts';
import {
  builtFromModeledWseVersion,
  type RecordedBuiltFromModeledWseVersion,
} from './modeled-wse-derivation-methods/modeled-wse-derivation-method.ts';
import { TERRAIN_TILE_INDEX_FILE, readTerrainTileIndex } from './terrain-tiles.ts';
import type { RecordedWsePolygonGenerationMethod } from './wse-polygon-generation-methods/wse-polygon-generation-method.ts';
import {
  changedMethodFiles,
  fingerprintWsePolygonGenerationMethod,
} from './wse-polygon-generation-methods/wse-polygon-generation-method-fingerprint.ts';
import { wsePolygonMethodGenerator } from './wse-polygon-generation-methods/wse-polygon-generation-method-generators.ts';
import {
  readSavedBuiltFromModeledWseVersion,
  readSavedWsePolygonMethodVersion,
  wsePolygonVersionRelativePath,
} from './wse-polygon-generation-methods/wse-polygon-generation-method-outputs.ts';
import { requestedWsePolygonGenerationMethod } from './wse-polygon-generation-methods/wse-polygon-generation-method-registry.ts';

/**
 * Stage 4 — water-surface polygons. Runs one WSE Polygon Generation Method, chosen with
 * `--wse-polygon-method=<id>` (default: the registry's default method), on the shared Stage 0–3
 * outputs, and writes its polygon sets and ladder summary to
 * `04-water-surface-polygons/<method-id>/v<version>/`, one compact
 * `water-surface-polygon-sets/<tncComid>.json` per TNC flowline.
 *
 * Version rule: the version's manifest records a SHA-256 fingerprint of the method's code files and
 * parameters. When that version folder already holds output with a different fingerprint, the stage
 * stops and asks for a version bump, even with `--force`, so an old version is never overwritten.
 * Other method and version folders are never touched. A version folder is also never rewritten from a different
 * modeled WSE version than the one it was built from; that needs a polygon method version bump too.
 *
 * Source: the Time Series of the current Modeled WSE Derivation Method version
 * (`03-time-series/<method-id>/v<version>/`). The manifest records that version under
 * `parameters.builtFromModeledWseVersion`, so a polygon version always names the modeled WSE version it came from.
 */

const acquireDirectory = stageDirectory('acquire');
const crossSectionsDirectory = stageDirectory('crossSections');
const waterSurfacePolygonsDirectory = stageDirectory('waterSurfacePolygons');

async function terrainTilePaths(): Promise<string[]> {
  const index = readTerrainTileIndex(await readJson(path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE)));
  return index.tiles.map((tile) => path.join(acquireDirectory, tile.file));
}

/** The Time Series files of the current Modeled WSE Derivation Method version, which this stage builds polygons from. */
async function timeSeriesFilePaths(timeSeriesDirectory: string): Promise<string[]> {
  const files = [...(await listTimeSeriesFiles(timeSeriesDirectory)).values()].flat();
  return files.map((relativePath) => path.join(timeSeriesDirectory, relativePath));
}

/** Throws the bump message when this version folder already holds output from different method code or parameters. */
async function refuseToOverwriteADifferentVersion(method: RecordedWsePolygonGenerationMethod, outputDirectory: string): Promise<void> {
  const saved = await readSavedWsePolygonMethodVersion(waterSurfacePolygonsDirectory, method.id, method.version);
  if (!saved || saved.method.methodSha256 === method.methodSha256) return;
  const changed = changedMethodFiles(saved.method, method);
  throw new Error(
    [
      `[04-water-surface-polygons] WSE Polygon Generation Method ${method.id} v${method.version} already has saved output ` +
        `in ${path.relative(repositoryRoot, outputDirectory)}/ from different method code or parameters.`,
      `  Saved fingerprint ${saved.method.methodSha256.slice(0, 12)}…, current ${method.methodSha256.slice(0, 12)}….`,
      `  Changed: ${changed.join(', ') || '(unknown)'}.`,
      `  Bump \`version\` to ${method.version + 1} in wse-polygon-generation-methods/${method.id}/method-config.ts and rerun, ` +
        `or revert the change. Old versions are kept so they can be compared on the map; this stage never overwrites one.`,
    ].join('\n'),
  );
}

/**
 * Throws when this polygon version folder was built from a different modeled WSE version than the one being read now.
 * Rewriting it would replace polygons that belong to an older modeled WSE version, so the fix is a polygon method version bump.
 */
async function refuseToOverwritePolygonsBuiltFromAnotherModeledWseVersion(
  method: RecordedWsePolygonGenerationMethod,
  outputDirectory: string,
  current: RecordedBuiltFromModeledWseVersion,
): Promise<void> {
  const saved = await readSavedBuiltFromModeledWseVersion(waterSurfacePolygonsDirectory, method.id, method.version);
  if (!saved || saved.methodSha256 === current.methodSha256) return;
  throw new Error(
    [
      `[04-water-surface-polygons] WSE Polygon Generation Method ${method.id} v${method.version} already has saved output ` +
        `in ${path.relative(repositoryRoot, outputDirectory)}/ built from modeled WSE ${saved.versionLabel}; the Time Series now read are ${current.versionLabel}.`,
      `  Bump \`version\` to ${method.version + 1} in wse-polygon-generation-methods/${method.id}/method-config.ts and rerun, ` +
        `so the polygons for ${saved.versionLabel} are kept next to the ones for ${current.versionLabel}. This stage never overwrites a polygon version built from another modeled WSE version.`,
    ].join('\n'),
  );
}

async function buildWaterSurfacePolygons(
  method: RecordedWsePolygonGenerationMethod,
  outputDirectory: string,
  timeSeriesDirectory: string,
): Promise<StageResult> {
  const tiles: ElevationGrid[] = [];
  for (const tilePath of await terrainTilePaths()) tiles.push(await readElevationGrid(tilePath));
  const result = await wsePolygonMethodGenerator(method.id)({
    segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
    segments: await loadCreekSegmentNetwork(),
    crossSections: (await readJson(path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE))) as CrossSectionsFile,
    timeSeriesFilePaths: await timeSeriesFilePaths(timeSeriesDirectory),
    terrainTiles: tiles,
  });

  const polygonSetsDirectory = path.join(outputDirectory, WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME);
  // Same version and fingerprint: remove this version's earlier polygon set files so no stale flowline file is validated.
  await rm(polygonSetsDirectory, { recursive: true, force: true });
  const polygonSetPaths: string[] = [];
  let polygonSetBytes = 0;
  let largestPolygonSetBytes = 0;
  for (const [tncComid, sets] of groupByTncComid(result.polygonSets)) {
    const polygonSetPath = path.join(polygonSetsDirectory, `${tncComid}.json`);
    const polygonSetsFile: WaterSurfacePolygonSetsFile = {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      waterSurfacePolygonSets: sets,
    };
    await writeCompactJson(polygonSetPath, polygonSetsFile);
    const { size } = await stat(polygonSetPath);
    polygonSetBytes += size;
    largestPolygonSetBytes = Math.max(largestPolygonSetBytes, size);
    polygonSetPaths.push(polygonSetPath);
  }
  const laddersPath = path.join(outputDirectory, POLYGON_LADDERS_FILE);
  await writeReadableJson(laddersPath, result.ladders);

  return {
    outputFiles: [...polygonSetPaths, laddersPath],
    counts: {
      creekSegments: result.polygonSets.length,
      polygonSetFiles: polygonSetPaths.length,
      ...result.counts,
    },
    warnings: result.warnings,
    measurements: { waterSurfacePolygonSetsBytes: polygonSetBytes, largestWaterSurfacePolygonSetFileBytes: largestPolygonSetBytes },
    summaryLines: [
      `WSE Polygon Generation Method ${method.id} v${method.version} (${method.label}), built from modeled WSE ${CURRENT_MODELED_WSE_VERSION_LABEL}.`,
      ...result.summaryLines,
      `${polygonSetPaths.length} polygon set file(s) in ${WATER_SURFACE_POLYGON_SETS_DIRECTORY_NAME}/: ${formatBytes(polygonSetBytes)} total, largest ${formatBytes(largestPolygonSetBytes)}.`,
    ],
  };
}

await runStageEntryPoint(async () => {
  // The Time Series must exist and match the code, or the polygons would record a version they were not built from.
  const modeledWse = await requireSavedCurrentModeledWseVersion('04-water-surface-polygons');
  const timeSeriesDirectory = modeledWse.outputDirectory;
  const method = await fingerprintWsePolygonGenerationMethod(requestedWsePolygonGenerationMethod(process.argv));
  const outputDirectory = path.join(waterSurfacePolygonsDirectory, wsePolygonVersionRelativePath(method.id, method.version));
  await refuseToOverwriteADifferentVersion(method, outputDirectory);
  await refuseToOverwritePolygonsBuiltFromAnotherModeledWseVersion(method, outputDirectory, builtFromModeledWseVersion(modeledWse.method));
  await runStage({
    stage: '04-water-surface-polygons',
    outputDirectory,
    inputFiles: [
      MODELED_EXTENT.flowlineSnapshotPath,
      path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE),
      path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE),
      ...(await terrainTilePaths()),
      ...(await timeSeriesFilePaths(timeSeriesDirectory)),
    ],
    parameters: {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      wsePolygonGenerationMethod: method,
      builtFromModeledWseVersion: builtFromModeledWseVersion(modeledWse.method),
    },
    run: () => buildWaterSurfacePolygons(method, outputDirectory, timeSeriesDirectory),
  });
});
