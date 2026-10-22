import { rm } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeCompactJson } from '../json-files.ts';
import { junctionNeighboursById, loadCreekSegmentNetwork, type JunctionNeighbours } from './creek-segment-network.ts';
import {
  CNF_DISCHARGE_FILE,
  NWM_DISCHARGE_FILE,
  exceedsMaximumTransferDistance,
  readNhdplusV2Crosswalk,
  readNormalizedDischarge,
  roundValue,
  type NhdplusV2ReachCrosswalk,
  type NormalizedDischargeFile,
} from './discharge-records.ts';
import { formatUtcDate, writeInspectionSvg } from './inspection-svg.ts';
import {
  CALIFORNIA_NATURAL_FLOWS,
  INSPECTION_SEGMENT_ID,
  MODELED_EXTENT,
  NATIONAL_WATER_MODEL,
  NHDPLUSV2_CROSSWALK_PATH,
  WATER_SURFACE_ELEVATION_VARIABLE_ID,
  stageDirectory,
} from './pipeline-configuration.ts';
import {
  DRAINAGE_AREA_RATIO_TRANSFER,
  MAXIMUM_TRANSFER_DISTANCE_M,
} from './modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { invertRatingCurve, type InversionOutcome } from './rating-curve-inversion.ts';
import {
  CROSS_SECTIONS_FILE,
  RATING_CURVES_FILE,
  TIME_SERIES_DIRECTORY_NAME,
  downstreamVertexDirectionByTncComid,
  groupByTncComid,
  type CrossSectionsFile,
  type RatingCurveRecord,
  type RatingCurvesFile,
  type WaterSurfaceElevationTimeSeriesFile,
  type WaterSurfaceElevationTimeSeriesSegment,
} from './stage-file-formats.ts';
import { runStage, runStageEntryPoint, type StageResult } from './stage-manifest.ts';
import { waterYearOf } from './water-years.ts';

/**
 * Stage 3 — time series. Turn each Dataset's discharge into a water-surface elevation (WSE)
 * Time Series per Creek Segment by inverting that segment's rating curve. The reach discharge
 * is first scaled to the segment by its drainage-area ratio from the crosswalk (USGS
 * drainage-area ratio method; see drainage-area-ratio.ts). Each segment also gets a junction
 * WSE at its upstream and downstream vertex: the higher of its own value and its neighbour's,
 * so the two segments meeting at a vertex share one height there (see `withJunctionWse`).
 */

const acquireDirectory = stageDirectory('acquire');
const crossSectionsDirectory = stageDirectory('crossSections');
const ratingCurvesDirectory = stageDirectory('ratingCurves');
const outputDirectory = stageDirectory('timeSeries');

type OutcomeCounts = Record<InversionOutcome, number>;

function emptyOutcomeCounts(): OutcomeCounts {
  return { bed: 0, interpolated: 0, clamped: 0, missing: 0 };
}

/** Reach discharge scaled to one Creek Segment by its drainage-area ratio (null stays null). */
function segmentDischarge(reachDischargeM3s: number | null, drainageAreaRatio: number): number | null {
  return reachDischargeM3s === null ? null : reachDischargeM3s * drainageAreaRatio;
}

/**
 * WSE values for every Creek Segment over the given timestamp index range of one Dataset.
 * A Drainage-Area Ratio Transfer segment carries the transfer flag; one whose borrowed reach is
 * beyond the maximum transfer distance gets no discharge, so every value is null.
 */
function invertDataset(input: {
  discharge: NormalizedDischargeFile;
  crosswalk: NhdplusV2ReachCrosswalk;
  curves: Map<string, RatingCurveRecord>;
  firstIndex: number;
  endIndex: number;
  outcomes: OutcomeCounts;
  clampedBySegment: Map<string, number>;
}): WaterSurfaceElevationTimeSeriesSegment[] {
  const reachValues = new Map(input.discharge.reaches.map((reach) => [reach.nhdplusV2Comid, reach.values]));
  return input.crosswalk.segments.map((segment) => {
    const { segmentId, nhdplusV2Comid, drainageAreaRatio } = segment;
    const curve = input.curves.get(segmentId);
    const discharges = nhdplusV2Comid === null || exceedsMaximumTransferDistance(segment) ? undefined : reachValues.get(nhdplusV2Comid);
    const values: (number | null)[] = [];
    for (let index = input.firstIndex; index < input.endIndex; index += 1) {
      if (!curve || !discharges) {
        values.push(null);
        input.outcomes.missing += 1;
        continue;
      }
      const { wseM, outcome } = invertRatingCurve(curve, segmentDischarge(discharges[index] ?? null, drainageAreaRatio));
      input.outcomes[outcome] += 1;
      if (outcome === 'clamped') input.clampedBySegment.set(segmentId, (input.clampedBySegment.get(segmentId) ?? 0) + 1);
      values.push(wseM === null ? null : roundValue(wseM, 3));
    }
    // The flag is written only when true, to keep the browser-facing files small.
    return segment[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]
      ? { segmentId, values, [DRAINAGE_AREA_RATIO_TRANSFER.fieldName]: true }
      : { segmentId, values };
  });
}

