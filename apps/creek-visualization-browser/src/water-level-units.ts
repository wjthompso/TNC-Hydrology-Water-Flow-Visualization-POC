// Units the Water-Surface Elevation Chart labels Anchor Water Depth in: water
// depth above the bed, in feet (the default) or meters. The chart's values are
// depths, not elevations on a datum, so observed and modeled readings share one
// scale: modeled depth is its WSE minus the WSE Anchor Point's bed; the
// observed gauge's depth is its gauge height.

const FEET_PER_METER = 1 / 0.3048;

export type WaterLevelUnit = 'ft' | 'm';

export const DEFAULT_WATER_LEVEL_UNIT: WaterLevelUnit = 'ft';

/** A new key, so a unit saved by the older WSE (NAVD88) toggle is ignored rather than read as a depth unit. */
const UNIT_STORAGE_KEY = 'tnc-water-depth-unit';

/** Water depth (m) in the chosen unit. */
export function toWaterLevelUnit(depthM: number, unit: WaterLevelUnit): number {
  return unit === 'm' ? depthM : depthM * FEET_PER_METER;
}

export function formatWaterLevel(depthM: number, unit: WaterLevelUnit): string {
  return `${toWaterLevelUnit(depthM, unit).toFixed(2)} ${unit}`;
}

/**
 * Anchor Water Depth Time Series (m): WSE minus the bed at the WSE Anchor
 * Point, clamped at 0 like `heldWaterDepthAt`. A missing reading stays missing.
 */
export function anchorWaterDepthSeriesM(
  waterSurfaceElevationM: readonly (number | null)[],
  anchorBedElevationM: number,
): (number | null)[] {
  return waterSurfaceElevationM.map((wseM) =>
    wseM === null ? null : Math.max(0, wseM - anchorBedElevationM),
  );
}

export function isWaterLevelUnit(value: unknown): value is WaterLevelUnit {
  return value === 'ft' || value === 'm';
}

export function readWaterLevelUnit(): WaterLevelUnit {
  try {
    const stored = localStorage.getItem(UNIT_STORAGE_KEY);
    if (isWaterLevelUnit(stored)) return stored;
  } catch {
    // Storage can be blocked; fall back to the default.
  }
  return DEFAULT_WATER_LEVEL_UNIT;
}

export function saveWaterLevelUnit(unit: WaterLevelUnit): void {
  try {
    localStorage.setItem(UNIT_STORAGE_KEY, unit);
  } catch {
    // Storage can be blocked; the choice still holds for this page.
  }
}
