import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { AdjacentCreekSegments } from '../../../creek-segment-adjacency.ts';
import { readJson, writeCompactJson } from '../../../json-files.ts';
import { adjacentSegmentsById, loadCreekSegmentNetwork, type NetworkCreekSegment } from '../../creek-segment-network.ts';
import {
  CNF_DISCHARGE_FILE,
  NWM_DISCHARGE_FILE,
  exceedsMaximumTransferDistance,
  readNhdplusV2Crosswalk,
  readNormalizedDischarge,
  roundValue,
  type CrosswalkSegment,
  type NormalizedDischargeFile,
} from '../../discharge-records.ts';
import {
  CALIFORNIA_NATURAL_FLOWS,
  MODELED_EXTENT,
  NATIONAL_WATER_MODEL,
  NHDPLUSV2_CROSSWALK_PATH,
  WATER_SURFACE_ELEVATION_VARIABLE_ID,
  stageDirectory,
} from '../../pipeline-configuration.ts';
import type { InversionOutcome } from '../../rating-curve-inversion.ts';
import {
  CROSS_SECTIONS_FILE,
  TIME_SERIES_DIRECTORY_NAME,
  downstreamVertexDirectionByTncComid,
  groupByTncComid,
  tncComidOfSegmentId,
  type CrossSectionsFile,
  type DownstreamVertexDirection,
} from '../../stage-file-formats.ts';
import { runStage, runStageEntryPoint, type StageResult } from '../../stage-manifest.ts';
import { currentModeledWseVersionDirectory, refuseToOverwriteADifferentModeledWseVersion } from '../../modeled-wse-version.ts';
import { TERRAIN_TILE_INDEX_FILE, TerrainSampler, readTerrainTileIndex } from '../../terrain-tiles.ts';
import { waterYearOf } from '../../water-years.ts';
import { DRAINAGE_AREA_RATIO_TRANSFER, MAXIMUM_TRANSFER_DISTANCE_M } from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { requestedModeledWseDerivationMethod } from '../modeled-wse-derivation-method-registry.ts';
import { junctionDepthsAlongRun, segmentRuns, smoothedDepthAtAnchor } from './junction-depths.ts';
import {
  ANCHOR_POSITION_ALONG_SEGMENT,
  JUNCTION_BED_SECTIONS,
  JUNCTION_DEPTH,
  LOCAL_BED_SLOPE,
  M2_MULTI_SECTION_MANNING_DEPTH_METHOD,
  MULTI_SECTION_TIME_SERIES_FIELDS,
  SOLVED_SECTIONS,
} from './method-config.ts';
import type { MultiSectionTimeSeriesFile, MultiSectionTimeSeriesSegment } from './multi-section-time-series-file.ts';
import { lookUpRatingCurve } from './rating-curve-lookup.ts';
import { solveSegmentSections, type BedProfilePoint, type SegmentSolvedSections } from './section-rating-curves.ts';

/**
 * m2 Stage 3 — multi-section time series. Reads the saved Stage 0–1 output (shared with m1) and writes
 * the m2 Time Series to `03-time-series/m2-multi-section-manning-depth/v<version>/`.
 *
 * Per Creek Segment: the reach discharge × drainage-area ratio (exactly as m1), inverted on the rating
 * curve at the anchor (mid-segment) Stage 1 section, with its own bed and a local bed slope. That raw
 * Manning anchor WSE is kept as `rawAnchorWseM`. The depth at each vertex is a smoothed mean of the
 * neighbouring segments' raw anchor depths (`junction-depths.ts`), one number per shared vertex. From
 * m2-v3 `values` is the WSE of that smoothed surface at the anchor point: anchor bed + the junction
 * depths interpolated to the anchor position, so the chart shows the water the browser draws. See METHOD.md in this folder.
 *
 * Run with `--modeled-wse-method=m2-multi-section-manning-depth`: the version helpers in
 * `modeled-wse-version.ts` read that flag to pick the output folder and fingerprint, so this script
 * refuses to run without it rather than write into m1's folder.
 */

