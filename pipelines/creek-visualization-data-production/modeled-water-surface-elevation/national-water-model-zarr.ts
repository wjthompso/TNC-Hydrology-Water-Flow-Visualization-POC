import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { zstdDecompressSync } from 'node:zlib';
import { expectRecord, isRecord } from '../json-files.ts';
import { fetchBytes, mapWithConcurrency } from './http-download.ts';

/**
 * Minimal reader for the NOAA National Water Model v3.0 retrospective CHRTOUT Zarr v2 store.
 * It handles only what this store uses: C-order chunks, zstd compression, no filters.
 * Node 22.15+ ships zstd in node:zlib, so no Zarr library is needed.
 *
 * The retrospective store never changes, so every compressed chunk is kept in a local
 * chunk cache. Changing the water-year window later downloads only chunks not yet cached.
 */

export interface ZarrArrayMetadata {
  shape: number[];
  chunks: number[];
  dtype: string;
  compressor: { id: string; level?: number } | null;
  filters: unknown;
  fillValue: unknown;
  order: string;
  attributes: Record<string, unknown>;
}

export interface ZarrStoreMetadata {
  streamflow: ZarrArrayMetadata;
  time: ZarrArrayMetadata;
  featureId: ZarrArrayMetadata;
  consolidatedMetadataBytes: number;
}

export interface DownloadMeter {
  /** Bytes fetched over the network. */
  bytes: number;
  /** Network requests made. */
  requests: number;
  /** Compressed bytes read from the local chunk cache instead of the network. */
  cachedBytes: number;
  /** Chunks read from the local chunk cache. */
  cachedChunks: number;
  /** Local chunk cache directory; omitted means no cache. */
  chunkCacheDirectory?: string;
}

function readArrayMetadata(metadata: Record<string, unknown>, name: string): ZarrArrayMetadata {
  const array = expectRecord(metadata[`${name}/.zarray`], `Zarr ${name}/.zarray`);
  const attributes = isRecord(metadata[`${name}/.zattrs`]) ? (metadata[`${name}/.zattrs`] as Record<string, unknown>) : {};
  const compressor = array.compressor;
  const parsed: ZarrArrayMetadata = {
    shape: array.shape as number[],
    chunks: array.chunks as number[],
    dtype: String(array.dtype),
    compressor: isRecord(compressor) ? { id: String(compressor.id), level: Number(compressor.level) } : null,
    filters: array.filters ?? null,
    fillValue: array.fill_value ?? null,
    order: String(array.order),
    attributes,
  };
  if (parsed.order !== 'C') throw new Error(`Zarr ${name} uses order ${parsed.order}; only C order is supported.`);
  if (parsed.filters !== null) throw new Error(`Zarr ${name} has filters; this reader supports none.`);
  if (parsed.compressor !== null && parsed.compressor.id !== 'zstd') {
    throw new Error(`Zarr ${name} uses compressor ${parsed.compressor.id}; only zstd is supported.`);
  }
  return parsed;
}

export async function readStoreMetadata(storeUrl: string, meter: DownloadMeter): Promise<ZarrStoreMetadata> {
  const bytes = await fetchBytes(`${storeUrl}/.zmetadata`);
  meter.bytes += bytes.length;
  meter.requests += 1;
  const consolidated = expectRecord(JSON.parse(bytes.toString('utf8')) as unknown, 'Zarr .zmetadata');
  const metadata = expectRecord(consolidated.metadata, 'Zarr .zmetadata metadata');
  return {
    streamflow: readArrayMetadata(metadata, 'streamflow'),
    time: readArrayMetadata(metadata, 'time'),
    featureId: readArrayMetadata(metadata, 'feature_id'),
    consolidatedMetadataBytes: bytes.length,
  };
}

async function readCachedChunk(cachePath: string): Promise<Buffer | null> {
  try {
    return await readFile(cachePath);
  } catch {
    return null;
  }
}

