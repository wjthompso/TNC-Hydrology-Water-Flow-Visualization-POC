import path from 'node:path';
import { readJson } from '../json-files.ts';
import { repositoryRoot } from '../constants.ts';
import { loadCreekSegmentNetwork } from './creek-segment-network.ts';
import {
  MODELED_WSE_VALIDATION_CHECKS,
  validateModeledWaterSurfaceElevationOutputs,
  type ModeledWaterSurfaceElevationValidationResult,
  type ValidationCheck,
} from './modeled-water-surface-elevation-validation.ts';
import {
  CATALOG,
  DRAINAGE_AREA_RATIO_TRANSFER,
  MAXIMUM_TRANSFER_DISTANCE_M,
  MODELED_EXTENT,
  WATER_SURFACE_ELEVATION_VARIABLE_ID,
  stageDirectory,
  timeSeriesDerivation,
} from './pipeline-configuration.ts';
import { writeReadableJson } from './readable-json.ts';
import {
  CROSS_SECTIONS_FILE,
  POLYGON_LADDERS_FILE,
  listTimeSeriesFiles,
  listWaterSurfacePolygonSetFiles,
  type CrossSectionsFile,
  type PolygonLaddersFile,
  type TimeSeriesDerivation,
  type WaterSurfacePolygonSetsFile,
} from './stage-file-formats.ts';
import { runStage, runStageEntryPoint, type StageResult } from './stage-manifest.ts';
import type { WsePolygonBrowserDrawing } from './wse-polygon-generation-methods/wse-polygon-generation-method.ts';
import {
  listSavedWsePolygonMethodVersions,
  type SavedWsePolygonMethodVersion,
} from './wse-polygon-generation-methods/wse-polygon-generation-method-outputs.ts';
import { DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID } from './wse-polygon-generation-methods/wse-polygon-generation-method-registry.ts';

/**
 * Stage 5 — catalog and validate. Describe every Publisher, Dataset, Variable, Time Series, and
 * saved WSE Polygon Generation Method version the modeled pipeline produced in `catalog.json`, then
 * check the outputs agree with each other. The checks live in
 * `modeled-water-surface-elevation-validation.ts` and run once per saved method version. A violation
 * in the default method's newest version (the one the browser opens) fails the stage; a violation in
 * any other version is a warning, and the catalog marks that version `validationPassed: false`.
 * Time Series paths are relative to `03-time-series/`; each file holds one TNC flowline.
 */

const crossSectionsDirectory = stageDirectory('crossSections');
const timeSeriesDirectory = stageDirectory('timeSeries');
const waterSurfacePolygonsDirectory = stageDirectory('waterSurfacePolygons');
const outputDirectory = stageDirectory('catalog');

/** One saved WSE Polygon Generation Method version, as listed in `catalog.json`. */
interface CatalogWsePolygonMethodVersion {
  methodId: string;
  version: number;
  label: string;
  description: string;
  browserDrawing: WsePolygonBrowserDrawing;
  /** Relative to `04-water-surface-polygons/`, e.g. `junction-sloped-terrain-fill/v1`. */
  path: string;
  completedAt: string | null;
  methodSha256: string;
  validationPassed: boolean;
}

/** The browser opens this version unless the URL asks for another: the default method's newest saved version. */
function defaultMethodVersion(saved: readonly SavedWsePolygonMethodVersion[]): SavedWsePolygonMethodVersion {
  const versions = saved.filter((entry) => entry.methodId === DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID);
  const newest = versions[versions.length - 1];
  if (!newest) {
    throw new Error(
      `No saved output for the default WSE Polygon Generation Method ${DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID} ` +
        `under ${path.relative(repositoryRoot, waterSurfacePolygonsDirectory)}/. Run Stage 4 first.`,
    );
  }
  return newest;
}

async function polygonSetFilesOf(versionDirectory: string): Promise<string[]> {
  return (await listWaterSurfacePolygonSetFiles(versionDirectory)).map((relativePath) => path.join(versionDirectory, relativePath));
}

interface Catalog {
  segmentNetworkVersion: string;
  publishers: { publisherId: string; name: string }[];
  datasets: {
    datasetId: string;
    publisherId: string;
    kind: string;
    timeStep: string;
    timeRangeUtc: [string, string];
    accuracyNote: string;
  }[];
  variables: { variableId: string; name: string; unit: string }[];
  /**
   * Drainage-Area Ratio Transfer: what the per-segment flag in every Time Series file means.
   * Each Time Series entry counts its flagged Creek Segments.
   */
  drainageAreaRatioTransfer: {
    fieldName: string;
    label: string;
    note: string;
    maximumTransferDistanceM: number;
  };
  timeSeries: {
    datasetId: string;
    variableId: string;
    paths: string[];
    /** Creek Segments in this Time Series whose discharge was transferred from a neighbouring creek's reach. */
    drainageAreaRatioTransferSegments: number;
    derivation: TimeSeriesDerivation;
  }[];
  /** Every saved WSE Polygon Generation Method version; the browser lists them in the dev tools. */
  wsePolygonGenerationMethods: {
    /** `path` of the version the browser opens by default. */
    defaultPath: string;
    versions: CatalogWsePolygonMethodVersion[];
  };
}

