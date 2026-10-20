import path from 'node:path';
import { readJson } from '../json-files.ts';
import { writeInspectionSvg } from './inspection-svg.ts';
import { CROSS_SECTION, INSPECTION_SEGMENT_ID, MODELED_EXTENT, RATING_CURVE, stageDirectory } from './pipeline-configuration.ts';
import { buildRatingCurveRecord } from './rating-curve-inversion.ts';
import { writeReadableJson } from './readable-json.ts';
import {
  CROSS_SECTIONS_FILE,
  RATING_CURVES_FILE,
  type CrossSectionsFile,
  type RatingCurveRecord,
  type RatingCurvesFile,
} from './stage-file-formats.ts';
import { runStage, runStageEntryPoint, type StageResult } from './stage-manifest.ts';

/**
 * Stage 2 — rating curves. Manning's equation normal depth on each Creek Segment's
 * representative cross-section: Q = (1/n) · A · R^(2/3) · S^(1/2), with R = A / P.
 * The curve is a water-surface elevation (WSE) ladder from the bed upward; the per-segment
 * math lives in `buildRatingCurveRecord` (rating-curve-inversion.ts) so it can be tested.
 */

const crossSectionsDirectory = stageDirectory('crossSections');
const outputDirectory = stageDirectory('ratingCurves');

async function readCrossSections(): Promise<CrossSectionsFile> {
  return (await readJson(path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE))) as CrossSectionsFile;
}

