# Historical playground notes

This README records the Composer 2.5 proof-of-concept playground. It is stale relative to UCS-246: the running application now lives in this folder, `apps/creek-visualization-browser`, shared tests and test commands live at the repository root, and the architecture source of truth is the Linear system design linked from the root README. The notes below describe how this playground was built, not the seven browser components or five HTTP (Hypertext Transfer Protocol) object contracts.

# Escondido Creek Water Visualization POC — Composer 2.5 Attempt

Browser POC for Escondido Creek at Dangermond Preserve comparing **ArcGIS SceneView** (default) with **Three.js sloped mesh** (fallback) for staged water visualization.

## What was built

| Component | Status |
| --- | --- |
| Vite + TypeScript + Tailwind scaffold | ✅ |
| Real creek centerline geometry | ✅ (TNC public FeatureServer) |
| Offline USGS 3DEP valley-bottom sampling | ✅ |
| Four terrain-aligned water stages | ✅ |
| Stage slider UI (+0, +0.25, +0.5, +1.0 m) | ✅ |
| **ArcGIS SceneView + WaterSymbol3DLayer** | ✅ (default renderer) |
| USGS NAIP imagery basemap (key-free) | ✅ |
| Esri World Imagery basemap (optional API key) | ✅ |
| **USGS 3DEP elevation (key-free 3D terrain via custom BaseElevationLayer)** | ✅ |
| Esri world-elevation ground (with API key) | ✅ |
| Three.js fallback renderer toggle | ✅ |
| Local meters → WGS84 coordinate conversion | ✅ |

### Visualization approaches

**ArcGIS SceneView (default):**

- Real-world map context at Dangermond Preserve (free USGS imagery + USGS 3DEP elevation without API key, or Esri imagery + world elevation with `VITE_ARCGIS_API_KEY`).
- Only the blue water ribbon is rendered — no centerline or mock terrain layers.
- Valley-bottom elevations are sampled **offline** in `generate-data.mjs` from USGS 3DEP (same source as terrain).
- At each resampled centerline station, the script probes perpendicular offsets (0, ±4, ±8, … ±30 m) and takes the **minimum** elevation as the thalweg / water baseline.
- Baseline stage (+0 m) places water at that valley minimum; higher stages add a uniform +0.25 / +0.5 / +1.0 m offset to every vertex.
- Water renders at **absolute-height** on the 3DEP terrain mesh when elevation loads successfully.
- **Fallback (terrain unavailable):** ground-draped water from the same precomputed meshes (z flattened).

**Three.js sloped water mesh (fallback):**

- Local-meter scene with translucent physical material — water only, no mock terrain or centerline.
- Uses the same offline valley-bottom elevations embedded in `reach.json`.

## API key status

| Mode | API key | Basemap | Ground / elevation | Notes |
| --- | --- | --- | --- | --- |
| **Key-free (default)** | Not required | USGS imagery | Custom `Usgs3DepElevationLayer` (GeoTIFF tiles), preflighted at creek | Full 3D pan/zoom/tilt/rotate with unconstrained navigation; water at absolute height from offline 3DEP sampling |
| **Key-free fallback** | Not required | USGS NAIP imagery | Flat + `relative-to-ground` offsets | Used only if terrain elevation query fails after view load |
| **With Esri key** | `VITE_ARCGIS_API_KEY` | Esri World Imagery | Esri `world-elevation` | Matches Digital Twin satellite + terrain context |

## Real vs mock

| Data | Status | Notes |
| --- | --- | --- |
| Creek centerline (WGS84) | **Real** | Longest Escondido Creek segment from TNC service; trimmed to ~344 m |
| Reach length & COMID | **Real** | From feature attributes |
| Basemap tiles | **Real** | USGS NAIP imagery (key-free) or Esri imagery (with key) |
| Ground elevation | **Real** | USGS 3DEP (key-free) or Esri world-elevation (with key) |
| Valley-bottom profile | **Real (offline)** | USGS 3DEP `getSamples` cross-section minimum per station |
| Water surface geometry | **Terrain-aligned ribbon** | 8 m base width (widens per stage); not terrain-clipped inundation |
| Vertical datum | **NAVD88** | From USGS 3DEP elevation service |

## How to run

```bash
# from the repository root
npm install
npm run generate-data -w creek-visualization-browser   # fetches centerline + USGS 3DEP valley profile → public/data/reach.json
npm run dev -w creek-visualization-browser
```

Open the URL Vite prints (usually `http://localhost:5173`).

- **Water stage** slider switches among precomputed meshes.
- **Renderer** toggle switches between ArcGIS (default) and Three.js fallback.

### Optional: Esri imagery + world elevation

```bash
cp .env.example .env
# Edit .env and set VITE_ARCGIS_API_KEY=your_key_here
npm run dev
```

### 3D navigation

- **Pan:** left-drag (or touch drag)
- **Zoom:** scroll wheel / pinch
- **Rotate & tilt:** right-drag (or two-finger drag on touch)
- **UI widgets:** zoom (+/−), compass (top-right)

## Verifying valley-bottom water

1. Run `npm run generate-data` and confirm console output shows a realistic elevation range (e.g. ~400–420 m NAVD88 for this reach).
2. Open ArcGIS view, tilt to ~78° and zoom to the creek — blue water should sit in the valley trough, not float above ridgelines.
3. Move the stage slider — water should rise uniformly (+0.25 / +0.5 / +1.0 m) while staying aligned with the creek path.
4. Inspect `public/data/reach.json` → `meta.valleyBottomSampling.elevationRangeM` and per-point `centerline[].valleyMinElevationM`.

## Project layout

```
apps/creek-visualization-browser/
├── scripts/generate-data.mjs   # centerline fetch + USGS 3DEP valley sampling
├── public/data/reach.json      # centerline, valley profile, water stage meshes
└── src/
    ├── arcgis-scene.ts         # SceneView — water layers only
    ├── usgs-elevation-layer.ts # BaseElevationLayer for 3DEP GeoTIFF tiles
    └── scene.ts                # Three.js fallback — water only
```

## Regenerating data

```bash
npm run generate-data
```

Requires network access to the TNC FeatureServer and USGS 3DEP ImageServer.

## Stubbed / out of scope

- Terrain-derived inundation footprints (T3)
- Performance metrics (T5)
- Flood scenario (T6)