/**
 * The water-surface elevation two neighbouring Creek Segments share at their vertex: the higher
 * of their two values. Both segments are solved on their own representative section, so their
 * values can differ by meters at one vertex. The higher value is the pool level that holds up to
 * the drop between them, and it is never below either segment's own water. The mean was tried
 * first and sat below the lidar thalweg bed at 33 of the 60 Jalama junctions at a low-flow hour
 * (by up to 0.74 m), leaving the bed dry at the junction; the higher value does so at 5 (≤ 0.11 m).
 */
function junctionWaterSurfaceElevation(valueM: number, neighbourValueM: number): number {
  return Math.max(valueM, neighbourValueM);
}

/**
 * Adds `junctionWseUpstreamM` and `junctionWseDownstreamM` to every segment: at a vertex shared
 * with a neighbour, `junctionWaterSurfaceElevation` of the two values at each timestamp; at a
 * flowline end, or where the neighbour's value is null, the segment's own value; null where the
 * segment's value is null. Both segments at a vertex get the same number.
 */
function withJunctionWse(
  segments: readonly WaterSurfaceElevationTimeSeriesSegment[],
  neighboursById: ReadonlyMap<string, JunctionNeighbours>,
): WaterSurfaceElevationTimeSeriesSegment[] {
  const valuesById = new Map(segments.map((segment) => [segment.segmentId, segment.values]));
  const junctionWith = (values: readonly (number | null)[], neighbourSegmentId: string | null): (number | null)[] => {
    const neighbourValues = neighbourSegmentId === null ? undefined : valuesById.get(neighbourSegmentId);
    return values.map((value, index) => {
      if (value === null) return null;
      const neighbourValue = neighbourValues?.[index] ?? null;
      return neighbourValue === null ? value : roundValue(junctionWaterSurfaceElevation(value, neighbourValue), 3);
    });
  };
  return segments.map((segment) => {
    const neighbours = neighboursById.get(segment.segmentId);
    return {
      ...segment,
      junctionWseUpstreamM: junctionWith(segment.values, neighbours?.upstreamSegmentId ?? null),
      junctionWseDownstreamM: junctionWith(segment.values, neighbours?.downstreamSegmentId ?? null),
    };
  });
}

function summarize(values: readonly (number | null)[]): { min: number; median: number; max: number } | null {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (present.length === 0) return null;
  return {
    min: present[0] as number,
    median: present[Math.floor(present.length / 2)] as number,
    max: present[present.length - 1] as number,
  };
}

/**
 * Writes one compact Time Series file per TNC flowline, holding only that flowline's Creek Segments.
 * `fileNameFor` maps a TNC COMID to a path under `time-series/<datasetId>/<variableId>/`.
 */
async function writeTimeSeriesPerTncFlowline(input: {
  datasetId: string;
  timestampsUtcMs: number[];
  segments: WaterSurfaceElevationTimeSeriesFile['segments'];
  fileNameFor: (tncComid: string) => string;
}): Promise<string[]> {
  const written: string[] = [];
  for (const [tncComid, segments] of groupByTncComid(input.segments)) {
    const filePath = path.join(
      outputDirectory,
      TIME_SERIES_DIRECTORY_NAME,
      input.datasetId,
      WATER_SURFACE_ELEVATION_VARIABLE_ID,
      input.fileNameFor(tncComid),
    );
    const file: WaterSurfaceElevationTimeSeriesFile = {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      datasetId: input.datasetId,
      variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID,
      timestampsUtcMs: input.timestampsUtcMs,
      segments,
    };
    await writeCompactJson(filePath, file);
    written.push(filePath);
  }
  return written;
}

function describeOutcomes(outcomes: OutcomeCounts): string {
  return `${outcomes.interpolated} interpolated, ${outcomes.bed} zero-discharge→bed, ${outcomes.clamped} clamped, ${outcomes.missing} missing`;
}

