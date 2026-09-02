import type { MeshData } from './types';

export const MAX_WATER_STAGE_FT = 3;
export const FT_TO_M = 0.3048;

const BASE_HALF_WIDTH_M = 4;
const WIDTH_GROWTH_PER_M_STAGE = 1.8;

export type CenterlinePoint = {
  x: number;
  y: number;
  lon: number;
  lat: number;
  valleyMinElevationM: number;
};

export function feetToMeters(feet: number): number {
  return feet * FT_TO_M;
}

export function metersToFeet(meters: number): number {
  return meters / FT_TO_M;
}

export function formatStageLabel(feet: number): string {
  if (feet < 0.001) return 'Baseline (0 ft)';
  const meters = feetToMeters(feet);
  const ftDisplay =
    Math.abs(feet - Math.round(feet)) < 0.001
      ? String(Math.round(feet))
      : feet.toFixed(2).replace(/\.?0+$/, '');
  return `${ftDisplay} ft (+${meters.toFixed(2)} m)`;
}

function perpendicularUnitNormal(
  centerline: CenterlinePoint[],
  index: number,
): { nx: number; ny: number } {
  const pt = centerline[index];
  const prev = centerline[Math.max(0, index - 1)];
  const next = centerline[Math.min(centerline.length - 1, index + 1)];
  const metersPerLon = 111320 * Math.cos((pt.lat * Math.PI) / 180);
  const dx = (next.lon - prev.lon) * metersPerLon;
  const dy = (next.lat - prev.lat) * 111320;
  const len = Math.hypot(dx, dy) || 1;
  return { nx: -dy / len, ny: dx / len };
}

/** Local-meter ribbon mesh for Three.js (positions + indices). */
export function buildRibbonMesh(
  centerline: CenterlinePoint[],
  stageOffsetM: number,
): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const halfWidth = BASE_HALF_WIDTH_M + stageOffsetM * WIDTH_GROWTH_PER_M_STAGE;

  for (let i = 0; i < centerline.length; i++) {
    const pt = centerline[i];
    const { nx, ny } = perpendicularUnitNormal(centerline, i);
    const waterZ = pt.valleyMinElevationM + stageOffsetM;

    positions.push(
      pt.x + nx * halfWidth,
      pt.y + ny * halfWidth,
      waterZ,
      pt.x - nx * halfWidth,
      pt.y - ny * halfWidth,
      waterZ,
    );
  }

  for (let i = 0; i < centerline.length - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }

  return { positions, indices };
}

function ribbonBankPoint(
  centerline: CenterlinePoint[],
  index: number,
  halfWidth: number,
  stageOffsetM: number,
  groundDraped: boolean,
  side: 1 | -1,
): number[] {
  const pt = centerline[index];
  const { nx, ny } = perpendicularUnitNormal(centerline, index);
  const metersPerLon = 111320 * Math.cos((pt.lat * Math.PI) / 180);
  const z = groundDraped ? 0 : pt.valleyMinElevationM + stageOffsetM;

  return [
    pt.lon + (side * nx * halfWidth) / metersPerLon,
    pt.lat + (side * ny * halfWidth) / 111320,
    z,
  ];
}

/** One quad ring per centerline segment for stable ArcGIS water tessellation. */
export function buildWaterRibbonSegmentRings(
  centerline: CenterlinePoint[],
  stageOffsetM: number,
  groundDraped = false,
): number[][][] {
  if (centerline.length < 2) return [];

  const halfWidth = BASE_HALF_WIDTH_M + stageOffsetM * WIDTH_GROWTH_PER_M_STAGE;
  const rings: number[][][] = [];

  for (let i = 0; i < centerline.length - 1; i++) {
    const ring = [
      ribbonBankPoint(centerline, i, halfWidth, stageOffsetM, groundDraped, 1),
      ribbonBankPoint(centerline, i, halfWidth, stageOffsetM, groundDraped, -1),
      ribbonBankPoint(centerline, i + 1, halfWidth, stageOffsetM, groundDraped, -1),
      ribbonBankPoint(centerline, i + 1, halfWidth, stageOffsetM, groundDraped, 1),
    ];
    ring.push(ring[0]);
    rings.push(ring);
  }

  return rings;
}
