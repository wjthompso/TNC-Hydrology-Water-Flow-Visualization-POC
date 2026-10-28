import { access } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../json-files.ts';
import { WATER_SURFACE_ELEVATION_VARIABLE_ID } from './pipeline-configuration.ts';
import { DRAINAGE_AREA_RATIO_TRANSFER } from './modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import {
  CROSS_SECTIONS_FILE,
  POLYGON_LADDERS_FILE,
  listTimeSeriesFiles,
  tncComidOfSegmentId,
  type CrossSectionsFile,
  type PolygonLaddersFile,
  type WaterSurfaceElevationTimeSeriesFile,
  type WaterSurfacePolygonSetsFile,
} from './stage-file-formats.ts';

/**
 * Consistency checks across the modeled water-surface elevation (WSE) pipeline outputs.
 * This module does not run on import and reads only the Time Series directory it is given,
 * so a test can validate a synthetic fixture. Time Series and polygon set files each hold one
 * TNC flowline's Creek Segments; the flowline is read from each file's segment ids, not its name. Stage 5 calls it and turns a failed report
 * into a non-zero exit.
 */

/** Printing every violation of a broken run would bury the first one; the report keeps this many per check. */
const MAXIMUM_EXAMPLES_PER_CHECK = 20;

export const MODELED_WSE_VALIDATION_CHECKS = {
  pathsExist: 'Every catalog Time Series path exists.',
  coversEverySegment:
    "Every Time Series file covers every Creek Segment of one TNC flowline exactly once, and every TNC flowline has the Dataset's full timestamp list.",
  polygonSetsCoverEverySegment:
    'Every water-surface polygon set file covers every Creek Segment of one TNC flowline exactly once, and every Creek Segment has one polygon set.',
  timestampsIncreasing: "Timestamps are strictly increasing within each file and across one TNC flowline's files of a Time Series.",
  valuesAtOrAboveBed: "Every value is null or at or above its Creek Segment's bed elevation.",
  valuesWithinLadder: "Every value is at or below its Creek Segment's polygon ladder ceiling.",
  segmentNetworkVersion: 'Every output uses the same segmentNetworkVersion.',
  catalogMatchesTimeSeries: 'Every catalog Dataset has a Time Series and every Time Series file names its Dataset and Variable.',
} as const;

const CHECKS = MODELED_WSE_VALIDATION_CHECKS;

export interface ValidationCheck {
  check: string;
  passed: boolean;
  violations: number;
  examples: string[];
}

/** Time Series files and time range found for one catalog Dataset while validating. */
export interface ValidatedDatasetTimeSeries {
  datasetId: string;
  /** Paths relative to the Time Series stage directory, e.g. `time-series/<datasetId>/…json`. */
  paths: string[];
  firstTimestampUtcMs: number | null;
  lastTimestampUtcMs: number | null;
  /** Distinct Creek Segments flagged as a Drainage-Area Ratio Transfer across the Dataset's files. */
  drainageAreaRatioTransferSegments: number;
}

export interface ModeledWaterSurfaceElevationValidationResult {
  passed: boolean;
  valuesChecked: number;
  checks: ValidationCheck[];
  /** One entry per catalog Dataset, in input order. Stage 5 builds the catalog from it. */
  datasets: ValidatedDatasetTimeSeries[];
}

/** Collects violations per named check so the report lists every check, passed or not. */
class ValidationReport {
  readonly checks = new Map<string, ValidationCheck>();

  declare(check: string): void {
    if (!this.checks.has(check)) this.checks.set(check, { check, passed: true, violations: 0, examples: [] });
  }

  fail(check: string, example: string): void {
    this.declare(check);
    const entry = this.checks.get(check) as ValidationCheck;
    entry.passed = false;
    entry.violations += 1;
    if (entry.examples.length < MAXIMUM_EXAMPLES_PER_CHECK) entry.examples.push(example);
  }

  get passed(): boolean {
    return [...this.checks.values()].every((entry) => entry.passed);
  }
}