async function buildTimeSeries(): Promise<StageResult> {
  const ratingCurves = (await readJson(path.join(ratingCurvesDirectory, RATING_CURVES_FILE))) as RatingCurvesFile;
  const curves = new Map(ratingCurves.segments.map((curve) => [curve.segmentId, curve]));
  const crosswalk = await readNhdplusV2Crosswalk(NHDPLUSV2_CROSSWALK_PATH);
  const crossSections = (await readJson(path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE))) as CrossSectionsFile;
  const neighboursById = junctionNeighboursById(await loadCreekSegmentNetwork(), downstreamVertexDirectionByTncComid(crossSections));
  const warnings: string[] = [];
  const outputFiles: string[] = [];
  const summaryLines: string[] = [];
  const counts: Record<string, number> = {};
  const inspectionStats: Record<string, unknown> = {};
  // Remove every earlier Time Series file, including the former single-file layout, so no stale file is listed.
  await rm(path.join(outputDirectory, TIME_SERIES_DIRECTORY_NAME), { recursive: true, force: true });
  for (const segment of crosswalk.segments) {
    const { segmentId, nhdplusV2Comid } = segment;
    if (nhdplusV2Comid === null) warnings.push(`${segmentId} unmapped: no NHDPlusV2 reach, values are null.`);
    if (!curves.has(segmentId)) warnings.push(`${segmentId} has no rating curve, values are null.`);
    if (exceedsMaximumTransferDistance(segment)) {
      warnings.push(
        `${segmentId} ${DRAINAGE_AREA_RATIO_TRANSFER.label}: borrowed NHDPlusV2 COMID ${String(nhdplusV2Comid)} is ` +
          `${String(segment.transferDistanceM)} m away, more than ${MAXIMUM_TRANSFER_DISTANCE_M} m; no discharge, values are null.`,
      );
    }
  }
  const transferSegments = crosswalk.segments.filter((segment) => segment[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]);
  counts.drainageAreaRatioTransferSegments = transferSegments.length;
  counts.transferDistanceExceededSegments = transferSegments.filter(exceedsMaximumTransferDistance).length;
  summaryLines.push(
    `${DRAINAGE_AREA_RATIO_TRANSFER.label}: ${transferSegments.length} segment(s) flagged; ` +
      `${counts.transferDistanceExceededSegments} beyond ${MAXIMUM_TRANSFER_DISTANCE_M} m get null values.`,
  );

  // California Natural Flows monthly: one file per TNC flowline for the whole record.
  const californiaNaturalFlows = await readNormalizedDischarge(path.join(acquireDirectory, CNF_DISCHARGE_FILE));
  const cnfOutcomes = emptyOutcomeCounts();
  const cnfClamped = new Map<string, number>();
  const cnfSegments = withJunctionWse(
    invertDataset({
      discharge: californiaNaturalFlows,
      crosswalk,
      curves,
      firstIndex: 0,
      endIndex: californiaNaturalFlows.timestampsUtcMs.length,
      outcomes: cnfOutcomes,
      clampedBySegment: cnfClamped,
    }),
    neighboursById,
  );
  outputFiles.push(
    ...(await writeTimeSeriesPerTncFlowline({
      datasetId: CALIFORNIA_NATURAL_FLOWS.datasetId,
      timestampsUtcMs: californiaNaturalFlows.timestampsUtcMs,
      segments: cnfSegments,
      fileNameFor: (tncComid) => `${tncComid}.json`,
    })),
  );
  counts.californiaNaturalFlowsTimestamps = californiaNaturalFlows.timestampsUtcMs.length;
  counts.californiaNaturalFlowsClampedValues = cnfOutcomes.clamped;
  for (const [segmentId, clamped] of cnfClamped) {
    warnings.push(`${segmentId} ${CALIFORNIA_NATURAL_FLOWS.datasetId}: ${clamped} values above the rating curve clamped.`);
  }
  summaryLines.push(`${CALIFORNIA_NATURAL_FLOWS.datasetId}: ${californiaNaturalFlows.timestampsUtcMs.length} timestamps; ${describeOutcomes(cnfOutcomes)}.`);
  inspectionStats[CALIFORNIA_NATURAL_FLOWS.datasetId] = summarize(
    cnfSegments.find((segment) => segment.segmentId === INSPECTION_SEGMENT_ID)?.values ?? [],
  );

  // National Water Model hourly: one file per TNC flowline per water year.
  const nationalWaterModel = await readNormalizedDischarge(path.join(acquireDirectory, NWM_DISCHARGE_FILE));
  const nwmOutcomes = emptyOutcomeCounts();
  const nwmClamped = new Map<string, number>();
  const waterYears = [...new Set(nationalWaterModel.timestampsUtcMs.map(waterYearOf))].sort((a, b) => a - b);
  const inspectionValues: (number | null)[] = [];
  for (const waterYear of waterYears) {
    const firstIndex = nationalWaterModel.timestampsUtcMs.findIndex((timestamp) => waterYearOf(timestamp) === waterYear);
    let endIndex = firstIndex;
    while (endIndex < nationalWaterModel.timestampsUtcMs.length && waterYearOf(nationalWaterModel.timestampsUtcMs[endIndex] as number) === waterYear) {
      endIndex += 1;
    }
    const segments = withJunctionWse(
      invertDataset({
        discharge: nationalWaterModel,
        crosswalk,
        curves,
        firstIndex,
        endIndex,
        outcomes: nwmOutcomes,
        clampedBySegment: nwmClamped,
      }),
      neighboursById,
    );
    inspectionValues.push(...(segments.find((segment) => segment.segmentId === INSPECTION_SEGMENT_ID)?.values ?? []));
    outputFiles.push(
      ...(await writeTimeSeriesPerTncFlowline({
        datasetId: NATIONAL_WATER_MODEL.datasetId,
        timestampsUtcMs: nationalWaterModel.timestampsUtcMs.slice(firstIndex, endIndex),
        segments,
        fileNameFor: (tncComid) => path.join(tncComid, `WY${waterYear}.json`),
      })),
    );
  }
  counts.nationalWaterModelTimestamps = nationalWaterModel.timestampsUtcMs.length;
  counts.nationalWaterModelWaterYears = waterYears.length;
  counts.nationalWaterModelClampedValues = nwmOutcomes.clamped;
  for (const [segmentId, clamped] of nwmClamped) {
    warnings.push(`${segmentId} ${NATIONAL_WATER_MODEL.datasetId}: ${clamped} values above the rating curve clamped.`);
  }
  summaryLines.push(
    `${NATIONAL_WATER_MODEL.datasetId}: ${nationalWaterModel.timestampsUtcMs.length} timestamps in WY${waterYears[0]}–WY${waterYears[waterYears.length - 1]}; ${describeOutcomes(nwmOutcomes)}.`,
  );
  inspectionStats[NATIONAL_WATER_MODEL.datasetId] = summarize(inspectionValues);

  const ratiosBelowOne = crosswalk.segments.filter((segment) => segment.drainageAreaRatio < 1).length;
  counts.drainageAreaRatioBelowOneSegments = ratiosBelowOne;
  summaryLines.push(`Reach discharge scaled by the drainage-area ratio on ${ratiosBelowOne} of ${crosswalk.segments.length} Creek Segments.`);
  const junctions = [...neighboursById.values()].filter((neighbours) => neighbours.downstreamSegmentId !== null).length;
  counts.junctions = junctions;
  summaryLines.push(`Junction WSE written at ${junctions} shared vertices: the higher of the two neighbouring Creek Segments' values.`);

  // Inspection hydrograph: the calendar month holding the largest NWM discharge at the inspection segment.
  const inspectionSegment = crosswalk.segments.find((segment) => segment.segmentId === INSPECTION_SEGMENT_ID);
  const inspectionComid = inspectionSegment?.nhdplusV2Comid;
  const inspectionRatio = inspectionSegment?.drainageAreaRatio ?? 1;
  const inspectionDischarge = (nationalWaterModel.reaches.find((reach) => reach.nhdplusV2Comid === inspectionComid)?.values ?? []).map(
    (value) => segmentDischarge(value, inspectionRatio),
  );
  const curve = curves.get(INSPECTION_SEGMENT_ID);
  if (inspectionDischarge.length > 0 && curve) {
    const peakIndex = inspectionDischarge.reduce<number>(
      (best, value, index) => ((value ?? -Infinity) > (inspectionDischarge[best] ?? -Infinity) ? index : best),
      0,
    );
    const peakDate = new Date(nationalWaterModel.timestampsUtcMs[peakIndex] as number);
    const monthStart = Date.UTC(peakDate.getUTCFullYear(), peakDate.getUTCMonth(), 1);
    const monthEnd = Date.UTC(peakDate.getUTCFullYear(), peakDate.getUTCMonth() + 1, 1);
    const indexes = nationalWaterModel.timestampsUtcMs.flatMap((timestamp, index) =>
      timestamp >= monthStart && timestamp < monthEnd ? [index] : [],
    );
    const monthLabel = peakDate.toISOString().slice(0, 7);
    const svgPath = path.join(outputDirectory, `hydrograph-${INSPECTION_SEGMENT_ID}-${NATIONAL_WATER_MODEL.datasetId}-${monthLabel}.svg`);
    await writeInspectionSvg(svgPath, [
      {
        title: `Creek Segment ${INSPECTION_SEGMENT_ID} modeled WSE, ${NATIONAL_WATER_MODEL.datasetId}, ${monthLabel} (UTC)`,
        xLabel: 'Date (UTC, MM-DD)',
        yLabel: 'Water-surface elevation (m NAVD88)',
        formatX: formatUtcDate,
        series: [
          {
            label: 'modeled WSE',
            points: indexes.map((index) => ({
              x: nationalWaterModel.timestampsUtcMs[index] as number,
              y: inspectionValues[index] ?? null,
            })),
            color: '#1d4ed8',
            strokeWidth: 1.8,
          },
          {
            label: `bed ${curve.bedElevationM} m`,
            points: [
              { x: monthStart, y: curve.bedElevationM },
              { x: monthEnd - 3_600_000, y: curve.bedElevationM },
            ],
            color: '#6b7280',
            dashed: true,
          },
          {
            label: 'observed gauge WSE ≈ 26.3 m (reference)',
            points: [
              { x: monthStart, y: 26.3 },
              { x: monthEnd - 3_600_000, y: 26.3 },
            ],
            color: '#dc2626',
            dashed: true,
          },
        ],
      },
      {
        title: `NWM discharge, NHDPlusV2 COMID ${String(inspectionComid)} × drainage-area ratio ${inspectionRatio}`,
        xLabel: 'Date (UTC, MM-DD)',
        yLabel: 'Discharge (m³/s)',
        formatX: formatUtcDate,
        series: [
          {
            label: 'NWM streamflow scaled to the Creek Segment',
            points: indexes.map((index) => ({
              x: nationalWaterModel.timestampsUtcMs[index] as number,
              y: inspectionDischarge[index] ?? null,
            })),
            color: '#0f766e',
            strokeWidth: 1.8,
          },
        ],
      },
    ]);
    outputFiles.push(svgPath);
  }

  for (const [datasetId, stats] of Object.entries(inspectionStats)) {
    const value = stats as { min: number; median: number; max: number } | null;
    summaryLines.push(
      value
        ? `${INSPECTION_SEGMENT_ID} ${datasetId} WSE min/median/max: ${value.min} / ${value.median} / ${value.max} m`
        : `${INSPECTION_SEGMENT_ID} ${datasetId}: no values`,
    );
  }

  return { outputFiles, counts, warnings, measurements: { inspectionSegmentWse: inspectionStats }, summaryLines };
}

