import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
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
  tncComidOfSegmentId,
  type CrossSectionRecord,
  type CrossSectionsFile,
  type WaterSurfaceElevationTimeSeriesFile,
  type WaterSurfaceElevationTimeSeriesSegment,
} from '../../stage-file-formats.ts';
import { runStage, runStageEntryPoint, type StageResult } from '../../stage-manifest.ts';
import { currentModeledWseVersionDirectory, refuseToOverwriteADifferentModeledWseVersion } from '../../modeled-wse-version.ts';
import { TERRAIN_TILE_INDEX_FILE, readTerrainTileIndex } from '../../terrain-tiles.ts';
import { waterYearOf } from '../../water-years.ts';
import { DRAINAGE_AREA_RATIO_TRANSFER, MAXIMUM_TRANSFER_DISTANCE_M } from '../m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { requestedModeledWseDerivationMethod } from '../modeled-wse-derivation-method-registry.ts';
import { anchorRating } from './anchor-section.ts';
import { bedAt, buildRunChannel, orientRun, segmentRuns, type OrientedSegment } from './flowline-channel.ts';
import { junctionDepthsAlongRun } from './junction-depths.ts';
import { LidarMosaic } from './lidar-mosaic.ts';
import {
  ANCHOR_POSITION_ALONG_SEGMENT,
  ANCHOR_SLOPE,
  CHANNEL_PROFILE,
  DRY_BELOW_DEPTH_M,
  FLOWLINE_PROFILE_TIME_SERIES_FIELDS,
  JUNCTION_DEPTH,
  M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD,
} from './method-config.ts';
import { lookUpRatingCurve } from './rating-curve-lookup.ts';

/**
 * m3 Stage 3 — flowline profile time series. Reads the saved Stage 0–1 output (shared with m1) and writes the m3 Time Series to
 * `03-time-series/m3-flowline-profile-manning-depth/v<version>/`.
 *
 * Per run of joined Creek Segments of a flowline: trace the drainage line on the 1 m lidar, smooth it in plan view, build the bed profile
 * (smoothed, never rising downstream), and cut the anchor cross-section perpendicular to the centerline at the middle of every segment.
 * Per segment: reach discharge × drainage-area ratio (exactly as m1), inverted on the rating curve of the anchor cross-section; the raw anchor
 * depth below 1 cm is dry. The depth at each junction is one smoothed number per shared vertex (`junction-depths.ts`). `values` is the WSE of that
 * smoothed surface at the anchor point: anchor bed (bed profile) + the junction depths interpolated to the middle. See METHOD.md in this folder.
 *
 * Run with `--modeled-wse-method=m3-flowline-profile-manning-depth`: the version helpers in `modeled-wse-version.ts` read that flag to pick
 * the output folder and fingerprint, so this script refuses to run without it rather than write into another method's folder.
 */

const METHOD = M3_FLOWLINE_PROFILE_MANNING_DEPTH_METHOD;
const acquireDirectory = stageDirectory('acquire');
const crossSectionsDirectory = stageDirectory('crossSections');
const outputDirectory = currentModeledWseVersionDirectory();
/** The steep reach this method was built for; its numbers go into the summary. */
const STEEP_EXAMPLE_SEGMENT_ID = '27714697-045';

type OutcomeCounts = Record<InversionOutcome, number>;

function emptyOutcomeCounts(): OutcomeCounts {
  return { bed: 0, interpolated: 0, clamped: 0, missing: 0 };
}

/** What the Time Series files carry for one Creek Segment of m3. */
interface FlowlineProfileTimeSeriesSegment extends WaterSurfaceElevationTimeSeriesSegment {
  /** Bed profile elevation at the anchor point, m NAVD88. Depth at the anchor = value − anchorBedElevationM. */
  anchorBedElevationM: number;
  /** True water depth at the upstream and downstream end of the segment's ribbon, m, parallel to `values`. */
  junctionDepthUpstreamM: (number | null)[];
  junctionDepthDownstreamM: (number | null)[];
  junctionBedUpstreamM: number;
  junctionBedDownstreamM: number;
}

