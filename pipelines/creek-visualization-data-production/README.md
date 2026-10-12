# Creek visualization data production

Offline pipeline for the Jalama Near Lompoc gauge (USGS 11120600) on TNC flowline COMID 27714637. Source Input Retention downloads snapshots. Publish then builds Creek Segments, the Monitoring Station Assignment, the observed water-surface elevation series, and prepared water-surface polygons. The browser only reads the published files.

## Commands

From the repository root:

- `npm run pipeline:acquire` downloads Retained Backend Source Data into `data/retained-backend-source-data/`. It needs the network.
- `npm run pipeline:publish` reads those snapshots and writes Published Creek Visualization Data to `apps/creek-visualization-browser/public/published-creek-visualization-data/`. It does not use the network. Running it twice writes the same bytes.

Acquire centers the USGS 3DEP window on the assigned Creek Segment, using the same nearest-segment calculation as publish. The reviewed assignment file is written only by publish.

## What goes where

Retained Backend Source Data:

- `tnc-flowline-27714637.json` — raw TNC flowline in EPSG 32610 (UTM zone 10N, meters)
- `usgs-11120600-station.json` — raw gauge location
- `usgs-11120600-observations.json` — gauge-height rows merged across pages, plus the request parameters
- `usgs-3dep-1m-window-jalama-27714637.tif` — USGS 3DEP 1 m bare-earth window, 400 m by 400 m
- `retention-manifest.json` — request URLs and retrieval times
- `reviewed-assignments/monitoring-station-assignment-usgs-11120600.json` — chosen Creek Segment, snap distance, and runner-up

Published Creek Visualization Data, fetched by the browser from `/published-creek-visualization-data/`:

- `creek-segments.json` — every Creek Segment on the flowline
- `water-surface-polygon-sets.json` — prepared polygons for the assigned segment only
- `monitoring-stations.json`
- `data-source-metadata.json`
- `creek-segment-time-series/usgs-11120600-observed-wse.json`

## Water-surface elevation

WSE in meters NAVD88 (North American Vertical Datum of 1988) is `(gauge height in feet + 83.34) * 0.3048`. The gauge datum, 83.34 ft NAVD88, is treated as constant. Null gauge-height readings stay null. Missing 15-minute slots are not filled in.

## Elevation buckets

Buckets are half-open 0.05 m steps `[minimum, maximum)`, from the 0.05 m multiple at or below the lowest reading through the bucket that contains the highest. Each prepared polygon is built at the bucket minimum, so the map never shows a higher water surface than that reading. A bucket with no wet ground is still published, with an empty ring list.

## Corridor

The polygon stays in the slab between the lines perpendicular to the Creek Segment through its original endpoints, and within 100 m of either side of that segment. USGS 3DEP cells below the bucket elevation are kept only when they are 8-connected to a wet cell under the segment centerline. The centerline is sampled at 0.5 m. The browser does not build this geometry.
