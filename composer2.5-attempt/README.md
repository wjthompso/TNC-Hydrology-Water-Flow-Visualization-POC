# Escondido Creek Water Visualization POC — Composer 2.5 Attempt

Browser POC for Escondido Creek at Dangermond Preserve comparing **ArcGIS SceneView** (default) with **Three.js sloped mesh** (fallback) for staged water visualization.

## What was built

| Component | Status |
| --- | --- |
| Vite + TypeScript + Tailwind scaffold | ✅ |
| Real creek centerline geometry | ✅ (TNC public FeatureServer) |
| Synthetic terrain bed strip | ✅ (mock elevation profile) |
| Precomputed sloped water ribbons at 4 stages | ✅ |
| Stage slider UI (+0, +0.25, +0.5, +1.0 m) | ✅ |
| **ArcGIS SceneView + WaterSymbol3DLayer** | ✅ (default renderer) |
| OpenStreetMap basemap (key-free) | ✅ → USGS NAIP imagery |
| Esri World Imagery basemap (optional API key) | ✅ |
| **USGS 3DEP elevation (key-free 3D terrain via custom BaseElevationLayer)** | ✅ |
| Esri world-elevation ground (with API key) | ✅ |
| Three.js fallback renderer toggle | ✅ |
| Local meters → WGS84 coordinate conversion | ✅ |

### Visualization approaches

**ArcGIS SceneView (default):**

- Real-world map context at Dangermond Preserve (free USGS imagery + USGS 3DEP elevation without API key, or Esri imagery + world elevation with `VITE_ARCGIS_API_KEY`).
- Creek centerline as GeoJSON-derived polyline in WGS84.
- Mock water/terrain ribbon meshes converted from local meters to geographic polygons with `WaterSymbol3DLayer`.
- **With 3D terrain:** mock geometry uses absolute heights. In key-free mode it is vertically aligned to the validated 3DEP sample at the creek; the source mesh itself remains synthetic.
- **Fallback (USGS elevation unavailable):** ground-draped geometry via `relative-to-ground` offsets on flat basemap.

**Three.js sloped water mesh (fallback):**

- Local-meter scene with translucent physical material (T4 comparison path).
- No basemap — useful for comparing mesh rendering without ArcGIS SDK weight.

## API key status

| Mode | API key | Basemap | Ground / elevation | Notes |
| --- | --- | --- | --- | --- |
| **Key-free (default)** | Not required | USGS imagery | Custom `Usgs3DepElevationLayer` (GeoTIFF tiles), preflighted at creek | Full 3D pan/zoom/tilt/rotate with unconstrained navigation; mock water uses sampled-ground-aligned absolute heights |
| **Key-free fallback** | Not required | USGS NAIP imagery | Flat + `relative-to-ground` offsets | Used only if terrain elevation query fails after view load |
| **With Esri key** | `VITE_ARCGIS_API_KEY` | Esri World Imagery | Esri `world-elevation` + `stay-above` | Matches Digital Twin satellite + terrain context |

Both elevation modes render mock terrain/water at absolute heights when 3D ground is available.

## Real vs mock

| Data | Status | Notes |
| --- | --- | --- |
| Creek centerline (WGS84) | **Real** | Longest Escondido Creek segment from TNC service; trimmed to ~344 m |
| Reach length & COMID | **Real** | From feature attributes |
| Basemap tiles | **Real** | USGS NAIP imagery (key-free) or Esri imagery (with key) |
| Ground elevation | **Real** | USGS 3DEP (key-free) or Esri world-elevation (with key) |
| Terrain / bed elevation | **Mock** | ~1.2 m drop per 100 m downstream + noise; baseline ~42.5 m |
| Water surface geometry | **Mock** | Fixed-width ribbon, widened per stage; not DEM-derived inundation |
| Vertical datum | **Mock** | NAVD88-like meters for labeling only |

## How to run

```bash
cd composer2.5-attempt
npm install
npm run generate-data   # fetches centerline, writes public/data/reach.json
npm run dev
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

A free [ArcGIS Developer](https://developers.arcgis.com/) API key unlocks Esri World Imagery and the Esri world-elevation ground service. Without a key, the POC first validates a Float32 GeoTIFF tile from the USGS 3DEP ImageServer, then attaches a custom `BaseElevationLayer` limited to 2 km around the creek. If validation fails, it keeps the reliable flat-ground fallback (the stock `ElevationLayer` cannot render this dynamic service in SceneView).

### 3D navigation

- **Pan:** left-drag (or touch drag)
- **Zoom:** scroll wheel / pinch
- **Rotate & tilt:** right-drag (or two-finger drag on touch)
- **UI widgets:** zoom (+/−), compass (reset north), navigation-toggle (switch 2D/3D pan mode) — top-right of the scene

In key-free mode, navigation remains unconstrained (`navigationConstraint: none`) even after 3DEP loads, preserving the verified pan/zoom/rotate behavior. The API-key mode uses Esri world elevation and its normal terrain navigation behavior.

## Project layout

```
composer2.5-attempt/
├── .env.example            # optional VITE_ARCGIS_API_KEY
├── index.html              # UI shell (descriptive element ids)
├── package.json
├── vite.config.ts          # optimizeDeps exclude for @arcgis/core
├── scripts/generate-data.mjs
├── public/data/reach.json
└── src/
    ├── main.ts             # bootstrap, renderer toggle
    ├── arcgis-scene.ts     # SceneView + WaterSymbol3DLayer
    ├── usgs-elevation-layer.ts  # BaseElevationLayer for USGS 3DEP GeoTIFF tiles
    ├── scene.ts            # Three.js fallback
    ├── geo.ts              # local meters → WGS84 conversion
    ├── ui.ts               # stage slider + renderer toggle
    ├── scene-backend.ts    # shared interface
    └── types.ts
```

## Coordinate conversion

Vertices in `reach.json` use local east-north meters `(x, y)` plus elevation `z`. ArcGIS layers convert via `meta.originWgs84`:

```
lon = originLon + x / (111320 * cos(originLat))
lat = originLat + y / 111320
z   = elevation in meters (absolute-height when 3D terrain loaded; flattened to 0 with relative-to-ground offsets only if elevation service fails)
```

## Stubbed / out of scope

- Terrain-derived inundation footprints (T3)
- Performance metrics (T5)
- Flood scenario (T6)

## Regenerating data

```bash
npm run generate-data
```

Requires network access to the TNC FeatureServer.