/** The discharge Publisher's display name, used in the derivation's discharge input. */
function publisherNameOf(publisherId: string): string {
  const publisher = CATALOG.publishers.find((entry) => entry.publisherId === publisherId);
  if (!publisher) throw new Error(`Catalog Dataset names unknown Publisher ${publisherId}.`);
  return publisher.name;
}

function isoUtcOrEmpty(timestampMs: number | null): string {
  return timestampMs === null ? '' : new Date(timestampMs).toISOString();
}

/** Runs every check against one saved method version's polygon sets and ladder. */
async function validateMethodVersion(
  saved: SavedWsePolygonMethodVersion,
  segmentIds: string[],
  crossSections: CrossSectionsFile,
): Promise<{ validation: ModeledWaterSurfaceElevationValidationResult; polygonSetFileCount: number }> {
  const versionDirectory = path.join(waterSurfacePolygonsDirectory, saved.relativePath);
  const polygonSetFiles: { relativePath: string; contents: WaterSurfacePolygonSetsFile }[] = [];
  for (const relativePath of await listWaterSurfacePolygonSetFiles(versionDirectory)) {
    const contents = (await readJson(path.join(versionDirectory, relativePath))) as WaterSurfacePolygonSetsFile;
    polygonSetFiles.push({ relativePath: `${saved.relativePath}/${relativePath}`, contents });
  }
  const validation = await validateModeledWaterSurfaceElevationOutputs({
    expectedSegmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
    segmentIds,
    crossSections,
    ladders: (await readJson(path.join(versionDirectory, POLYGON_LADDERS_FILE))) as PolygonLaddersFile,
    polygonSetFiles,
    catalogDatasets: CATALOG.datasets,
    timeSeriesDirectory,
  });
  return { validation, polygonSetFileCount: polygonSetFiles.length };
}

