import path from 'node:path';
import { readJson, writePrettyJson } from '../json-files.ts';
import { roundToDecimals, type UtmPoint } from '../utm-geometry.ts';
import { loadCreekSegmentNetwork, type NetworkCreekSegment } from './creek-segment-network.ts';
import { bankTopIndices, valleyEdgeIndices, wettedGeometryAt, type ProfileSample } from './cross-section-geometry.ts';
import { REACH_ASSIGNMENTS_FILE, exceedsMaximumTransferDistance, readNhdplusV2ReachAssignments } from './discharge-records.ts';
import { buildCrosswalkWithDrainageAreaRatios, sampleSegmentDrainageAreas, summarizeRatios } from './drainage-area-ratio.ts';
import { writeInspectionSvg } from './inspection-svg.ts';
import { INSPECTION_SEGMENT_ID, MODELED_EXTENT, NHDPLUSV2_CROSSWALK_PATH, stageDirectory } from './pipeline-configuration.ts';
import {
  CROSS_SECTION,
  DRAINAGE_AREA_RATIO,
  DRAINAGE_AREA_RATIO_TRANSFER,
} from './modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/method-config.ts';
import { writeReadableJson } from './readable-json.ts';
import {
  CROSS_SECTIONS_FILE,
  downstreamVertexDirection,
  type CrossSectionRecord,
  type CrossSectionsFile,
} from './stage-file-formats.ts';
import { runStage, runStageEntryPoint, type StageResult } from './stage-manifest.ts';
import { refuseToOverwriteADifferentModeledWseVersion } from './modeled-wse-version.ts';
import { TERRAIN_TILE_INDEX_FILE, TerrainSampler, readTerrainTileIndex } from './terrain-tiles.ts';

/**
 * Stage 1 — cross-sections. For every Creek Segment, sample several cross-sections
 * perpendicular to the segment from the USGS 3DEP 1 m terrain, pick a representative
 * one, and estimate the longitudinal bed slope along the network.
 *
 * This stage also writes the tracked NHDPlusV2 reach crosswalk: Stage 0's reach assignment
 * plus each segment's drainage-area ratio. The ratio needs the segment's downstream thalweg
 * point, which only this stage knows (see drainage-area-ratio.ts).
 *
 * Note: USGS 3DEP is bare-earth lidar, so the "bed" is the lowest ground the lidar saw,
 * which is the water surface on the survey date where water was present.
 */

const acquireDirectory = stageDirectory('acquire');
const outputDirectory = stageDirectory('crossSections');

interface SampledSection {
  /** Distance along the segment from its start vertex, meters. */
  alongSegmentM: number;
  networkDistanceM: number;
  centerUtm: UtmPoint;
  thalwegOffsetM: number;
  /** The section's lowest ground near the flowline, in EPSG 32610 meters. Stage 4 seeds its flood fill here. */
  thalwegUtm: UtmPoint;
  bedElevationM: number;
  areaAtReferenceDepthM2: number;
  lowestBankTopM: number;
  leftBankTopOffsetM: number;
  rightBankTopOffsetM: number;
  /** Offsets of the trimmed section ends (valley edges). */
  valleyEdgeLeftOffsetM: number;
  valleyEdgeRightOffsetM: number;
  /** True when the valley-edge guard cut at least one side short of the sampled half-width. */
  trimmedAtValleyEdge: boolean;
  /** True on a side whose valley edge was too low above the bed, so it kept the untrimmed half-section. */
  valleyEdgeTrimFallbackLeft: boolean;
  valleyEdgeTrimFallbackRight: boolean;
  /** Profile after the valley-edge trim; Stage 2 builds the rating curve on this. */
  profile: ProfileSample[];
  missingSamples: number;
}

/**
 * Index of the thalweg: the lowest sample within the search half-width of the TNC flowline.
 * A tie goes to the sample nearer the flowline. Returns -1 when no sample is in range.
 */
