Context: I am a GIS Developer with only one year of experience in GIS, I am new to creeks.

## Q1. What data sources can we use to create the creek segments at the Dangermond Preserve? That is, ignoring water levels, do we have data sources which can give us the geometry of the different creek segments at a given time?

**Plain English:** You build creek shapes from two ingredients: **(1) a line down the middle of each creek** (TNC's NHD flowlines — Escondido, Jalama, etc.) and **(2) a terrain map** (USGS 3DEP elevation, or finer 2018 lidar if you need more detail). Nobody has published ready-made "here's the exact creek polygon" layers for Dangermond — you combine the centerline with the terrain to figure out where the banks are (buffer for a rough strip, or cross-sections against the DEM for something terrain-aware). It's all basically a **2018 snapshot**; the creek path on the map doesn't auto-update every year. Lidar can't see underwater, so there's no public bathymetry. If the creek moved sideways decades ago, you'd need old aerial photos — different problem. Dan may have better survey data that's not public yet.

**Answer:** For creek segment geometry at Dangermond, the best public sources are centerlines plus terrain-derived banks—not pre-made channel polygons. TNC's [NHD 1:24k flowlines](https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_nhd24kflowlines_streams/FeatureServer/7) (Escondido, Jalama, Espada, etc.) give connected reach topology, direction, and names. USGS [NHDPlus HR](https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer) adds national NHDFlowline, NHDArea, and catchment layers; NHDArea covers wider channels only, not surveyed bank lines. Bank and valley geometry come from [USGS 3DEP 1 m bare-earth DEM](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services) (six tiles over the Preserve) and, where needed, [2018 Dangermond lidar](https://portal.opentopography.org/datasetMetadata?otCollectionID=OT.042022.32611.1) (~61 pts/m², ground classified, NAVD88). TNC's [2 m contours](https://services.arcgis.com/F7DSX1DSNSiWmOqh/arcgis/rest/services/jldp_2m_contours/FeatureServer) are a lidar derivative useful for QA. Practical segment footprints are derived offline: buffer or cross-section the centerline against DEM/lidar to get channel ribbons or stage footprints. No public surveyed cross-sections, bank polylines, or bathymetry exist; airborne lidar does not map submerged beds. These sources are static snapshots—NHD vintages and September 2018 terrain—not time-stamped channel geometry. Historical planform would require multi-date aerial imagery (e.g., via the [Preserve data portal](https://www.dangermondpreserve.org/science/data/)). Partner-held survey data may exist but is not publicly published.

## Q2. Does the topology of the creek change significantly in the Dangermond Preserve, such that a visualization would need to change over time if we wanted to show historical creek water level increases and decreases?

**Answer:** For historical water-level visualization, creek planform topology does not need to change over time in most Dangermond reaches. Escondido and sibling creeks are largely bedrock-confined canyons in the Santa Ynez Mountains—channels where lateral migration and meander cutoffs are slow (typically sub-meter to a few meters per year on alluvial reaches elsewhere in coastal CA; often negligible in bedrock). What changes on storm-to-season timescales is water surface elevation and inundation width against a fixed channel template—not centerline connectivity. Episodic aggradation or scour after wildfire debris flows can alter bed elevation locally, but that is vertical adjustment more than network rewiring. Meaningful planform change on human timescales (years–decades) comes mainly from infrastructure: TNC removed two Jalama Creek fish barriers in 2023–2024; Escondido barrier removal is underway; Jalama Road culverts and bridge aprons constrain flow paths. Treat "topology" separately: planform/banks are quasi-static; stage topology is water-surface elevation plus terrain-clipped footprint. Practical recommendation: one static centerline + 2018 terrain; animate gauge-derived stage and precomputed inundation polygons per timestep. Update channel geometry only after documented restoration or geomorphic events—not for ordinary historical rise/fall. A time-varying DEM is unnecessary for stage visualization; reserve that for post-fire or post-restoration scenarios.

## Q3. If we have the water level for a creek at a specific point, what is that water level relative to? Seeing as how that creek segment has a number of different points in its geometry, with low and high points.

**Answer:** A stream-gauge reading is not relative to the varying elevations along your creek polygon. USGS *stage* (gage height) is the distance from the water surface to a fixed, site-specific *gage datum*—an arbitrary benchmark, usually set below the streambed so channel scour or fill does not invalidate the reference. Stage is not depth and not tied to any vertex on the creek geometry. For 3D rendering you convert it to absolute *water-surface elevation* (WSE) in a shared vertical datum such as NAVD88: `WSE = gage-zero elevation + stage`. That value applies at the gauge location, not uniformly to every polygon vertex.

Your creek segment vertices typically represent bank lines, centerlines, or thalweg samples at different ground elevations along the reach. The water surface is a separate horizontal-ish free surface: over a short reach (hundreds of meters) it is effectively flat in absolute elevation; over longer distances it follows the longitudinal channel slope, often modeled as a mild gradient downstream from the gauge or from a hydraulic model. Depth at any point is `WSE − local bed/bank elevation`, which varies because terrain dips and rises even when WSE is single-valued at the gauge.

For the POC, treat the gauge as one control point in NAVD88, assign WSE along the reach via a simple sloped profile or precomputed stage library, and derive polygon placement from terrain intersection—not from raw stage alone.

## Q4. Building on Q2, since the creek segments are one set of polygons, and the terrain is a different polygon, if we wanted to show the creek's topology change over time, would we need to change the elevation map as we show year over year changes? Can this be done performanently in a web browser?

**Answer:** For year-over-year *water level* changes, you generally do **not** need to change the elevation map. Ordinary rise and fall is a moving water surface against a relatively stable bare-earth DEM. Keep one NAVD88 terrain (USGS 3DEP or 2018 lidar) and swap precomputed water polygons or meshes at discrete stages; the browser renders prepared geometry, not live flooding physics. This matches how the POC should work and stays performant—stage switches can be near-instant once assets are loaded.

You only need a new terrain surface when showing actual *geomorphic* change: channel incision or aggradation, avulsion, landslides, or post-fire erosion. That is a different question from stage variability, and at Dangermond such change is usually slow except after major storms or fires. USGS 3DEP is primarily a best-available snapshot, not a continuous time series; multi-temporal DEMs exist for some areas but are sparse and must be curated offline.

Swapping an entire ground elevation layer in ArcGIS SceneView is feasible for era-to-era comparison, but reloading terrain tiles costs memory and causes a visible hitch—not something to animate every timestep. The practical architecture: one static terrain service, time-varying water layers keyed to observations, and optional separate "before/after terrain" scenes only when geomorphic change is the story. Dynamic terrain morphing in-browser is possible but overkill for this POC; pre-tile historical DEMs as alternate elevation services if needed.

## Q5. What is a good mapping between the words scientists and geographers use when referring to creek segments and the 3D language we would use when determining how to render a visualization of creek water levels?

**Answer:** Scientists and GIS users describe the creek in 1D/2D hydrologic terms; the renderer needs 3D geometry tied to a common vertical datum. **Reach** or **segment** is a length of stream between meaningful breaks (confluences, gauges, study bounds); in NHD each reach is a **feature** keyed by **COMID**, which you use to join attributes to rendered water pieces. **Centerline** / **flowline** is the map line of the stream (TNC NHD flowlines are approximate, not surveyed); **thalweg** is the lowest point along a cross-section (the POC samples this from 3DEP); **banks** are terrain edges; the **channel** is the conveyance between banks; the **floodplain** is adjacent low ground that wets at higher stages. **Stage** and **gage height** are water level at a sensor (often relative to a local gauge datum); **water-surface elevation (WSE)** is the absolute surface height—express everything in **NAVD88** meters for rendering. **Depth** = WSE − terrain elevation; **discharge** (Q) is flow rate and is usually encoded as color/size, not geometry. **Inundation extent** / **flood footprint** is the 2D wet area at a stage; **wetted perimeter** is shoreline length. In 3D: each stage → a **polygon** or **mesh** with per-**vertex Z** in **absolute-height** mode (`elevationInfo.mode = "absolute-height"`) draped on terrain; fallback **ground-draped** (`relative-to-ground`) when elevation fails. ArcGIS **WaterSymbol3DLayer** styles flat water surfaces; a custom sloped **mesh** preserves longitudinal slope. All elevations—terrain, thalweg profile, WSE—must share NAVD88 or seams and stage changes will look wrong.

## Q6. Building on Q4, is there a way render high detail terrain geometry in the browser near the creek, while keeping any area, say, 30 feet away from the creek banks low resolution to save on compute? Or, can modern web browsers efficiently render high resolution terrain geometry by the creek when we're zoomed in?

**Answer:** Yes, but you usually should not hand-build a sharp "9 m high-res / 30 m low-res" corridor unless profiling proves you need it. **ArcGIS SceneView** terrain is already a quadtree LOD system: `world-elevation` or a custom **BaseElevationLayer** (as in the POC) fetches 257×257-sample tiles and SceneView refines detail by camera distance, tilt, and a global memory budget—coarser tiles far from view, finer tiles near the creek when zoomed in. Mixing 1 m lidar corridor + 30 m background in one ground surface is awkward in SceneView because tiled layers must share one scheme; Esri's composite elevation handles multi-source blending automatically. **CesiumJS** uses the same idea via quantized-mesh tiles and `maximumScreenSpaceError`. **Three.js** can do corridor LOD (high-res clip + decimated skirt, or progressive mesh), but you own cracks, skirts, and datum alignment. At creek zoom on a 250–500 m reach, expect roughly **4–12 visible terrain tiles** (~130k triangles each) → **~0.5–1.5 M triangles**, which modern desktop GPUs handle at 30+ fps; mobile throttles via `qualityProfile` and memory limits (~750 MB medium). The POC already limits USGS 3DEP to a **~2 km** creek extent—this is the right pattern: bound high-res terrain geographically rather than per-bank distance. A literal 30 ft (~9 m) buffer saves little versus SceneView's screen-space refinement and adds seam risk. **Practical recommendation:** keep the bounded 1 m 3DEP layer for the study reach; use world-elevation outside it if needed; precompute water footprints offline; only invest in custom corridor LOD if `performanceInfo` shows frame drops after extending extent or adding lidar.

## Q7. It would be nice if this 3D water visualization was such that we could say, as long as you provide real, modeled, or a mix of real + modeled values for the water levels for each creek segment (this assumes we've already determined the creek segment shapes) at different points in time, we can show the change in water levels over time. Can we do that? What would we need?

**Answer:** Yes. The visualization layer does not run hydraulics—it **renders prepared outputs**. Given fixed segment geometry and a static terrain surface (Q2, Q4), any time series of **water-surface elevation (WSE in NAVD88)** per segment—observed, modeled, or mixed—can drive a timeline animation by swapping precomputed wet footprints or adjusting a sloped water surface. This is the same pattern as [USGS Flood Inundation Mapping](https://www.usgs.gov/mission-areas/water-resources/science/flood-inundation-mapping-science): model or gauge upstream → stage library offline → browser displays the matching stage at each timestamp.

**What you need:** (1) a **time-series table** keyed by segment, timestamp, WSE, and source type (`observed` / `modeled` / `interpolated`); (2) a **stage library**—inundation polygons or meshes precomputed at discrete WSE steps against the DEM (Q1); (3) **gauge datum conversion** so raw stage becomes NAVD88 WSE; (4) a rule to **extend WSE along ungauged reaches**—simple thalweg slope from the nearest gauge for a POC, hydraulic-model WSE profiles (HEC-RAS) when accuracy or floodplain width matters. The POC already handles rendering one reach; the gap is the time-indexed data contract and WSE → geometry lookup, not new 3D technology.


## Q8. Creeks often run downhill, how do we determine the slope of a creek segment?

**Plain English:** Slope is just **how much the creek bed drops per distance downstream** — rise over run. You already have the ingredients: resample the centerline, read the **lowest ground elevation** (thalweg) from the DEM at each station, then compare upstream vs downstream height. Simplest: `(bed elevation at top − bed elevation at bottom) / reach length`. The POC does this implicitly — `valleyMinElevationM` along the Escondido reach drops ~22 m over 344 m (~6% slope), and the water mesh follows that profile. When you have a gauge WSE, use the same slope to extrapolate: water at the gauge is 820 ft, and 100 m downstream it's slightly lower. **NHDPlus HR** has a `Slope` field per reach (from coarser 10 m DEM, network-smoothed) — useful for sanity checks, not your primary source on a short canyon reach. Use HEC-RAS or surveyed cross-sections only when you need floodplain accuracy or backwater behind culverts/bridges.

**Answer:** Distinguish **channel (bed/thalweg) slope** S₀ from **water-surface slope** S_wse—they coincide in uniform flow but diverge at pools, riffles, and structures. For this POC, derive slope from the **thalweg longitudinal profile**: at each centerline station, sample perpendicular DEM probes and take the minimum elevation (`valleyMinElevationM` in `generate-data.mjs`). Reach-average slope: `S = (Z_upstream − Z_downstream) / L`, or linear regression on Z vs chainage for a robust single value; smooth noisy profiles before computing segment-by-segment slopes (pools and DEM noise produce local reversals). The POC embeds slope in the thalweg profile (`waterZ = valleyMinElevationM + stageOffsetM`) rather than storing an explicit constant. For gauge-driven WSE extrapolation (Q3, Q7): `WSE(s) = WSE_gauge + S_wse × (s − s_gauge)` downstream—on Escondido's ~0.063 m/m reach, a flat horizontal WSE over 344 m would be wrong by ~22 m. **NHD** flowlines carry `ELEV` (mostly null for free-flowing streams). **NHDPlus HR** provides reach `Slope`, `MinElevSmo`, `MaxElevSmo`, and `SlopeLenKM` (join via COMID)—derived from 10 m 3DEP with network-wide elevation smoothing; use for QA, not primary input on a 1 m thalweg reach. Accuracy is limited by DEM vertical error (~±10–20 cm on 1 m 3DEP) and centerline offset from the true thalweg; sufficient for visual POC and short bedrock reaches. Escalate to step-backwater or HEC-RAS WSE profiles when floodplain width, structure backwater, or sub-foot WSE accuracy matters ([USGS FIM](https://www.usgs.gov/mission-areas/water-resources/science/flood-inundation-mapping-science) pattern).

---

## Glossary

Terms used throughout this document, in alphabetical order.

**Aggradation** — The buildup of sediment on a streambed or floodplain. The channel bed gets *higher* over time as material is deposited. Opposite of scour.

**Alluvial (reach)** — A stream section where the channel sits in loose sediment (gravel, sand, silt) rather than solid bedrock. These reaches can shift shape more easily than bedrock-confined ones.

**Bank / stream bank** — The sloped ground on either side of the channel where the creek meets the land. Where you'd stand if you walked up out of the water.

**Bank polyline** — A GIS line feature tracing the edge of a bank. A surveyed bank polyline was measured in the field with GPS or survey equipment. We don't have public ones for Dangermond creeks.

**Bare-earth DEM** — A digital elevation model where vegetation and buildings have been removed, leaving only ground surface heights. USGS 3DEP "bare earth" tiles show the terrain you'd see if everything above ground were stripped away.

**Bathymetry** — Underwater topography: the shape of the streambed *below* the water surface. Airborne lidar generally cannot measure this because laser pulses don't penetrate deep water.

**Bed (streambed / channel bed)** — The bottom surface of the creek where water flows. Can be rock, gravel, or sand.

**Bedrock-confined** — A channel cut into solid rock (like a canyon). The creek can't easily move sideways because the rock walls hold it in place.

**Bridge apron** — The paved or armored slope where a road or bridge meets the creek channel. Often concrete or riprap. It changes how water enters/leaves the channel at a crossing and can block or redirect flow during floods.

**Buffer (GIS)** — Create a zone of fixed width around a line or polygon. Example: "buffer the centerline by 8 meters" → a ribbon 16 m wide centered on the creek line. Quick but not terrain-aware.

**Centerline** — A single line down the middle of the creek, representing where the stream runs on a map. TNC's NHD flowlines are centerlines. They are approximate map products—not a field-surveyed path.

**Channel** — The physical trough the water flows through, bounded by banks.

**Channel polygon** — A map polygon outlining the channel footprint (the wet area or the area between banks). "Pre-made channel polygons" would mean someone already drew these for you; we don't have those publicly.

**Channel ribbon** — A simple elongated polygon shaped like a strip along the creek—often made by buffering the centerline. Used as a basic water footprint before doing terrain-aware inundation.

**Channel template** — The fixed shape of the creek channel (centerline path, bank positions, bed elevation) that water moves within. Think of it as the "mold" the water fills; the mold stays put while water level goes up and down.

**COMID** — Common Identifier. A unique ID assigned to each stream reach in the National Hydrography Dataset (NHD). Used to join creek geometry to attributes.

**Cross-section** — A slice across the creek, perpendicular to flow. Looks like a profile from one bank, down to the lowest point, up to the other bank. Used to find where water would intersect the terrain at a given elevation.

**Cross-section (surveyed)** — A cross-section measured in the field with known elevations at specific points. Much more accurate than deriving one from a DEM, but none are publicly available here.

**Culvert** — A pipe or tunnel under a road that carries creek water through the crossing. Jalama Road has culverts where the creek passes beneath the pavement. They constrain flow (size, slope, blockage) and can cause backups during high water.

**DEM (Digital Elevation Model)** — A raster grid where each cell stores ground elevation. The "terrain surface" your 3D scene sits on.

**Episodic** — Happening occasionally, in bursts—not continuously. "Episodic aggradation" = sediment buildup during specific events (e.g., a post-fire debris flow), not steady year-round change.

**Fish barrier** — A human-made or natural obstruction (dam, weir, culvert, perched outlet) that blocks fish from moving upstream. TNC has removed barriers on Jalama Creek as part of restoration.

**Flowline** — Same idea as centerline; NHD's term for a stream line feature.

**Footprint (stage footprint / inundation footprint)** — The 2D map area covered by water at a given water level. The "wet polygon" you'd draw on a map.

**Gage datum / gauge datum** — A fixed, arbitrary zero point at a stream gauge site. Stage is measured *up from* this point. It is local to that gauge—not NAVD88 directly.

**Gage height** — Same as stage: how high the water is above the gauge datum at the sensor.

**Inundation width** — How wide the wet area is at a given location or along a reach. When water rises, the creek gets wider as low banks submerge.

**Lidar** — Light Detection and Ranging. An aircraft shoots laser pulses downward; measuring return times builds a very dense 3D point cloud of the ground. Dangermond's 2018 lidar has ~61 points per square meter.

**Longitudinal profile** — Elevation plotted along the length of the creek (distance downstream vs. height). Shows how the thalweg or water surface slopes.

**Meander cutoff** — When a curved bend in a river/creek gets cut off (often during floods), leaving the channel on a straighter path. A form of planform change.

**NAVD88** — North American Vertical Datum of 1988. A standard reference for "height above sea level" used across the US. All terrain and water elevations in the POC should use this so layers align.

**NHD (National Hydrography Dataset)** — USGS/USFS stream mapping program. Provides flowlines, catchments, and other hydro layers nationwide.

**Planform** — The creek's shape as seen from above: where the centerline goes, how it bends, where the banks are. "Planform change" = the creek moving sideways on the map.

**Pre-made channel polygons** — Ready-to-use GIS polygons someone else already created for the channel shape. We don't have these; we derive geometry from centerlines + terrain.

**Reach** — A continuous length of stream between two meaningful points (confluences, gauges, property boundaries). Your ~344 m Escondido Creek test section is one reach.

**Scour** — Erosion that *removes* material from the streambed or banks. The channel bed gets *lower*. Opposite of aggradation. Often happens during high flows.

**Stage** — Water level at a gauge, measured as height above the local gage datum. **Not** the same as depth (distance from surface to bed) or absolute elevation.

**Stage footprint** — Same as inundation footprint: the polygon showing what's wet at a given stage.

**Streambed / submerged bed** — The ground under the water. "Airborne lidar does not map submerged beds" = the laser can't reliably measure the bottom through water, so the DEM shows the dry channel shape or an approximation, not the true underwater terrain.

**Surveyed cross-section** — See **Cross-section (surveyed)**.

**Terrain-derived bank** — A bank edge inferred from elevation data (DEM or lidar) rather than measured in the field. Example: "where the ground rises steeply away from the thalweg" or "where water at elevation X would stop."

**Thalweg** — The lowest point along a cross-section of the creek—the deepest part of the channel where water preferentially flows. Pronounced "TAHL-veg." Your POC samples thalweg elevation by taking the minimum DEM value across perpendicular offsets at each centerline point.

**Topology (creek)** — How the creek network is connected: which segments join, flow direction, branch structure. "Centerline connectivity" = whether segment A still connects to segment B. This rarely changes; water level does.

**Vertex (plural: vertices)** — A corner point of a line or polygon in GIS. Each vertex can have X, Y, and optionally Z (elevation). "Your creek segment vertices represent bank lines…" = the points defining your water polygon sit at different ground heights along the reach.

**Water-surface elevation (WSE)** — The absolute height of the water surface in a standard datum (NAVD88). Converted from stage via: `WSE = gage-zero elevation + stage`.

**Wetted area / wet footprint** — See **Footprint (stage footprint)**.

### Data source definitions

Concise reference for datasets and datums mentioned in this project. Each entry is one line: what it is, and how we use it.

**2018 Dangermond Preserve lidar (OpenTopography)** — Airborne laser point cloud (~61 pts/m², ground-classified, NAVD88, UTM 11N, CC BY 4.0); use for higher-resolution bare-earth terrain and bank detail in a small creek corridor when USGS 3DEP 1 m is too coarse—process offline, not in the browser.

**Dangermond Preserve data portal** — TNC hub linking imagery, sensors, Geospatial Hub layers, and partner datasets; use to find historical aerial photos, internal surveys, and monitoring assets not in public FeatureServers.

**Esri World Imagery** — Esri-hosted satellite/aerial basemap tiles; use as an optional prettier basemap in ArcGIS SceneView when you have a `VITE_ARCGIS_API_KEY`—visual context only, not hydrology geometry.

**Esri world-elevation** — Esri-hosted global terrain service; use as optional 3D ground in SceneView with an API key—handy outside the study area, but coarser than local 3DEP/lidar for creek work.

**Multi-date aerial imagery** — Time-stamped overhead photos (e.g., UCSB archive via the Preserve portal); use only when you need to see historical channel planform change—the creek path moving sideways—not for ordinary water-level animation.

**NAVD88 (North American Vertical Datum of 1988)** — The shared "height above sea level" reference for US elevation data; express terrain, thalweg, and water-surface elevations in NAVD88 meters so DEM, water meshes, and gauge conversions align in 3D—mixing datums causes floating or sunken water.

**Partner-held survey data** — Field-measured cross-sections, bank lines, or bathymetry that TNC or collaborators may have but have not published; use if Dan or the team provides it—most accurate channel geometry, but not available in public services today.

**Stream gauge / gage-height time series** — Sensor readings of stage (height above a local gage datum) at a fixed point; convert to NAVD88 water-surface elevation (`WSE = gage-zero elevation + stage`) to drive historical or live water levels— the POC does not use this yet but should for real observations.

**TNC 2 m contours (FeatureServer)** — Contour lines derived from 2018 lidar; use for quick terrain sanity checks and QA against DEM/lidar—helpful reference, not a primary geometry source for water polygons.

**TNC JLDP NHD 1:24k flowlines (FeatureServer/7)** — TNC's clipped National Hydrography Dataset stream centerlines (Escondido, Jalama, Espada, etc.) with names, flow direction, and COMID; use as the creek spine to build reaches, cross-sections, and water ribbons—approximate map lines, not surveyed channel centers.

**TNC public stream-gauge layer (JLDP_Fire_Variables_WFL7/FeatureServer/18)** — Map of active and proposed monitoring locations on Preserve creeks; use to pick gauge-linked test reaches and join future stage time series—locations and metadata, not the gauge readings themselves.

**USGS 3DEP 1 m bare-earth DEM** — National 1-meter ground elevation grid (six tiles cover the Preserve, NAVD88); use as the default terrain surface, thalweg sampling input, and inundation clipping surface in the POC—best first choice before processing full lidar.

**USGS NAIP imagery** — Free US aerial photo basemap; use for key-free map context in the POC—visual backdrop only.

**USGS NHDPlus HR** — National high-resolution hydrography (flowlines, NHDArea water polygons, catchments); use for national-standard topology and wider-channel polygons—supplements TNC flowlines but does not provide surveyed bank lines.

### Phrases explained

**"Buffer or cross-section the centerline against DEM/lidar"** — Two ways to build creek geometry from a centerline + terrain data:
- **Buffer:** Draw a fixed-width strip around the centerline (fast, rough).
- **Cross-section:** At many points along the centerline, slice perpendicular to the creek, read elevations from the DEM, and find where the water level would hit each bank. Connect those bank points into a polygon (more accurate, terrain-aware).

**"Centerlines plus terrain-derived banks—not pre-made channel polygons"** — Start with a map line down the creek (centerline), use elevation data to figure out where the banks are (terrain-derived), and build your water shapes from that. Don't expect a ready-made polygon layer someone already drew for the channel.

**"Episodic aggradation or scour after wildfire debris flows"** — After a fire, heavy rain can send mud, rocks, and burned debris rushing down the creek. This can suddenly deposit sediment (aggradation, bed gets higher) or carve material away (scour, bed gets lower). It happens in events, not smoothly over time.

**"Water surface elevation and inundation width against a fixed channel template—not centerline connectivity"** — When you animate historical water levels, what actually changes is (1) how high the water is and (2) how wide the wet area gets. The creek's path on the map (centerline) and how segments connect stay the same. You're filling the same channel mold with more or less water—not redrawng where the creek goes.