const METHOD = M2_MULTI_SECTION_MANNING_DEPTH_METHOD;
const acquireDirectory = stageDirectory('acquire');
const crossSectionsDirectory = stageDirectory('crossSections');
const outputDirectory = currentModeledWseVersionDirectory();
/** The segment from the slide this method was built for; its numbers go into the summary. */
const STEEP_EXAMPLE_SEGMENT_ID = '27714697-045';

type OutcomeCounts = Record<InversionOutcome, number>;

function emptyOutcomeCounts(): OutcomeCounts {
  return { bed: 0, interpolated: 0, clamped: 0, missing: 0 };
}

/** Everything one Creek Segment needs to turn discharge into its m2 fields. */
interface SegmentModel {
  segment: NetworkCreekSegment;
  crosswalk: CrosswalkSegment | undefined;
  sections: SegmentSolvedSections | undefined;
  direction: DownstreamVertexDirection;
  /** False when the segment gets no discharge (unmapped, or a transfer beyond the maximum distance). */
  hasDischarge: boolean;
}

/** The raw Manning anchor WSE as written to the file, and the raw anchor depth it implies, parallel over the timestamps. */
interface SegmentRawAnchors {
  /** Written as `rawAnchorWseM`. */
  rawAnchorWseM: (number | null)[];
  /** Raw depth at the anchor: null where the WSE is null, 0 where the segment is dry. Feeds the junction depths. */
  rawAnchorDepthM: (number | null)[];
}

/** WSE − bed, never below 0 (a ladder step rounded to the millimetre can sit a hair under the bed). */
function depthAbove(wseM: number, bedM: number): number {
  return Math.max(0, wseM - bedM);
}

function invertSegment(input: {
  model: SegmentModel;
  dischargeByComid: ReadonlyMap<number, readonly (number | null)[]>;
  firstIndex: number;
  endIndex: number;
  outcomes: OutcomeCounts;
  clampedBySegment: Map<string, number>;
}): SegmentRawAnchors {
  const { model } = input;
  const length = input.endIndex - input.firstIndex;
  const result: SegmentRawAnchors = {
    rawAnchorWseM: new Array<number | null>(length).fill(null),
    rawAnchorDepthM: new Array<number | null>(length).fill(null),
  };
  const anchor = model.sections?.anchor;
  const comid = model.crosswalk?.nhdplusV2Comid ?? null;
  const reachDischarge = comid === null ? undefined : input.dischargeByComid.get(comid);
  if (!model.hasDischarge || !anchor?.curve || !reachDischarge || !model.sections) {
    input.outcomes.missing += length;
    return result;
  }
  const ratio = model.crosswalk?.drainageAreaRatio ?? 1;
  for (let offset = 0; offset < length; offset += 1) {
    const reachValue = reachDischarge[input.firstIndex + offset] ?? null;
    const dischargeM3s = reachValue === null ? null : reachValue * ratio;
    const { wseM, outcome } = lookUpRatingCurve(anchor.curve, dischargeM3s);
    input.outcomes[outcome] += 1;
    if (outcome === 'clamped') input.clampedBySegment.set(model.segment.segmentId, (input.clampedBySegment.get(model.segment.segmentId) ?? 0) + 1);
    if (wseM === null) continue;
    // Dry or wet is decided on the raw WSE as written to the file, so a reader can rebuild every junction depth from `rawAnchorWseM`.
    result.rawAnchorWseM[offset] = roundValue(wseM, 3);
    result.rawAnchorDepthM[offset] = depthAbove(result.rawAnchorWseM[offset] as number, anchor.bedElevationM);
  }
  return result;
}

/** Mean of two numbers at a shared vertex; the own number where the neighbour has none. */
function sharedAtVertex(own: number, neighbour: number | null | undefined): number {
  return neighbour === null || neighbour === undefined ? own : (own + neighbour) / 2;
}

