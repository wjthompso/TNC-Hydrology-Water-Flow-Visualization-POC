// Tooltip wording for the Dev tools metrics that describe the selected water polygon or Creek
// Segment, outside the Water click inspector (whose rows carry their own text in
// water-click-readout.ts). Each text is one to three plain-English sentences.

export const WATER_CLICK_INSPECTOR_TIP =
  'Click water to read the numbers behind it. Each row is tagged model truth (from the pipeline’s Time Series and saved polygons), what we draw (after the visibility boost), browser terrain (what the 3D scene’s ground does), or measured ground (1 m lidar, read by the dev server). “Bed” always means the pipeline’s estimate; “ground” always means a measured or sampled surface. Hover or focus any (i) for how a row is computed and how it relates to its neighbors.';

export const ANCHOR_WATER_MARKER_TIP =
  'The pink flag floats above the WSE Anchor Point on a callout line, so the ground cannot hide it. The pink dot at its foot is the water we draw at the anchor (the Time Series value when no water is drawn). When the water is drawn underground, the dot is hidden under the browser terrain.';

export const ANCHOR_BED_MARKER_TIP =
  'The pipeline’s bed estimate at the anchor (Anchor bed elevation), with a pink line up to the drawn water. It is an estimate, not a measured ground height. It is hidden when it lies below the browser terrain, which is common on steep creeks.';

export const ANCHOR_LIDAR_GROUND_MARKER_TIP =
  'The measured 1 m lidar ground at the anchor’s longitude and latitude (bilinear between the four 1 m cell centers around it). Drawn only when the dev server can read the local lidar tiles; hosted data has none. It is often hidden, because the browser terrain usually sits above the lidar on steep ground (compare the ground rows).';

export const WSE_OVERRIDE_TIP =
  'Temporarily draws the Selected Creek Segment at a water height you type, so you can compare polygons at the same level. Nothing is saved; Clear or selecting another segment goes back to the Dataset’s value.';

export const WSE_OVERRIDE_TARGET_TIP =
  'The Selected Creek Segment: the one you picked by clicking its water. The override applies to it only.';

export const WSE_OVERRIDE_ANCHOR_UNIT_TIP =
  'NAVD88 (North American Vertical Datum of 1988) is the height-above-sea-level scale. For depth-based methods (the ribbon and HAND) the typed value is the WSE (water-surface elevation) at the segment’s anchor point, the same number the chart plots; the rest of the water follows from the bed and the depth.';

export const WSE_OVERRIDE_PLAIN_UNIT_TIP =
  'NAVD88 (North American Vertical Datum of 1988) is the height-above-sea-level scale. The typed value is the WSE (water-surface elevation: the water’s height above sea level) the segment is drawn at.';

export const WSE_OVERRIDE_STATUS_TIP =
  '“Dataset value” means the water is drawn from the Time Series. “Pinned” means it is drawn from your typed value until you clear it or select another segment.';

export const SEGMENT_PLACEMENTS_TIP =
  'Each Creek Segment drawn now and the water height of the polygon drawn for it. Depth-based methods (the ribbon and HAND) list the modeled WSE (water-surface elevation) and the depth bucket; elevation-bucket methods list the bucket’s lowest water height.';

export const WATER_SURFACE_READING_TIP_MODELED =
  'The modeled WSE (water-surface elevation: the water’s height above sea level, NAVD88) of the selected Creek Segment at its anchor point at the selected time. It is the value the chart plots, with no visibility boost.';

export const WATER_SURFACE_READING_TIP_OBSERVED =
  'The WSE (water-surface elevation: the water’s height above sea level, NAVD88) observed at the USGS gauge at the selected time.';

export const DRAWN_ELEVATION_TIP =
  'Water height of the polygon actually drawn for the selected segment, and its gap to the reading above. Elevation-bucket methods draw a pre-built polygon at the bucket’s floor, so it can sit a few centimeters off; depth-based methods (the ribbon and HAND) report the modeled WSE itself.';

export const SEGMENT_BADGE_TIP =
  'The last part of the selected Creek Segment’s id, for example 044 of 27714697-044.';
