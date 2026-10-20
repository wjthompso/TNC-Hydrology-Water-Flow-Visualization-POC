// Scene imagery choices (UCS-262), kept free of ArcGIS imports so tests and the
// test catalog can name the exact imagery dataset a page opened with. Each choice
// is a Preserve Aerial Imagery Overlay over the Esri World Imagery base imagery,
// or the base imagery alone (see docs/architecture/glossary.md).

export const SCENE_IMAGERY_QUERY_PARAM = 'imagery';

const ESRI_WORLD_IMAGERY_CREDIT = 'Esri, Maxar, Earthstar Geographics, and the GIS User Community';

export const SCENE_IMAGERY_OPTIONS = [
  {
    id: 'preserve-2024',
    label: 'Overlay: Preserve aerial, Jan 2024 (8 cm)',
    datasetName:
      'Jack and Laura Dangermond Preserve Aerial Imagery - 2024 (8 cm, January 2024, via Vandenberg), over Esri World Imagery outside the Preserve',
    credit: `Dangermond Preserve aerial imagery, January 2024, via Vandenberg; ${ESRI_WORLD_IMAGERY_CREDIT} outside the Preserve`,
  },
  {
    id: 'preserve-2019',
    label: 'Overlay: Preserve aerial, Oct 2019',
    datasetName:
      'Dangermond Preserve Imagery 2019 (4-band, October 2019, flown for Vandenberg), over Esri World Imagery outside the Preserve',
    credit: `Dangermond Preserve aerial imagery, October 2019, flown for Vandenberg; ${ESRI_WORLD_IMAGERY_CREDIT} outside the Preserve`,
  },
  {
    id: 'esri-world-imagery',
    label: 'Base only: Esri World Imagery (50 cm)',
    datasetName: 'Esri World Imagery',
    credit: ESRI_WORLD_IMAGERY_CREDIT,
  },
] as const;

export type SceneImageryId = (typeof SCENE_IMAGERY_OPTIONS)[number]['id'];

/** The sharpest Preserve imagery opens by default. */
export const DEFAULT_SCENE_IMAGERY_ID: SceneImageryId = 'preserve-2024';

/**
 * Cheapest imagery to draw. Tests whose promise is about water or terrain, not
 * imagery, open with it so each scene load stays short.
 */
export const FAST_TEST_SCENE_IMAGERY_ID: SceneImageryId = 'esri-world-imagery';

export function readSceneImageryId(locationSearch: string): SceneImageryId {
  const requested = new URLSearchParams(locationSearch).get(SCENE_IMAGERY_QUERY_PARAM);
  const option = SCENE_IMAGERY_OPTIONS.find((item) => item.id === requested);
  return option?.id ?? DEFAULT_SCENE_IMAGERY_ID;
}

export function sceneImageryOption(id: SceneImageryId): (typeof SCENE_IMAGERY_OPTIONS)[number] {
  const option = SCENE_IMAGERY_OPTIONS.find((item) => item.id === id);
  if (!option) throw new Error(`Unknown scene imagery: ${id}`);
  return option;
}

export function sceneImageryCredit(id: SceneImageryId): string {
  return sceneImageryOption(id).credit;
}

/** Adds the imagery choice to a page path, leaving the default out of the URL. */
export function withSceneImagery(pathAndQuery: string, id: SceneImageryId): string {
  if (id === DEFAULT_SCENE_IMAGERY_ID) return pathAndQuery;
  const [pathname, query = ''] = pathAndQuery.split('?');
  const params = new URLSearchParams(query);
  params.set(SCENE_IMAGERY_QUERY_PARAM, id);
  return `${pathname}?${params.toString()}`;
}
