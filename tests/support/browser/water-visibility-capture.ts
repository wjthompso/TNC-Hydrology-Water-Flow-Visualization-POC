/**
 * JSON shape emitted by the dev HUD's water-visibility capture, mirrored at
 * `apps/creek-visualization-browser/src/dev-tools-capture-schema.ts`. Keep both
 * files identical: a future replay Feature Behavior Test will consume captures
 * produced by the running app, so property names and types must line up.
 *
 * This module is Node-safe. Do not import `@arcgis/core` here.
 */

export interface CapturedHit {
  layerId: string | null;
  graphicType: 'water-surface' | 'other';
  segmentId: string | null;
  bucketMinElevationM: number | null;
  bucketMaxElevationM: number | null;
  mapPointWgs84: { longitude: number; latitude: number; z: number | null } | null;
  distanceM: number | null;
}

export interface CapturedCameraPose {
  positionWgs84: [number, number, number];
  headingDegrees: number;
  tiltDegrees: number;
}

export interface WaterVisibilityCapture {
  screenPoint: { x: number; y: number };
  cameraPose: CapturedCameraPose;
  mapHitWgs84: { longitude: number; latitude: number; z: number | null } | null;
  hits: CapturedHit[];
}

/** The dev HUD renders a 1280x800 scene surface, so the capture must land inside it. */
const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 800;
const SEGMENT_ID_PATTERN = /^\d{8}-\d{3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function assertScreenPoint(screenPoint: unknown): void {
  if (!isRecord(screenPoint)) {
    throw new Error('capture.screenPoint must be an object with x and y numbers.');
  }
  const { x, y } = screenPoint;
  if (!isFiniteNumber(x) || x < 0 || x > SCREEN_WIDTH) {
    throw new Error(
      `capture.screenPoint.x must be a finite number in [0, ${SCREEN_WIDTH}]; got ${String(x)}.`,
    );
  }
  if (!isFiniteNumber(y) || y < 0 || y > SCREEN_HEIGHT) {
    throw new Error(
      `capture.screenPoint.y must be a finite number in [0, ${SCREEN_HEIGHT}]; got ${String(y)}.`,
    );
  }
}

function assertCameraPose(cameraPose: unknown): void {
  if (!isRecord(cameraPose)) {
    throw new Error('capture.cameraPose must be an object.');
  }
  const { positionWgs84, headingDegrees, tiltDegrees } = cameraPose;
  if (!Array.isArray(positionWgs84) || positionWgs84.length !== 3) {
    throw new Error('capture.cameraPose.positionWgs84 must be a [longitude, latitude, z] tuple.');
  }
  for (let index = 0; index < 3; index += 1) {
    if (!isFiniteNumber(positionWgs84[index])) {
      throw new Error(
        `capture.cameraPose.positionWgs84[${index}] must be a finite number; got ${String(positionWgs84[index])}.`,
      );
    }
  }
  if (!isFiniteNumber(headingDegrees)) {
    throw new Error(
      `capture.cameraPose.headingDegrees must be a finite number; got ${String(headingDegrees)}.`,
    );
  }
  if (!isFiniteNumber(tiltDegrees)) {
    throw new Error(
      `capture.cameraPose.tiltDegrees must be a finite number; got ${String(tiltDegrees)}.`,
    );
  }
}

function assertMapPoint(path: string, mapPoint: unknown): void {
  if (mapPoint === null) return;
  if (!isRecord(mapPoint)) {
    throw new Error(`${path} must be an object or null.`);
  }
  const { longitude, latitude, z } = mapPoint;
  if (!isFiniteNumber(longitude)) {
    throw new Error(`${path}.longitude must be a finite number; got ${String(longitude)}.`);
  }
  if (!isFiniteNumber(latitude)) {
    throw new Error(`${path}.latitude must be a finite number; got ${String(latitude)}.`);
  }
  if (!isNullableFiniteNumber(z)) {
    throw new Error(`${path}.z must be a finite number or null; got ${String(z)}.`);
  }
}

function assertHit(index: number, hit: unknown): void {
  if (!isRecord(hit)) {
    throw new Error(`capture.hits[${index}] must be an object.`);
  }
  const { layerId, graphicType, segmentId, bucketMinElevationM, bucketMaxElevationM, mapPointWgs84, distanceM } = hit;
  if (layerId !== null && typeof layerId !== 'string') {
    throw new Error(`capture.hits[${index}].layerId must be a string or null.`);
  }
  if (graphicType !== 'water-surface' && graphicType !== 'other') {
    throw new Error(
      `capture.hits[${index}].graphicType must be "water-surface" or "other"; got ${String(graphicType)}.`,
    );
  }
  if (segmentId !== null) {
    if (typeof segmentId !== 'string' || !SEGMENT_ID_PATTERN.test(segmentId)) {
      throw new Error(
        `capture.hits[${index}].segmentId must match NNNNNNNN-NNN or be null; got ${String(segmentId)}.`,
      );
    }
  }
  if (!isNullableFiniteNumber(bucketMinElevationM)) {
    throw new Error(
      `capture.hits[${index}].bucketMinElevationM must be a finite number or null; got ${String(bucketMinElevationM)}.`,
    );
  }
  if (!isNullableFiniteNumber(bucketMaxElevationM)) {
    throw new Error(
      `capture.hits[${index}].bucketMaxElevationM must be a finite number or null; got ${String(bucketMaxElevationM)}.`,
    );
  }
  assertMapPoint(`capture.hits[${index}].mapPointWgs84`, mapPointWgs84);
  if (!isNullableFiniteNumber(distanceM)) {
    throw new Error(
      `capture.hits[${index}].distanceM must be a finite number or null; got ${String(distanceM)}.`,
    );
  }
}

/**
 * Throws a clear error naming the first malformed field, so a replay test can
 * surface a readable diagnostic before trying to use the capture.
 */
export function assertWellFormedCapture(capture: unknown): asserts capture is WaterVisibilityCapture {
  if (!isRecord(capture)) {
    throw new Error('capture must be a JSON object.');
  }
  assertScreenPoint(capture.screenPoint);
  assertCameraPose(capture.cameraPose);
  assertMapPoint('capture.mapHitWgs84', capture.mapHitWgs84);
  if (!Array.isArray(capture.hits)) {
    throw new Error('capture.hits must be an array.');
  }
  capture.hits.forEach((hit, index) => assertHit(index, hit));
}