/** Bed at each vertex: the mean of the two end-section beds that meet there, or the own end-section bed at a flowline end. */
function vertexBeds(
  model: SegmentModel,
  modelsById: ReadonlyMap<string, SegmentModel>,
  adjacent: AdjacentCreekSegments,
): { atStartM: number; atEndM: number } {
  const own = model.sections as SegmentSolvedSections;
  const previous = adjacent.atStart ? modelsById.get(adjacent.atStart.segmentId)?.sections : undefined;
  const next = adjacent.atEnd ? modelsById.get(adjacent.atEnd.segmentId)?.sections : undefined;
  return {
    atStartM: sharedAtVertex(own.startEndBedElevationM, previous?.endEndBedElevationM),
    atEndM: sharedAtVertex(own.endEndBedElevationM, next?.startEndBedElevationM),
  };
}

/** Depth at each segment's start and end vertex over the timestamp range, rounded as written to the file; null where the value is null. */
interface JunctionDepths {
  junctionDepthAtStart: (number | null)[];
  junctionDepthAtEnd: (number | null)[];
}

/** The junction depths of every segment of one flowline, smoothed from the raw anchor depths: each run of joined segments is smoothed one timestamp at a time. */
function junctionDepthsOfFlowline(
  models: readonly SegmentModel[],
  adjacentById: ReturnType<typeof adjacentSegmentsById>,
  anchorsById: ReadonlyMap<string, SegmentRawAnchors>,
  timestampCount: number,
): Map<string, JunctionDepths> {
  const depthsById = new Map<string, JunctionDepths>();
  for (const run of segmentRuns(models.map((model) => model.segment), adjacentById)) {
    const lengthsM = run.map((segment) => segment.preciseLengthM);
    const rawAnchorDepthSeries = run.map((segment) => (anchorsById.get(segment.segmentId) as SegmentRawAnchors).rawAnchorDepthM);
    const junctionDepths = run.map((): JunctionDepths => ({
      junctionDepthAtStart: new Array<number | null>(timestampCount).fill(null),
      junctionDepthAtEnd: new Array<number | null>(timestampCount).fill(null),
    }));
    for (let offset = 0; offset < timestampCount; offset += 1) {
      const { atStartM, atEndM } = junctionDepthsAlongRun(
        rawAnchorDepthSeries.map((series) => series[offset] ?? null),
        lengthsM,
      );
      junctionDepths.forEach((depths, position) => {
        const atStart = atStartM[position] ?? null;
        const atEnd = atEndM[position] ?? null;
        depths.junctionDepthAtStart[offset] = atStart === null ? null : roundValue(atStart, 3);
        depths.junctionDepthAtEnd[offset] = atEnd === null ? null : roundValue(atEnd, 3);
      });
    }
    run.forEach((segment, position) => depthsById.set(segment.segmentId, junctionDepths[position] as JunctionDepths));
  }
  return depthsById;
}

/**
 * Builds every Creek Segment of one TNC flowline over one timestamp index range. Junctions never
 * cross flowlines (`adjacentSegmentsById` pairs only segments of the same flowline), so a flowline
 * can be solved and written on its own.
 */
