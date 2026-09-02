# Dangermond Preserve Creek Water Visualization Research Plan

## Concise Answer

Yes, a creek's rise and fall can be represented convincingly in browser-based 3D using relatively simple water surfaces. The best first experiment is an ArcGIS `SceneView` containing short, connected creek polygons rendered with `WaterSymbol3DLayer`. Each polygon follows the creek's downstream elevation profile, and a modeled change in water level raises or lowers the surfaces. This should be performant for a short creek reach and will quickly reveal whether the visual effect is believable.

Fixed-width polygons are useful for the first visual test, but they should not be treated as a realistic inundation model. The stronger MVP should precompute several terrain-derived water footprints—one for each water-level interval—and switch between them as the timeline changes. The browser should render prepared geometry rather than calculate flooding. A connected sloped surface or mesh should also be tested against ArcGIS's native flat water polygons because it may produce fewer visible steps, although it will not necessarily retain ArcGIS's animated water appearance.

The lowest-friction starting data is TNC's public creek centerline layer combined with the USGS 3DEP 1-meter bare-earth DEM. The Preserve's much denser 2018 lidar should be used only where the 1-meter DEM does not represent the banks adequately. Escondido Creek is a promising test location because the public stream-gauge layer identifies several active level loggers there.

## Recommended Decision

Build a small comparison prototype for one 250–500-meter reach of Escondido Creek:

1. **Native ArcGIS water:** short, connected, approximately horizontal water polygons with animated water styling.
2. **Connected sloped water:** one continuous terrain-aware surface or mesh using a simpler translucent material.
3. **Two geometry modes:** a fixed-width baseline and precomputed terrain-derived widths at discrete water levels.

This directly tests the central question: which lightweight browser visualization looks most convincing and least visually janky? It avoids prematurely turning the repository into a hydrologic-modeling project.

## MVP Task Summary

| ID | Status | Last Updated (Timestamp) | Task Description | Notes |
| --- | --- | --- | --- | --- |
| T1 | Proposed | 2026-09-02 14:25 EDT | Prepare one representative Escondido Creek reach so the visualization methods can be compared against the same terrain, imagery, centerline, and vertical datum. | Prefer the USGS 1 m DEM; use corridor lidar only if needed. |
| T2 | Proposed | 2026-09-02 14:25 EDT | Build the simplest rising-water visualization and verify that connected ArcGIS water polygons can rise and fall without obvious gaps, terrain penetration, or unacceptable frame-rate loss. | Keep the initial footprint fixed. |
| T3 | Proposed | 2026-09-02 14:25 EDT | Generate terrain-responsive water footprints at several stages so the visible creek widens and contracts as its modeled level changes. | Perform geometry generation offline. |
| T4 | Proposed | 2026-09-02 14:25 EDT | Compare native flat water polygons with a continuous sloped surface and determine which representation provides the best balance of appearance, continuity, and scientific readability. | Native ArcGIS water and a sloped mesh have different visual strengths. |
| T5 | Proposed | 2026-09-02 14:25 EDT | Evaluate the prototype using repeatable visual and performance measurements so the team can make an evidence-based visualization decision. | Include shoreline error, seams, stage-switch latency, memory, and frame rate. |
| T6 | Proposed | 2026-09-02 14:25 EDT | Extend the winning creek representation to one high-water scenario and determine whether the same delivery approach can communicate flooding. | This tests visualization only, not flood-model validity. |

## Answers to the High-Level Questions

### 1. Can flat horizontal polygons reasonably visualize changing creek levels?

**Concise answer:** Yes, as an approximation and as a strong visualization MVP.

