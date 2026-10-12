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