/** Write to a temporary name first so an interrupted run never leaves a truncated chunk in the cache. */
async function writeCachedChunk(cachePath: string, compressed: Buffer): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.partial-${process.pid}`;
  await writeFile(temporaryPath, compressed);
  await rename(temporaryPath, cachePath);
}

async function readChunk(
  storeUrl: string,
  name: string,
  chunkKey: string,
  metadata: ZarrArrayMetadata,
  meter: DownloadMeter,
): Promise<Buffer> {
  const cachePath = meter.chunkCacheDirectory ? path.join(meter.chunkCacheDirectory, name, chunkKey) : null;
  let compressed = cachePath ? await readCachedChunk(cachePath) : null;
  if (compressed) {
    meter.cachedBytes += compressed.length;
    meter.cachedChunks += 1;
  } else {
    compressed = await fetchBytes(`${storeUrl}/${name}/${chunkKey}`);
    meter.bytes += compressed.length;
    meter.requests += 1;
    if (cachePath) await writeCachedChunk(cachePath, compressed);
  }
  return metadata.compressor === null ? compressed : zstdDecompressSync(compressed);
}

function asInt64Values(buffer: Buffer, dtype: string): number[] {
  if (dtype !== '<i8') throw new Error(`Expected little-endian int64, got ${dtype}.`);
  const values: number[] = [];
  for (let offset = 0; offset < buffer.length; offset += 8) values.push(Number(buffer.readBigInt64LE(offset)));
  return values;
}

/** Column index in the `feature_id` dimension for each requested NHDPlusV2 COMID (or -1). */
export async function locateFeatureColumns(
  storeUrl: string,
  metadata: ZarrStoreMetadata,
  comids: readonly number[],
  meter: DownloadMeter,
): Promise<Map<number, number>> {
  if (metadata.featureId.chunks[0] !== metadata.featureId.shape[0]) {
    throw new Error('feature_id is split across several chunks; this reader expects one.');
  }
  const featureIds = asInt64Values(
    await readChunk(storeUrl, 'feature_id', '0', metadata.featureId, meter),
    metadata.featureId.dtype,
  );
  const wanted = new Set(comids);
  const columns = new Map<number, number>(comids.map((comid) => [comid, -1]));
  featureIds.forEach((featureId, index) => {
    if (wanted.has(featureId)) columns.set(featureId, index);
  });
  return columns;
}

/** Parse "hours since 1979-02-01T01:00:00" (UTC assumed) into epoch milliseconds. */
function timeUnitOrigin(metadata: ZarrArrayMetadata): number {
  const units = String(metadata.attributes.units ?? '');
  const match = /^hours since (\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/.exec(units);
  if (!match) throw new Error(`Unexpected NWM time units "${units}".`);
  return Date.parse(`${match[1]}T${match[2]}Z`);
}

/**
 * Time indexes covering [startMs, endMs). Reads only the time chunks that the
 * hourly-spacing guess points at, then confirms every timestamp.
 */
export async function locateTimeRange(
  storeUrl: string,
  metadata: ZarrStoreMetadata,
  startMs: number,
  endMs: number,
  meter: DownloadMeter,
): Promise<{ firstIndex: number; timestampsUtcMs: number[] }> {
  const origin = timeUnitOrigin(metadata.time);
  const hourMs = 3_600_000;
  const chunkLength = metadata.time.chunks[0] ?? 1;
  const totalLength = metadata.time.shape[0] ?? 0;
  const guessFirst = Math.max(0, Math.round((startMs - origin) / hourMs));
  const guessLast = Math.min(totalLength - 1, Math.round((endMs - origin) / hourMs));
  const firstChunk = Math.floor(guessFirst / chunkLength);
  const lastChunk = Math.floor(guessLast / chunkLength);
  const chunkIndexes = Array.from({ length: lastChunk - firstChunk + 1 }, (_, offset) => firstChunk + offset);
  const chunks = await mapWithConcurrency(chunkIndexes, 8, (chunk) =>
    readChunk(storeUrl, 'time', String(chunk), metadata.time, meter),
  );
  const timestamps: { index: number; ms: number }[] = [];
  chunks.forEach((buffer, offset) => {
    const base = (firstChunk + offset) * chunkLength;
    asInt64Values(buffer, metadata.time.dtype).forEach((hours, position) => {
      timestamps.push({ index: base + position, ms: origin + hours * hourMs });
    });
  });
  const inRange = timestamps.filter((entry) => entry.ms >= startMs && entry.ms < endMs);
  if (inRange.length === 0) throw new Error('No NWM timestamps fall inside the requested window.');
  for (let position = 1; position < inRange.length; position += 1) {
    const previous = inRange[position - 1];
    const current = inRange[position];
    if (!previous || !current || current.index !== previous.index + 1) {
      throw new Error('NWM time indexes inside the window are not contiguous.');
    }
  }
  return { firstIndex: inRange[0]?.index ?? 0, timestampsUtcMs: inRange.map((entry) => entry.ms) };
}

/**
 * Read `streamflow` (m³/s) for several feature columns over a contiguous time-index range.
 * Values are int32 × scale_factor; the fill value becomes null.
 */
export async function readStreamflowColumns(input: {
  storeUrl: string;
  metadata: ZarrStoreMetadata;
  columns: readonly number[];
  firstTimeIndex: number;
  timeCount: number;
  concurrency: number;
  meter: DownloadMeter;
  onChunk?: (done: number, total: number) => void;
}): Promise<(number | null)[][]> {
  const array = input.metadata.streamflow;
  if (array.dtype !== '<i4') throw new Error(`Expected streamflow dtype <i4, got ${array.dtype}.`);
  const [timeChunk, featureChunk] = array.chunks as [number, number];
  const scale = Number(array.attributes.scale_factor ?? 1);
  const offset = Number(array.attributes.add_offset ?? 0);
  const fill = Number(array.fillValue);
  const missing = Number(array.attributes.missing_value ?? fill);

  const lastTimeIndex = input.firstTimeIndex + input.timeCount - 1;
  const timeChunks: number[] = [];
  for (let chunk = Math.floor(input.firstTimeIndex / timeChunk); chunk <= Math.floor(lastTimeIndex / timeChunk); chunk += 1) {
    timeChunks.push(chunk);
  }
  const featureChunks = [...new Set(input.columns.map((column) => Math.floor(column / featureChunk)))];
  const jobs = timeChunks.flatMap((timeChunkIndex) =>
    featureChunks.map((featureChunkIndex) => ({ timeChunkIndex, featureChunkIndex })),
  );

  const values = input.columns.map(() => new Array<number | null>(input.timeCount).fill(null));
  let done = 0;
  await mapWithConcurrency(jobs, input.concurrency, async (job) => {
    const buffer = await readChunk(
      input.storeUrl,
      'streamflow',
      `${job.timeChunkIndex}.${job.featureChunkIndex}`,
      array,
      input.meter,
    );
    const featureStart = job.featureChunkIndex * featureChunk;
    const timeStart = job.timeChunkIndex * timeChunk;
    // Edge chunks are stored full size in Zarr v2, so the row stride is always the chunk width.
    const rowsInChunk = buffer.length / 4 / featureChunk;
    input.columns.forEach((column, columnPosition) => {
      if (Math.floor(column / featureChunk) !== job.featureChunkIndex) return;
      const columnInChunk = column - featureStart;
      for (let row = 0; row < rowsInChunk; row += 1) {
        const timeIndex = timeStart + row;
        const outputIndex = timeIndex - input.firstTimeIndex;
        if (outputIndex < 0 || outputIndex >= input.timeCount) continue;
        const raw = buffer.readInt32LE((row * featureChunk + columnInChunk) * 4);
        const columnValues = values[columnPosition];
        if (!columnValues) continue;
        columnValues[outputIndex] = raw === fill || raw === missing ? null : raw * scale + offset;
      }
    });
    done += 1;
    input.onChunk?.(done, jobs.length);
  });
  return values;
}

/** Number of streamflow chunks one feature column needs across the whole record. */
export function fullRecordChunkCount(metadata: ZarrStoreMetadata): number {
  const [timeLength] = metadata.streamflow.shape as [number];
  const [timeChunk] = metadata.streamflow.chunks as [number];
  return Math.ceil(timeLength / timeChunk);
}
