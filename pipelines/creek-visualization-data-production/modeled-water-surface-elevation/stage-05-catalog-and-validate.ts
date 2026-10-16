import path from 'node:path';
import { readJson } from '../json-files.ts';
import { repositoryRoot } from '../constants.ts';
import { loadCreekSegmentNetwork } from './creek-segment-network.ts';
import {
  MODELED_WSE_VALIDATION_CHECKS,
  validateModeledWaterSurfaceElevationOutputs,
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

/**
 * Stage 5 — catalog and validate. Describe every Publisher, Dataset, Variable, and Time Series
 * the modeled pipeline produced in `catalog.json`, then check the outputs agree with each other.
 * The checks live in `modeled-water-surface-elevation-validation.ts`. Any violation fails the stage.
 * Time Series paths are relative to `03-time-series/`; each file holds one TNC flowline.
 */

const crossSectionsDirectory = stageDirectory('crossSections');
const timeSeriesDirectory = stageDirectory('timeSeries');
const polygonsDirectory = stageDirectory('waterSurfacePolygons');
const outputDirectory = stageDirectory('catalog');

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

async function buildCatalogAndValidate(): Promise<StageResult> {
  const expectedVersion = MODELED_EXTENT.segmentNetworkVersion;
  const segmentIds = (await loadCreekSegmentNetwork()).map((segment) => segment.segmentId);
  const polygonSetFiles: { relativePath: string; contents: WaterSurfacePolygonSetsFile }[] = [];
  for (const relativePath of await listWaterSurfacePolygonSetFiles(polygonsDirectory)) {
    const contents = (await readJson(path.join(polygonsDirectory, relativePath))) as WaterSurfacePolygonSetsFile;
    polygonSetFiles.push({ relativePath, contents });
  }
  const validation = await validateModeledWaterSurfaceElevationOutputs({
    expectedSegmentNetworkVersion: expectedVersion,
    segmentIds,
    crossSections: (await readJson(path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE))) as CrossSectionsFile,
    ladders: (await readJson(path.join(polygonsDirectory, POLYGON_LADDERS_FILE))) as PolygonLaddersFile,
    polygonSetFiles,
    catalogDatasets: CATALOG.datasets,
    timeSeriesDirectory,
  });

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
  };
  const { checks, valuesChecked } = validation;
  const validationReport = {
    segmentNetworkVersion: expectedVersion,
    passed: validation.passed,
    creekSegments: segmentIds.length,
    timeSeriesFiles: timeSeries.reduce((sum, entry) => sum + entry.paths.length, 0),
    waterSurfacePolygonSetFiles: polygonSetFiles.length,
    valuesChecked,
    checks,
  };
  const catalogPath = path.join(outputDirectory, 'catalog.json');
  const reportPath = path.join(outputDirectory, 'validation-report.json');
  await writeReadableJson(catalogPath, catalog);
  await writeReadableJson(reportPath, validationReport);

  const failed = checks.filter((entry) => !entry.passed);
  if (failed.length > 0) {
    const details = failed.map((entry) => `- ${entry.check} ${entry.violations} violation(s), e.g. ${entry.examples[0]}`).join('\n');
    throw new Error(`Modeled WSE validation failed (see ${path.relative(repositoryRoot, reportPath)}):\n${details}`);
  }

  return {
    outputFiles: [catalogPath, reportPath],
    counts: {
      publishers: catalog.publishers.length,
      datasets: catalog.datasets.length,
      timeSeries: catalog.timeSeries.length,
      timeSeriesFiles: validationReport.timeSeriesFiles,
      waterSurfacePolygonSetFiles: polygonSetFiles.length,
      valuesChecked,
      checksPassed: checks.length,
      drainageAreaRatioTransferSegments: Math.max(...timeSeries.map((entry) => entry.drainageAreaRatioTransferSegments)),
    },
    warnings: [],
    summaryLines: [
      `Validation passed: ${checks.length} checks over ${validationReport.timeSeriesFiles} Time Series files, ${polygonSetFiles.length} polygon set files, ${valuesChecked} values, ${segmentIds.length} Creek Segments.`,
      ...datasets.map((dataset) => `${dataset.datasetId}: ${dataset.timeRangeUtc[0]} → ${dataset.timeRangeUtc[1]}`),
      ...timeSeries.map((entry) => `${entry.datasetId}: ${entry.drainageAreaRatioTransferSegments} ${DRAINAGE_AREA_RATIO_TRANSFER.label} segment(s).`),
    ],
  };
}

await runStageEntryPoint(async () => {
  const timeSeriesPaths = [...(await listTimeSeriesFiles(timeSeriesDirectory)).values()].flat();
  const polygonSetPaths = await listWaterSurfacePolygonSetFiles(polygonsDirectory);
  await runStage({
    stage: '05-catalog',
    outputDirectory,
    inputFiles: [
      MODELED_EXTENT.flowlineSnapshotPath,
      path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE),
      path.join(polygonsDirectory, POLYGON_LADDERS_FILE),
      ...polygonSetPaths.map((relativePath) => path.join(polygonsDirectory, relativePath)),
      ...timeSeriesPaths.map((relativePath) => path.join(timeSeriesDirectory, relativePath)),
    ],
    parameters: {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      catalog: CATALOG,
      drainageAreaRatioTransfer: { ...DRAINAGE_AREA_RATIO_TRANSFER, maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M },
      derivations: CATALOG.datasets.map((dataset) => timeSeriesDerivation(publisherNameOf(dataset.publisherId))),
      checks: MODELED_WSE_VALIDATION_CHECKS,
    },
    run: buildCatalogAndValidate,
  });
});