function buildFlowlineSegments(input: {
  models: readonly SegmentModel[];
  modelsById: ReadonlyMap<string, SegmentModel>;
  adjacentById: ReturnType<typeof adjacentSegmentsById>;
  dischargeByComid: ReadonlyMap<number, readonly (number | null)[]>;
  firstIndex: number;
  endIndex: number;
  outcomes: OutcomeCounts;
  clampedBySegment: Map<string, number>;
}): MultiSectionTimeSeriesSegment[] {
  const anchorsById = new Map<string, SegmentRawAnchors>();
  for (const model of input.models) anchorsById.set(model.segment.segmentId, invertSegment({ ...input, model }));
  const junctionDepthsById = junctionDepthsOfFlowline(input.models, input.adjacentById, anchorsById, input.endIndex - input.firstIndex);
  return input.models.map((model) => {
    const { segmentId } = model.segment;
    const rawAnchors = anchorsById.get(segmentId) as SegmentRawAnchors;
    const adjacent = input.adjacentById.get(segmentId) ?? {};
    const { junctionDepthAtStart, junctionDepthAtEnd } = junctionDepthsById.get(segmentId) as JunctionDepths;
    const sections = model.sections;
    const beds = sections ? vertexBeds(model, input.modelsById, adjacent) : null;
    const anchorBedElevationM = sections?.anchor.bedElevationM ?? Number.NaN;
    const bedAtStartM = roundValue(beds?.atStartM ?? anchorBedElevationM, 3);
    const bedAtEndM = roundValue(beds?.atEndM ?? anchorBedElevationM, 3);
    // Vertex order running downstream (+1) puts the upstream vertex at the segment's start.
    const runsDownstream = model.direction === 1;
    const junctionDepthUpstreamM = runsDownstream ? junctionDepthAtStart : junctionDepthAtEnd;
    const junctionDepthDownstreamM = runsDownstream ? junctionDepthAtEnd : junctionDepthAtStart;
    const junctionBedUpstreamM = runsDownstream ? bedAtStartM : bedAtEndM;
    const junctionBedDownstreamM = runsDownstream ? bedAtEndM : bedAtStartM;
    const withBed = (depths: (number | null)[], bedM: number): (number | null)[] =>
      depths.map((depth) => (depth === null ? null : roundValue(bedM + depth, 3)));
    // m2-v3: the segment's WSE is the smoothed surface at the anchor point, from the junction depths as written to the file.
    // Start and end depths are used (not upstream and downstream) because the anchor is half-way, so the order does not matter.
    const values = junctionDepthAtStart.map((depthAtStartM, offset) => {
      const depthAtEndM = junctionDepthAtEnd[offset];
      return depthAtStartM === null || depthAtEndM === null || depthAtEndM === undefined
        ? null
        : roundValue(anchorBedElevationM + smoothedDepthAtAnchor(depthAtStartM, depthAtEndM), 3);
    });
    const record: MultiSectionTimeSeriesSegment = {
      segmentId,
      values,
      rawAnchorWseM: rawAnchors.rawAnchorWseM,
      junctionWseUpstreamM: withBed(junctionDepthUpstreamM, junctionBedUpstreamM),
      junctionWseDownstreamM: withBed(junctionDepthDownstreamM, junctionBedDownstreamM),
      anchorBedElevationM,
      junctionDepthUpstreamM,
      junctionDepthDownstreamM,
      junctionBedUpstreamM,
      junctionBedDownstreamM,
    };
    // The flag is written only when true, as in m1, to keep the browser-facing files small.
    if (model.crosswalk?.[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]) record[DRAINAGE_AREA_RATIO_TRANSFER.fieldName] = true;
    return record;
  });
}

async function writeFlowlineFile(input: {
  datasetId: string;
  timestampsUtcMs: number[];
  segments: MultiSectionTimeSeriesSegment[];
  relativeFileName: string;
}): Promise<string> {
  const filePath = path.join(outputDirectory, TIME_SERIES_DIRECTORY_NAME, input.datasetId, WATER_SURFACE_ELEVATION_VARIABLE_ID, input.relativeFileName);
  const file: MultiSectionTimeSeriesFile = {
    segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
    datasetId: input.datasetId,
    variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID,
    timestampsUtcMs: input.timestampsUtcMs,
    segments: input.segments,
  };
  await writeCompactJson(filePath, file);
  return filePath;
}

function describeOutcomes(outcomes: OutcomeCounts): string {
  return `${outcomes.interpolated} interpolated, ${outcomes.bed} zero-discharge→bed, ${outcomes.clamped} clamped, ${outcomes.missing} missing (anchor section)`;
}

function dischargeByComidOf(discharge: NormalizedDischargeFile): Map<number, (number | null)[]> {
  return new Map(discharge.reaches.map((reach) => [reach.nhdplusV2Comid, reach.values]));
}

/** Index ranges [firstIndex, endIndex) of each water year in an ascending timestamp list. */
function waterYearRanges(timestampsUtcMs: readonly number[]): { waterYear: number; firstIndex: number; endIndex: number }[] {
  const ranges: { waterYear: number; firstIndex: number; endIndex: number }[] = [];
  timestampsUtcMs.forEach((timestamp, index) => {
    const waterYear = waterYearOf(timestamp);
    const last = ranges[ranges.length - 1];
    if (last && last.waterYear === waterYear) last.endIndex = index + 1;
    else ranges.push({ waterYear, firstIndex: index, endIndex: index + 1 });
  });
  return ranges;
}

