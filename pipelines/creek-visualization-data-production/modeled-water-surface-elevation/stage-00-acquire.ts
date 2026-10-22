import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expectNumber, expectRecord, expectString, readJson, writePrettyJson } from '../json-files.ts';
import { loadCreekSegmentNetwork } from './creek-segment-network.ts';
import {
  CNF_DISCHARGE_FILE,
  NWM_DISCHARGE_FILE,
  REACH_ASSIGNMENTS_FILE,
  exceedsMaximumTransferDistance,
  roundValue,
  type NormalizedDischargeFile,
} from './discharge-records.ts';
import { fetchText, urlWithParams } from './http-download.ts';
import { summarizeTransferDistances } from './nhdplusv2-reach-geometry.ts';
import {
  fullRecordChunkCount,
  locateFeatureColumns,
  locateTimeRange,
  readStoreMetadata,
  readStreamflowColumns,
  type DownloadMeter,
} from './national-water-model-zarr.ts';
import { buildNhdplusV2ReachCrosswalk, type TncFlowlineIdentity } from './nhdplusv2-reach-crosswalk.ts';
import {
  CALIFORNIA_NATURAL_FLOWS,
  CUBIC_FEET_TO_CUBIC_METERS,
  MODELED_EXTENT,
  NATIONAL_WATER_MODEL,
  NATIONAL_WATER_MODEL_CHUNK_CACHE_DIRECTORY,
  NHDPLUSV2_REACH_ATTRIBUTES_CACHE_FILE,
  NHDPLUSV2_REACH_GEOMETRY_CACHE_FILE,
  NLDI_POSITION_CACHE_FILE,
  TERRAIN_TILE_MAX_PIXELS,
  TERRAIN_TILE_STEP_M,
  stageDirectory,
} from './pipeline-configuration.ts';
import {
  DRAINAGE_AREA_RATIO_TRANSFER,
  MAXIMUM_TRANSFER_DISTANCE_M,
} from './modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { formatBytes, runStage, runStageEntryPoint, type StageResult } from './stage-manifest.ts';
import { refuseToOverwriteADifferentModeledWseVersion } from './modeled-wse-version.ts';
import { acquireTerrainTiles } from './terrain-acquisition.ts';
import { requestedWaterYears, waterYearStartMs } from './water-years.ts';

/**
 * Stage 0 — acquire. Downloads every network input the later stages need:
 * USGS 3DEP 1 m terrain, the NHDPlusV2 reach assignment per Creek Segment (Stage 1 adds the
 * drainage-area ratio and writes the tracked crosswalk), California Natural Flows monthly
 * discharge, and NOAA National Water Model hourly retrospective discharge.
 */

const outputDirectory = stageDirectory('acquire');

interface CaliforniaNaturalFlowsRow {
  statistic: string;
  variable: string;
  year: number;
  month: number;
  value: number;
}

function parseCaliforniaNaturalFlowsCsv(csv: string, comid: number): CaliforniaNaturalFlowsRow[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]?.split(',') ?? [];
  const expectedHeader = ['comid', 'statistic', 'variable', 'year', 'month', 'value'];
  if (header.join(',') !== expectedHeader.join(',')) {
    throw new Error(`California Natural Flows CSV for ${comid} has header "${header.join(',')}", expected "${expectedHeader.join(',')}".`);
  }
  return lines.slice(1).map((line) => {
    const [rowComid, statistic = '', variable = '', year, month, value] = line.split(',');
    if (Number(rowComid) !== comid) throw new Error(`California Natural Flows row for COMID ${rowComid} in the ${comid} response.`);
    return { statistic, variable, year: Number(year), month: Number(month), value: Number(value) };
  });
}

