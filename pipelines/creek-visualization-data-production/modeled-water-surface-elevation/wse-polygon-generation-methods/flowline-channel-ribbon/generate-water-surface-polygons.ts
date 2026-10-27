import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { adjacentSegmentsById, type NetworkCreekSegment } from '../../creek-segment-network.ts';
import { roundToDecimals, utm10nToWgs84 } from '../../../utm-geometry.ts';
import {
  bedAt,
  buildRunChannel,
  isBreachedStation,
  orientRun,
  segmentRuns,
  thalwegPoint,
  waterSurfaceStations,
  type OrientedSegment,
  type RunChannel,
} from '../../modeled-wse-derivation-methods/m3-flowline-profile-manning-depth/flowline-channel.ts';
import { LidarMosaic } from '../../modeled-wse-derivation-methods/m3-flowline-profile-manning-depth/lidar-mosaic.ts';
import { CHANNEL_PROFILE } from '../../modeled-wse-derivation-methods/m3-flowline-profile-manning-depth/method-config.ts';
import {
  downstreamVertexDirectionByTncComid,
  tncComidOfSegmentId,
  type CrossSectionRecord,
  type PolygonLaddersFile,
  type WaterSurfacePolygonSetsFile,
} from '../../stage-file-formats.ts';
import type { WsePolygonMethodInputs, WsePolygonMethodResult } from '../wse-polygon-generation-method-generators.ts';
import { FLOWLINE_CHANNEL_RIBBON_METHOD } from './method-config.ts';
import { computeRibbonEdges, type RibbonEdges } from './ribbon-offsets.ts';

/**
 * WSE Polygon Generation Method `flowline-channel-ribbon` (Stage 4). For every run of joined Creek Segments of every flowline: build the m3
 * channel (smoothed lidar-traced centerline, raw lidar bed at the lowest point of every station, breached through tall short barriers), compute
 * the ribbon edges for every depth rung, and write each Creek Segment's rungs as vertex-aligned morph-target rings on m3's water-surface
 * stations, the stations Stage 3 pool-fills the water surface on. See METHOD.md and DESIGN.md in this folder.
 */

const PARAMETERS = FLOWLINE_CHANNEL_RIBBON_METHOD.parameters;
type PolygonSet = WaterSurfacePolygonSetsFile['waterSurfacePolygonSets'][number];

/** What a ribbon polygon set carries besides its buckets (see `channelRibbonFields` in method-config.ts). */
interface ChannelRibbonSummary {
  stationCount: number;
  lengthM: number;
  anchorLonLat: [number, number];
  anchorBedElevationM: number;
  /** Which of the segment's stations is the WSE Anchor Point. */
  anchorStation: number;
  /** The next Creek Segment of the run in flow order, or null at the run's downstream end: the browser pool-fills the run along this chain. */
  downstreamSegmentId: string | null;
  /** Stations whose bed is a breach line through a barrier (the water passes through the fill there). */
  breachedStations: number;
  /** Each station's distance from the segment's upstream boundary station along the centerline, m: where m3 smooths the water surface. */
  stationDistancesM: number[];
  trueTopWidthAtAnchorM: number[];
  displayTopWidthAtAnchorM: number[];
}

/** Value of a dense-table array at a fractional station index (linear). */
function sampleAt(array: ArrayLike<number>, stationIndex: number): number {
  const low = Math.floor(stationIndex);
  const high = Math.min(array.length - 1, low + 1);
  const t = stationIndex - low;
  const a = array[low] as number;
  const b = array[high] as number;
  return a + t * (b - a);
}

interface SegmentRibbon {
  polygonSet: PolygonSet & { channelRibbon?: ChannelRibbonSummary };
  ladder: PolygonLaddersFile['segments'][number];
  vertexCount: number;
  /** Per rung: stations whose edge point is behind the previous station's along the centerline (the ribbon folds there). */
  foldedStationsByRung: number[];
}

/** Centerline point and left normal of a table station. */
function frameOf(channel: RunChannel, station: number): { x: number; y: number; normalX: number; normalY: number } {
  return { x: channel.x[station] as number, y: channel.y[station] as number, normalX: channel.normalX[station] as number, normalY: channel.normalY[station] as number };
}

