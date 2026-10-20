// Units the Water-Surface Elevation Chart labels water-surface elevation (WSE)
// in. Both are absolute WSE on the NAVD88 (North American Vertical Datum of
// 1988) datum, in meters or feet, so observed and modeled values read the same
// way. Neither is relative to a gauge datum: modeled Creek Segments have none.

const FEET_PER_METER = 1 / 0.3048;

export type WaterLevelUnit = 'wse-navd88-m' | 'wse-navd88-ft';

const UNIT_STORAGE_KEY = 'tnc-water-level-unit';

/** Water-surface elevation (m NAVD88) in the chosen unit. */
export function toWaterLevelUnit(waterSurfaceElevationM: number, unit: WaterLevelUnit): number {
  return unit === 'wse-navd88-m' ? waterSurfaceElevationM : waterSurfaceElevationM * FEET_PER_METER;
}

export function formatWaterLevel(waterSurfaceElevationM: number, unit: WaterLevelUnit): string {
  const value = toWaterLevelUnit(waterSurfaceElevationM, unit);
  return unit === 'wse-navd88-m' ? `${value.toFixed(2)} m` : `${value.toFixed(2)} ft`;
}

export function isWaterLevelUnit(value: unknown): value is WaterLevelUnit {
  return value === 'wse-navd88-m' || value === 'wse-navd88-ft';
}

export function readWaterLevelUnit(): WaterLevelUnit {
  try {
    const stored = localStorage.getItem(UNIT_STORAGE_KEY);
    if (isWaterLevelUnit(stored)) return stored;
  } catch {
    // Storage can be blocked; fall back to the default.
  }
  return 'wse-navd88-m';
}

export function saveWaterLevelUnit(unit: WaterLevelUnit): void {
  try {
    localStorage.setItem(UNIT_STORAGE_KEY, unit);
  } catch {
    // Storage can be blocked; the choice still holds for this page.
  }
}