async function acquireCaliforniaNaturalFlows(
  comids: readonly number[],
): Promise<{ files: string[]; timestampCount: number; warnings: string[] }> {
  const warnings: string[] = [];
  const files: string[] = [];
  const valuesByComid = new Map<number, Map<number, number>>();
  const allTimestamps = new Set<number>();
  for (const comid of comids) {
    const url = urlWithParams(CALIFORNIA_NATURAL_FLOWS.streamUrl, { comids: String(comid) });
    const csv = await fetchText(url);
    const rawPath = path.join(outputDirectory, `california-natural-flows-raw-${comid}.csv`);
    await writeFile(rawPath, csv);
    files.push(rawPath);
    const rows = parseCaliforniaNaturalFlowsCsv(csv, comid).filter(
      (row) => row.statistic === CALIFORNIA_NATURAL_FLOWS.statistic && row.variable === CALIFORNIA_NATURAL_FLOWS.variable,
    );
    if (rows.length === 0) warnings.push(`California Natural Flows has no mean estimated rows for NHDPlusV2 COMID ${comid}.`);
    const byTimestamp = new Map<number, number>();
    for (const row of rows) {
      const timestamp = Date.UTC(row.year, row.month - 1, 1);
      allTimestamps.add(timestamp);
      if (Number.isFinite(row.value)) byTimestamp.set(timestamp, row.value * CUBIC_FEET_TO_CUBIC_METERS);
    }
    valuesByComid.set(comid, byTimestamp);
  }
  const timestampsUtcMs = [...allTimestamps].sort((a, b) => a - b);
  const normalized: NormalizedDischargeFile = {
    publisherId: CALIFORNIA_NATURAL_FLOWS.publisherId,
    datasetId: CALIFORNIA_NATURAL_FLOWS.datasetId,
    variableId: 'discharge',
    unit: 'm3/s',
    normalization:
      'Monthly mean of the "estimated" (unimpaired) statistic, cfs × 0.0283168 → m³/s; timestamp = first instant of the month UTC.',
    timestampsUtcMs,
    reaches: comids.map((comid) => {
      const byTimestamp = valuesByComid.get(comid) ?? new Map<number, number>();
      return {
        nhdplusV2Comid: comid,
        values: timestampsUtcMs.map((timestamp) => {
          const value = byTimestamp.get(timestamp);
          return value === undefined ? null : roundValue(value, 6);
        }),
      };
    }),
  };
  const normalizedPath = path.join(outputDirectory, CNF_DISCHARGE_FILE);
  await writePrettyJson(normalizedPath, normalized);
  files.push(normalizedPath);
  return { files, timestampCount: timestampsUtcMs.length, warnings };
}

