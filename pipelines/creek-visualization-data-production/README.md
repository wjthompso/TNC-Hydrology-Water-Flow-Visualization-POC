# Creek visualization data production

Offline pipeline for the Jalama Near Lompoc gauge (USGS 11120600) on TNC flowline COMID 27714637. Source Input Retention downloads snapshots. Publish then builds Creek Segments, the Monitoring Station Assignment, and the observed water-surface elevation series, and copies the prepared water-surface polygons from a reviewed snapshot of the modeled pipeline's Stage 4 output. The browser only reads the published files.

## Commands

From the repository root:

- `npm run pipeline:acquire` downloads source snapshots into the tracked source inputs folder, `data/source-inputs/`. It needs the network.
- `npm run pipeline:publish` reads those snapshots and writes Published Creek Visualization Data to `apps/creek-visualization-browser/public/published-creek-visualization-data/`. It does not use the network. Running it twice writes the same bytes.

Acquire centers the USGS 3DEP window on the assigned Creek Segment, using the same nearest-segment calculation as publish. The reviewed assignment file is written only by publish.

## What goes where

Source inputs (`data/source-inputs/`; the whole `data/` layout is in [data/README.md](../../data/README.md)):

- `tnc-flowline-27714637.json` — raw TNC flowline in EPSG 32610 (UTM zone 10N, meters)
- `usgs-11120600-station.json` — raw gauge location
- `usgs-11120600-observations.json` — gauge-height rows merged across pages, plus the request parameters
- `usgs-3dep-1m-window-jalama-27714637.tif` — USGS 3DEP 1 m bare-earth window, 400 m by 400 m
- `retention-manifest.json` — request URLs and retrieval times
- `reviewed-assignments/monitoring-station-assignment-usgs-11120600.json` — chosen Creek Segment, snap distance, and runner-up
- `stage-04-junction-sloped-terrain-fill-v1-27714637-026-polygon-set.json` — reviewed copy of Stage 4's prepared water-surface polygon set for Creek Segment 27714637-026, WSE Polygon Generation Method `junction-sloped-terrain-fill` v1, in the published file's shape
- `stage-04-junction-sloped-terrain-fill-v1-27714637-026-polygon-set.provenance.json` — that snapshot's Stage 4 source path, source-file SHA-256, method id, version, and fingerprint, and its own SHA-256
- `stage-01-cross-section-beds-27714637.json` — Stage 1's representative bed (`bedElevationM`) of every Creek Segment on the flowline, plus Stage 1's flow-direction verdict (observed WSE propagation, below)
- `stage-04-junction-sloped-terrain-fill-v1-27714637-gauge-neighbours-polygon-sets.json` — reviewed copy of Stage 4's polygon sets for the Creek Segments within the propagation hop count of the gauge segment, in the published file's shape, with a `.provenance.json` beside it

Published Creek Visualization Data, fetched by the browser from `/published-creek-visualization-data/`:

- `creek-segments.json` — every Creek Segment on the flowline
- `water-surface-polygon-sets.json` — prepared polygons for the assigned segment first, a byte-for-byte copy of the retained Stage 4 snapshot, then the propagation neighbours' sets from their retained snapshot
- `observed-wse-propagation.json` — the gauge segment and its propagation neighbours: role, hops from the gauge, bed elevation, and flow-order neighbour ids
- `monitoring-stations.json`
- `data-source-metadata.json`
- `creek-segment-time-series/usgs-11120600-observed-wse.json`

## Water-surface elevation

WSE in meters NAVD88 (North American Vertical Datum of 1988) is `(gauge height in feet + 83.34) * 0.3048`. The gauge datum, 83.34 ft NAVD88, is treated as constant. Null gauge-height readings stay null. Missing 15-minute slots are not filled in.

## Observed water-surface polygons

