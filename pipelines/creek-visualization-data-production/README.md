# Creek visualization data production

Offline pipeline for the Jalama Near Lompoc gauge (USGS 11120600) on TNC flowline COMID 27714637. Source Input Retention downloads snapshots. Publish then builds Creek Segments, the Monitoring Station Assignment, and the observed water-surface elevation series, and copies the prepared water-surface polygons from a reviewed snapshot of the modeled pipeline's Stage 4 output. The browser only reads the published files.

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
- `stage-04-junction-sloped-terrain-fill-v1-27714637-026-polygon-set.json` — reviewed copy of Stage 4's prepared water-surface polygon set for Creek Segment 27714637-026, WSE Polygon Generation Method `junction-sloped-terrain-fill` v1, in the published file's shape
- `stage-04-junction-sloped-terrain-fill-v1-27714637-026-polygon-set.provenance.json` — that snapshot's Stage 4 source path, source-file SHA-256, method id, version, and fingerprint, and its own SHA-256

Published Creek Visualization Data, fetched by the browser from `/published-creek-visualization-data/`:

- `creek-segments.json` — every Creek Segment on the flowline
- `water-surface-polygon-sets.json` — prepared polygons for the assigned segment only, a byte-for-byte copy of the retained Stage 4 snapshot
- `monitoring-stations.json`
- `data-source-metadata.json`
- `creek-segment-time-series/usgs-11120600-observed-wse.json`

## Water-surface elevation

WSE in meters NAVD88 (North American Vertical Datum of 1988) is `(gauge height in feet + 83.34) * 0.3048`. The gauge datum, 83.34 ft NAVD88, is treated as constant. Null gauge-height readings stay null. Missing 15-minute slots are not filled in.

## Observed water-surface polygons

Observed and modeled water draw one set of prepared water-surface polygons. Publish does not trace observed polygons. It copies `stage-04-junction-sloped-terrain-fill-v1-27714637-026-polygon-set.json` unchanged, which is Stage 4's polygon set for Creek Segment 27714637-026 from WSE Polygon Generation Method `junction-sloped-terrain-fill` v1 (see [modeled-water-surface-elevation/METHODOLOGY.md](modeled-water-surface-elevation/METHODOLOGY.md#wse-polygon-generation-methods)). Its buckets are half-open `[minimum, maximum)`: 0.05 m steps from the 0.05 m multiple at or below the Stage 1 bed (25.70 m), then 0.25 m steps to at least 2 m above the highest modeled WSE (34.15 m). Every observed reading (26.31–28.95 m) falls in one. Each polygon was traced on the Stage 0 USGS 3DEP tiles inside a 100 m corridor cut at the junction bisectors, so it can carry a wet threshold that slopes between junction WSEs. The browser does not build this geometry.

Segment Network Release Validation checks that the buckets ascend without gaps or overlap, that every observed reading falls in one, and that every ring vertex lies inside that bisector-cut corridor's bounding box. Publish measures the corridor on the retained USGS 3DEP window.

To refresh the snapshot after a new Stage 4 method or version, rerun `npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach`, extract segment 27714637-026 from `04-water-surface-polygons/<method-id>/v<version>/water-surface-polygon-sets/27714637.json` in the same shape, rename the snapshot for the new method and version, update its provenance file and `OBSERVED_POLYGON_SET_SNAPSHOT_FILE` in `constants.ts`, review it, and run `npm run pipeline:publish`.

## Modeled water-surface elevation

`npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach` runs a separate staged pipeline. It turns California Natural Flows and NOAA National Water Model discharge into a modeled WSE Time Series, prepared water-surface polygons, and a validated catalog for every Creek Segment in one extent. `jalama-gauge-reach` is the 61-segment dev extent. `dangermond-preserve` covers all 105 preserve flowlines and is the default. It writes only to `data/modeled-water-surface-elevation-pipeline-output/<extentId>/`, which git ignores, plus one tracked crosswalk per extent in `data/retained-backend-source-data/reviewed-assignments/`. It does not touch the published files above; observed polygons change only when the retained Stage 4 snapshot is refreshed by hand (see [Observed water-surface polygons](#observed-water-surface-polygons)). See [modeled-water-surface-elevation/METHODOLOGY.md](modeled-water-surface-elevation/METHODOLOGY.md) for the stages, equation, parameters, and limitations. Stage 4 runs one versioned WSE Polygon Generation Method at a time (`--wse-polygon-method=<method-id>`) and keeps each version's output side by side; [WSE Polygon Generation Methods](modeled-water-surface-elevation/METHODOLOGY.md#wse-polygon-generation-methods) covers the folder layout, the version bump rule, and how to add a method.
