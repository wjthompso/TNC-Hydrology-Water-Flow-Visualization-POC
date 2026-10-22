/**
 * Reads the developer's LOCAL modeled water-surface elevation pipeline output
 * (git-ignored, under data/pipeline-working-output/)
 * for the F-140 seam tests. Nothing here touches the browser.
 *
 * Approved fixture decision (UCS-271 seam tests, 2026-10-16): the tests read
 * local output rather than a reviewed fixture. When that output is missing the
 * caller must report inconclusive or skip with the message from
 * `missingLocalPipelineOutput`, never pass.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { utm10nToWgs84 } from '../../../../../pipelines/creek-visualization-data-production/utm-geometry.ts';

export const JALAMA_EXTENT_ID = 'jalama-gauge-reach';
export const JALAMA_TNC_COMID = '27714637';
export const NATIONAL_WATER_MODEL_HOURLY_DATASET_ID = 'national-water-model-hourly';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const pipelineOutputRoot = path.join(repositoryRoot, 'data/pipeline-working-output');
const publishedCreekSegmentsFile = path.join(
  repositoryRoot,
  'apps/creek-visualization-browser/public/published-creek-visualization-data/creek-segments.json',
);

const CROSS_SECTIONS_RELATIVE_PATH = '01-cross-sections/cross-sections.json';

export function localPipelineOutputDirectory(extentId: string): string {
  return path.join(pipelineOutputRoot, extentId);
}

/** Water year: Oct 1 through Sep 30, named for the year it ends in. */
export function waterYearOf(timeUtcMs: number): number {
  const date = new Date(timeUtcMs);
  return date.getUTCMonth() >= 9 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

function hourlyTimeSeriesRelativePath(datasetId: string, comid: string, timeUtcMs: number): string {
  return `03-time-series/time-series/${datasetId}/water-surface-elevation/${comid}/WY${waterYearOf(timeUtcMs)}.json`;
}

/**
 * Null when every file the tests need is present. Otherwise a message that
 * names the missing file and the command that produces it.
 */
export function missingLocalPipelineOutput(input: {
  extentId: string;
  datasetId: string;
  comid: string;
  timesUtcMs: readonly number[];
}): string | null {
  const directory = localPipelineOutputDirectory(input.extentId);
  const needed = [
    CROSS_SECTIONS_RELATIVE_PATH,
    ...input.timesUtcMs.map((time) => hourlyTimeSeriesRelativePath(input.datasetId, input.comid, time)),
  ];
  const missing = needed.filter((relative) => !existsSync(path.join(directory, relative)));
  if (missing.length === 0) return null;
  return (
    `Local pipeline output for extent ${input.extentId} is missing ${missing.join(', ')} ` +
    `under ${directory}. Run \`npm run pipeline:modeled-wse:all -- --extent=${input.extentId}\` first. ` +
    'The test cannot check the seam without it.'
  );
}

// ---------------------------------------------------------------------------
// Stage 1 cross-sections: thalweg points and representative bed per Creek Segment

export interface ThalwegPoint {
  readonly longitude: number;
  readonly latitude: number;
  readonly bedElevationM: number;
  readonly alongSegmentM: number;
}

export interface SegmentThalweg {
  readonly segmentId: string;
  /** Representative bed elevation Stage 1 chose for the whole segment, m. */
  readonly bedElevationM: number;
  /** Stage 1 thalweg points in the segment's own along-segment order. */
  readonly points: readonly ThalwegPoint[];
}

export interface CrossSectionsSummary {
  readonly segmentNetworkVersion: string;
  readonly bySegmentId: ReadonlyMap<string, SegmentThalweg>;
  /** Segment ids of one TNC flowline in ascending id order. */
  segmentIdsOfComid(comid: string): string[];
  /**
   * +1 when a higher segment index is farther downstream on that flowline, −1
   * otherwise. Same rule as Stage 1: the first sampled bed versus the last.
   */
  downstreamIndexDirection(comid: string): 1 | -1;
}

interface CrossSectionsFileShape {
  segmentNetworkVersion: string;
  segments: {
    segmentId: string;
    bedElevationM: number;
    sections: { alongSegmentM: number; thalwegUtm: { x: number; y: number }; bedElevationM: number }[];
  }[];
}

export function tncComidOfSegmentId(segmentId: string): string {
  return segmentId.split('-')[0] ?? segmentId;
}

export function readCrossSections(extentId: string): CrossSectionsSummary {
  const file = JSON.parse(
    readFileSync(path.join(localPipelineOutputDirectory(extentId), CROSS_SECTIONS_RELATIVE_PATH), 'utf8'),
  ) as CrossSectionsFileShape;
  const bySegmentId = new Map<string, SegmentThalweg>();
  for (const record of file.segments) {
    bySegmentId.set(record.segmentId, {
      segmentId: record.segmentId,
      bedElevationM: record.bedElevationM,
      points: record.sections.map((section) => {
        const [longitude, latitude] = utm10nToWgs84(section.thalwegUtm.x, section.thalwegUtm.y);
        return { longitude, latitude, bedElevationM: section.bedElevationM, alongSegmentM: section.alongSegmentM };
      }),
    });
  }
  const segmentIdsOfComid = (comid: string): string[] =>
    [...bySegmentId.keys()].filter((id) => tncComidOfSegmentId(id) === comid).sort();
  return {
    segmentNetworkVersion: file.segmentNetworkVersion,
    bySegmentId,
    segmentIdsOfComid,
    downstreamIndexDirection(comid) {
      const ids = segmentIdsOfComid(comid);
      const first = bySegmentId.get(ids[0] ?? '');
      const last = bySegmentId.get(ids[ids.length - 1] ?? '');
      const firstBed = first?.points[0]?.bedElevationM ?? 0;
      const lastPoints = last?.points ?? [];
      const lastBed = lastPoints[lastPoints.length - 1]?.bedElevationM ?? 0;
      return firstBed - lastBed >= 0 ? 1 : -1;
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 3 Time Series: one water-surface elevation per Creek Segment at one hour

/** Null when the file has no slot for that exact timestamp. */
export function readWaterSurfaceElevationsAt(input: {
  extentId: string;
  datasetId: string;
  comid: string;
  timeUtcMs: number;
}): ReadonlyMap<string, number | null> | null {
  const file = JSON.parse(
    readFileSync(
      path.join(
        localPipelineOutputDirectory(input.extentId),
        hourlyTimeSeriesRelativePath(input.datasetId, input.comid, input.timeUtcMs),
      ),
      'utf8',
    ),
  ) as { timestampsUtcMs: number[]; segments: { segmentId: string; values: (number | null)[] }[] };
  const slot = file.timestampsUtcMs.indexOf(input.timeUtcMs);
  if (slot < 0) return null;
  return new Map(file.segments.map((segment) => [segment.segmentId, segment.values[slot] ?? null]));
}

// ---------------------------------------------------------------------------
// Junction geometry: the thalweg polyline across two neighbouring Creek Segments

export interface LonLat {
  readonly longitude: number;
  readonly latitude: number;
}

export interface Junction {
  readonly upstreamSegmentId: string;
  readonly downstreamSegmentId: string;
  /** The flowline vertex the two Creek Segments share, from the published creek-segments file. */
  readonly sharedVertexWgs84: LonLat;
  /** Stage 1 bed elevation at the shared vertex, interpolated along the thalweg, m. */
  readonly sharedVertexBedElevationM: number;
  /** Thalweg points of both segments ordered upstream to downstream. */
  readonly thalwegUpstreamToDownstream: readonly ThalwegPoint[];
  /** Distance along that polyline where it crosses from the upstream into the downstream segment, m. */
  readonly crossingAlongM: number;
}

export interface JunctionSample extends LonLat {
  /** Signed distance along the thalweg from the crossing; negative is upstream. */
  readonly alongFromCrossingM: number;
  /** Stage 1 thalweg bed elevation interpolated at this sample, m. */
  readonly bedElevationM: number;
  /** The Creek Segment this sample lies in. */
  readonly segmentId: string;
}

const EARTH_RADIUS_M = 6_378_137;

/** Local flat frame in meters around an origin; exact enough over a few hundred meters. */
function localFrame(origin: LonLat) {
  const cosLatitude = Math.cos((origin.latitude * Math.PI) / 180);
  const metersPerDegree = (EARTH_RADIUS_M * Math.PI) / 180;
  return {
    toLocal(point: LonLat): { x: number; y: number } {
      return {
        x: (point.longitude - origin.longitude) * metersPerDegree * cosLatitude,
        y: (point.latitude - origin.latitude) * metersPerDegree,
      };
    },
    toLonLat(local: { x: number; y: number }): LonLat {
      return {
        longitude: origin.longitude + local.x / (metersPerDegree * cosLatitude),
        latitude: origin.latitude + local.y / metersPerDegree,
      };
    },
  };
}

function readPublishedSegmentPaths(): Map<string, [number, number][]> {
  const file = JSON.parse(readFileSync(publishedCreekSegmentsFile, 'utf8')) as {
    creekSegments: { segmentId: string; pathWgs84: [number, number][] }[];
  };
  return new Map(file.creekSegments.map((segment) => [segment.segmentId, segment.pathWgs84]));
}

/**
 * Builds the junction between two neighbouring Creek Segments: the shared
 * flowline vertex, the two segments' Stage 1 thalweg points ordered upstream
 * to downstream, and where that thalweg polyline crosses the shared boundary.
 * The boundary is the perpendicular to the mean flow direction at the vertex.
 */
export function readJunction(
  crossSections: CrossSectionsSummary,
  segmentIdA: string,
  segmentIdB: string,
): Junction {
  const comid = tncComidOfSegmentId(segmentIdA);
  if (tncComidOfSegmentId(segmentIdB) !== comid) {
    throw new Error(`${segmentIdA} and ${segmentIdB} are not on the same TNC flowline.`);
  }
  const direction = crossSections.downstreamIndexDirection(comid);
  const [upstreamSegmentId, downstreamSegmentId] =
    (segmentIdA < segmentIdB) === (direction === 1) ? [segmentIdA, segmentIdB] : [segmentIdB, segmentIdA];
  const upstream = crossSections.bySegmentId.get(upstreamSegmentId);
  const downstream = crossSections.bySegmentId.get(downstreamSegmentId);
  if (!upstream || !downstream) {
    throw new Error(`cross-sections.json has no record for ${upstreamSegmentId} or ${downstreamSegmentId}.`);
  }

  const paths = readPublishedSegmentPaths();
  const upstreamPath = paths.get(upstreamSegmentId);
  const downstreamPath = paths.get(downstreamSegmentId);
  if (!upstreamPath || !downstreamPath) {
    throw new Error(`The published creek-segments file is missing ${upstreamSegmentId} or ${downstreamSegmentId}.`);
  }
  const shared = upstreamPath.find(([lon, lat]) =>
    downstreamPath.some(([lon2, lat2]) => lon === lon2 && lat === lat2),
  );
  if (!shared) throw new Error(`${upstreamSegmentId} and ${downstreamSegmentId} share no flowline vertex.`);
  const sharedVertexWgs84: LonLat = { longitude: shared[0], latitude: shared[1] };

  // Flow direction of each segment, oriented upstream to downstream.
  const frame = localFrame(sharedVertexWgs84);
  const flowVector = (pathWgs84: [number, number][]): { x: number; y: number } => {
    const first = frame.toLocal({ longitude: pathWgs84[0][0], latitude: pathWgs84[0][1] });
    const last = pathWgs84[pathWgs84.length - 1];
    const end = frame.toLocal({ longitude: last[0], latitude: last[1] });
    const dx = (end.x - first.x) * direction;
    const dy = (end.y - first.y) * direction;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  };
  const flowA = flowVector(upstreamPath);
  const flowB = flowVector(downstreamPath);
  const bisectorLength = Math.hypot(flowA.x + flowB.x, flowA.y + flowB.y) || 1;
  const bisector = { x: (flowA.x + flowB.x) / bisectorLength, y: (flowA.y + flowB.y) / bisectorLength };

  const orderedPoints = (segment: SegmentThalweg): ThalwegPoint[] =>
    direction === 1 ? [...segment.points] : [...segment.points].reverse();
  const thalwegUpstreamToDownstream = [...orderedPoints(upstream), ...orderedPoints(downstream)];

  // Signed along-flow coordinate of every polyline point relative to the vertex.
  const locals = thalwegUpstreamToDownstream.map((point) => frame.toLocal(point));
  const alongFlow = locals.map((local) => local.x * bisector.x + local.y * bisector.y);
  const cumulative: number[] = [0];
  for (let index = 1; index < locals.length; index += 1) {
    const previous = locals[index - 1] as { x: number; y: number };
    const current = locals[index] as { x: number; y: number };
    cumulative.push((cumulative[index - 1] as number) + Math.hypot(current.x - previous.x, current.y - previous.y));
  }
  let crossingAlongM: number | null = null;
  for (let index = 1; index < alongFlow.length; index += 1) {
    const before = alongFlow[index - 1] as number;
    const after = alongFlow[index] as number;
    if (before < 0 && after >= 0) {
      const fraction = before / (before - after);
      crossingAlongM =
        (cumulative[index - 1] as number) + fraction * ((cumulative[index] as number) - (cumulative[index - 1] as number));
      break;
    }
  }
  if (crossingAlongM === null) {
    throw new Error(
      `The thalweg polyline of ${upstreamSegmentId} and ${downstreamSegmentId} never crosses their shared boundary.`,
    );
  }
  const crossing = pointAlong(thalwegUpstreamToDownstream, cumulative, crossingAlongM, frame);
  return {
    upstreamSegmentId,
    downstreamSegmentId,
    sharedVertexWgs84,
    sharedVertexBedElevationM: crossing.bedElevationM,
    thalwegUpstreamToDownstream,
    crossingAlongM,
  };
}

function pointAlong(
  points: readonly ThalwegPoint[],
  cumulative: readonly number[],
  alongM: number,
  frame: ReturnType<typeof localFrame>,
): LonLat & { bedElevationM: number } {
  const total = cumulative[cumulative.length - 1] as number;
  const clamped = Math.max(0, Math.min(total, alongM));
  let index = 1;
  while (index < cumulative.length - 1 && (cumulative[index] as number) < clamped) index += 1;
  const from = points[index - 1] as ThalwegPoint;
  const to = points[index] as ThalwegPoint;
  const span = (cumulative[index] as number) - (cumulative[index - 1] as number) || 1;
  const fraction = (clamped - (cumulative[index - 1] as number)) / span;
  const a = frame.toLocal(from);
  const b = frame.toLocal(to);
  const lonLat = frame.toLonLat({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction });
  return { ...lonLat, bedElevationM: from.bedElevationM + (to.bedElevationM - from.bedElevationM) * fraction };
}

/**
 * Creek-bed sample points along the junction's thalweg polyline at the given
 * signed distances from the boundary crossing (negative is upstream). Distances
 * beyond the polyline's ends are dropped.
 */
export function junctionSamplesAt(junction: Junction, distancesFromCrossingM: readonly number[]): JunctionSample[] {
  const frame = localFrame(junction.sharedVertexWgs84);
  const points = junction.thalwegUpstreamToDownstream;
  const locals = points.map((point) => frame.toLocal(point));
  const cumulative: number[] = [0];
  for (let index = 1; index < locals.length; index += 1) {
    const previous = locals[index - 1] as { x: number; y: number };
    const current = locals[index] as { x: number; y: number };
    cumulative.push((cumulative[index - 1] as number) + Math.hypot(current.x - previous.x, current.y - previous.y));
  }
  const total = cumulative[cumulative.length - 1] as number;
  const samples: JunctionSample[] = [];
  for (const distance of distancesFromCrossingM) {
    const alongM = junction.crossingAlongM + distance;
    if (alongM < 0 || alongM > total) continue;
    const point = pointAlong(points, cumulative, alongM, frame);
    samples.push({
      ...point,
      alongFromCrossingM: distance,
      segmentId: distance < 0 ? junction.upstreamSegmentId : junction.downstreamSegmentId,
    });
  }
  return samples;
}

/** Evenly spaced signed distances, `-halfWindowM .. +halfWindowM` at `spacingM`, excluding exactly 0. */
export function symmetricDistances(halfWindowM: number, spacingM: number): number[] {
  const distances: number[] = [];
  for (let distance = -halfWindowM; distance <= halfWindowM + 1e-9; distance += spacingM) {
    const rounded = Math.round(distance * 1000) / 1000;
    if (rounded !== 0) distances.push(rounded);
  }
  return distances;
}