await runStageEntryPoint(async () => {
  await runStage({
    stage: '03-time-series',
    outputDirectory,
    inputFiles: [
      MODELED_EXTENT.flowlineSnapshotPath,
      path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE),
      path.join(ratingCurvesDirectory, RATING_CURVES_FILE),
      NHDPLUSV2_CROSSWALK_PATH,
      path.join(acquireDirectory, CNF_DISCHARGE_FILE),
      path.join(acquireDirectory, NWM_DISCHARGE_FILE),
    ],
    parameters: {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      variableId: WATER_SURFACE_ELEVATION_VARIABLE_ID,
      fileLayout: 'one compact JSON file per TNC flowline: <datasetId>/<variableId>/<tncComid>.json, hourly <tncComid>/WY<year>.json',
      junctionWse:
        'segments[].junctionWseUpstreamM / junctionWseDownstreamM, parallel to values: the higher of the segment value and its neighbour at the shared vertex; own value at a flowline end or where the neighbour is null',
      decimals: 3,
      dischargeScaling: 'segment Q = reach Q × drainageAreaRatio from the crosswalk (USGS drainage-area ratio method, ratio capped at 1)',
      drainageAreaRatioTransfer: {
        ...DRAINAGE_AREA_RATIO_TRANSFER,
        maximumTransferDistanceM: MAXIMUM_TRANSFER_DISTANCE_M,
        fileLayout: `segments[].${DRAINAGE_AREA_RATIO_TRANSFER.fieldName}: true only on transfer segments; beyond the maximum distance every value is null`,
      },
      inversion: 'first ladder crossing, linear interpolation; Q ≤ 0 → bed; missing → null; above curve → clamp',
    },
    run: buildTimeSeries,
  });
});