/** Everything one Creek Segment needs to turn discharge into its fields. */
interface SegmentModel {
  segmentId: string;
  /** Index in the network (vertex) order of its flowline, so a file lists segments in the order the other methods do. */
  networkIndex: number;
  crosswalk: CrosswalkSegment | undefined;
  /** Null when the segment has no channel or no rating curve: its values are null. */
  rating: ReturnType<typeof anchorRating> | null;
  hasDischarge: boolean;
  /** Centerline arc length of the segment's ribbon, meters. */
  lengthM: number;
  anchorBedElevationM: number;
  bedUpstreamM: number;
  bedDownstreamM: number;
}

/** One run of joined segments in flow order. */
interface RunModel {
  models: SegmentModel[];
}

interface FlowlineModel {
  tncComid: string;
  runs: RunModel[];
}

/** WSE − bed, never below 0; under `DRY_BELOW_DEPTH_M` the segment is dry. */
function wetDepth(wseM: number, bedM: number): number {
  const depthM = Math.max(0, wseM - bedM);
  return depthM < DRY_BELOW_DEPTH_M ? 0 : depthM;
}

/** Raw anchor depth per timestamp: null where the value is null or the segment has no discharge or rating. */
function rawAnchorDepths(input: {
  model: SegmentModel;
  dischargeByComid: ReadonlyMap<number, readonly (number | null)[]>;
  firstIndex: number;
  endIndex: number;
  outcomes: OutcomeCounts;
  clampedBySegment: Map<string, number>;
}): (number | null)[] {
  const { model } = input;
  const length = input.endIndex - input.firstIndex;
  const depths = new Array<number | null>(length).fill(null);
  const curve = model.rating?.curve;
  const comid = model.crosswalk?.nhdplusV2Comid ?? null;
  const reachDischarge = comid === null ? undefined : input.dischargeByComid.get(comid);
  if (!model.hasDischarge || !curve || !reachDischarge || !model.rating) {
    input.outcomes.missing += length;
    return depths;
  }
  const ratio = model.crosswalk?.drainageAreaRatio ?? 1;
  for (let offset = 0; offset < length; offset += 1) {
    const reachValue = reachDischarge[input.firstIndex + offset] ?? null;
    const dischargeM3s = reachValue === null ? null : reachValue * ratio;
    const { wseM, outcome } = lookUpRatingCurve(curve, dischargeM3s);
    input.outcomes[outcome] += 1;
    if (outcome === 'clamped') input.clampedBySegment.set(model.segmentId, (input.clampedBySegment.get(model.segmentId) ?? 0) + 1);
    if (wseM === null) continue;
    // Depths are measured from the lowest ground at the anchor cross-section, the bed the rating curve starts at.
    depths[offset] = roundValue(wetDepth(roundValue(wseM, 3), model.rating.thalwegBedM), 3);
  }
  return depths;
}

/**
 * The Time Series records of every segment of one flowline over one timestamp range. A flowline is solved and written on its own: junctions
 * never cross flowlines.
 */