async function buildCatalogAndValidate(): Promise<StageResult> {
  const expectedVersion = MODELED_EXTENT.segmentNetworkVersion;
  const segmentIds = (await loadCreekSegmentNetwork()).map((segment) => segment.segmentId);
  const crossSections = (await readJson(path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE))) as CrossSectionsFile;
  const savedVersions = await listSavedWsePolygonMethodVersions(waterSurfacePolygonsDirectory);
  const defaultVersion = defaultMethodVersion(savedVersions);

  const warnings: string[] = [];
  const methodVersions: CatalogWsePolygonMethodVersion[] = [];
  const methodVersionReports: { path: string; passed: boolean; waterSurfacePolygonSetFiles: number; checks: ValidationCheck[] }[] = [];
  let defaultValidation: ModeledWaterSurfaceElevationValidationResult | null = null;
  let polygonSetFileCount = 0;
  for (const saved of savedVersions) {
    const checked = await validateMethodVersion(saved, segmentIds, crossSections);
    if (saved === defaultVersion) {
      defaultValidation = checked.validation;
      polygonSetFileCount = checked.polygonSetFileCount;
    } else if (!checked.validation.passed) {
      warnings.push(`WSE Polygon Generation Method ${saved.relativePath} fails validation; see validation-report.json.`);
    }
    methodVersions.push({
      methodId: saved.methodId,
      version: saved.version,
      label: saved.method.label,
      description: saved.method.description,
      browserDrawing: saved.method.browserDrawing,
      path: saved.relativePath,
      completedAt: saved.completedAt,
      methodSha256: saved.method.methodSha256,
      validationPassed: checked.validation.passed,
    });
    methodVersionReports.push({
      path: saved.relativePath,
      passed: checked.validation.passed,
      waterSurfacePolygonSetFiles: checked.polygonSetFileCount,
      checks: checked.validation.checks,
    });
  }
  const validation = defaultValidation as ModeledWaterSurfaceElevationValidationResult;

  const validatedByDatasetId = new Map(validation.datasets.map((dataset) => [dataset.datasetId, dataset]));
  const datasets: Catalog['datasets'] = [];
  const timeSeries: Catalog['timeSeries'] = [];
  for (const dataset of CATALOG.datasets) {
    const validated = validatedByDatasetId.get(dataset.datasetId);
    datasets.push({
      datasetId: dataset.datasetId,
      publisherId: dataset.publisherId,
      kind: dataset.kind,
      timeStep: dataset.timeStep,
      timeRangeUtc: [isoUtcOrEmpty(validated?.firstTimestampUtcMs ?? null), isoUtcOrEmpty(validated?.lastTimestampUtcMs ?? null)],
      accuracyNote: dataset.accuracyNote,
    });
    timeSeries.push({
      datasetId: dataset.datasetId,
      variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID,
      paths: validated?.paths ?? [],
      drainageAreaRatioTransferSegments: validated?.drainageAreaRatioTransferSegments ?? 0,
      derivation: timeSeriesDerivation(publisherNameOf(dataset.publisherId)),
    });
  }

  const catalog: Catalog = {
    segmentNetworkVersion: expectedVersion,
    publishers: CATALOG.publishers.map((publisher) => ({ ...publisher })),
    datasets,
    variables: CATALOG.variables.map((variable) => ({ ...variable })),
    drainageAreaRatioTransfer: { ...DRAINAGE_AREA_RATIO_TRANSFER, maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M },
    timeSeries,
    wsePolygonGenerationMethods: { defaultPath: defaultVersion.relativePath, versions: methodVersions },
  };
  const { checks, valuesChecked } = validation;
  // The top-level result is the default method's newest version, which the browser opens and the stage gates on.
  const validationReport = {
    segmentNetworkVersion: expectedVersion,
    passed: validation.passed,
    wsePolygonGenerationMethodPath: defaultVersion.relativePath,
    creekSegments: segmentIds.length,
    timeSeriesFiles: timeSeries.reduce((sum, entry) => sum + entry.paths.length, 0),
    waterSurfacePolygonSetFiles: polygonSetFileCount,
    valuesChecked,
    checks,
    wsePolygonGenerationMethodVersions: methodVersionReports,
  };
  const catalogPath = path.join(outputDirectory, 'catalog.json');
  const reportPath = path.join(outputDirectory, 'validation-report.json');
  await writeReadableJson(catalogPath, catalog);
  await writeReadableJson(reportPath, validationReport);

  const failed = checks.filter((entry) => !entry.passed);
  if (failed.length > 0) {
    const details = failed.map((entry) => `- ${entry.check} ${entry.violations} violation(s), e.g. ${entry.examples[0]}`).join('\n');
    throw new Error(
      `Modeled WSE validation failed for WSE Polygon Generation Method ${defaultVersion.relativePath} ` +
        `(see ${path.relative(repositoryRoot, reportPath)}):\n${details}`,
    );
  }

  return {
    outputFiles: [catalogPath, reportPath],
    counts: {
      publishers: catalog.publishers.length,
      datasets: catalog.datasets.length,
      timeSeries: catalog.timeSeries.length,
      timeSeriesFiles: validationReport.timeSeriesFiles,
      waterSurfacePolygonSetFiles: polygonSetFileCount,
      wsePolygonGenerationMethodVersions: methodVersions.length,
      valuesChecked,
      checksPassed: checks.length,
      drainageAreaRatioTransferSegments: Math.max(...timeSeries.map((entry) => entry.drainageAreaRatioTransferSegments)),
    },
    warnings,
    summaryLines: [
      `Validation passed: ${checks.length} checks over ${validationReport.timeSeriesFiles} Time Series files, ${polygonSetFileCount} polygon set files, ${valuesChecked} values, ${segmentIds.length} Creek Segments.`,
      `WSE Polygon Generation Methods: ${methodVersions.map((entry) => `${entry.path}${entry.validationPassed ? '' : ' (fails validation)'}`).join(', ')}; default ${defaultVersion.relativePath}.`,
      ...datasets.map((dataset) => `${dataset.datasetId}: ${dataset.timeRangeUtc[0]} → ${dataset.timeRangeUtc[1]}`),
      ...timeSeries.map((entry) => `${entry.datasetId}: ${entry.drainageAreaRatioTransferSegments} ${DRAINAGE_AREA_RATIO_TRANSFER.label} segment(s).`),
    ],
  };
}

await runStageEntryPoint(async () => {
  const timeSeriesPaths = [...(await listTimeSeriesFiles(timeSeriesDirectory)).values()].flat();
  // Every saved method version is an input, so a new version or a rerun of one reruns this stage.
  const methodVersionFiles: string[] = [];
  for (const saved of await listSavedWsePolygonMethodVersions(waterSurfacePolygonsDirectory)) {
    const versionDirectory = path.join(waterSurfacePolygonsDirectory, saved.relativePath);
    methodVersionFiles.push(
      path.join(versionDirectory, 'manifest.json'),
      path.join(versionDirectory, POLYGON_LADDERS_FILE),
      ...(await polygonSetFilesOf(versionDirectory)),
    );
  }
  await runStage({
    stage: '05-catalog',
    outputDirectory,
    inputFiles: [
      MODELED_EXTENT.flowlineSnapshotPath,
      path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE),
      ...methodVersionFiles,
      ...timeSeriesPaths.map((relativePath) => path.join(timeSeriesDirectory, relativePath)),
    ],
    parameters: {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      catalog: CATALOG,
      drainageAreaRatioTransfer: { ...DRAINAGE_AREA_RATIO_TRANSFER, maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M },
      derivations: CATALOG.datasets.map((dataset) => timeSeriesDerivation(publisherNameOf(dataset.publisherId))),
      checks: MODELED_WSE_VALIDATION_CHECKS,
      defaultWsePolygonGenerationMethodId: DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID,
    },
    run: buildCatalogAndValidate,
  });
});
