import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readJson, writePrettyJson } from '../../json-files.ts';
import { REACH_ASSIGNMENTS_FILE, readNhdplusV2ReachAssignments, roundValue, type NormalizedDischargeFile } from '../discharge-records.ts';
import { MODELED_EXTENT, pipelineWorkingOutputDirectory, stageDirectory } from '../pipeline-configuration.ts';
import { formatBytes, runStage, runStageEntryPoint, sha256OfFile, type StageResult } from '../stage-manifest.ts';
import {
  OPERATIONAL_NATIONAL_WATER_MODEL,
  OPERATIONAL_NATIONAL_WATER_MODEL_BUCKET_URL,
  operationalNormalizationText,
} from './operational-national-water-model-config.ts';

/**
 * Stage 0b — acquire the operational National Water Model (NWM) Analysis and Assimilation hourly discharge of the extent's NHDPlusV2
 * reaches. Runs after Stage 0 (`run-all-stages.ts` does that) because it reads Stage 0's reach assignment. The reading itself is
 * Python (`acquire_operational_nwm_streamflow.py`, run with `uv run`): it range-reads only `feature_id` and `streamflow` from each
 * ~13 MB hourly file (~2.4 MB per file) into a resumable per-day cache, so ~10,000 hours never need ~130 GB of disk.
 * Writes `00-acquire/national-water-model-operational-hourly-discharge.json` (a `NormalizedDischargeFile`). Its manifest sits in
 * `00-acquire/operational-national-water-model/`, so Stage 0's own manifest is untouched.
 *
 * Flags: `--operational-nwm-start=<UTC hour>` and `--operational-nwm-end=<UTC hour>` (defaults in the config), `--extent=`, `--force`.
 */

const operationalDirectory = path.join(stageDirectory('acquire'), 'operational-national-water-model');
const pythonScriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acquire_operational_nwm_streamflow.py');
const cacheDirectory = path.join(pipelineWorkingOutputDirectory, OPERATIONAL_NATIONAL_WATER_MODEL.cacheDirectoryName);
const HOUR_MS = 3_600_000;

/** One hour's entry in the Python reader's per-day cache. */
interface CachedHour {
  status: 'ok' | 'not-found' | 'failed';
  error?: string;
  validTimeUtc?: string;
  nwmVersion?: string;
  codeVersion?: string;
  modelConfiguration?: string;
  streamflow?: Record<string, number | null>;
  absentFeatureIds?: number[];
  valuesOutsideValidRange?: number;
  bytesTransferred?: number;
}

interface PythonRunReport {
  hoursInRange: number;
  hoursFromCache: number;
  hoursRequested: number;
  bytesTransferred: number;
  httpRequests: number;
  downloadSeconds: number;
}

function requestedHour(flagName: string, fallback: string): number {
  const prefix = `--${flagName}=`;
  const flag = process.argv.find((argument) => argument.startsWith(prefix));
  const text = flag ? flag.slice(prefix.length) : fallback;
  const timestampMs = Date.parse(text);
  if (!Number.isFinite(timestampMs) || !/(Z|[+-]\d\d:\d\d)$/.test(text) || timestampMs % HOUR_MS !== 0) {
    throw new Error(`Could not read ${prefix}${text}. Use a UTC hour such as ${fallback}.`);
  }
  return timestampMs;
}

function isoHour(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace('.000Z', 'Z');
}

function runPython(arguments_: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.UV_BINARY ?? 'uv', ['run', '--quiet', pythonScriptPath, ...arguments_], { stdio: 'inherit' });
    child.on('error', (error) => reject(new Error(`Could not start uv (${error.message}). Install it with \`brew install uv\`.`, { cause: error })));
    child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(`The Python reader exited with ${code ?? signal}.`))));
  });
}