Observed and modeled water draw one set of prepared water-surface polygons. Publish does not trace observed polygons. It copies `stage-04-junction-sloped-terrain-fill-v1-27714637-026-polygon-set.json` unchanged, which is Stage 4's polygon set for Creek Segment 27714637-026 from WSE Polygon Generation Method `junction-sloped-terrain-fill` v1 (see [modeled-water-surface-elevation/METHODOLOGY.md](modeled-water-surface-elevation/METHODOLOGY.md#wse-polygon-generation-methods)). Its buckets are half-open `[minimum, maximum)`: 0.05 m steps from the 0.05 m multiple at or below the Stage 1 bed (25.70 m), then 0.25 m steps to at least 2 m above the highest modeled WSE (34.15 m). Every observed reading (26.31–28.95 m) falls in one. Each polygon was traced on the Stage 0 USGS 3DEP tiles inside a 100 m corridor cut at the junction bisectors, so it can carry a wet threshold that slopes between junction WSEs. The browser does not build this geometry.

Segment Network Release Validation checks that the buckets ascend without gaps or overlap, that every observed reading falls in one, and that every ring vertex lies inside that bisector-cut corridor's bounding box. Publish measures the corridor on the retained USGS 3DEP window.

To refresh the snapshot after a new Stage 4 method or version, rerun `npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach`, extract segment 27714637-026 from `04-water-surface-polygons/<method-id>/v<version>/water-surface-polygon-sets/27714637.json` in the same shape, rename the snapshot for the new method and version, update its provenance file and `OBSERVED_POLYGON_SET_SNAPSHOT_FILE` in `constants.ts`, review it, and run `npm run pipeline:publish`.

## Observed WSE propagation

Creek Segment Observed WSE Propagation (UCS-300; see the glossary) gives the Creek Segments just upstream and downstream of the gauge's segment an inferred WSE, so observed water does not stop at one segment. Each neighbour keeps the gauge segment's observed depth: `inferred WSE = neighbour bed + (observed WSE − gauge segment bed)`, with beds from Stage 1's representative cross-sections (USGS 3DEP). The rule is the same in both directions, so the surface follows the bed slope and never forms a level pool. A reading with no depth above the gauge bed, or no reading at all, propagates nothing.

- **Hop count.** One constant, `OBSERVED_WSE_PROPAGATION.hopsPerDirection` in [observed-wse-propagation.ts](observed-wse-propagation.ts), currently 3, applies to both directions. The published `observed-wse-propagation.json` records it and the browser draws exactly the segments listed there.
- **Changing it.** Edit the constant, run `node --experimental-strip-types --disable-warning=ExperimentalWarning pipelines/creek-visualization-data-production/retain-observed-wse-propagation-inputs.ts` (it reads the git-ignored `jalama-gauge-reach` Stage 1 and Stage 4 output; rerun `npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach` first if it is missing), review the two retained files, then `npm run pipeline:publish`. Publish refuses to run when the retained neighbour polygons do not match the hop count.
- **Polygons.** Inferred water draws the same Stage 4 prepared polygons modeled water does, picked from each neighbour's own ladder by the inferred WSE, and slopes between junction heights (the gauge segment's drawn height where they meet, the higher of two inferred values elsewhere) so neighbours join without a step.
- **Presentation.** Inferred water is teal with an outline, apart from the observed blue, and the legend and the Water-Surface Elevation Chart name it as inferred, not measured.
- **Validation.** Publish checks that every inferred reading falls inside its segment's prepared ladder, so no inferred water silently disappears.

## Modeled water-surface elevation

`npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach` runs a separate staged pipeline. It turns California Natural Flows and NOAA National Water Model discharge into a modeled WSE Time Series, prepared water-surface polygons, and a validated catalog for every Creek Segment in one extent. `jalama-gauge-reach` is the 61-segment dev extent. `dangermond-preserve` covers all 105 preserve flowlines and is the default. It writes only to `data/pipeline-working-output/<extentId>/`, which git ignores, plus one tracked crosswalk per extent in `data/source-inputs/reviewed-assignments/`. It does not touch the published files above; observed polygons change only when the retained Stage 4 snapshot is refreshed by hand (see [Observed water-surface polygons](#observed-water-surface-polygons)). See [modeled-water-surface-elevation/METHODOLOGY.md](modeled-water-surface-elevation/METHODOLOGY.md) for the stages, equation, parameters, and limitations. Stage 4 runs one versioned WSE Polygon Generation Method at a time (`--wse-polygon-method=<method-id>`) and keeps each version's output side by side; [WSE Polygon Generation Methods](modeled-water-surface-elevation/METHODOLOGY.md#wse-polygon-generation-methods) covers the folder layout, the version bump rule, and how to add a method.