function lowestSampleNearFlowline(profile: readonly ProfileSample[]): number {
  let thalwegIndex = -1;
  for (const [index, sample] of profile.entries()) {
    if (Math.abs(sample.offsetM) > CROSS_SECTION.thalwegSearchHalfWidthM) continue;
    const best = profile[thalwegIndex];
    const lower = !best || sample.elevationM < best.elevationM;
    const equalButNearer = best !== undefined && sample.elevationM === best.elevationM && Math.abs(sample.offsetM) < Math.abs(best.offsetM);
    if (lower || equalButNearer) thalwegIndex = index;
  }
  return thalwegIndex;
}

/** Median, 90th percentile, and maximum of the absolute thalweg offsets, meters. */
function thalwegOffsetDistribution(offsetsM: readonly number[]): { medianM: number; p90M: number; maxM: number } {
  const sorted = offsetsM.map(Math.abs).sort((a, b) => a - b);
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  return { medianM: at(0.5), p90M: at(0.9), maxM: sorted[sorted.length - 1] ?? 0 };
}

function sampleSection(
  terrain: TerrainSampler,
  segment: NetworkCreekSegment,
  alongSegmentM: number,
): SampledSection {
  const dx = segment.endUtm.x - segment.startUtm.x;
  const dy = segment.endUtm.y - segment.startUtm.y;
  const length = Math.hypot(dx, dy);
  const unitX = dx / length;
  const unitY = dy / length;
  const normalX = -unitY;
  const normalY = unitX;
  const centerUtm = { x: segment.startUtm.x + unitX * alongSegmentM, y: segment.startUtm.y + unitY * alongSegmentM };

  const sampledProfile: ProfileSample[] = [];
  let missingSamples = 0;
  const steps = Math.round(CROSS_SECTION.halfWidthM / CROSS_SECTION.sampleSpacingM);
  for (let step = -steps; step <= steps; step += 1) {
    const offsetM = step * CROSS_SECTION.sampleSpacingM;
    const elevation = terrain.elevationAt({ x: centerUtm.x + normalX * offsetM, y: centerUtm.y + normalY * offsetM });
    if (elevation === null) {
      missingSamples += 1;
      continue;
    }
    sampledProfile.push({ offsetM, elevationM: elevation });
  }

  const sampledThalwegIndex = lowestSampleNearFlowline(sampledProfile);
  if (sampledThalwegIndex < 0) throw new Error(`Creek Segment ${segment.segmentId} has no terrain near its centerline.`);
  const thalweg = sampledProfile[sampledThalwegIndex] as ProfileSample;

  // Valley-edge guard: trim each side at its highest point so the section never reaches into a neighbouring valley.
  const edges = valleyEdgeIndices(sampledProfile, sampledThalwegIndex);
  // Fallback: a trimmed side whose valley edge is barely above the bed would cap the rating curve
  // at the bed, so that side keeps the untrimmed half-section and Stage 2 caps on the other side.
  const bankHeightAt = (index: number): number => (sampledProfile[index]?.elevationM ?? Infinity) - thalweg.elevationM;
  const valleyEdgeTrimFallbackLeft = edges.leftIndex > 0 && bankHeightAt(edges.leftIndex) < CROSS_SECTION.valleyEdgeMinimumBankHeightM;
  const valleyEdgeTrimFallbackRight =
    edges.rightIndex < sampledProfile.length - 1 && bankHeightAt(edges.rightIndex) < CROSS_SECTION.valleyEdgeMinimumBankHeightM;
  const leftIndex = valleyEdgeTrimFallbackLeft ? 0 : edges.leftIndex;
  const rightIndex = valleyEdgeTrimFallbackRight ? sampledProfile.length - 1 : edges.rightIndex;
  const profile = sampledProfile.slice(leftIndex, rightIndex + 1);
  const thalwegIndex = sampledThalwegIndex - leftIndex;
  const trimmedAtValleyEdge = leftIndex > 0 || rightIndex < sampledProfile.length - 1;

  const geometry = wettedGeometryAt(profile, thalwegIndex, thalweg.elevationM + CROSS_SECTION.representativeAreaDepthM);
  const banks = bankTopIndices(profile, thalwegIndex, CROSS_SECTION.bankTopSearchHalfWidthM);
  const leftBankTop = profile[banks.leftIndex] as ProfileSample;
  const rightBankTop = profile[banks.rightIndex] as ProfileSample;
  return {
    alongSegmentM,
    networkDistanceM: segment.networkDistanceStartM + alongSegmentM,
    centerUtm,
    thalwegOffsetM: thalweg.offsetM,
    thalwegUtm: { x: centerUtm.x + normalX * thalweg.offsetM, y: centerUtm.y + normalY * thalweg.offsetM },
    bedElevationM: thalweg.elevationM,
    areaAtReferenceDepthM2: geometry.areaM2,
    lowestBankTopM: Math.min(leftBankTop.elevationM, rightBankTop.elevationM),
    leftBankTopOffsetM: leftBankTop.offsetM,
    rightBankTopOffsetM: rightBankTop.offsetM,
    valleyEdgeLeftOffsetM: (profile[0] as ProfileSample).offsetM,
    valleyEdgeRightOffsetM: (profile[profile.length - 1] as ProfileSample).offsetM,
    trimmedAtValleyEdge,
    valleyEdgeTrimFallbackLeft,
    valleyEdgeTrimFallbackRight,
    profile,
    missingSamples,
  };
}