function buildFlowlineSegments(input: {
  flowline: FlowlineModel;
  dischargeByComid: ReadonlyMap<number, readonly (number | null)[]>;
  firstIndex: number;
  endIndex: number;
  outcomes: OutcomeCounts;
  clampedBySegment: Map<string, number>;
}): FlowlineProfileTimeSeriesSegment[] {
  const length = input.endIndex - input.firstIndex;
  const records: { networkIndex: number; record: FlowlineProfileTimeSeriesSegment }[] = [];
  for (const run of input.flowline.runs) {
    const rawDepths = run.models.map((model) => rawAnchorDepths({ ...input, model }));
    const lengthsM = run.models.map((model) => model.lengthM);
    const junctionUpstream = run.models.map(() => new Array<number | null>(length).fill(null));
    const junctionDownstream = run.models.map(() => new Array<number | null>(length).fill(null));
    for (let offset = 0; offset < length; offset += 1) {
      const { upstreamM, downstreamM } = junctionDepthsAlongRun(rawDepths.map((series) => series[offset] ?? null), lengthsM);
      run.models.forEach((_model, position) => {
        const up = upstreamM[position] ?? null;
        const down = downstreamM[position] ?? null;
        (junctionUpstream[position] as (number | null)[])[offset] = up === null ? null : roundValue(up, 3);
        (junctionDownstream[position] as (number | null)[])[offset] = down === null ? null : roundValue(down, 3);
      });
    }
    run.models.forEach((model, position) => {
      const upstreamDepths = junctionUpstream[position] as (number | null)[];
      const downstreamDepths = junctionDownstream[position] as (number | null)[];
      // The segment's WSE is the smoothed surface at the anchor point, from the junction depths as written to the file.
      const values = upstreamDepths.map((up, offset) => {
        const down = downstreamDepths[offset];
        return up === null || down === null || down === undefined
          ? null
          : roundValue(model.anchorBedElevationM + up + (down - up) * ANCHOR_POSITION_ALONG_SEGMENT, 3);
      });
      const record: FlowlineProfileTimeSeriesSegment = {
        segmentId: model.segmentId,
        values,
        anchorBedElevationM: roundValue(model.anchorBedElevationM, 3),
        junctionDepthUpstreamM: upstreamDepths,
        junctionDepthDownstreamM: downstreamDepths,
        junctionBedUpstreamM: roundValue(model.bedUpstreamM, 3),
        junctionBedDownstreamM: roundValue(model.bedDownstreamM, 3),
      };
      // The flag is written only when true, as in m1, to keep the browser-facing files small.
      if (model.crosswalk?.[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]) record[DRAINAGE_AREA_RATIO_TRANSFER.fieldName] = true;
      records.push({ networkIndex: model.networkIndex, record });
    });
  }
  return records.sort((a, b) => a.networkIndex - b.networkIndex).map((entry) => entry.record);
}