async function buildModels(warnings: string[]): Promise<{ models: SegmentModel[]; slopeFlooredSections: number; sectionsWithoutCurve: number }> {
  const network = await loadCreekSegmentNetwork();
  const crossSections = (await readJson(path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE))) as CrossSectionsFile;
  const crosswalk = await readNhdplusV2Crosswalk(NHDPLUSV2_CROSSWALK_PATH);
  const crosswalkById = new Map(crosswalk.segments.map((segment) => [segment.segmentId, segment]));
  const recordById = new Map(crossSections.segments.map((record) => [record.segmentId, record]));
  const directionByTncComid = downstreamVertexDirectionByTncComid(crossSections);
  const bedProfileByTncComid = new Map<string, BedProfilePoint[]>();
  for (const record of crossSections.segments) {
    const tncComid = tncComidOfSegmentId(record.segmentId);
    const profile = bedProfileByTncComid.get(tncComid) ?? [];
    for (const section of record.sections) profile.push({ distanceM: section.networkDistanceM, bedM: section.bedElevationM });
    bedProfileByTncComid.set(tncComid, profile);
  }
  console.log('  Loading USGS 3DEP terrain tiles to resample the anchor cross-sections…');
  const terrain = await TerrainSampler.load(acquireDirectory, readTerrainTileIndex(await readJson(path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE))));

  let slopeFlooredSections = 0;
  let sectionsWithoutCurve = 0;
  const models = network.map((segment, index): SegmentModel => {
    const { segmentId } = segment;
    const tncComid = tncComidOfSegmentId(segmentId);
    const direction = directionByTncComid.get(tncComid) ?? 1;
    const segmentCrosswalk = crosswalkById.get(segmentId);
    const record = recordById.get(segmentId);
    if (!segmentCrosswalk) warnings.push(`${segmentId} has no crosswalk entry, values are null.`);
    else if (segmentCrosswalk.nhdplusV2Comid === null) warnings.push(`${segmentId} unmapped: no NHDPlusV2 reach, values are null.`);
    if (segmentCrosswalk && exceedsMaximumTransferDistance(segmentCrosswalk)) {
      warnings.push(
        `${segmentId} ${DRAINAGE_AREA_RATIO_TRANSFER.label}: borrowed NHDPlusV2 COMID ${String(segmentCrosswalk.nhdplusV2Comid)} is ` +
          `${String(segmentCrosswalk.transferDistanceM)} m away, more than ${MAXIMUM_TRANSFER_DISTANCE_M} m; no discharge, values are null.`,
      );
    }
    if (!record) warnings.push(`${segmentId} has no Stage 1 cross-sections, values are null.`);
    const sections = record
      ? solveSegmentSections({ terrain, segment, record, bedProfile: bedProfileByTncComid.get(tncComid) ?? [], direction })
      : undefined;
    if (sections) {
      if (sections.anchor.slopeFloored) slopeFlooredSections += 1;
      if (!sections.anchor.curve) {
        sectionsWithoutCurve += 1;
        warnings.push(`${segmentId} ${sections.anchor.problem ?? `section ${sections.anchor.sectionIndex} has no rating curve`}; values are null.`);
      }
    }
    if ((index + 1) % 500 === 0 || index === network.length - 1) console.log(`  Anchor rating curves: ${index + 1} of ${network.length} Creek Segments`);
    return {
      segment,
      crosswalk: segmentCrosswalk,
      sections,
      direction,
      hasDischarge: segmentCrosswalk !== undefined && segmentCrosswalk.nhdplusV2Comid !== null && !exceedsMaximumTransferDistance(segmentCrosswalk),
    };
  });
  return { models, slopeFlooredSections, sectionsWithoutCurve };
}