/** Reads every per-day cache file that overlaps the range into one map keyed by valid-hour timestamp. */
async function readCachedHours(startMs: number, endMs: number): Promise<Map<number, CachedHour>> {
  const hours = new Map<number, CachedHour>();
  for (const name of (await readdir(cacheDirectory)).filter((entry) => /^\d{8}\.json$/.test(entry)).sort()) {
    const dayMs = Date.UTC(Number(name.slice(0, 4)), Number(name.slice(4, 6)) - 1, Number(name.slice(6, 8)));
    if (dayMs > endMs || dayMs + 24 * HOUR_MS <= startMs) continue;
    const day = (await readJson(path.join(cacheDirectory, name))) as { hours: Record<string, CachedHour> };
    for (const [hour, entry] of Object.entries(day.hours)) {
      const timestampMs = dayMs + Number(hour) * HOUR_MS;
      if (timestampMs >= startMs && timestampMs <= endMs) hours.set(timestampMs, entry);
    }
  }
  return hours;
}

/** Runs of consecutive hours as `first → last` ISO strings. */
function hourRanges(timestampsMs: readonly number[]): string[] {
  const ranges: string[] = [];
  let first: number | null = null;
  let previous = 0;
  for (const timestampMs of timestampsMs) {
    if (first === null) first = timestampMs;
    else if (timestampMs - previous !== HOUR_MS) {
      ranges.push(first === previous ? isoHour(first) : `${isoHour(first)} → ${isoHour(previous)}`);
      first = timestampMs;
    }
    previous = timestampMs;
  }
  if (first !== null) ranges.push(first === previous ? isoHour(first) : `${isoHour(first)} → ${isoHour(previous)}`);
  return ranges;
}

interface VersionRun {
  nwmVersion: string;
  codeVersion: string;
  modelConfiguration: string;
  firstValidHourUtc: string;
  lastValidHourUtc: string;
  hours: number;
}

/** Consecutive okay hours with the same (NWM_version_number, code_version, model_configuration). */
function versionRuns(timestampsMs: readonly number[], hours: ReadonlyMap<number, CachedHour>): VersionRun[] {
  const runs: VersionRun[] = [];
  for (const timestampMs of timestampsMs) {
    const entry = hours.get(timestampMs);
    if (entry?.status !== 'ok') continue;
    const key = [entry.nwmVersion ?? '?', entry.codeVersion ?? '?', entry.modelConfiguration ?? '?'] as const;
    const last = runs[runs.length - 1];
    if (last && last.nwmVersion === key[0] && last.codeVersion === key[1] && last.modelConfiguration === key[2]) {
      last.lastValidHourUtc = isoHour(timestampMs);
      last.hours += 1;
    } else {
      runs.push({ nwmVersion: key[0], codeVersion: key[1], modelConfiguration: key[2], firstValidHourUtc: isoHour(timestampMs), lastValidHourUtc: isoHour(timestampMs), hours: 1 });
    }
  }
  return runs;
}

