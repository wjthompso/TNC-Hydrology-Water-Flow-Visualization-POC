import { COMID } from './constants.ts';
import { expectNumber, expectRecord, isRecord } from './json-files.ts';
import { roundToDecimals, utm10nToWgs84, type UtmPoint } from './utm-geometry.ts';

export interface CreekSegment {
  segmentId: string;
  comid: number;
  vertexIndexStart: number;
  vertexIndexEnd: number;
  /** Length rounded to centimeters for the published record. */
  lengthM: number;
  preciseLengthM: number;
  startUtm: UtmPoint;
  endUtm: UtmPoint;
  pathWgs84: [number, number][];
}

export function creekSegmentId(comid: number, vertexIndexStart: number): string {
  return `${comid}-${String(vertexIndexStart).padStart(3, '0')}`;
}

function expectWkid32610(response: Record<string, unknown>, label: string): void {
  if (!('spatialReference' in response)) throw new Error(`${label} spatial reference is missing.`);
  const spatialReference = response.spatialReference;
  if (!isRecord(spatialReference)) throw new Error(`${label} spatial reference is not an object.`);
  const wkid = spatialReference.wkid ?? spatialReference.latestWkid;
  if (wkid !== 32610) {
    throw new Error(`${label} spatial reference is ${String(wkid)}, expected EPSG 32610.`);
  }
}

function readVertex(vertex: unknown, label: string, index: number): UtmPoint {
  if (!Array.isArray(vertex) || vertex.length < 2) {
    throw new Error(`${label} vertex ${index} is not a coordinate pair.`);
  }
  const x = vertex[0];
  const y = vertex[1];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} vertex ${index} is not finite.`);
  }
  return { x, y };
}

function publishedPath(point: UtmPoint): [number, number] {
  const [longitude, latitude] = utm10nToWgs84(point.x, point.y);
  return [roundToDecimals(longitude, 7), roundToDecimals(latitude, 7)];
}

/**
 * Cut one TNC flowline into Creek Segments at its original vertices.
 * Vertices are not resampled.
 */
export function segmentTncFlowline(flowlineResponse: unknown): CreekSegment[] {
  const response = expectRecord(flowlineResponse, 'TNC flowline');
  expectWkid32610(response, 'TNC flowline');
  if (!Array.isArray(response.features) || response.features.length !== 1) {
    throw new Error(`TNC flowline returned ${Array.isArray(response.features) ? response.features.length : 0} features, expected 1.`);
  }
  const feature = expectRecord(response.features[0], 'TNC flowline feature');
  const attributes = expectRecord(feature.attributes, 'TNC flowline attributes');
  const comid = expectNumber(attributes, 'COMID', 'TNC flowline');
  if (comid !== COMID) throw new Error(`TNC flowline COMID is ${comid}, expected ${COMID}.`);

  const geometry = expectRecord(feature.geometry, 'TNC flowline geometry');
  if (!Array.isArray(geometry.paths) || geometry.paths.length !== 1) {
    throw new Error(`TNC flowline has ${Array.isArray(geometry.paths) ? geometry.paths.length : 0} paths, expected 1.`);
  }
  const path = geometry.paths[0];
  if (!Array.isArray(path) || path.length < 2) {
    throw new Error('TNC flowline path needs at least two original vertices.');
  }

  const vertices = path.map((vertex, index) => readVertex(vertex, 'TNC flowline', index));
  const segments: CreekSegment[] = [];
  for (let index = 0; index < vertices.length - 1; index += 1) {
    const startUtm = vertices[index];
    const endUtm = vertices[index + 1];
    if (!startUtm || !endUtm) continue;
    const preciseLengthM = Math.hypot(endUtm.x - startUtm.x, endUtm.y - startUtm.y);
    segments.push({
      segmentId: creekSegmentId(comid, index),
      comid,
      vertexIndexStart: index,
      vertexIndexEnd: index + 1,
      lengthM: roundToDecimals(preciseLengthM, 2),
      preciseLengthM,
      startUtm,
      endUtm,
      pathWgs84: [publishedPath(startUtm), publishedPath(endUtm)],
    });
  }
  if (segments.length === 0) throw new Error('TNC flowline produced no Creek Segments.');
  return segments;
}

/**
 * Cut every TNC flowline in a query response into Creek Segments at original vertices,
 * using the same rule as `segmentTncFlowline`. A flowline with several paths keeps one
 * vertex numbering across its paths; the last vertex of one path and the first of the next
 * are not adjacent, so no Creek Segment spans the gap. Flowlines are ordered by COMID.
 */
export function segmentTncFlowlines(flowlineResponse: unknown): CreekSegment[] {
  const response = expectRecord(flowlineResponse, 'TNC flowlines');
  expectWkid32610(response, 'TNC flowlines');
  if (!Array.isArray(response.features) || response.features.length === 0) {
    throw new Error('TNC flowlines response has no features.');
  }
  const features = response.features.map((value, index) => {
    const feature = expectRecord(value, `TNC flowline feature ${index}`);
    const attributes = expectRecord(feature.attributes, `TNC flowline feature ${index} attributes`);
    return { feature, comid: expectNumber(attributes, 'COMID', `TNC flowline feature ${index}`) };
  });
  features.sort((a, b) => a.comid - b.comid);
  const segments: CreekSegment[] = [];
  const seenComids = new Set<number>();
  for (const { feature, comid } of features) {
    const label = `TNC flowline ${comid}`;
    if (seenComids.has(comid)) throw new Error(`${label} appears more than once.`);
    seenComids.add(comid);
    const geometry = expectRecord(feature.geometry, `${label} geometry`);
    if (!Array.isArray(geometry.paths) || geometry.paths.length === 0) throw new Error(`${label} has no paths.`);
    let vertexIndex = 0;
    for (const path of geometry.paths) {
      if (!Array.isArray(path) || path.length < 2) throw new Error(`${label} has a path with fewer than two vertices.`);
      const vertices = path.map((vertex, index) => readVertex(vertex, label, vertexIndex + index));
      for (let index = 0; index < vertices.length - 1; index += 1) {
        const startUtm = vertices[index];
        const endUtm = vertices[index + 1];
        if (!startUtm || !endUtm) continue;
        const preciseLengthM = Math.hypot(endUtm.x - startUtm.x, endUtm.y - startUtm.y);
        if (preciseLengthM === 0) continue;
        segments.push({
          segmentId: creekSegmentId(comid, vertexIndex + index),
          comid,
          vertexIndexStart: vertexIndex + index,
          vertexIndexEnd: vertexIndex + index + 1,
          lengthM: roundToDecimals(preciseLengthM, 2),
          preciseLengthM,
          startUtm,
          endUtm,
          pathWgs84: [publishedPath(startUtm), publishedPath(endUtm)],
        });
      }
      vertexIndex += vertices.length;
    }
  }
  if (segments.length === 0) throw new Error('TNC flowlines produced no Creek Segments.');
  return segments;
}