async function writeFlowlineFile(input: {
  datasetId: string;
  timestampsUtcMs: number[];
  segments: FlowlineProfileTimeSeriesSegment[];
  relativeFileName: string;
}): Promise<string> {
  const filePath = path.join(outputDirectory, TIME_SERIES_DIRECTORY_NAME, input.datasetId, WATER_SURFACE_ELEVATION_VARIABLE_ID, input.relativeFileName);
  const file: WaterSurfaceElevationTimeSeriesFile = {
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

interface ModelBuild {
  flowlines: FlowlineModel[];
  segmentCount: number;
  slopeFlooredSegments: number;
  segmentsWithoutRating: number;
  /** Stations whose valley-bottom fit ended at the search edge. */
  stationsAtSearchEdge: number;
  /** Mean sideways move of the centerline from the smoothed flowline over every station, m. */
  meanOffsetFromFlowlineM: number;
  /** Largest |bed profile − local lowest ground| along any channel, m. */
  maximumBedProfileDeviationM: number;
  /** Mean |bed profile − local lowest ground| over every station of every channel, m. */
  meanBedProfileDeviationM: number;
}

/** Builds the channel of every run of every flowline and the anchor rating of every segment. */
async function buildModels(warnings: string[]): Promise<ModelBuild> {
  const network = await loadCreekSegmentNetwork();
  const crossSections = (await readJson(path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE))) as CrossSectionsFile;
  const crosswalk = await readNhdplusV2Crosswalk(NHDPLUSV2_CROSSWALK_PATH);
  const crosswalkById = new Map(crosswalk.segments.map((segment) => [segment.segmentId, segment]));
  const recordById: ReadonlyMap<string, CrossSectionRecord> = new Map(crossSections.segments.map((record) => [record.segmentId, record]));
  const directionByTncComid = downstreamVertexDirectionByTncComid(crossSections);
  const adjacentById = adjacentSegmentsById(network);
  const networkIndexById = new Map(network.map((segment, index) => [segment.segmentId, index]));
  const segmentsByComid = new Map<string, NetworkCreekSegment[]>();
  for (const segment of network) {
    const comid = tncComidOfSegmentId(segment.segmentId);
    segmentsByComid.set(comid, [...(segmentsByComid.get(comid) ?? []), segment]);
  }
  console.log('  Indexing USGS 3DEP terrain tiles for channel tracing…');
  const mosaic = LidarMosaic.fromTerrainFiles(acquireDirectory, readTerrainTileIndex(await readJson(path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE))));

  const build: ModelBuild = {
    flowlines: [],
    segmentCount: 0,
    slopeFlooredSegments: 0,
    segmentsWithoutRating: 0,
    stationsAtSearchEdge: 0,
    meanOffsetFromFlowlineM: 0,
    maximumBedProfileDeviationM: 0,
    meanBedProfileDeviationM: 0,
  };
  let deviationSumM = 0;
  let offsetSumM = 0;
  let stationCount = 0;
  for (const [tncComid, flowlineSegments] of segmentsByComid) {
    const flowline: FlowlineModel = { tncComid, runs: [] };
    for (const run of segmentRuns(flowlineSegments, adjacentById)) {
      const oriented = orientRun(run, recordById, directionByTncComid.get(tncComid) ?? 1);
      const points = oriented.flatMap((segment: OrientedSegment) => [segment.upstreamVertex, segment.downstreamVertex]);
      // The window reaches past the flowline by the valley-bottom search and the cross-section half-width, so every sample is inside it.
      const margin = CHANNEL_PROFILE.valleyBottomFit.searchHalfWidthM + CHANNEL_PROFILE.crossSection.halfWidthM + 10;
      const window = await mosaic.window(
        Math.min(...points.map((point) => point.x)) - margin,
        Math.min(...points.map((point) => point.y)) - margin,
        Math.max(...points.map((point) => point.x)) + margin,
        Math.max(...points.map((point) => point.y)) + margin,
      );
      const channel = buildRunChannel(oriented, window);
      build.stationsAtSearchEdge += channel.stationsAtSearchEdge;
      offsetSumM += channel.meanOffsetFromFlowlineM * channel.stationCount;
      for (let station = 0; station < channel.stationCount; station += 1) {
        const deviation = Math.abs((channel.bedM[station] as number) - (channel.thalwegM[station] as number));
        deviationSumM += deviation;
        build.maximumBedProfileDeviationM = Math.max(build.maximumBedProfileDeviationM, deviation);
      }
      stationCount += channel.stationCount;
      const models = oriented.map((segment, position): SegmentModel => {
        const segmentCrosswalk = crosswalkById.get(segment.segmentId);
        if (!segmentCrosswalk) warnings.push(`${segment.segmentId} has no crosswalk entry, values are null.`);
        else if (segmentCrosswalk.nhdplusV2Comid === null) warnings.push(`${segment.segmentId} unmapped: no NHDPlusV2 reach, values are null.`);
        if (segmentCrosswalk && exceedsMaximumTransferDistance(segmentCrosswalk)) {
          warnings.push(
            `${segment.segmentId} ${DRAINAGE_AREA_RATIO_TRANSFER.label}: borrowed NHDPlusV2 COMID ${String(segmentCrosswalk.nhdplusV2Comid)} is ` +
              `${String(segmentCrosswalk.transferDistanceM)} m away, more than ${MAXIMUM_TRANSFER_DISTANCE_M} m; no discharge, values are null.`,
          );
        }
        const first = channel.boundaries[position] as number;
        const last = channel.boundaries[position + 1] as number;
        const anchorIndex = first + (last - first) * ANCHOR_POSITION_ALONG_SEGMENT;
        const rating = last > first ? anchorRating(channel, segment.segmentId, anchorIndex) : null;
        if (!rating) warnings.push(`${segment.segmentId} has no ribbon (its boundaries coincide), values are null.`);
        else {
          if (rating.slopeFloored) build.slopeFlooredSegments += 1;
          if (!rating.curve) {
            build.segmentsWithoutRating += 1;
            warnings.push(`${segment.segmentId} ${rating.problem ?? 'has no rating curve'}; values are null.`);
          }
        }
        return {
          segmentId: segment.segmentId,
          networkIndex: networkIndexById.get(segment.segmentId) as number,
          crosswalk: segmentCrosswalk,
          rating,
          hasDischarge: segmentCrosswalk !== undefined && segmentCrosswalk.nhdplusV2Comid !== null && !exceedsMaximumTransferDistance(segmentCrosswalk),
          lengthM: (last - first) * channel.spacingM,
          anchorBedElevationM: bedAt(channel, anchorIndex),
          bedUpstreamM: bedAt(channel, first),
          bedDownstreamM: bedAt(channel, last),
        };
      });
      build.segmentCount += models.length;
      flowline.runs.push({ models });
    }
    build.flowlines.push(flowline);
    if (build.flowlines.length % 20 === 0 || build.flowlines.length === segmentsByComid.size) {
      console.log(`  Channels and anchor rating curves: ${build.flowlines.length} of ${segmentsByComid.size} flowlines, ${build.segmentCount} Creek Segments`);
    }
  }
  build.meanBedProfileDeviationM = stationCount === 0 ? 0 : deviationSumM / stationCount;
  build.meanOffsetFromFlowlineM = stationCount === 0 ? 0 : offsetSumM / stationCount;
  return build;
}