async function acquireOperational(startMs: number, endMs: number): Promise<StageResult> {
  const warnings: string[] = [];
  const reachAssignments = await readNhdplusV2ReachAssignments(path.join(stageDirectory('acquire'), REACH_ASSIGNMENTS_FILE));
  const comids = [...new Set(reachAssignments.segments.flatMap((segment) => (segment.nhdplusV2Comid === null ? [] : [segment.nhdplusV2Comid])))].sort((a, b) => a - b);
  const reportPath = path.join(operationalDirectory, 'python-run-report.json');
  console.log(`  Reading operational NWM Analysis and Assimilation hours ${isoHour(startMs)} → ${isoHour(endMs)} for ${comids.length} NHDPlusV2 COMIDs…`);
  await runPython([
    `--start=${isoHour(startMs)}`,
    `--end=${isoHour(endMs)}`,
    `--comids=${comids.join(',')}`,
    `--cache-dir=${cacheDirectory}`,
    `--report-out=${reportPath}`,
    `--workers=${OPERATIONAL_NATIONAL_WATER_MODEL.downloadWorkers}`,
  ]);
  const pythonReport = (await readJson(reportPath)) as PythonRunReport;

  const cached = await readCachedHours(startMs, endMs);
  const timestampsUtcMs: number[] = [];
  for (let timestampMs = startMs; timestampMs <= endMs; timestampMs += HOUR_MS) timestampsUtcMs.push(timestampMs);

  const okHours = timestampsUtcMs.filter((timestampMs) => cached.get(timestampMs)?.status === 'ok');
  const missingHours = timestampsUtcMs.filter((timestampMs) => cached.get(timestampMs)?.status !== 'ok');
  const notFoundHours = missingHours.filter((timestampMs) => cached.get(timestampMs)?.status === 'not-found');
  const failedHours = missingHours.filter((timestampMs) => cached.get(timestampMs)?.status === 'failed');

  // A reach that is no NWM feature_id in any hour is left out of the file, as the retrospective Dataset does.
  const absentEverywhere = comids.filter((comid) => okHours.length > 0 && okHours.every((timestampMs) => cached.get(timestampMs)?.absentFeatureIds?.includes(comid)));
  for (const comid of absentEverywhere) warnings.push(`NHDPlusV2 COMID ${comid} is not an operational NWM feature_id in any hour; it is left out of the discharge file.`);
  const foundComids = comids.filter((comid) => !absentEverywhere.includes(comid));
  const partiallyAbsent = foundComids.filter((comid) => okHours.some((timestampMs) => cached.get(timestampMs)?.absentFeatureIds?.includes(comid)));
  for (const comid of partiallyAbsent) warnings.push(`NHDPlusV2 COMID ${comid} was missing from some operational NWM files; those values are null.`);

  const normalized: NormalizedDischargeFile = {
    publisherId: OPERATIONAL_NATIONAL_WATER_MODEL.publisherId,
    datasetId: OPERATIONAL_NATIONAL_WATER_MODEL.datasetId,
    variableId: 'discharge',
    unit: 'm3/s',
    normalization: operationalNormalizationText({
      firstValidHourUtc: isoHour(startMs),
      lastValidHourUtc: isoHour(endMs),
      hours: timestampsUtcMs.length,
      missingHours: missingHours.length,
    }),
    timestampsUtcMs,
    reaches: foundComids.map((comid) => ({
      nhdplusV2Comid: comid,
      values: timestampsUtcMs.map((timestampMs) => {
        const raw = cached.get(timestampMs)?.streamflow?.[String(comid)];
        return raw === undefined || raw === null ? null : roundValue(raw / 100, 2);
      }),
    })),
  };
  const normalizedPath = path.join(stageDirectory('acquire'), OPERATIONAL_NATIONAL_WATER_MODEL.dischargeFile);
  await writePrettyJson(normalizedPath, normalized);

  const runs = versionRuns(timestampsUtcMs, cached);
  const distinctVersions = [...new Set(runs.map((run) => `${run.nwmVersion} / ${run.codeVersion} / ${run.modelConfiguration}`))];
  if (distinctVersions.length > 1) {
    const message =
      `NWM MODEL VERSION CHANGED MID-RANGE: ${distinctVersions.length} distinct (NWM_version_number / code_version / model_configuration): ` +
      runs.map((run) => `${run.nwmVersion} / ${run.codeVersion} / ${run.modelConfiguration} ${run.firstValidHourUtc} → ${run.lastValidHourUtc} (${run.hours} h)`).join('; ') +
      '. Flows on either side of a change are not strictly comparable.';
    warnings.unshift(message);
    console.warn(`\n!!!!! ${message}\n`);
  }
  for (const run of runs) {
    if (run.modelConfiguration !== 'analysis_and_assimilation') warnings.push(`Unexpected model_configuration ${run.modelConfiguration} ${run.firstValidHourUtc} → ${run.lastValidHourUtc}.`);
  }
  if (missingHours.length > 0) {
    warnings.push(
      `${missingHours.length} of ${timestampsUtcMs.length} hours have no operational NWM value (${notFoundHours.length} not found, ${failedHours.length} failed after retries): ` +
        `${hourRanges(missingHours).slice(0, 20).join(', ')}${hourRanges(missingHours).length > 20 ? ', …' : ''}; their values are null.`,
    );
  }
  const outsideValidRange = okHours.reduce((sum, timestampMs) => sum + (cached.get(timestampMs)?.valuesOutsideValidRange ?? 0), 0);
  if (outsideValidRange > 0) warnings.push(`${outsideValidRange} reach-hour value(s) were outside the file's valid_range (0–50,000 m³/s); they are null.`);

  const nullValues = normalized.reaches.reduce((sum, reach) => sum + reach.values.filter((value) => value === null).length, 0);
  const cumulativeBytes = [...cached.values()].reduce((sum, entry) => sum + (entry.bytesTransferred ?? 0), 0);
  const jalama = normalized.reaches.find((reach) => reach.nhdplusV2Comid === 17593507);
  return {
    outputFiles: [normalizedPath, reportPath],
    counts: {
      hours: timestampsUtcMs.length,
      hoursWithValues: okHours.length,
      hoursMissing: missingHours.length,
      hoursNotFound: notFoundHours.length,
      hoursFailed: failedHours.length,
      reaches: foundComids.length,
      reachesNotNwmFeatures: absentEverywhere.length,
      nullValues,
      distinctNwmVersions: distinctVersions.length,
    },
    warnings,
    measurements: {
      requestedComids: comids,
      firstValidHourUtc: isoHour(startMs),
      lastValidHourUtc: isoHour(endMs),
      nwmVersionRuns: runs,
      missingHourRanges: hourRanges(missingHours),
      thisRun: pythonReport,
      cumulativeBytesTransferredAcrossRuns: cumulativeBytes,
      jalamaGaugeReach17593507MaximumM3s: jalama ? Math.max(...jalama.values.filter((value): value is number => value !== null)) : null,
    },
    summaryLines: [
      `Operational NWM Analysis and Assimilation: ${okHours.length} of ${timestampsUtcMs.length} hours (${isoHour(startMs)} → ${isoHour(endMs)}), ${foundComids.length} reaches, ${missingHours.length} missing hours, ${nullValues} null values.`,
      `Versions seen: ${runs.map((run) => `${run.nwmVersion} / ${run.codeVersion} ${run.firstValidHourUtc} → ${run.lastValidHourUtc} (${run.hours} h)`).join('; ') || 'none'}.`,
      `This run: ${pythonReport.hoursRequested} hours requested, ${pythonReport.hoursFromCache} from cache, ${formatBytes(pythonReport.bytesTransferred)} in ${pythonReport.httpRequests} HTTP requests, ${pythonReport.downloadSeconds} s; all runs ${formatBytes(cumulativeBytes)}.`,
      `Source: ${OPERATIONAL_NATIONAL_WATER_MODEL_BUCKET_URL}/${OPERATIONAL_NATIONAL_WATER_MODEL.fileNamePattern}`,
    ],
  };
}

await runStageEntryPoint(async () => {
  const startMs = requestedHour('operational-nwm-start', OPERATIONAL_NATIONAL_WATER_MODEL.defaultFirstValidHourUtc);
  const endMs = requestedHour('operational-nwm-end', OPERATIONAL_NATIONAL_WATER_MODEL.defaultLastValidHourUtc);
  if (endMs < startMs) throw new Error('--operational-nwm-end is before --operational-nwm-start.');
  await runStage({
    stage: '00-acquire-operational-national-water-model',
    outputDirectory: operationalDirectory,
    inputFiles: [MODELED_EXTENT.flowlineSnapshotPath, path.join(stageDirectory('acquire'), REACH_ASSIGNMENTS_FILE)],
    parameters: {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      operationalNationalWaterModel: {
        ...OPERATIONAL_NATIONAL_WATER_MODEL,
        bucketUrl: OPERATIONAL_NATIONAL_WATER_MODEL_BUCKET_URL,
        firstValidHourUtc: isoHour(startMs),
        lastValidHourUtc: isoHour(endMs),
        pythonReaderSha256: await sha256OfFile(pythonScriptPath),
      },
    },
    run: () => acquireOperational(startMs, endMs),
  });
});