async function buildTimeSeries(): Promise<StageResult> {
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const summaryLines: string[] = [];
  const outputFiles: string[] = [];
  const { models, slopeFlooredSections, sectionsWithoutCurve } = await buildModels(warnings);
  counts.creekSegments = models.length;
  counts.solvedSections = models.length;
  counts.slopeFlooredSolvedSections = slopeFlooredSections;
  counts.solvedSectionsWithoutRatingCurve = sectionsWithoutCurve;
  counts.drainageAreaRatioTransferSegments = models.filter((model) => model.crosswalk?.[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]).length;
  counts.transferDistanceExceededSegments = models.filter((model) => model.crosswalk && exceedsMaximumTransferDistance(model.crosswalk)).length;
  const modelsById = new Map(models.map((model) => [model.segment.segmentId, model]));
  const adjacentById = adjacentSegmentsById(models.map((model) => model.segment));
  const modelsByTncComid = groupByTncComid(models.map((model) => ({ ...model, segmentId: model.segment.segmentId })));

  // Same version and fingerprint (the guard in the entry point passed): remove this version's earlier Time Series files.
  await rm(path.join(outputDirectory, TIME_SERIES_DIRECTORY_NAME), { recursive: true, force: true });

  const example: Record<string, unknown> = {};
  const datasets = [
    { datasetId: CALIFORNIA_NATURAL_FLOWS.datasetId, file: CNF_DISCHARGE_FILE, hourly: false },
    { datasetId: NATIONAL_WATER_MODEL.datasetId, file: NWM_DISCHARGE_FILE, hourly: true },
  ];
  for (const dataset of datasets) {
    const discharge = await readNormalizedDischarge(path.join(acquireDirectory, dataset.file));
    const dischargeByComid = dischargeByComidOf(discharge);
    const outcomes = emptyOutcomeCounts();
    const clampedBySegment = new Map<string, number>();
    const ranges = dataset.hourly
      ? waterYearRanges(discharge.timestampsUtcMs)
      : [{ waterYear: 0, firstIndex: 0, endIndex: discharge.timestampsUtcMs.length }];
    for (const range of ranges) {
      const timestampsUtcMs = discharge.timestampsUtcMs.slice(range.firstIndex, range.endIndex);
      for (const [tncComid, flowlineModels] of modelsByTncComid) {
        const segments = buildFlowlineSegments({
          models: flowlineModels,
          modelsById,
          adjacentById,
          dischargeByComid,
          firstIndex: range.firstIndex,
          endIndex: range.endIndex,
          outcomes,
          clampedBySegment,
        });
        const relativeFileName = dataset.hourly ? path.join(tncComid, `WY${range.waterYear}.json`) : `${tncComid}.json`;
        outputFiles.push(await writeFlowlineFile({ datasetId: dataset.datasetId, timestampsUtcMs, segments, relativeFileName }));
        const exampleSegment = segments.find((segment) => segment.segmentId === STEEP_EXAMPLE_SEGMENT_ID);
        if (exampleSegment && dataset.hourly) {
          const values = exampleSegment.values.filter((value): value is number => value !== null);
          const previous = (example[dataset.datasetId] as { maxDepthM: number } | undefined)?.maxDepthM ?? 0;
          example[dataset.datasetId] = {
            anchorBedElevationM: exampleSegment.anchorBedElevationM,
            junctionBedUpstreamM: exampleSegment.junctionBedUpstreamM,
            junctionBedDownstreamM: exampleSegment.junctionBedDownstreamM,
            maxDepthM: Math.max(previous, ...values.map((value) => roundValue(value - exampleSegment.anchorBedElevationM, 3))),
          };
        }
      }
      if (dataset.hourly) console.log(`  ${dataset.datasetId} WY${range.waterYear}: ${modelsByTncComid.size} flowline files written`);
    }
    counts[`${dataset.datasetId}Timestamps`] = discharge.timestampsUtcMs.length;
    counts[`${dataset.datasetId}ClampedValues`] = outcomes.clamped;
    for (const [segmentId, clamped] of clampedBySegment) {
      warnings.push(`${segmentId} ${dataset.datasetId}: ${clamped} anchor values above the rating curve clamped.`);
    }
    summaryLines.push(`${dataset.datasetId}: ${discharge.timestampsUtcMs.length} timestamps in ${ranges.length} file set(s); ${describeOutcomes(outcomes)}.`);
  }
  summaryLines.push(
    `${models.length} Creek Segments × 1 solved anchor section (index ${SOLVED_SECTIONS.anchorSectionIndex}); junction beds from sections ${JUNCTION_BED_SECTIONS.startEndSectionIndex} and ${JUNCTION_BED_SECTIONS.endEndSectionIndex}; ` +
      `local slope ±${LOCAL_BED_SLOPE.halfWindowM} m, ${slopeFlooredSections} section slopes floored, ${sectionsWithoutCurve} sections without a rating curve; ` +
      `junction depth: mean of raw anchor depths within ±${JUNCTION_DEPTH.smoothingHalfWindowM} m; values = WSE of the smoothed surface at the anchor point (${ANCHOR_POSITION_ALONG_SEGMENT} along the segment), raw Manning anchor WSE in rawAnchorWseM.`,
    `${STEEP_EXAMPLE_SEGMENT_ID}: ${JSON.stringify(example[NATIONAL_WATER_MODEL.datasetId] ?? null)}`,
  );
  return { outputFiles, counts, warnings, measurements: { steepExampleSegment: { segmentId: STEEP_EXAMPLE_SEGMENT_ID, ...example } }, summaryLines };
}

