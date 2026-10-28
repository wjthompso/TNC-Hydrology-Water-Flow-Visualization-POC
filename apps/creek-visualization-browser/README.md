# Creek visualization browser

Standalone experience for observed water on one Creek Segment of Jalama Creek, next to the Jalama Near Lompoc gauge (USGS site 11120600).

An ArcGIS SceneView opens framed on that segment. Esri World Imagery is the base imagery everywhere; near the creek the Preserve Aerial Imagery Overlay (January 2024, 8 cm) draws over it. Both drape on USGS 3DEP terrain, with Esri World Elevation for far zoom. The **Imagery** picker, or `?imagery=preserve-2019` / `?imagery=esri-world-imagery`, switches the overlay imagery or turns it off. Play, Pause, and the time slider walk a regular 15-minute clock from the first observed timestamp to the last, in America/Los_Angeles. The page selects a prepared water-surface polygon for the selected time. It does not build water geometry, fill a missing reading, or show a water-surface elevation, stage, or discharge. A time with no observation shows no water. Neighbouring segments stay empty.

## Run

From the repository root:

```bash
npm install
npm run dev -w creek-visualization-browser
```

Optional `VITE_ARCGIS_API_KEY` is sent with ArcGIS requests and can raise tile quota. Imagery and terrain load without it. See `.env.example`.

Dev tools are a developer HUD (heads-up display): camera pose, click hit tests, segment placements, and in the modeled experience a click-to-read modeled water-surface elevation plus the "Side creeks with borrowed flow" (Drainage-Area Ratio Transfer) navigation, whose Next/Previous step through every flagged Creek Segment in the extent. User-facing labels for that water live in `src/drainage-area-ratio-transfer-labels.ts`. The development server shows a `Dev tools` button in the top-right corner. It starts collapsed and remembers its state in `localStorage`. Adding `?devtools` to the URL opens the HUD on load. A production build hides the button and ignores `?devtools`, so a shared Digital Twin link cannot open it. Set `VITE_SHOW_DEV_TOOLS=true` to force Dev tools on in any build, or `false` to hide them on the development server for a demo. See `.env.example`.

## Modeled water

`?dataset=national-water-model-hourly` or `?dataset=california-natural-flows-monthly` opens the modeled experience on the whole-watershed `dangermond-preserve` extent by default; `?modeledExtent=jalama-gauge-reach` switches to the single gauge reach, and `?time=<ISO 8601 UTC>` picks the opening slot. The pipeline working output under `data/pipeline-working-output/<extent>/` is served by the dev middleware in `vite-plugins/modeled-water-data-plugin.ts`, which also computes `creek-segment-paths.json` (each Creek Segment's flowline vertices, upstream to downstream, and the ids of the neighbours sharing its two vertices). Each water polygon is drawn sloped between the segment's `junctionWseUpstreamM` and `junctionWseDownstreamM` from the Time Series, measured between the segment's two junction bisectors so neighbours meet along the whole shared boundary (see `src/sloped-water-surface.ts`); a segment whose Time Series lacks those fields, or whose path is unavailable, draws flat at its bucket minimum. Whether polygons are sloped or flat follows the selected WSE Polygon Generation Method's `browserDrawing`; a method drawn `flat-at-bucket-minimum` with the default polygons reproduces the UCS-271 stair-stepping and seam bugs.

`?wsePolygonMethod=<method-id>@v<version>` draws a saved WSE Polygon Generation Method version instead of the default method's newest version (`<method-id>` alone means its newest version). The dev middleware lists the saved versions in `wse-polygon-methods.json`, and Dev tools → **Derived data products** switches between them live with no URL parameter to remember: **Modeled WSE version** (`m1-v1`, `m2-v1`, from the saved Stage 3 versions) picks the Time Series and draws its newest polygon version, and **WSE polygon version** picks among the polygon versions built from that Time Series (each polygon version is only drawn with the Time Series it was built from). The readout under the selects lists what is saved, what is drawn, and which registered methods have no output in the extent yet. A switch keeps the camera and selected time and writes `?wsePolygonMethod=` so the address bar stays reloadable. See [WSE Polygon Generation Methods](../../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/METHODOLOGY.md#wse-polygon-generation-methods).

**Default pairing.** With neither `?wsePolygonMethod=` nor `?modeledWse=`, the page opens `flowline-channel-ribbon` v2 drawn with the `m5-flowline-profile-jarrett-depth` v1 Time Series through a channel pairing (Jarrett's slope-dependent roughness on the raw lidar bed), on the development server, in test mode, and in a production build. An extent without m5 saved on the ribbon's channel (`jalama-gauge-reach`) opens the ribbon with its own Time Series. Switching to the default pairing drops both URL parameters; any other choice keeps them. `?wsePolygonMethod=junction-sloped-terrain-fill@v1` reopens the former default.

**Production data.** A production build (`VITE_CREEK_DATA_SOURCE` unset) reads the same pairing from three public hosted services: modeled WSE `m5-v1`, WSE polygons `m3-v2`, and the `m3-v2` exact-rings service the ribbon drawing reads its station-ordered rings from. `VITE_MODELED_WSE_SERVICE_URL` and `VITE_WSE_POLYGONS_SERVICE_URL` repoint it (set both; the `m1-v1` service URLs are in `.env.example`). The hosted services publish National Water Model hours for water years 2021–2023 only, so an earlier `?time=` opens on the first hosted hour. See [arcgis-publishing/README.md](../../pipelines/creek-visualization-data-production/arcgis-publishing/README.md), section 1.

## Published data

The page loads five JSON files from `/published-creek-visualization-data/` (`public/published-creek-visualization-data/`):

- `creek-segments.json`
- `water-surface-polygon-sets.json`
- `monitoring-stations.json`
- `data-source-metadata.json`
- `creek-segment-time-series/usgs-11120600-observed-wse.json`

Files that carry `segmentNetworkVersion` must agree. A mismatch, or any other failed load, is shown in the sidebar.

## Code map

- `standalone-experience-shell.ts` — page SceneView, base imagery, terrain, and camera
- `scene-imagery.ts` / `scene-imagery-options.ts` — overlay imagery layers, the imagery picker choices, and their dataset names
- `creek-visualization-library-interface.ts` — `attachCreekVisualization(view, options)`
- `http-data-contract-loader.ts` — fetch and validate the five files
- `creek-data-contract.ts` — contract types, indexes, and the 15-minute clock
- `selected-time-creek-state-resolver.ts` — exact-time bucket selection
- `arcgis-scene-renderer.ts` — one reused water graphic per prepared segment
- `observation-timeline-controls.ts` — Play, Pause, and scrub