function isoUtc(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks that one file's segment ids all belong to one TNC flowline and list each of that flowline's
 * Creek Segments exactly once. Returns the flowline COMID, or null when the file mixes flowlines or is empty.
 */
function checkOneTncFlowlineFile(input: {
  report: ValidationReport;
  check: string;
  relativePath: string;
  fileSegmentIds: string[];
  segmentIdsByTncComid: Map<string, string[]>;
}): string | null {
  const { report, check, relativePath, fileSegmentIds } = input;
  const tncComids = [...new Set(fileSegmentIds.map(tncComidOfSegmentId))];
  if (tncComids.length !== 1) {
    report.fail(check, `${relativePath} holds ${tncComids.length} TNC flowlines (${tncComids.join(', ')}); expected exactly 1.`);
    return null;
  }
  const tncComid = tncComids[0] as string;
  const expected = input.segmentIdsByTncComid.get(tncComid) ?? [];
  const missing = expected.filter((segmentId) => !fileSegmentIds.includes(segmentId));
  const unexpected = fileSegmentIds.filter((segmentId) => !expected.includes(segmentId));
  if (missing.length > 0) report.fail(check, `${relativePath} is missing ${missing.join(', ')}.`);
  if (unexpected.length > 0) report.fail(check, `${relativePath} has unknown ${unexpected.join(', ')}.`);
  if (new Set(fileSegmentIds).size !== fileSegmentIds.length) report.fail(check, `${relativePath} lists a Creek Segment more than once.`);
  return tncComid;
}

/**
 * The bed a depth-layout method (m2–m5) solved on at the WSE Anchor Point, written per segment as `anchorBedElevationM`.
 * It can differ from Stage 1's bed (m3 v2 and later use the raw lidar's lowest point), so their values are checked against it;
 * m1 files have no such field and keep Stage 1's bed.
 */
function anchorBedOf(segment: WaterSurfaceElevationTimeSeriesFile['segments'][number]): number | undefined {
  const anchorBed = (segment as { anchorBedElevationM?: unknown }).anchorBedElevationM;
  return typeof anchorBed === 'number' ? anchorBed : undefined;
}

/** Returns the report; never throws for a violation. */
export async function validateModeledWaterSurfaceElevationOutputs(inputs: {
  expectedSegmentNetworkVersion: string;
  segmentIds: string[];
  crossSections: CrossSectionsFile;
  ladders: PolygonLaddersFile;
  /** Every Stage 4 polygon set file, one per TNC flowline; `relativePath` is only used in messages. */
  polygonSetFiles: { relativePath: string; contents: WaterSurfacePolygonSetsFile }[];
  catalogDatasets: readonly { datasetId: string }[];
  /** Contains `time-series/<datasetId>/` with nested `.json` files, one TNC flowline per file. */
  timeSeriesDirectory: string;
}): Promise<ModeledWaterSurfaceElevationValidationResult> {
  const report = new ValidationReport();
  for (const check of Object.values(CHECKS)) report.declare(check);
  const expectedVersion = inputs.expectedSegmentNetworkVersion;
  const { segmentIds } = inputs;
  const segmentIdsByTncComid = new Map<string, string[]>();
  for (const segmentId of segmentIds) {
    const tncComid = tncComidOfSegmentId(segmentId);
    segmentIdsByTncComid.set(tncComid, [...(segmentIdsByTncComid.get(tncComid) ?? []), segmentId]);
  }

  const bedBySegmentId = new Map(inputs.crossSections.segments.map((section) => [section.segmentId, section.bedElevationM]));
  const ceilingBySegmentId = new Map(inputs.ladders.segments.map((ladder) => [ladder.segmentId, ladder.ceilingM]));
  for (const [label, version] of [
    [CROSS_SECTIONS_FILE, inputs.crossSections.segmentNetworkVersion],
    [POLYGON_LADDERS_FILE, inputs.ladders.segmentNetworkVersion],
    ...inputs.polygonSetFiles.map(({ relativePath, contents }) => [relativePath, contents.segmentNetworkVersion] as const),
  ] as const) {
    if (version !== expectedVersion) report.fail(CHECKS.segmentNetworkVersion, `${label} has ${version}, expected ${expectedVersion}.`);
  }

  if (inputs.polygonSetFiles.length === 0) report.fail(CHECKS.polygonSetsCoverEverySegment, 'No water-surface polygon set files.');
  const polygonSetCountBySegmentId = new Map<string, number>();
  for (const { relativePath, contents } of inputs.polygonSetFiles) {
    const fileSegmentIds = contents.waterSurfacePolygonSets.map((set) => set.segmentId);
    checkOneTncFlowlineFile({ report, check: CHECKS.polygonSetsCoverEverySegment, relativePath, fileSegmentIds, segmentIdsByTncComid });
    for (const segmentId of fileSegmentIds) polygonSetCountBySegmentId.set(segmentId, (polygonSetCountBySegmentId.get(segmentId) ?? 0) + 1);
  }
  for (const segmentId of segmentIds) {
    const count = polygonSetCountBySegmentId.get(segmentId) ?? 0;
    if (count !== 1) report.fail(CHECKS.polygonSetsCoverEverySegment, `${segmentId} has ${count} polygon sets across all files; expected 1.`);
  }

  const pathsByDatasetId = await listTimeSeriesFiles(inputs.timeSeriesDirectory);
  const datasets: ValidatedDatasetTimeSeries[] = [];
  let valuesChecked = 0;
  for (const dataset of inputs.catalogDatasets) {
    const paths = pathsByDatasetId.get(dataset.datasetId) ?? [];
    if (paths.length === 0) report.fail(CHECKS.catalogMatchesTimeSeries, `${dataset.datasetId} has no Time Series files.`);
    /** Previous timestamp and full timestamp list per TNC flowline, in path order. */
    const previousTimestampByTncComid = new Map<string, number>();
    const timestampsByTncComid = new Map<string, number[]>();
    let firstTimestamp: number | null = null;
    let lastTimestamp: number | null = null;
    const transferSegmentIds = new Set<string>();
    for (const relativePath of paths) {
      const absolutePath = path.join(inputs.timeSeriesDirectory, relativePath);
      if (!(await fileExists(absolutePath))) {
        report.fail(CHECKS.pathsExist, `${relativePath} is missing.`);
        continue;
      }
      const file = (await readJson(absolutePath)) as WaterSurfaceElevationTimeSeriesFile;
      if (file.segmentNetworkVersion !== expectedVersion) {
        report.fail(CHECKS.segmentNetworkVersion, `${relativePath} has ${file.segmentNetworkVersion}, expected ${expectedVersion}.`);
      }
      if (file.datasetId !== dataset.datasetId || file.variableId !== WATER_SURFACE_ELEVATION_VARIABLE_ID) {
        report.fail(CHECKS.catalogMatchesTimeSeries, `${relativePath} names ${file.datasetId} / ${file.variableId}.`);
      }

      const fileSegmentIds = file.segments.map((segment) => segment.segmentId);
      const tncComid =
        checkOneTncFlowlineFile({ report, check: CHECKS.coversEverySegment, relativePath, fileSegmentIds, segmentIdsByTncComid }) ??
        relativePath;
      let previousTimestamp = previousTimestampByTncComid.get(tncComid) ?? -Infinity;
      for (const timestamp of file.timestampsUtcMs) {
        if (!(timestamp > previousTimestamp)) {
          report.fail(CHECKS.timestampsIncreasing, `${relativePath} has ${isoUtc(timestamp)} after ${isoUtc(previousTimestamp)}.`);
        }
        previousTimestamp = timestamp;
        if (firstTimestamp === null || timestamp < firstTimestamp) firstTimestamp = timestamp;
        if (lastTimestamp === null || timestamp > lastTimestamp) lastTimestamp = timestamp;
      }
      previousTimestampByTncComid.set(tncComid, previousTimestamp);
      timestampsByTncComid.set(tncComid, [...(timestampsByTncComid.get(tncComid) ?? []), ...file.timestampsUtcMs]);

      for (const segment of file.segments) {
        const { segmentId, values } = segment;
        if (segment[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]) transferSegmentIds.add(segmentId);
        if (values.length !== file.timestampsUtcMs.length) {
          report.fail(CHECKS.coversEverySegment, `${relativePath} ${segmentId} has ${values.length} values for ${file.timestampsUtcMs.length} timestamps.`);
        }
        const bed = anchorBedOf(segment) ?? bedBySegmentId.get(segmentId);
        const ceiling = ceilingBySegmentId.get(segmentId);
        if (bed === undefined) report.fail(CHECKS.valuesAtOrAboveBed, `${segmentId} has no Stage 1 bed elevation.`);
        if (ceiling === undefined) report.fail(CHECKS.valuesWithinLadder, `${segmentId} has no Stage 4 polygon ladder.`);
        values.forEach((value, index) => {
          if (value === null) return;
          valuesChecked += 1;
          const when = isoUtc(file.timestampsUtcMs[index] as number);
          if (bed !== undefined && value < bed) report.fail(CHECKS.valuesAtOrAboveBed, `${relativePath} ${segmentId} ${when}: ${value} m < bed ${bed} m.`);
          if (ceiling !== undefined && value > ceiling) {
            report.fail(CHECKS.valuesWithinLadder, `${relativePath} ${segmentId} ${when}: ${value} m > ceiling ${ceiling} m.`);
          }
        });
      }
    }
    if (paths.length > 0) {
      const referenceTimestamps = [...timestampsByTncComid.values()][0] ?? [];
      for (const tncComid of segmentIdsByTncComid.keys()) {
        const timestamps = timestampsByTncComid.get(tncComid);
        if (!timestamps) {
          report.fail(CHECKS.coversEverySegment, `${dataset.datasetId} has no Time Series file for TNC flowline ${tncComid}.`);
        } else if (timestamps.length !== referenceTimestamps.length || timestamps.some((timestamp, index) => timestamp !== referenceTimestamps[index])) {
          report.fail(CHECKS.coversEverySegment, `${dataset.datasetId} TNC flowline ${tncComid} has a different timestamp list than the other flowlines.`);
        }
      }
    }
    datasets.push({
      datasetId: dataset.datasetId,
      paths,
      firstTimestampUtcMs: firstTimestamp,
      lastTimestampUtcMs: lastTimestamp,
      drainageAreaRatioTransferSegments: transferSegmentIds.size,
    });
  }
  for (const datasetId of pathsByDatasetId.keys()) {
    if (!inputs.catalogDatasets.some((dataset) => dataset.datasetId === datasetId)) {
      report.fail(CHECKS.catalogMatchesTimeSeries, `Time Series folder ${datasetId} has no catalog Dataset.`);
    }
  }

  return { passed: report.passed, valuesChecked, checks: [...report.checks.values()], datasets };
}
