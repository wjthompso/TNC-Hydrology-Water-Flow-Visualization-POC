/** Query flag for a timeline-only page. Honored only while the test server sets VITE_TEST_MODE. */
export const TIMELINE_FIXTURE_PARAM = 'timeline';
export const TIMELINE_FIXTURE_VALUE = 'fixture';
/** Real published record, real opening slot, no 3D scene. */
export const TIMELINE_OPENING_VALUE = 'opening';

export function timelineOnlyMode(
  locationSearch: string,
  testMode: boolean,
): 'fixture' | 'opening' | null {
  if (!testMode) return null;
  const value = new URLSearchParams(locationSearch).get(TIMELINE_FIXTURE_PARAM);
  if (value === TIMELINE_FIXTURE_VALUE || value === TIMELINE_OPENING_VALUE) return value;
  return null;
}

export function isTimelineFixtureRequest(locationSearch: string, testMode: boolean): boolean {
  return timelineOnlyMode(locationSearch, testMode) === 'fixture';
}

export function timelineFixturePath(): string {
  return `/?${TIMELINE_FIXTURE_PARAM}=${TIMELINE_FIXTURE_VALUE}`;
}

export function timelineOpeningPath(): string {
  return `/?${TIMELINE_FIXTURE_PARAM}=${TIMELINE_OPENING_VALUE}`;
}