ArcGIS Maps SDK for JavaScript provides [`WaterSymbol3DLayer`](https://developers.arcgis.com/javascript/latest/references/core/symbols/WaterSymbol3DLayer/), which renders polygon geometry as animated, reflective water in a 3D `SceneView`. It is a renderer, not a water simulation or creek-segmentation system.

Short polygons can approximate the longitudinal slope of a creek. Each polygon receives an absolute water-surface elevation, and all surfaces can be raised or lowered as the modeled stage changes. Adjacent polygons should share boundaries or overlap slightly so that small elevation differences do not create visible gaps.

The main visual limitations are:

- Long polygons will intersect terrain or float above it because a creek is not level along its full length.
- Short horizontal polygons can create a staircase effect.
- Fixed-width polygons will not show the shoreline expanding as water rises.
- ArcGIS's native water symbol is a flat surface treatment, not volumetric or physically simulated water.

A connected sloped mesh is the main alternative. It better preserves longitudinal slope and continuity, but it may require a simpler translucent material rather than ArcGIS's native animated water symbol. Both methods should therefore be included in the POC.

### 2. Do the polygon shapes need to change as water rises?

**Concise answer:** Not for the first visual test, but yes for a believable creek or flood visualization.

A fixed footprint that only moves vertically can answer whether the rendering method works. It cannot accurately show inundation because real water intersects progressively higher parts of the creek banks as stage rises.

The recommended terrain-aware algorithm is:

1. Establish a baseline water-surface profile along creek distance, or chainage.
2. Convert each modeled stage into an absolute water-surface elevation using a common vertical datum.
3. Calculate `depth = water-surface elevation - terrain elevation`.
4. Keep cells with positive depth that are connected to the creek.
5. Extract the zero-depth boundary as the shoreline.
6. Simplify and validate the polygon.
7. Precompute the resulting polygon or mesh for several discrete stages.

Keeping only water cells connected to the creek is important. A simple terrain comparison may otherwise fill isolated depressions that the creek cannot hydraulically reach—the GIS equivalent of discovering surprise puddles everywhere.

For a faster intermediate prototype, sample perpendicular cross-sections along the centerline, find the left and right terrain intersections at each water elevation, and connect those points into a continuous ribbon. This works best for a narrow, single-channel reach without complicated islands or tight meanders.

### 3. What geographic and topographic data already exists?

**Concise answer:** Enough public data already exists to build the MVP.

Recommended starting sources:

- [TNC public creek centerlines](https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_nhd24kflowlines_streams/FeatureServer/7): high-resolution NHD flowlines clipped to the Preserve. These are suitable starting lines, although they are not surveyed channel centers or bank boundaries.
- [USGS 3DEP products](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services): six 1-meter bare-earth DEM tiles cover the Preserve. These are the simplest terrain inputs for the first prototype.
- [2018 Dangermond Preserve lidar](https://portal.opentopography.org/datasetMetadata?otCollectionID=OT.042022.32611.1): 129.13 square kilometers with approximately 60.68 points per square meter, including ground-classified points. The data uses UTM Zone 11N and NAVD88 and is licensed CC BY 4.0.
- [TNC 2-meter contours](https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_2m_contours/FeatureServer): derived from the 2018 lidar and useful as a quick terrain-elevation reference.
- [Public Preserve stream gauges](https://services.arcgis.com/F7DSX1DSNSiWmOqh/ArcGIS/rest/services/JLDP_Fire_Variables_WFL7/FeatureServer/18): identifies active and proposed monitoring locations on Escondido, Espada, Damsite, Jalama, Ramajal, and Gaspar Creeks.
- [Dangermond Preserve data portal](https://www.dangermondpreserve.org/science/data/): points to imagery, sensors, the Geospatial Hub, research datasets, and additional partner content.

The first attempt should use the TNC centerline and USGS 1-meter DEM. Processing billions of lidar points is unnecessary until the simpler data demonstrates a visible deficiency. If the DEM smooths away narrow banks, download and process only a small lidar corridor around the selected reach.

The most important data limitation is bathymetry. Normal airborne topographic lidar generally does not measure the creek bed beneath water. Approximate dry-channel geometry may be sufficient for this visual POC, but engineering-grade hydraulics would require surveyed cross-sections, reliable channel-bed elevations, culvert geometry, roughness, and model calibration.

### 4. Can the visualization support comparison with cameras, sensors, and model outputs?

**Concise answer:** Yes for visual and spatial comparison, but the visualization should not be confused with validation of the underlying hydrologic model.

The strongest validation dataset would pair:

- A camera image with a known timestamp and view.
- A water-level observation at the same time.
- A surveyed or manually traced wet shoreline.
- The modeled water-surface elevation and rendered shoreline.

Useful quantitative measures include:

- Inundation intersection-over-union.
- Total wet-area error.
- Median and 95th-percentile shoreline distance.
- Water-surface elevation error at gauges or surveyed control points.
- Percentage of the rendered water surface that incorrectly penetrates terrain.
- Invalid polygon count, unmatched mesh edges, and maximum seam displacement.

Camera imagery can also be compared using fixed camera calibration or known landmarks, but image-space comparison becomes unreliable when vegetation, glare, shadows, and camera pose are not controlled.

For the POC, a practical target is shoreline error within approximately one DEM cell at the median and two cells at the 95th percentile when compared with the chosen reference. These are product targets for the experiment, not universal hydraulic-accuracy standards.

### 5. Are there better web-based 3D approaches?

**Concise answer:** There are alternatives, but ArcGIS remains the best first platform for this project.

- **ArcGIS `WaterSymbol3DLayer`:** best out-of-the-box water appearance and easiest integration with the existing Digital Twin architecture. The application must provide the geometry and elevation.
- **Connected ArcGIS polygon or mesh with a simple fill:** better longitudinal continuity and analytical clarity, but less realistic water styling.
- **CesiumJS:** strong terrain and dynamic geometry support, with more custom implementation needed for polished water.
- **deck.gl:** efficient GPU rendering for large polygon collections but no equivalent realistic water material.
- **Three.js:** highest customization ceiling and highest engineering cost because terrain integration, geospatial precision, interaction, and data lifecycle become application responsibilities.
- **HEC-RAS outputs:** potentially the best source of defensible flood geometry, but HEC-RAS is a modeling system feeding the visualization, not a browser rendering replacement.

The POC should remain in ArcGIS unless a specific visual limitation is demonstrated. A custom renderer should not be adopted merely because it offers more theoretical control.

### 6. Can this approach show a flood simulation?

**Concise answer:** Yes, provided the flood extents or water-surface elevations are generated outside the browser.

The same stage-library approach can display ordinary creek changes and high-water inundation. At each timestep, the browser receives or selects:

- The water-surface elevation along each reach.
- The corresponding shoreline or inundation polygon.
- Optionally, depth, velocity, and flow-direction attributes for color or particle overlays.

For an initial high-water visualization, the terrain-clipping algorithm may be sufficient. For scientifically defensible flood behavior—especially around culverts, roads, bridges, backwater, storage areas, or multiple flow paths—a hydraulic model such as HEC-RAS should generate the source results.

The architecture should remain:

`observations and forecast inputs → hydrologic/hydraulic model → prepared stage geometry → browser visualization`

The browser communicates the result; it does not need to solve the flood physics.

## Detailed MVP Plan

### T1 — Prepare a representative reach

Select a visually legible 250–500-meter portion of Escondido Creek near an active gauge and, if possible, a camera or accessible field location. Acquire the centerline, 1-meter terrain, imagery, gauge location, and vertical-datum information. Verify that all elevations can be expressed consistently in NAVD88 meters.

The selected reach should be narrow and single-threaded, avoid a major confluence, and contain enough bank variation to make changing width visible.

### T2 — Test native ArcGIS water

Create short, connected creek polygons with a fixed footprint. Assign each segment its baseline absolute elevation and apply the same stage-change offset along the reach. Render the polygons with ArcGIS's water symbol and test several segment lengths.

This task should answer:

- Does the water appear convincingly embedded in the terrain?
- At what segment length do elevation steps become distracting?
- Are overlap or shoreline skirts needed to hide seams?
- Can the stage change be animated or discretely updated without stutter?

### T3 — Generate terrain-derived stage footprints

Create water geometry for a small set of stage changes, such as baseline, +0.25 m, +0.5 m, +1.0 m, and +1.5 m. Start with cross-section-derived widths. If that produces unacceptable artifacts, move to raster depth calculation, creek-connected component filtering, shoreline contouring, and triangulation.

Do not morph arbitrary polygon vertices between stages because shoreline topology can change. Select the nearest prepared stage or briefly crossfade adjacent stages.

### T4 — Compare flat polygons and a continuous sloped surface

Render the same modeled stages using:

- Short horizontal polygons with native animated water.
- A continuous surface with per-vertex elevations and simpler material.

Compare reflections, visible steps, seams, terrain intersections, depth readability, and overall realism from identical camera positions.

### T5 — Measure visual quality and browser performance

Record:

- Geometry count and triangle count.
- Compressed payload size.
- Initial scene load time.
- Stage-switch latency.
- Frame rate and memory on a named target laptop and phone.
- Visible seam and terrain-penetration errors.
- Shoreline metrics where reference data is available.

Reasonable starting targets are at least 30 frames per second on the target device and stage changes under 100 milliseconds after geometry has loaded. These must be measured rather than assumed; ArcGIS explicitly notes that complex or numerous 3D polygons can affect scene performance.

### T6 — Test one flood scenario

Generate one intentionally high water surface and confirm that the selected representation can expand beyond the ordinary channel, remain connected to the creek, and communicate depth or severity. Identify where simple terrain clipping becomes implausible due to roads, culverts, bridges, or disconnected depressions.

This task should end with a clear decision:

- The visualization approach is sufficient with precomputed model output.
- The rendering approach is sufficient, but hydraulic-model output is required.
- The visual result is insufficient and a different rendering technology should be investigated.

## Success Criteria

The MVP is successful if it demonstrates that:

- Creek stage changes are clear and visually believable in the browser.
- The winning representation does not show distracting gaps, stairs, floating water, or substantial terrain penetration.
- Water width can respond to terrain using precomputed geometry.
- The approach maintains acceptable performance on representative hardware.
- The same delivery architecture can show at least one high-water extent.
- The team can distinguish measured, modeled, and visually approximated information in the interface.

The MVP does not need to prove that the water elevations are hydrologically correct. It needs to prove that scientifically generated elevations and extents can be communicated effectively once supplied.

## Key References

- [ArcGIS WaterSymbol3DLayer](https://developers.arcgis.com/javascript/latest/references/core/symbols/WaterSymbol3DLayer/)
- [ArcGIS realistic water sample](https://developers.arcgis.com/javascript/latest/sample-code/visualization-realistic-water/)
- [ArcGIS 3D water workflows](https://doc.arcgis.com/en/3d/workflows/visualization/water-feature-layers.htm)
- [ArcGIS elevation placement](https://developers.arcgis.com/javascript/latest/references/core/symbols/support/ElevationInfo/)
- [HEC-RAS inundation mapping](https://www.hec.usace.army.mil/confluence/rasdocs/rmum/latest/mapping-results/managing-results-maps)
- [USGS flood-inundation mapping science](https://www.usgs.gov/mission-areas/water-resources/science/flood-inundation-mapping-science)
- [Dangermond Preserve lidar metadata](https://portal.opentopography.org/datasetMetadata?otCollectionID=OT.042022.32611.1)
- [USGS 3DEP products and services](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services)