async function acquireNationalWaterModel(comids: readonly number[]): Promise<{
  files: string[];
  timestampCount: number;
  warnings: string[];
  measurements: Record<string, unknown>;
  summary: string;
}> {
  const warnings: string[] = [];
  const meter: DownloadMeter = {
    bytes: 0,
    requests: 0,
    cachedBytes: 0,
    cachedChunks: 0,
    chunkCacheDirectory: NATIONAL_WATER_MODEL_CHUNK_CACHE_DIRECTORY,
  };
  const { first, last } = requestedWaterYears();
  const startMs = waterYearStartMs(first);
  const endMs = waterYearStartMs(last + 1);
  const startedAt = Date.now();

  const metadata = await readStoreMetadata(NATIONAL_WATER_MODEL.zarrStoreUrl, meter);
  const columns = await locateFeatureColumns(NATIONAL_WATER_MODEL.zarrStoreUrl, metadata, comids, meter);
  const featureIdBytes = meter.bytes - metadata.consolidatedMetadataBytes;
  const foundComids = comids.filter((comid) => (columns.get(comid) ?? -1) >= 0);
  for (const comid of comids) {
    if (!foundComids.includes(comid)) warnings.push(`NHDPlusV2 COMID ${comid} is not a NWM feature_id.`);
  }
  const timeRange = await locateTimeRange(NATIONAL_WATER_MODEL.zarrStoreUrl, metadata, startMs, endMs, meter);
  const lastAvailableMs = timeRange.timestampsUtcMs[timeRange.timestampsUtcMs.length - 1] ?? startMs;
  const firstAvailableMs = timeRange.timestampsUtcMs[0] ?? startMs;
  // The retrospective record ends partway through a water year; keep only the hours it has, with no padding.
  const lastWaterYearPartial = lastAvailableMs + 3_600_000 < endMs;
  if (lastWaterYearPartial) {
    warnings.push(
      `WY${last} is partial: the NWM record ends ${new Date(lastAvailableMs).toISOString()}, so WY${last} covers only the hours up to then.`,
    );
  }
  if (firstAvailableMs > startMs) {
    warnings.push(`WY${first} is partial: the NWM record starts ${new Date(firstAvailableMs).toISOString()}.`);
  }
  const bytesBeforeStreamflow = meter.bytes;
  const requestsBeforeStreamflow = meter.requests;
  const cachedChunksBeforeStreamflow = meter.cachedChunks;
  const cachedBytesBeforeStreamflow = meter.cachedBytes;
  const streamflowStartedAt = Date.now();
  let lastLogged = 0;
  const values = await readStreamflowColumns({
    storeUrl: NATIONAL_WATER_MODEL.zarrStoreUrl,
    metadata,
    columns: foundComids.map((comid) => columns.get(comid) ?? -1),
    firstTimeIndex: timeRange.firstIndex,
    timeCount: timeRange.timestampsUtcMs.length,
    concurrency: NATIONAL_WATER_MODEL.chunkDownloadConcurrency,
    meter,
    onChunk: (done, total) => {
      if (done === total || Date.now() - lastLogged > 5000) {
        lastLogged = Date.now();
        console.log(`  NWM streamflow chunk ${done} of ${total} (${formatBytes(meter.bytes)} so far)`);
      }
    },
  });
  const streamflowMs = Date.now() - streamflowStartedAt;
  const streamflowBytes = meter.bytes - bytesBeforeStreamflow;
  const streamflowChunks = meter.requests - requestsBeforeStreamflow;
  const streamflowCachedChunks = meter.cachedChunks - cachedChunksBeforeStreamflow;
  const streamflowCachedBytes = meter.cachedBytes - cachedBytesBeforeStreamflow;
  const streamflowChunksUsed = streamflowChunks + streamflowCachedChunks;

  const featureChunkWidth = metadata.streamflow.chunks[1] ?? 1;
  const featureChunksNeeded = new Set(foundComids.map((comid) => Math.floor((columns.get(comid) ?? 0) / featureChunkWidth))).size;
  const fullRecordChunks = fullRecordChunkCount(metadata) * featureChunksNeeded;
  // Linear extrapolation from the window's chunk sizes; time assumes every chunk is downloaded at the same concurrency.
  const fullRecordScale = streamflowChunksUsed > 0 ? fullRecordChunks / streamflowChunksUsed : 0;
  const estimatedFullRecordBytes = Math.round((streamflowBytes + streamflowCachedBytes) * fullRecordScale);
  const downloadMsPerChunk = streamflowChunks > 0 ? streamflowMs / streamflowChunks : 0;
  const estimatedFullRecordMs = Math.round(downloadMsPerChunk * fullRecordChunks);

  const normalized: NormalizedDischargeFile = {
    publisherId: NATIONAL_WATER_MODEL.publisherId,
    datasetId: NATIONAL_WATER_MODEL.datasetId,
    variableId: 'discharge',
    unit: 'm3/s',
    normalization:
      `NWM v3.0 retrospective CHRTOUT streamflow (int32 × scale_factor → m³/s), water years ${first}–${last}` +
      `${lastWaterYearPartial ? ` (WY${last} partial, through ${new Date(lastAvailableMs).toISOString()})` : ''}; fill value → null.`,
    timestampsUtcMs: timeRange.timestampsUtcMs,
    reaches: foundComids.map((comid, index) => ({
      nhdplusV2Comid: comid,
      values: (values[index] ?? []).map((value) => (value === null ? null : roundValue(value, 4))),
    })),
  };
  const normalizedPath = path.join(outputDirectory, NWM_DISCHARGE_FILE);
  await writePrettyJson(normalizedPath, normalized);

  const zarrLayoutPath = path.join(outputDirectory, 'national-water-model-zarr-layout.json');
  const zarrLayout = {
    storeUrl: NATIONAL_WATER_MODEL.zarrStoreUrl,
    streamflow: metadata.streamflow,
    time: metadata.time,
    featureId: metadata.featureId,
    featureColumns: Object.fromEntries(foundComids.map((comid) => [String(comid), columns.get(comid)])),
  };
  await writePrettyJson(zarrLayoutPath, zarrLayout);

  const measurements = {
    waterYears: `${first}-${last}`,
    timeIndexRange: [timeRange.firstIndex, timeRange.firstIndex + timeRange.timestampsUtcMs.length - 1],
    streamflowChunkShape: metadata.streamflow.chunks,
    streamflowShape: metadata.streamflow.shape,
    compressor: metadata.streamflow.compressor,
    lastAvailableTimestampUtc: new Date(lastAvailableMs).toISOString(),
    lastWaterYearPartial,
    featureIdChunkBytes: featureIdBytes,
    streamflowChunksDownloaded: streamflowChunks,
    streamflowBytesDownloaded: streamflowBytes,
    streamflowChunksFromCache: streamflowCachedChunks,
    streamflowBytesFromCache: streamflowCachedBytes,
    streamflowDownloadMs: streamflowMs,
    totalBytesDownloaded: meter.bytes,
    totalRequests: meter.requests,
    totalBytesFromCache: meter.cachedBytes,
    totalChunksFromCache: meter.cachedChunks,
    totalMs: Date.now() - startedAt,
    fullRecordStreamflowChunks: fullRecordChunks,
    estimatedFullRecordStreamflowBytes: estimatedFullRecordBytes,
    estimatedFullRecordStreamflowMs: estimatedFullRecordMs,
  };
  const summary =
    `NWM WY${first}–WY${last}: ${streamflowChunksUsed} streamflow chunks, ${streamflowChunks} downloaded ` +
    `(${formatBytes(streamflowBytes)} in ${(streamflowMs / 1000).toFixed(1)} s), ${streamflowCachedChunks} from cache ` +
    `(${formatBytes(streamflowCachedBytes)}); all NWM network bytes ${formatBytes(meter.bytes)}. ` +
    `Full record ≈ ${fullRecordChunks} chunks, ${formatBytes(estimatedFullRecordBytes)}.`;
  return {
    files: [normalizedPath, zarrLayoutPath],
    timestampCount: timeRange.timestampsUtcMs.length,
    warnings,
    measurements,
    summary,
  };
}