/** Number of section sides (0, 1, or 2) that kept the untrimmed half-section. */
function valleyEdgeTrimFallbackSides(section: SampledSection): number {
  return Number(section.valleyEdgeTrimFallbackLeft) + Number(section.valleyEdgeTrimFallbackRight);
}

/** Least-squares slope of bed elevation versus network distance inside a window; positive = bed drops downstream. */
function windowedBedSlope(points: readonly { distanceM: number; bedM: number }[], centerM: number): number {
  const inWindow = points.filter((point) => Math.abs(point.distanceM - centerM) <= CROSS_SECTION.slopeSmoothingHalfWindowM);
  const meanX = inWindow.reduce((sum, point) => sum + point.distanceM, 0) / inWindow.length;
  const meanY = inWindow.reduce((sum, point) => sum + point.bedM, 0) / inWindow.length;
  let covariance = 0;
  let variance = 0;
  for (const point of inWindow) {
    covariance += (point.distanceM - meanX) * (point.bedM - meanY);
    variance += (point.distanceM - meanX) ** 2;
  }
  return variance === 0 ? 0 : -covariance / variance;
}

function round3(value: number): number {
  return roundToDecimals(value, 3);
}

async function buildCrossSections(): Promise<StageResult> {
  const segments = await loadCreekSegmentNetwork();
  const terrain = await TerrainSampler.load(
    acquireDirectory,
    readTerrainTileIndex(await readJson(path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE))),
  );

  const sampledBySegment = segments.map((segment) =>
    Array.from({ length: CROSS_SECTION.sectionsPerSegment }, (_, index) =>
      sampleSection(terrain, segment, ((index + 0.5) / CROSS_SECTION.sectionsPerSegment) * segment.preciseLengthM),
    ),
  );

  // The bed profile uses every sampled section so the slope sees the whole network, not only representatives.
  // Network distance restarts on each TNC flowline, so each flowline (COMID) gets its own bed profile.
  const bedProfileByComid = new Map<number, { distanceM: number; bedM: number }[]>();
  sampledBySegment.forEach((sections, segmentIndex) => {
    const comid = segments[segmentIndex]?.comid ?? 0;
    const profile = bedProfileByComid.get(comid) ?? [];
    for (const section of sections) profile.push({ distanceM: section.networkDistanceM, bedM: section.bedElevationM });
    bedProfileByComid.set(comid, profile);
  });
  // Vertex order may run upstream or downstream; orient so slope is positive in the direction the bed falls.
  const downstreamSignByComid = new Map<number, number>();
  for (const [comid, profile] of bedProfileByComid) {
    downstreamSignByComid.set(comid, downstreamVertexDirection(profile.map((point) => point.bedM)));
  }
  const bedProfile = sampledBySegment.flat().map((section) => ({ distanceM: section.networkDistanceM, bedM: section.bedElevationM }));
  const downstreamSign = downstreamSignByComid.get(segments[0]?.comid ?? 0) ?? 1;

  const warnings: string[] = [];
  const records: CrossSectionRecord[] = segments.map((segment, segmentIndex) => {
    const sections = sampledBySegment[segmentIndex] ?? [];
    const segmentWarnings: string[] = [];
    const byArea = sections
      .map((section, index) => ({ index, area: section.areaAtReferenceDepthM2 }))
      .sort((a, b) => a.area - b.area);
    const representativeSectionIndex = byArea[Math.floor(byArea.length / 2)]?.index ?? 0;
    const representative = sections[representativeSectionIndex] as SampledSection;
    const rawSlope =
      (downstreamSignByComid.get(segment.comid) ?? 1) *
      windowedBedSlope(bedProfileByComid.get(segment.comid) ?? [], representative.networkDistanceM);
    const slopeFloored = rawSlope < CROSS_SECTION.minimumSlope;
    if (slopeFloored) {
      segmentWarnings.push(`min-slope: raw slope ${rawSlope.toFixed(5)} floored to ${CROSS_SECTION.minimumSlope}.`);
    }
    const missing = sections.reduce((sum, section) => sum + section.missingSamples, 0);
    if (missing > 0) segmentWarnings.push(`terrain-gap: ${missing} cross-section samples had no USGS 3DEP elevation.`);
    if (valleyEdgeTrimFallbackSides(representative) > 0) {
      const sides = [representative.valleyEdgeTrimFallbackLeft ? 'left' : '', representative.valleyEdgeTrimFallbackRight ? 'right' : ''].filter(Boolean);
      segmentWarnings.push(
        `valley-edge-trim-fallback: the representative section's ${sides.join(' and ')} valley edge is less than ` +
          `${CROSS_SECTION.valleyEdgeMinimumBankHeightM} m above the bed, so that side keeps the untrimmed half-section.`,
      );
    }
    for (const warning of segmentWarnings) warnings.push(`${segment.segmentId} ${warning}`);
    return {
      segmentId: segment.segmentId,
      networkDistanceMidM: round3(segment.networkDistanceStartM + segment.preciseLengthM / 2),
      bedElevationM: round3(representative.bedElevationM),
      rawSlope: roundToDecimals(rawSlope, 6),
      slope: roundToDecimals(Math.max(rawSlope, CROSS_SECTION.minimumSlope), 6),
      slopeFloored,
      representativeSectionIndex,
      lowestBankTopM: round3(representative.lowestBankTopM),
      sections: sections.map((section) => ({
        alongSegmentM: round3(section.alongSegmentM),
        networkDistanceM: round3(section.networkDistanceM),
        thalwegOffsetM: section.thalwegOffsetM,
        thalwegUtm: { x: round3(section.thalwegUtm.x), y: round3(section.thalwegUtm.y) },
        bedElevationM: round3(section.bedElevationM),
        areaAtReferenceDepthM2: round3(section.areaAtReferenceDepthM2),
        valleyEdgeLeftOffsetM: section.valleyEdgeLeftOffsetM,
        valleyEdgeRightOffsetM: section.valleyEdgeRightOffsetM,
        trimmedAtValleyEdge: section.trimmedAtValleyEdge,
        valleyEdgeTrimFallbackLeft: section.valleyEdgeTrimFallbackLeft,
        valleyEdgeTrimFallbackRight: section.valleyEdgeTrimFallbackRight,
        leftBankTopOffsetM: section.leftBankTopOffsetM,
        rightBankTopOffsetM: section.rightBankTopOffsetM,
      })),
      profileOffsetsM: representative.profile.map((sample) => sample.offsetM),
      profileElevationsM: representative.profile.map((sample) => round3(sample.elevationM)),
      warnings: segmentWarnings,
    };
  });

  const thalwegOffsets = thalwegOffsetDistribution(sampledBySegment.flat().map((section) => section.thalwegOffsetM));
  const sectionsAtSearchEdge = sampledBySegment
    .flat()
    .filter((section) => Math.abs(section.thalwegOffsetM) >= CROSS_SECTION.thalwegSearchHalfWidthM).length;
  if (sectionsAtSearchEdge > 0) {
    warnings.push(
      `thalweg-search-edge: ${sectionsAtSearchEdge} section(s) found their lowest ground at ±${CROSS_SECTION.thalwegSearchHalfWidthM} m; the true channel may lie farther out.`,
    );
  }

  const output: CrossSectionsFile = {
    segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion,
    description:
      'Representative cross-section per Creek Segment from USGS 3DEP 1 m terrain. Bed = thalweg = lowest ground within the thalweg search width; ' +
      'each section records its thalweg point (thalwegUtm, EPSG 32610 m) and elevation (bedElevationM). ' +
      'Valley-edge guard: each side is trimmed at its highest point between the thalweg and the sampled end, ' +
      'so the profile never reaches into a neighbouring valley; trimmed ends are valleyEdgeLeftOffsetM / valleyEdgeRightOffsetM. ' +
      `A trimmed side whose valley edge is less than ${CROSS_SECTION.valleyEdgeMinimumBankHeightM} m above the bed keeps the untrimmed ` +
      'half-section instead (valleyEdgeTrimFallbackLeft / valleyEdgeTrimFallbackRight), and Stage 2 caps the ladder on the other side. ' +
      'Bank tops (left/rightBankTopOffsetM) are the highest ground within the bank-top search half-width on each side. ' +
      'Slope = least-squares bed slope over a network window, floored at the minimum slope.',
    parameters: CROSS_SECTION,
    thalwegOffsetFromFlowlineM: thalwegOffsets,
    segments: records,
  };
  const outputPath = path.join(outputDirectory, CROSS_SECTIONS_FILE);
  await writeReadableJson(outputPath, output);

  const svgPath = path.join(outputDirectory, `cross-section-${INSPECTION_SEGMENT_ID}.svg`);
  const inspectionIndex = segments.findIndex((segment) => segment.segmentId === INSPECTION_SEGMENT_ID);
  const inspection = records[inspectionIndex];
  const inspectionSections = sampledBySegment[inspectionIndex];
  if (inspection && inspectionSections) {
    await writeInspectionSvg(svgPath, [
      {
        title: `Creek Segment ${INSPECTION_SEGMENT_ID} cross-sections (bed ${inspection.bedElevationM} m, slope ${inspection.slope})`,
        xLabel: 'Offset from TNC flowline (m, positive = left of vertex order)',
        yLabel: 'Ground elevation (m NAVD88)',
        series: [
          ...inspectionSections.map((section, index) => ({
            label: `section ${index}${index === inspection.representativeSectionIndex ? ' (representative)' : ''} at ${section.alongSegmentM.toFixed(1)} m`,
            points: section.profile.map((sample) => ({ x: sample.offsetM, y: sample.elevationM })),
            color: index === inspection.representativeSectionIndex ? '#1d4ed8' : '#9ca3af',
            strokeWidth: index === inspection.representativeSectionIndex ? 2.5 : 1,
          })),
          {
            label: `bed ${inspection.bedElevationM} m`,
            points: [
              { x: -CROSS_SECTION.halfWidthM, y: inspection.bedElevationM },
              { x: CROSS_SECTION.halfWidthM, y: inspection.bedElevationM },
            ],
            color: '#dc2626',
            dashed: true,
          },
        ],
      },
      {
        title: 'Bed profile along the network (all sampled sections)',
        xLabel: 'Distance along TNC flowline from vertex 0 (m)',
        yLabel: 'Bed elevation (m NAVD88)',
        series: [
          { label: 'sampled bed', points: bedProfile.map((point) => ({ x: point.distanceM, y: point.bedM })), color: '#0f766e' },
          {
            label: 'representative bed per segment',
            points: records.map((record) => ({ x: record.networkDistanceMidM, y: record.bedElevationM })),
            color: '#1d4ed8',
            dashed: true,
          },
        ],
      },
    ]);
  }

  // Drainage-area ratio: sample the flow-accumulation raster at each segment's downstream thalweg point.
  console.log('  Sampling the flow-accumulation raster at each downstream thalweg point…');
  const downstreamThalwegBySegmentId = new Map<string, UtmPoint>();
  segments.forEach((segment, segmentIndex) => {
    const sections = sampledBySegment[segmentIndex] ?? [];
    const runsDownstream = (downstreamSignByComid.get(segment.comid) ?? 1) > 0;
    const downstreamSection = runsDownstream ? sections[sections.length - 1] : sections[0];
    if (downstreamSection) downstreamThalwegBySegmentId.set(segment.segmentId, downstreamSection.thalwegUtm);
  });
  let lastLogged = 0;
  const drainageAreas = await sampleSegmentDrainageAreas({
    pointsBySegmentId: downstreamThalwegBySegmentId,
    cacheDirectory: acquireDirectory,
    onProgress: (done, total) => {
      if (done === total || Date.now() - lastLogged > 5000) {
        lastLogged = Date.now();
        console.log(`  Flow accumulation samples ${done} of ${total}`);
      }
    },
  });
  const assignments = await readNhdplusV2ReachAssignments(path.join(acquireDirectory, REACH_ASSIGNMENTS_FILE));
  const crosswalkResult = buildCrosswalkWithDrainageAreaRatios({ assignments, segmentAreaKm2BySegmentId: drainageAreas.areaKm2BySegmentId });
  warnings.push(...crosswalkResult.warnings);
  await writePrettyJson(NHDPLUSV2_CROSSWALK_PATH, crosswalkResult.crosswalk);
  const ratios = summarizeRatios(crosswalkResult.crosswalk.segments.map((segment) => segment.drainageAreaRatio));
  const inspectionCrosswalk = crosswalkResult.crosswalk.segments.find((segment) => segment.segmentId === INSPECTION_SEGMENT_ID);

  const allSections = sampledBySegment.flat();
  const sectionsTrimmedAtValleyEdge = allSections.filter((section) => section.trimmedAtValleyEdge).length;
  const valleyEdgeTrimFallbacks = allSections.reduce((sum, section) => sum + valleyEdgeTrimFallbackSides(section), 0);
  const valleyEdgeTrimFallbackSegments = records.filter((record) =>
    record.warnings.some((warning) => warning.startsWith('valley-edge-trim-fallback')),
  ).length;
  const transferSegments = crosswalkResult.crosswalk.segments.filter((segment) => segment[DRAINAGE_AREA_RATIO_TRANSFER.fieldName]);
  const flooredCount = records.filter((record) => record.slopeFloored).length;
  const slopes = records.map((record) => record.slope).sort((a, b) => a - b);
  return {
    outputFiles: [outputPath, ...(inspection ? [svgPath] : []), NHDPLUSV2_CROSSWALK_PATH, drainageAreas.cachePath],
    counts: {
      creekSegments: records.length,
      sectionsSampled: records.length * CROSS_SECTION.sectionsPerSegment,
      slopeFlooredSegments: flooredCount,
      thalwegSectionsAtSearchEdge: sectionsAtSearchEdge,
      sectionsTrimmedAtValleyEdge,
      valleyEdgeTrimFallbacks,
      valleyEdgeTrimFallbackSegments,
      drainageAreaRatioBelowOneSegments: ratios.belowOne,
      drainageAreaRatioTransferSegments: transferSegments.length,
      transferDistanceExceededSegments: transferSegments.filter(exceedsMaximumTransferDistance).length,
      segmentsWithoutDrainageArea: crosswalkResult.crosswalk.segments.filter((segment) => segment.segmentDrainageAreaKm2 === null).length,
      flowAccumulationSamplesFetched: drainageAreas.fetched,
      flowAccumulationSamplesReused: drainageAreas.reused,
    },
    warnings,
    measurements: {
      thalwegOffsetFromFlowlineM: thalwegOffsets,
      drainageAreaRatio: { min: ratios.min, median: ratios.median, max: ratios.max },
      inspectionSegmentDrainageArea: inspectionCrosswalk
        ? {
            segmentDrainageAreaKm2: inspectionCrosswalk.segmentDrainageAreaKm2,
            reachDrainageAreaKm2: inspectionCrosswalk.reachDrainageAreaKm2,
            drainageAreaRatio: inspectionCrosswalk.drainageAreaRatio,
          }
        : null,
    },
    summaryLines: [
      `${records.length} Creek Segments × ${CROSS_SECTION.sectionsPerSegment} sections; vertex order runs ${downstreamSign > 0 ? 'downstream' : 'upstream'}.`,
      `Thalweg offset from TNC flowline: median ${thalwegOffsets.medianM} m, p90 ${thalwegOffsets.p90M} m, max ${thalwegOffsets.maxM} m ` +
        `(search ±${CROSS_SECTION.thalwegSearchHalfWidthM} m; ${sectionsAtSearchEdge} at the edge).`,
      `Valley-edge guard trimmed ${sectionsTrimmedAtValleyEdge} of ${allSections.length} sections short of ±${CROSS_SECTION.halfWidthM} m; ` +
        `${valleyEdgeTrimFallbacks} section side(s) fell back to the untrimmed half-section (${valleyEdgeTrimFallbackSegments} representative sections).`,
      `Bed ${Math.min(...records.map((r) => r.bedElevationM))}–${Math.max(...records.map((r) => r.bedElevationM))} m; slope median ${slopes[Math.floor(slopes.length / 2)]}; ${flooredCount} floored at ${CROSS_SECTION.minimumSlope}.`,
      inspection ? `${INSPECTION_SEGMENT_ID}: bed ${inspection.bedElevationM} m, slope ${inspection.slope} (raw ${inspection.rawSlope}).` : '',
      `Drainage-area ratio: min ${ratios.min}, median ${ratios.median}, max ${ratios.max}; ${ratios.belowOne} of ${records.length} segments below 1 ` +
        `(${drainageAreas.fetched} raster samples fetched, ${drainageAreas.reused} reused).`,
      inspectionCrosswalk
        ? `${INSPECTION_SEGMENT_ID}: segment ${String(inspectionCrosswalk.segmentDrainageAreaKm2)} km² ÷ reach ${String(inspectionCrosswalk.reachDrainageAreaKm2)} km² = ratio ${inspectionCrosswalk.drainageAreaRatio}.`
        : '',
    ],
  };
}

await runStageEntryPoint(async () => {
  await refuseToOverwriteADifferentModeledWseVersion('01-cross-sections');
  await runStage({
    stage: '01-cross-sections',
    outputDirectory,
    inputFiles: [
      MODELED_EXTENT.flowlineSnapshotPath,
      path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE),
      ...readTerrainTileIndex(await readJson(path.join(acquireDirectory, TERRAIN_TILE_INDEX_FILE))).tiles.map((tile) =>
        path.join(acquireDirectory, tile.file),
      ),
      path.join(acquireDirectory, REACH_ASSIGNMENTS_FILE),
    ],
    parameters: { segmentNetworkVersion: MODELED_EXTENT.segmentNetworkVersion, ...CROSS_SECTION, drainageAreaRatio: DRAINAGE_AREA_RATIO },
    run: buildCrossSections,
  });
});