await runStageEntryPoint(async () => {
  const requested = requestedModeledWseDerivationMethod(process.argv);
  if (requested.id !== METHOD.id) {
    throw new Error(
      `[03-time-series ${METHOD.id}] Run with --modeled-wse-method=${METHOD.id}; the version helpers read that flag to pick ` +
        `the output folder, and without it this script would write into ${requested.id}'s folder.`,
    );
  }
  const version = await refuseToOverwriteADifferentModeledWseVersion('03-time-series');
  const terrainTileIndexPath = path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE);
  await runStage({
    stage: '03-time-series',
    outputDirectory,
    inputFiles: [
      MODELED_EXTENT.flowlineSnapshotPath,
      path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE),
      NHDPLUSV2_CROSSWALK_PATH,
      path.join(acquireDirectory, CNF_DISCHARGE_FILE),
      path.join(acquireDirectory, NWM_DISCHARGE_FILE),
      terrainTileIndexPath,
      ...readTerrainTileIndex(await readJson(terrainTileIndexPath)).tiles.map((tile) => path.join(acquireDirectory, tile.file)),
    ],
    parameters: {
      modeledWseDerivationMethod: version.method,
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID,
      fileLayout: 'one compact JSON file per TNC flowline: <datasetId>/<variableId>/<tncComid>.json, hourly <tncComid>/WY<year>.json',
      segmentFields: MULTI_SECTION_TIME_SERIES_FIELDS,
      decimals: 3,
      dischargeScaling: 'segment Q = reach Q × drainageAreaRatio from the crosswalk (USGS drainage-area ratio method, ratio capped at 1), as m1',
      drainageAreaRatioTransfer: {
        ...DRAINAGE_AREA_RATIO_TRANSFER,
        maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M,
        fileLayout: `segments[].${DRAINAGE_AREA_RATIO_TRANSFER.fieldName}: true only on transfer segments; beyond the maximum distance every value is null`,
      },
      inversion: 'first ladder crossing, linear interpolation (binary search, same result as m1); Q ≤ 0 → bed; missing → null; above curve → clamp',
      junctionDepth: {
        ...JUNCTION_DEPTH,
        rule: 'one depth per shared vertex: length-weighted mean of the wet RAW anchor depths within the half-window; own raw anchor depth at a flowline end or next to a dry or null segment',
      },
      anchorWse: {
        anchorPositionAlongSegment: ANCHOR_POSITION_ALONG_SEGMENT,
        rule: 'values = anchorBedElevationM + (junction depth at the start vertex + (junction depth at the end vertex − start) × anchorPositionAlongSegment), rounded to 3 decimals; a dry segment (raw anchor depth 0) has depth 0 and values = anchor bed',
        rawAnchorWseM: 'the raw Manning normal-depth WSE at the anchor section, kept for diagnosis',
      },
    },
    run: buildTimeSeries,
  });
});