async function buildTimeSeries(): Promise<StageResult> {
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const summaryLines: string[] = [];
  const outputFiles: string[] = [];
  const build = await buildModels(warnings);
  counts.creekSegments = build.segmentCount;
  counts.flowlines = build.flowlines.length;
  counts.slopeFlooredAnchorSections = build.slopeFlooredSegments;
  counts.anchorSectionsWithoutRatingCurve = build.segmentsWithoutRating;
  counts.centerlineStationsAtSearchEdge = build.stationsAtSearchEdge;
  const allModels = build.flowlines.flatMap((flowline) => flowline.runs.flatMap((run) => run.models));
  counts.drainageAreaRatioTransferSegments = allModels.filter((model) => model.crosswalk?.[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]).length;
  counts.transferDistanceExceededSegments = allModels.filter((model) => model.crosswalk && exceedsMaximumTransferDistance(model.crosswalk)).length;

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
      for (const flowline of build.flowlines) {
        const segments = buildFlowlineSegments({
          flowline,
          dischargeByComid,
          firstIndex: range.firstIndex,
          endIndex: range.endIndex,
          outcomes,
          clampedBySegment,
        });
        const relativeFileName = dataset.hourly ? path.join(flowline.tncComid, `WY${range.waterYear}.json`) : `${flowline.tncComid}.json`;
        outputFiles.push(await writeFlowlineFile({ datasetId: dataset.datasetId, timestampsUtcMs, segments, relativeFileName }));
        const exampleSegment = segments.find((segment) => segment.segmentId === STEEP_EXAMPLE_SEGMENT_ID);
        if (exampleSegment && dataset.hourly) {
          const depths = [...exampleSegment.junctionDepthUpstreamM, ...exampleSegment.junctionDepthDownstreamM].filter((value): value is number => value !== null);
          const previous = (example[dataset.datasetId] as { maxJunctionDepthM: number } | undefined)?.maxJunctionDepthM ?? 0;
          example[dataset.datasetId] = {
            anchorBedElevationM: exampleSegment.anchorBedElevationM,
            junctionBedUpstreamM: exampleSegment.junctionBedUpstreamM,
            junctionBedDownstreamM: exampleSegment.junctionBedDownstreamM,
            maxJunctionDepthM: Math.max(previous, ...depths),
          };
        }
      }
      if (dataset.hourly) console.log(`  ${dataset.datasetId} WY${range.waterYear}: ${build.flowlines.length} flowline files written`);
    }
    counts[`${dataset.datasetId}Timestamps`] = discharge.timestampsUtcMs.length;
    counts[`${dataset.datasetId}ClampedValues`] = outcomes.clamped;
    for (const [segmentId, clamped] of clampedBySegment) {
      warnings.push(`${segmentId} ${dataset.datasetId}: ${clamped} anchor values above the rating curve clamped.`);
    }
    summaryLines.push(`${dataset.datasetId}: ${discharge.timestampsUtcMs.length} timestamps in ${ranges.length} file set(s); ${describeOutcomes(outcomes)}.`);
  }
  summaryLines.push(
    `${build.segmentCount} Creek Segments on ${build.flowlines.length} flowlines, one anchor cross-section each, cut perpendicular to the smoothed centerline at ${ANCHOR_POSITION_ALONG_SEGMENT} of the ribbon; ` +
      `local slope of the bed profile ±${ANCHOR_SLOPE.halfWindowM} m, ${build.slopeFlooredSegments} slopes floored, ${build.segmentsWithoutRating} anchors without a rating curve, centerline moved a mean ${build.meanOffsetFromFlowlineM.toFixed(1)} m sideways from the smoothed flowline, ${build.stationsAtSearchEdge} stations at the search edge; ` +
      `bed profile vs the lowest ground along the centerline: mean ${build.meanBedProfileDeviationM.toFixed(3)} m, max ${build.maximumBedProfileDeviationM.toFixed(2)} m; ` +
      `junction depth: mean of raw anchor depths within ±${JUNCTION_DEPTH.smoothingHalfWindowM} m (raw depth under ${DRY_BELOW_DEPTH_M} m is dry); values = WSE of the smoothed surface at the anchor point.`,
    `${STEEP_EXAMPLE_SEGMENT_ID}: ${JSON.stringify(example[NATIONAL_WATER_MODEL.datasetId] ?? null)}`,
  );
  return {
    outputFiles,
    counts,
    warnings,
    measurements: {
      centerlineMeanOffsetFromFlowlineM: build.meanOffsetFromFlowlineM,
      steepExampleSegment: { segmentId: STEEP_EXAMPLE_SEGMENT_ID, ...example },
      bedProfileDeviationFromLowestGroundM: { mean: build.meanBedProfileDeviationM, max: build.maximumBedProfileDeviationM },
    },
    summaryLines,
  };
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
      segmentFields: FLOWLINE_PROFILE_TIME_SERIES_FIELDS,
      decimals: 3,
      dischargeScaling: 'segment Q = reach Q × drainageAreaRatio from the crosswalk (USGS drainage-area ratio method, ratio capped at 1), as m1',
      drainageAreaRatioTransfer: {
        ...DRAINAGE_AREA_RATIO_TRANSFER,
        maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M,
        fileLayout: `segments[].${DRAINAGE_AREA_RATIO_TRANSFER.fieldName}: true only on transfer segments; beyond the maximum distance every value is null`,
      },
      inversion: 'first ladder crossing, linear interpolation (binary search, same result as m1); Q ≤ 0 → bed; missing → null; above curve → clamp',
      dryRule: `a raw anchor depth under ${DRY_BELOW_DEPTH_M} m is 0 (dry)`,
      junctionDepth: {
        ...JUNCTION_DEPTH,
        rule: 'one depth per shared vertex: length-weighted mean of the wet raw anchor depths within the half-window; own raw anchor depth at a flowline end or next to a dry or null segment',
      },
      anchorWse: {
        anchorPositionAlongSegment: ANCHOR_POSITION_ALONG_SEGMENT,
        rule: 'values = anchorBedElevationM + (junction depth at the upstream end + (junction depth at the downstream end − upstream) × anchorPositionAlongSegment), rounded to 3 decimals; a dry segment has depth 0 and values = anchor bed',
      },
    },
    run: buildTimeSeries,
  });
});