/** The ribbon of one Creek Segment between table stations `first` and `last` of its run's channel, on m3's water-surface stations. */
function segmentRibbon(
  channel: RunChannel,
  edges: RibbonEdges,
  segment: { segmentId: string; downstreamSegmentId: string | null },
  first: number,
  last: number,
): SegmentRibbon {
  const { segmentId } = segment;
  const rungs = edges.rungDepthsM;
  const lengthM = (last - first) * channel.spacingM;
  const { stations: stationIndices, anchorStation, stationDistancesM } = waterSurfaceStations(channel, first, last);
  const stationCount = stationIndices.length;
  const bedProfileM = stationIndices.map((index) => roundToDecimals(channel.bedM[index] as number, 3));
  const frames = stationIndices.map((index) => frameOf(channel, index));
  const foldedStationsByRung = rungs.map(() => 0);
  const buckets: PolygonSet['elevationBuckets'] = rungs.map((rungDepthM, rung) => {
    const leftEdge = edges.left[rung] as Float32Array;
    const rightEdge = edges.right[rung] as Float32Array;
    const vertex = (station: number, offsetM: number): [number, number, number] => {
      const frame = frames[station] as (typeof frames)[number];
      const [longitude, latitude] = utm10nToWgs84(frame.x + frame.normalX * offsetM, frame.y + frame.normalY * offsetM);
      return [roundToDecimals(longitude, 7), roundToDecimals(latitude, 7), bedProfileM[station] as number];
    };
    const left = stationIndices.map((index, station) => vertex(station, sampleAt(leftEdge, index)));
    const right = stationIndices.map((index, station) => vertex(station, sampleAt(rightEdge, index)));
    // A station whose edge point is behind the previous one along the centerline is a fold (the ribbon would twist there).
    {
      for (let station = 1; station < stationCount; station += 1) {
        const previous = frames[station - 1] as (typeof frames)[number];
        const current = frames[station] as (typeof frames)[number];
        const tangentX = current.normalY;
        const tangentY = -current.normalX;
        for (const side of [leftEdge, rightEdge]) {
          const a = sampleAt(side, stationIndices[station - 1] as number);
          const b = sampleAt(side, stationIndices[station] as number);
          const dx = current.x + current.normalX * b - (previous.x + previous.normalX * a);
          const dy = current.y + current.normalY * b - (previous.y + previous.normalY * a);
          if (dx * tangentX + dy * tangentY <= 0) {
            foldedStationsByRung[rung] = (foldedStationsByRung[rung] as number) + 1;
            break;
          }
        }
      }
    }
    return {
      minWaterSurfaceElevationM: rungDepthM,
      maxWaterSurfaceElevationM: rung === rungs.length - 1 ? PARAMETERS.topBucketMaximumDepthM : (rungs[rung + 1] as number),
      // Left edge upstream to downstream, then right edge back: clockwise, as the renderer expects for an outer ring.
      ringsWgs84: [[...left, ...right.reverse()] as unknown as [number, number][]],
    };
  });

  const anchorIndex = stationIndices[anchorStation] as number;
  const anchorPoint = thalwegPoint(channel, anchorIndex);
  const [anchorLongitude, anchorLatitude] = utm10nToWgs84(anchorPoint.x, anchorPoint.y);
  // The lidar at the anchor point, as the Time Series stores it (the station's bed, except on a segment wholly on a breach).
  const anchorBedElevationM = roundToDecimals(channel.thalwegM[anchorIndex] as number, 3);
  const summary: ChannelRibbonSummary = {
    stationCount,
    lengthM: roundToDecimals(lengthM, 2),
    // 8 decimals (about 1 mm) so the lidar read back at this point is the anchor bed within a millimeter or two even on steep ground.
    anchorLonLat: [roundToDecimals(anchorLongitude, 8), roundToDecimals(anchorLatitude, 8)],
    anchorBedElevationM,
    anchorStation,
    downstreamSegmentId: segment.downstreamSegmentId,
    breachedStations: stationIndices.filter((index) => isBreachedStation(channel, index)).length,
    stationDistancesM,
    trueTopWidthAtAnchorM: rungs.map((_depth, rung) => roundToDecimals(sampleAt(edges.trueTopWidthM[rung] as Float32Array, anchorIndex), 2)),
    displayTopWidthAtAnchorM: rungs.map((_depth, rung) =>
      roundToDecimals(sampleAt(edges.left[rung] as Float32Array, anchorIndex) - sampleAt(edges.right[rung] as Float32Array, anchorIndex), 2),
    ),
  };
  const topRungM = rungs[rungs.length - 1] as number;
  return {
    polygonSet: { segmentId, elevationBuckets: buckets, channelRibbon: summary },
    ladder: {
      segmentId,
      bedElevationM: anchorBedElevationM,
      maxModeledWaterSurfaceElevationM: roundToDecimals(anchorBedElevationM + topRungM, 3),
      ceilingM: roundToDecimals(anchorBedElevationM + topRungM, 3),
      fineBuckets: rungs.length,
      coarseBuckets: 0,
      emptyBuckets: 0,
    },
    vertexCount: stationCount * 2 * rungs.length,
    foldedStationsByRung,
  };
}

