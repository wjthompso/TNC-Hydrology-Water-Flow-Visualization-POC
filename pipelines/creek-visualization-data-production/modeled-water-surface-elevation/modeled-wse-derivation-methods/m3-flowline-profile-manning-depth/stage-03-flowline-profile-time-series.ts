import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { readJson, writeCompactJson } from '../../../json-files.ts';
import { roundToDecimals, utm10nToWgs84 } from '../../../utm-geometry.ts';
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
import { buildRunChannel, isBreachedStation, orientRun, segmentRuns, thalwegPoint, waterSurfaceStations, type OrientedSegment } from './flowline-channel.ts';
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
  POOL_FILLED_WATER_SURFACE,
} from './method-config.ts';
import { poolFilledRunSurfaces } from './pool-filled-water-surface.ts';
import { lookUpRatingCurve } from './rating-curve-lookup.ts';

/**
 * m3 Stage 3 — flowline profile time series. Reads the saved Stage 0–1 output (shared with m1) and writes the m3 Time Series to
 * `03-time-series/m3-flowline-profile-manning-depth/v<version>/`.
 *
 * Per run of joined Creek Segments of a flowline: fit the valley-bottom centerline on the 1 m lidar, take the raw lidar at the lowest point
 * across every station as the bed (breached through tall, short barriers), and cut the anchor cross-section through the lowest point at the
 * middle of every segment. Per segment: reach discharge × drainage-area ratio (exactly as m1), inverted on the rating curve of the anchor
 * cross-section; the raw anchor depth below 1 cm is dry. The flowing depth at each junction is one smoothed number per shared vertex
 * (`junction-depths.ts`). `values` is the pool-filled water surface at the anchor station (`pool-filled-water-surface.ts`, the function the
 * browser draws with: the water smoothed over a window scaled by its depth, then pool-filled), from the junction depths as written and the
 * station beds and distances rounded as the ribbon stores them. See METHOD.md in this folder.
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
  /** Bed at the anchor point, m NAVD88. Depth at the anchor = value − anchorBedElevationM. */
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
  /** Bed at each water-surface station (the ribbon's stations), m NAVD88, rounded to 3 decimals as the ribbon ring stores it. */
  stationBedsM: number[];
  /** Distance of each of those stations from the segment's upstream boundary, meters (cm), as the ribbon stores it. */
  stationDistancesM: number[];
  /** Which of those stations is the WSE Anchor Point. */
  anchorStation: number;
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
    // The segment's WSE is the pool-filled surface at its anchor station, from the junction depths as written to the file.
    const valuesByPosition = run.models.map(() => new Array<number | null>(length).fill(null));
    for (let offset = 0; offset < length; offset += 1) {
      const surfaces = poolFilledRunSurfaces(
        run.models.map((model, position) => ({
          stationBedsM: model.stationBedsM,
          stationDistancesM: model.stationDistancesM,
          upstreamDepthM: (junctionUpstream[position] as (number | null)[])[offset] ?? null,
          downstreamDepthM: (junctionDownstream[position] as (number | null)[])[offset] ?? null,
        })),
        POOL_FILLED_WATER_SURFACE,
      );
      run.models.forEach((model, position) => {
        const up = (junctionUpstream[position] as (number | null)[])[offset] ?? null;
        const surface = surfaces[position];
        // A dry segment (depth 0) holds its anchor bed, as in v1; a segment without a value holds null.
        (valuesByPosition[position] as (number | null)[])[offset] =
          up === null ? null : surface ? roundValue(surface[model.anchorStation] as number, 3) : roundValue(model.anchorBedElevationM, 3);
      });
    }
    run.models.forEach((model, position) => {
      const upstreamDepths = junctionUpstream[position] as (number | null)[];
      const downstreamDepths = junctionDownstream[position] as (number | null)[];
      const values = valuesByPosition[position] as (number | null)[];
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
  /** Mean |offset of the lowest point from the centerline| over every station, m. */
  meanThalwegOffsetM: number;
  stationsAtDescentLimit: number;
  stationsWithoutLidar: number;
  /** Anchor stations whose valley-bottom fit ended at the search edge, or whose lowest point was followed to the descent limit. */
  anchorsAtSearchEdge: number;
  anchorsAtDescentLimit: number;
  /** Anchors moved off a breached middle station, and anchors left on one because every station of the segment is breached. */
  anchorsMovedOffBreach: number;
  anchorsOnBreach: number;
  /** Every breached barrier, with its segment and position, for the manifest. */
  breaches: { segmentId: string; lonLat: [number, number]; poolDepthM: number; heightAboveDownstreamM: number; lengthAtHalfHeightM: number; breachLengthM: number }[];
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
    meanThalwegOffsetM: 0,
    stationsAtDescentLimit: 0,
    stationsWithoutLidar: 0,
    anchorsAtSearchEdge: 0,
    anchorsAtDescentLimit: 0,
    anchorsMovedOffBreach: 0,
    anchorsOnBreach: 0,
    breaches: [],
  };
  let thalwegOffsetSumM = 0;
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
      build.stationsAtDescentLimit += channel.stationsAtDescentLimit;
      build.stationsWithoutLidar += channel.stationsWithoutLidar;
      for (let station = 0; station < channel.stationCount; station += 1) thalwegOffsetSumM += Math.abs(channel.thalwegOffsetM[station] as number);
      stationCount += channel.stationCount;
      const segmentAtStation = (station: number): string => {
        const position = channel.boundaries.findIndex((boundary, index) => index > 0 && station <= boundary);
        return (oriented[Math.max(0, position - 1)] as OrientedSegment).segmentId;
      };
      for (const breach of channel.breaches) {
        const crest = thalwegPoint(channel, breach.crestStation);
        const [longitude, latitude] = utm10nToWgs84(crest.x, crest.y);
        build.breaches.push({
          segmentId: segmentAtStation(breach.crestStation),
          lonLat: [roundToDecimals(longitude, 6), roundToDecimals(latitude, 6)],
          poolDepthM: roundValue(breach.poolDepthM, 2),
          heightAboveDownstreamM: roundValue(breach.heightAboveDownstreamM, 2),
          lengthAtHalfHeightM: roundValue(breach.lengthAtHalfHeightM, 1),
          breachLengthM: roundValue((breach.lastStation - breach.firstStation) * channel.spacingM, 1),
        });
      }
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
        const { stations, anchorStation, stationDistancesM } = waterSurfaceStations(channel, first, last);
        const anchorIndex = stations[anchorStation] as number;
        // A segment wholly on a breached fill runs through its culvert: there is no lidar of its creek bed, so it has no rating curve and no water.
        const whollyOnBreach = last > first && isBreachedStation(channel, anchorIndex);
        if (last > first) {
          const middle = Math.round(first + (last - first) * ANCHOR_POSITION_ALONG_SEGMENT);
          if (whollyOnBreach) build.anchorsOnBreach += 1;
          else if (anchorIndex !== middle) build.anchorsMovedOffBreach += 1;
          if (channel.atSearchEdge[anchorIndex]) build.anchorsAtSearchEdge += 1;
          if (Math.abs(channel.thalwegOffsetM[anchorIndex] as number) >= CHANNEL_PROFILE.bed.descentLimitM - 1e-9) build.anchorsAtDescentLimit += 1;
        }
        const rating = last > first && !whollyOnBreach ? anchorRating(channel, segment.segmentId, anchorIndex) : null;
        if (whollyOnBreach) warnings.push(`${segment.segmentId} lies wholly on a breached barrier (a fill over a culvert), values are null.`);
        else if (!rating) warnings.push(`${segment.segmentId} has no ribbon (its boundaries coincide), values are null.`);
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
          stationBedsM: stations.map((station) => roundValue(channel.bedM[station] as number, 3)),
          stationDistancesM,
          anchorStation,
          // The lidar at the anchor point; the same as the bed there except on a segment wholly on a breach, which has no water.
          anchorBedElevationM: channel.thalwegM[anchorIndex] as number,
          bedUpstreamM: channel.bedM[first] as number,
          bedDownstreamM: channel.bedM[last] as number,
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
  build.meanThalwegOffsetM = stationCount === 0 ? 0 : thalwegOffsetSumM / stationCount;
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
  counts.stationsAtDescentLimit = build.stationsAtDescentLimit;
  counts.stationsWithoutLidar = build.stationsWithoutLidar;
  counts.anchorsAtSearchEdge = build.anchorsAtSearchEdge;
  counts.anchorsAtDescentLimit = build.anchorsAtDescentLimit;
  counts.anchorsMovedOffBreachedBarrier = build.anchorsMovedOffBreach;
  counts.anchorsOnBreachedBarrier = build.anchorsOnBreach;
  counts.breachedBarriers = build.breaches.length;
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
    `${build.segmentCount} Creek Segments on ${build.flowlines.length} flowlines, one anchor cross-section each, through the lowest point of the table station nearest ${ANCHOR_POSITION_ALONG_SEGMENT} of the ribbon; ` +
      `local slope of the bed ±${ANCHOR_SLOPE.halfWindowM} m, ${build.slopeFlooredSegments} slopes floored, ${build.segmentsWithoutRating} anchors without a rating curve, centerline moved a mean ${build.meanOffsetFromFlowlineM.toFixed(1)} m sideways from the smoothed flowline, ${build.stationsAtSearchEdge} stations at the search edge (${build.anchorsAtSearchEdge} anchors); ` +
      `lowest point a mean ${build.meanThalwegOffsetM.toFixed(2)} m from the centerline, ${build.stationsAtDescentLimit} stations at the descent limit (${build.anchorsAtDescentLimit} anchors), ${build.stationsWithoutLidar} without lidar; ` +
      `${build.breaches.length} barriers breached, ${build.anchorsMovedOffBreach} anchors moved off a breach, ${build.anchorsOnBreach} left on one; ` +
      `junction depth: mean of raw anchor depths within ±${JUNCTION_DEPTH.smoothingHalfWindowM} m (raw depth under ${DRY_BELOW_DEPTH_M} m is dry); values = the pool-filled water surface at the anchor station.`,
    `${STEEP_EXAMPLE_SEGMENT_ID}: ${JSON.stringify(example[NATIONAL_WATER_MODEL.datasetId] ?? null)}`,
  );
  return {
    outputFiles,
    counts,
    warnings,
    measurements: {
      centerlineMeanOffsetFromFlowlineM: build.meanOffsetFromFlowlineM,
      steepExampleSegment: { segmentId: STEEP_EXAMPLE_SEGMENT_ID, ...example },
      meanThalwegOffsetFromCenterlineM: build.meanThalwegOffsetM,
      breachedBarriers: build.breaches,
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
        rule: 'values = the pool-filled water surface (pool-filled-water-surface.ts) at the anchor station, from the junction depths as written and the station beds rounded to 3 decimals, rounded to 3 decimals; a dry segment has depth 0 and values = anchor bed',
        poolFilledWaterSurface: POOL_FILLED_WATER_SURFACE,
      },
    },
    run: buildTimeSeries,
  });
});