async function acquire(): Promise<StageResult> {
  const segments = await loadCreekSegmentNetwork();
  const flowlines = expectRecord(await readJson(MODELED_EXTENT.flowlineSnapshotPath), 'TNC flowlines');
  const flowlineIdentityByComid = new Map<number, TncFlowlineIdentity>();
  for (const [index, value] of (Array.isArray(flowlines.features) ? flowlines.features : []).entries()) {
    const attributes = expectRecord(expectRecord(value, `TNC flowline feature ${index}`).attributes, `TNC flowline feature ${index} attributes`);
    flowlineIdentityByComid.set(expectNumber(attributes, 'COMID', `TNC flowline feature ${index}`), {
      reachCode: expectString(attributes, 'REACHCODE', `TNC flowline feature ${index}`),
      gnisName: typeof attributes.GNIS_NAME === 'string' ? attributes.GNIS_NAME.trim() : '',
    });
  }

  console.log('  Downloading USGS 3DEP 1 m terrain…');
  const terrain = await acquireTerrainTiles({ segments, bufferM: MODELED_EXTENT.terrainBufferM, outputDirectory });

  console.log('  Assigning each Creek Segment its NHDPlusV2 reach with NLDI…');
  const crosswalkResult = await buildNhdplusV2ReachCrosswalk({ segments, flowlineIdentityByComid, cacheDirectory: outputDirectory });
  const reachAssignmentsPath = path.join(outputDirectory, REACH_ASSIGNMENTS_FILE);
  await writePrettyJson(reachAssignmentsPath, crosswalkResult.assignments);
  const assignedSegments = crosswalkResult.assignments.segments;
  const distinctComids = [...new Set(assignedSegments.flatMap((entry) => (entry.nhdplusV2Comid === null ? [] : [entry.nhdplusV2Comid])))].sort(
    (a, b) => a - b,
  );

  // Drainage-Area Ratio Transfer: how many segments borrow a neighbouring creek's reach, and how far away it is.
  const transferSegments = assignedSegments.filter((entry) => entry[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]);
  const transferDistances = summarizeTransferDistances(
    transferSegments.flatMap((entry) => (typeof entry.transferDistanceM === 'number' ? [entry.transferDistanceM] : [])),
  );
  const transferDistanceExceededSegments = transferSegments.filter(exceedsMaximumTransferDistance).length;
  // The lookup caches exist only once something was fetched or seeded; list them as outputs when they do.
  const cachePaths: string[] = [];
  for (const cacheFile of [NLDI_POSITION_CACHE_FILE, NHDPLUSV2_REACH_ATTRIBUTES_CACHE_FILE, NHDPLUSV2_REACH_GEOMETRY_CACHE_FILE]) {
    const cachePath = path.join(outputDirectory, cacheFile);
    if (await stat(cachePath).then(() => true, () => false)) cachePaths.push(cachePath);
  }

  console.log(`  Downloading California Natural Flows for ${distinctComids.length} NHDPlusV2 COMID(s)…`);
  const californiaNaturalFlows = await acquireCaliforniaNaturalFlows(distinctComids);

  console.log('  Reading NOAA National Water Model retrospective Zarr…');
  const nationalWaterModel = await acquireNationalWaterModel(distinctComids);

  const segmentCountsByComid = distinctComids
    .map((comid) => `${comid}×${assignedSegments.filter((entry) => entry.nhdplusV2Comid === comid).length}`)
    .join(', ');
  return {
    outputFiles: [
      ...terrain.files,
      reachAssignmentsPath,
      ...cachePaths,
      ...californiaNaturalFlows.files,
      ...nationalWaterModel.files,
    ],
    counts: {
      creekSegments: segments.length,
      terrainTiles: terrain.index.tiles.length,
      distinctNhdplusV2Comids: distinctComids.length,
      unmappedCreekSegments: assignedSegments.filter((entry) => entry.nhdplusV2Comid === null).length,
      reachesWithoutDrainageArea: new Set(
        assignedSegments.flatMap((entry) => (entry.nhdplusV2Comid !== null && entry.reachDrainageAreaKm2 === null ? [entry.nhdplusV2Comid] : [])),
      ).size,
      drainageAreaRatioTransferSegments: transferSegments.length,
      transferDistanceExceededSegments,
      nldiLookupsFetched: crosswalkResult.nldiLookupsFetched,
      nldiLookupsReused: crosswalkResult.nldiLookupsReused,
      nldiLookupsSeeded: crosswalkResult.nldiLookupsSeeded,
      reachAttributesFetched: crosswalkResult.reachAttributesFetched,
      reachAttributesReused: crosswalkResult.reachAttributesReused,
      reachGeometriesFetched: crosswalkResult.reachGeometriesFetched,
      reachGeometriesReused: crosswalkResult.reachGeometriesReused,
      californiaNaturalFlowsTimestamps: californiaNaturalFlows.timestampCount,
      nationalWaterModelTimestamps: nationalWaterModel.timestampCount,
    },
    warnings: [...crosswalkResult.warnings, ...californiaNaturalFlows.warnings, ...nationalWaterModel.warnings],
    measurements: {
      terrainTiles: terrain.index.tiles.length,
      terrainTilesDownloaded: terrain.downloadedTiles,
      terrainTilesReused: terrain.reusedTiles,
      terrainBytes: terrain.bytes,
      reachCodes: crosswalkResult.assignments.reachCodes,
      transferDistanceM: transferDistances,
      nationalWaterModel: nationalWaterModel.measurements,
    },
    summaryLines: [
      `${segments.length} Creek Segments; terrain in ${terrain.index.tiles.length} overlapping tile(s) (${formatBytes(terrain.bytes)}).`,
      `NHDPlusV2 COMIDs: ${segmentCountsByComid} (${crosswalkResult.nldiLookupsFetched} NLDI lookups fetched, ${crosswalkResult.nldiLookupsReused} reused, ` +
        `${crosswalkResult.nldiLookupsSeeded} seeded from the tracked crosswalk; ${crosswalkResult.reachAttributesFetched} reach attribute lookups fetched, ` +
        `${crosswalkResult.reachAttributesReused} reused).`,
      `${DRAINAGE_AREA_RATIO_TRANSFER.label}: ${transferSegments.length} segment(s) borrow a neighbouring creek's reach; ` +
        `distance median ${String(transferDistances.medianM)} m, p90 ${String(transferDistances.p90M)} m, max ${String(transferDistances.maxM)} m; ` +
        `${transferDistanceExceededSegments} beyond ${MAXIMUM_TRANSFER_DISTANCE_M} m get no discharge.`,
      `California Natural Flows: ${californiaNaturalFlows.timestampCount} monthly timestamps.`,
      `NWM: ${nationalWaterModel.timestampCount} hourly timestamps.`,
      nationalWaterModel.summary,
    ],
  };
}

await runStageEntryPoint(async () => {
  await refuseToOverwriteADifferentModeledWseVersion('00-acquire');
  const { first, last } = requestedWaterYears();
  await runStage({
    stage: '00-acquire',
    outputDirectory,
    inputFiles: [MODELED_EXTENT.flowlineSnapshotPath],
    parameters: {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      terrainBufferM: MODELED_EXTENT.terrainBufferM,
      terrainTileMaxPixels: TERRAIN_TILE_MAX_PIXELS,
      terrainTileStepM: TERRAIN_TILE_STEP_M,
      reachAssignment: {
        reachDrainageArea: 'EPA NHDPlusV2 TotDASqKm per assigned reach (reachDrainageAreaKm2)',
        drainageAreaRatioTransfer: DRAINAGE_AREA_RATIO_TRANSFER,
        maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M,
      },
      californiaNaturalFlows: CALIFORNIA_NATURAL_FLOWS,
      cubicFeetToCubicMeters: CUBIC_FEET_TO_CUBIC_METERS,
      nationalWaterModel: { zarrStoreUrl: NATIONAL_WATER_MODEL.zarrStoreUrl, firstWaterYear: first, lastWaterYear: last },
    },
    run: acquire,
  });
});