async function buildRatingCurves(): Promise<StageResult> {
  const crossSections = await readCrossSections();
  const warnings: string[] = [];
  const records: RatingCurveRecord[] = crossSections.segments.map((section) => {
    const record = buildRatingCurveRecord(section);
    for (const flag of record.flags) warnings.push(`${section.segmentId} ${flag}`);
    return record;
  });

  const output: RatingCurvesFile = {
    segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
    description:
      "Manning's equation normal-depth rating curve per Creek Segment on its representative cross-section, " +
      'trimmed at its valley edges and divided at its bank tops into main channel and left/right floodplain. ' +
      'Q = Σ (1/nᵢ)·Aᵢ·Rᵢ^(2/3)·S^(1/2) over the three subsections; WSE in m NAVD88, Q in m³/s. ' +
      'The ladder rises to the lower valley edge (bed + maximum depth is a safety cap); a side that kept the untrimmed ' +
      'half-section in Stage 1 (valley-edge trim fallback) has no valley edge and does not cap the ladder. ' +
      'dischargeM3s is the running maximum of rawManningDischargeM3s so discharge never falls as WSE rises.',
    parameters: RATING_CURVE,
    segments: records,
  };
  const outputPath = path.join(outputDirectory, RATING_CURVES_FILE);
  await writeReadableJson(outputPath, output);

  const outputFiles = [outputPath];
  const inspection = records.find((record) => record.segmentId === INSPECTION_SEGMENT_ID);
  if (inspection) {
    const svgPath = path.join(outputDirectory, `rating-curve-${INSPECTION_SEGMENT_ID}.svg`);
    await writeInspectionSvg(svgPath, [
      {
        title: `Creek Segment ${INSPECTION_SEGMENT_ID} rating curve (n = ${RATING_CURVE.manningRoughnessN} channel / ${RATING_CURVE.floodplainManningRoughnessN} floodplain, S = ${inspection.slope}, bed ${inspection.bedElevationM} m)`,
        xLabel: 'Discharge Q (m³/s)',
        yLabel: 'Water-surface elevation (m NAVD88)',
        series: [
          {
            label: "raw Manning's discharge (before running maximum)",
            points: inspection.rawManningDischargeM3s.map((discharge, index) => ({
              x: discharge,
              y: inspection.waterSurfaceElevationM[index] ?? null,
            })),
            color: '#9ca3af',
            dashed: true,
          },
          {
            label: "Manning's normal depth (running maximum, used for inversion)",
            points: inspection.dischargeM3s.map((discharge, index) => ({
              x: discharge,
              y: inspection.waterSurfaceElevationM[index] ?? null,
            })),
            color: '#1d4ed8',
            strokeWidth: 2,
          },
          {
            label: `lower bank top ${Math.min(inspection.leftBankTop.elevationM, inspection.rightBankTop.elevationM)} m (floodplain starts above)`,
            points: [
              { x: 0, y: Math.min(inspection.leftBankTop.elevationM, inspection.rightBankTop.elevationM) },
              {
                x: inspection.dischargeM3s[inspection.dischargeM3s.length - 1] ?? 1,
                y: Math.min(inspection.leftBankTop.elevationM, inspection.rightBankTop.elevationM),
              },
            ],
            color: '#a16207',
            dashed: true,
          },
          {
            label: 'observed gauge WSE ≈ 26.3 m (reference)',
            points: [
              { x: 0, y: 26.3 },
              { x: inspection.dischargeM3s[inspection.dischargeM3s.length - 1] ?? 1, y: 26.3 },
            ],
            color: '#dc2626',
            dashed: true,
          },
        ],
      },
    ]);
    outputFiles.push(svgPath);
  }

  const maxima = records.map((record) => record.dischargeM3s[record.dischargeM3s.length - 1] ?? 0).sort((a, b) => a - b);
  return {
    outputFiles,
    counts: {
      creekSegments: records.length,
      ladderSteps: records.reduce((sum, record) => sum + record.waterSurfaceElevationM.length, 0),
      flaggedSegments: records.filter((record) => record.flags.length > 0).length,
      nonMonotonicDischargeSegments: records.filter((record) =>
        record.flags.some((flag) => flag.startsWith('non-monotonic-discharge')),
      ).length,
      nonMonotonicDischargeLadderSteps: records.reduce(
        (sum, record) =>
          sum + record.rawManningDischargeM3s.filter((discharge, index) => discharge !== record.dischargeM3s[index]).length,
        0,
      ),
      valleyEdgeCappedSegments: records.filter((record) => record.capReason === 'lower-valley-edge').length,
      maximumDepthCappedSegments: records.filter((record) => record.capReason === 'maximum-depth').length,
      shallowSectionSegments: records.filter((record) => record.flags.some((flag) => flag.startsWith('shallow-section'))).length,
      valleyEdgeTrimFallbackSegments: crossSections.segments.filter((section) => {
        const representative = section.sections[section.representativeSectionIndex];
        return representative?.valleyEdgeTrimFallbackLeft || representative?.valleyEdgeTrimFallbackRight;
      }).length,
      overbankLadderSteps: records.reduce((sum, record) => sum + record.overbankLadderSteps, 0),
    },
    warnings,
    summaryLines: [
      `${records.length} rating curves; ladder-top discharge ${maxima[0]?.toFixed(1)}–${maxima[maxima.length - 1]?.toFixed(1)} m³/s (median ${maxima[Math.floor(maxima.length / 2)]?.toFixed(1)}).`,
      inspection
        ? `${INSPECTION_SEGMENT_ID}: ${inspection.waterSurfaceElevationM.length} steps to ${inspection.capElevationM} m (${inspection.capReason}); ` +
          `bank tops ${inspection.leftBankTop.elevationM} m / ${inspection.rightBankTop.elevationM} m; Q max ${inspection.dischargeM3s[inspection.dischargeM3s.length - 1]} m³/s.`
        : '',
    ],
  };
}

await runStageEntryPoint(async () => {
  await runStage({
    stage: '02-rating-curves',
    outputDirectory,
    inputFiles: [path.join(crossSectionsDirectory, CROSS_SECTIONS_FILE)],
    parameters: {
      segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
      ...RATING_CURVE,
      valleyEdgeMinimumBankHeightM: CROSS_SECTION.valleyEdgeMinimumBankHeightM,
    },
    run: buildRatingCurves,
  });
});
