# Creek visualization browser

Standalone experience for observed water on one Creek Segment of Jalama Creek, next to the Jalama Near Lompoc gauge (USGS site 11120600).

An ArcGIS SceneView opens framed on that segment, over Esri World Imagery and Esri World Elevation terrain. Play, Pause, and the time slider walk a regular 15-minute clock from the first observed timestamp to the last, in America/Los_Angeles. The page selects a prepared water-surface polygon for the selected time. It does not build water geometry, fill a missing reading, or show a water-surface elevation, stage, or discharge. A time with no observation shows no water. Neighbouring segments stay empty.

## Run

From the repository root:

```bash
npm install
npm run dev -w creek-visualization-browser
```

Optional `VITE_ARCGIS_API_KEY` is sent with ArcGIS requests and can raise tile quota. Imagery and terrain load without it. See `.env.example`.

On the development server a `Dev tools` button in the top-right corner opens the developer HUD (camera pose, click hit tests, segment placements, and in the modeled experience a click-to-read modeled water-surface elevation plus the "Side creeks with borrowed flow" (Drainage-Area Ratio Transfer) navigation, whose Next/Previous step through every flagged Creek Segment in the extent). User-facing labels for that water live in `src/drainage-area-ratio-transfer-labels.ts`. It starts collapsed and remembers its state in `localStorage`. Adding `?devtools` to the URL opens the HUD on load, in every build.

## Modeled water

`?dataset=national-water-model-hourly` or `?dataset=california-natural-flows-monthly` opens the modeled experience on the whole-watershed `dangermond-preserve` extent by default; `?modeledExtent=jalama-gauge-reach` switches to the single gauge reach, and `?time=<ISO 8601 UTC>` picks the opening slot. The pipeline output under `data/modeled-water-surface-elevation-pipeline-output/<extent>/` is served by the dev middleware in `vite-plugins/modeled-water-data-plugin.ts`, which also computes `creek-segment-paths.json` (each Creek Segment's flowline vertices, upstream to downstream). Water polygons draw flat at their bucket minimum while `DRAW_SLOPED_WATER_SURFACES` in `src/modeled-creek-experience.ts` is off. When it is on, each water polygon is drawn sloped between the segment's `junctionWseUpstreamM` and `junctionWseDownstreamM` from the Time Series (see `src/sloped-water-surface.ts`); a segment whose Time Series lacks those fields, or whose path is unavailable, draws flat at its bucket minimum.

## Published data

The page loads five JSON files from `/published-creek-visualization-data/` (`public/published-creek-visualization-data/`):

- `creek-segments.json`
- `water-surface-polygon-sets.json`
- `monitoring-stations.json`
- `data-source-metadata.json`
- `creek-segment-time-series/usgs-11120600-observed-wse.json`

Files that carry `segmentNetworkVersion` must agree. A mismatch, or any other failed load, is shown in the sidebar.

## Code map

- `standalone-experience-shell.ts` — page SceneView, Esri imagery, world elevation, and camera
- `creek-visualization-library-interface.ts` — `attachCreekVisualization(view, options)`
- `http-data-contract-loader.ts` — fetch and validate the five files
- `creek-data-contract.ts` — contract types, indexes, and the 15-minute clock
- `selected-time-creek-state-resolver.ts` — exact-time bucket selection
- `arcgis-scene-renderer.ts` — one reused water graphic per prepared segment
- `observation-timeline-controls.ts` — Play, Pause, and scrub