/** A sanity check against the m3 Time Series: every segment's anchor bed must equal the bed this stage computes, or the chart and the drawn water disagree. */
async function anchorBedMismatches(
  timeSeriesFilePaths: readonly string[],
  anchorBedBySegmentId: ReadonlyMap<string, number>,
): Promise<{ checked: number; mismatched: string[] }> {
  const monthlyFiles = timeSeriesFilePaths.filter((filePath) => filePath.includes(`${path.sep}california-natural-flows-monthly${path.sep}`));
  let checked = 0;
  const mismatched: string[] = [];
  for (const filePath of monthlyFiles) {
    const file = JSON.parse(await readFile(filePath, 'utf8')) as { segments: { segmentId: string; anchorBedElevationM?: number }[] };
    for (const segment of file.segments) {
      const mine = anchorBedBySegmentId.get(segment.segmentId);
      if (mine === undefined || typeof segment.anchorBedElevationM !== 'number') continue;
      checked += 1;
      if (Math.abs(segment.anchorBedElevationM - mine) > 0.0015) mismatched.push(`${segment.segmentId} (Time Series ${segment.anchorBedElevationM}, ribbon ${mine})`);
    }
  }
  return { checked, mismatched };
}

export async function generateFlowlineChannelRibbonPolygons(inputs: WsePolygonMethodInputs): Promise<WsePolygonMethodResult> {
  const { segments, crossSections } = inputs;
  const recordById: ReadonlyMap<string, CrossSectionRecord> = new Map(crossSections.segments.map((record) => [record.segmentId, record]));
  const directionByTncComid = downstreamVertexDirectionByTncComid(crossSections);
  const adjacentById = adjacentSegmentsById(segments);
  const networkIndexById = new Map(segments.map((segment, index) => [segment.segmentId, index]));
  const mosaic = LidarMosaic.fromElevationGrids(inputs.terrainTiles);
  const segmentsByComid = new Map<string, NetworkCreekSegment[]>();
  for (const segment of segments) {
    const comid = tncComidOfSegmentId(segment.segmentId);
    segmentsByComid.set(comid, [...(segmentsByComid.get(comid) ?? []), segment]);
  }

  const warnings: string[] = [];
  const ribbons: { networkIndex: number; ribbon: SegmentRibbon }[] = [];
  const anchorBedBySegmentId = new Map<string, number>();
  let stationsAtSearchEdge = 0;
  const foldedStationsByRung = PARAMETERS.rungDepthsM.map(() => 0);
  let emptySegments = 0;
  let processedFlowlines = 0;
  for (const [tncComid, flowlineSegments] of segmentsByComid) {
    for (const run of segmentRuns(flowlineSegments, adjacentById)) {
      const oriented = orientRun(run, recordById, directionByTncComid.get(tncComid) ?? 1);
      const points = oriented.flatMap((segment: OrientedSegment) => [segment.upstreamVertex, segment.downstreamVertex]);
      const margin = CHANNEL_PROFILE.valleyBottomFit.searchHalfWidthM + CHANNEL_PROFILE.crossSection.halfWidthM + 10;
      const window = await mosaic.window(
        Math.min(...points.map((point) => point.x)) - margin,
        Math.min(...points.map((point) => point.y)) - margin,
        Math.max(...points.map((point) => point.x)) + margin,
        Math.max(...points.map((point) => point.y)) + margin,
      );
      const channel = buildRunChannel(oriented, window);
      stationsAtSearchEdge += channel.stationsAtSearchEdge;
      const edges = computeRibbonEdges(channel);
      oriented.forEach((segment, position) => {
        const first = channel.boundaries[position] as number;
        const last = channel.boundaries[position + 1] as number;
        const networkIndex = networkIndexById.get(segment.segmentId) as number;
        if (last <= first) {
          emptySegments += 1;
          warnings.push(`${segment.segmentId} has no ribbon: its two boundaries coincide on the centerline.`);
          ribbons.push({
            networkIndex,
            ribbon: {
              polygonSet: { segmentId: segment.segmentId, elevationBuckets: [] },
              ladder: { segmentId: segment.segmentId, bedElevationM: bedAt(channel, first), maxModeledWaterSurfaceElevationM: bedAt(channel, first), ceilingM: bedAt(channel, first), fineBuckets: 0, coarseBuckets: 0, emptyBuckets: 0 },
              vertexCount: 0,
              foldedStationsByRung: PARAMETERS.rungDepthsM.map(() => 0),
            },
          });
          return;
        }
        const ribbon = segmentRibbon(channel, edges, { segmentId: segment.segmentId, downstreamSegmentId: oriented[position + 1]?.segmentId ?? null }, first, last);
        ribbon.foldedStationsByRung.forEach((folds, rung) => (foldedStationsByRung[rung] = (foldedStationsByRung[rung] as number) + folds));
        anchorBedBySegmentId.set(segment.segmentId, ribbon.ladder.bedElevationM);
        ribbons.push({ networkIndex, ribbon });
      });
    }
    processedFlowlines += 1;
    if (processedFlowlines % 10 === 0 || processedFlowlines === segmentsByComid.size) {
      console.log(`  Ribbons: ${processedFlowlines} of ${segmentsByComid.size} flowlines, ${ribbons.length} Creek Segments`);
    }
  }
  ribbons.sort((a, b) => a.networkIndex - b.networkIndex);

  const { checked, mismatched } = await anchorBedMismatches(inputs.timeSeriesFilePaths, anchorBedBySegmentId);
  if (mismatched.length > 0) {
    warnings.push(
      `${mismatched.length} of ${checked} anchor beds in the Time Series differ from the bed this method computes (the Time Series and the polygons were built by different code): ${mismatched.slice(0, 5).join('; ')}.`,
    );
  }
  const foldsUpToOneMeter = foldedStationsByRung.reduce((sum, folds, rung) => ((PARAMETERS.rungDepthsM[rung] as number) <= 1 ? sum + folds : sum), 0);
  const totalFolds = foldedStationsByRung.reduce((sum, folds) => sum + folds, 0);
  if (totalFolds > 0) {
    warnings.push(`${totalFolds} ribbon station-rungs fold back along the centerline (an edge point behind the previous station), ${foldsUpToOneMeter} of them at rungs up to 1 m deep.`);
  }

  const totalVertices = ribbons.reduce((sum, entry) => sum + entry.ribbon.vertexCount, 0);
  const rungCount = PARAMETERS.rungDepthsM.length;
  return {
    polygonSets: ribbons.map((entry) => entry.ribbon.polygonSet),
    ladders: {
      segmentNetworkVersion: inputs.segmentNetworkVersion,
      description:
        `DEPTH-rung ladder per Creek Segment (bucket min/max in the polygon sets are depths in m above the local thalweg, not elevations): ${rungCount} rungs from ${PARAMETERS.rungDepthsM[0]} m ` +
        `to ${PARAMETERS.rungDepthsM[rungCount - 1]} m, the same for every segment. Here bedElevationM is the bed profile elevation at the anchor point, ` +
        'and maxModeledWaterSurfaceElevationM = ceilingM = anchor bed + the top rung depth.',
      segments: ribbons.map((entry) => entry.ribbon.ladder),
    },
    counts: {
      depthRungBuckets: ribbons.reduce((sum, entry) => sum + entry.ribbon.polygonSet.elevationBuckets.length, 0),
      ringVertices: totalVertices,
      segmentsWithoutRibbon: emptySegments,
      centerlineStationsAtSearchEdge: stationsAtSearchEdge,
      foldedStationRungs: totalFolds,
      foldedStationRungsUpToOneMeter: foldsUpToOneMeter,
      anchorBedsChecked: checked,
      anchorBedMismatches: mismatched.length,
    },
    warnings,
    summaryLines: [
      `${ribbons.length} Creek Segments, ${rungCount} depth rungs each, ${totalVertices} ring vertices; ${emptySegments} without a ribbon.`,
      `${stationsAtSearchEdge} centerline station(s) whose valley-bottom fit ended at the search edge; folded stations per rung: ${foldedStationsByRung.join(', ')}.`,
      `Anchor beds checked against the m3 Time Series: ${checked}, ${mismatched.length} mismatched.`,
    ],
  };
}
