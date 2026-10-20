# Glossary

This file is the canonical glossary. The [Linear Glossary](https://linear.app/ucsb-spatial-center/document/glossary-a3c56f69f036) is a synced copy. A term is added, renamed, or redefined only after explicit developer approval.

## Bank-overlap margin

The small outward horizontal distance by which a prepared water-surface polygon is extended past the modeled waterline, so that the surrounding bank terrain depth-occludes the polygon's jagged 1 m rim. The margin is bounded by the Creek Segment corridor, so it cannot bleed into a neighbouring creek. Current value: 2 m. Implemented in the publishing pipeline as an isotropic dilation of the wet mask before the water-surface polygon is traced, in `pipelines/creek-visualization-data-production/water-surface-polygon-generation.ts`.

## Bug Check

A Feature Behavior Test that checks for the absence of one known or likely bug. Passing means the bug's user-visible behavior was not observed under the documented test methodology. Every Bug Check records its bug reference and Root Cause Analysis separately from its test methodology and is proven through a Bug Reproduction Run when safe and practical. Essentially a regression test, although the bug may not have yet been encountered.

## Bug Reproduction Run (with bug-producing environment enabled)

A controlled test run against a safely restored bug-producing environment. The test must fail for the intended behavioral reason, proving it detects the bug, and then pass in the fixed environment. A Bug Reproduction Run is review evidence only and never replaces or updates the test's recorded release result. Remove the bug-producing environment after review unless its continued maintenance is explicitly approved.

## California Natural Flows Database

A database of modeled California stream flow rates, also called the Flow Modeler. It gives a flow rate on a coarse NHDPlusV2 stream line, not a water level at a gauge. It is a Publisher; the modeled water-surface elevation pipeline uses its monthly Dataset (monthly mean discharge, 1950–2024) to derive modeled water-surface elevation. The browser does not show it yet.

## COMID

COMID (common identifier) is the identifier of one source hydrography line. Two separate COMID numbering systems are in use, and the same number never names the same line in both. NHD (National Hydrography Dataset) 1:24K COMIDs identify TNC (The Nature Conservancy) flowlines and Creek Segments; COMID 27714637 is the Jalama TNC flowline. NHDPlusV2 COMIDs identify the coarser reaches used by California Natural Flows and the NOAA National Water Model; COMID 17593507 is the Jalama gauge reach. REACHCODE 18060013000078 links the two for Jalama. A COMID is not a Creek Segment.

## Creek Segment

The stretch of creek between two adjacent original vertices on a TNC (The Nature Conservancy) flowline. This definition may change later so the shown water reads more clearly on the map.

## Dataset

One product from a Publisher with one time step and one date range, such as California Natural Flows monthly, NOAA National Water Model hourly retrospective, or the Jalama Near Lompoc gauge 15-minute readings. A Dataset is either observed or modeled (`kind`) and can hold several Variables. Spelled as one word to match the TNC-DigitalTwin Data Catalog.

## Derivation

A note on a Time Series whose values were calculated rather than received from the Publisher. It records the Variable it came from, the method, and who calculated it; for example, water-surface elevation derived from California Natural Flows discharge with Manning's equation by the UCSB Spatial Center. A Time Series without a Derivation comes straight from the Publisher. Derivation is independent of observed versus modeled.

## Digital Twin

The larger product an Experience belongs to.

## Distinct Population Segment (DPS)

A Distinct Population Segment (DPS) is a geographically and genetically distinct population that NOAA (National Oceanic and Atmospheric Administration) Fisheries can list under the ESA (Endangered Species Act) separately from the species as a whole. The fish relevant to this Experience are the Southern California Steelhead DPS of Oncorhynchus mykiss irideus (the anadromous, ocean-going form of coastal rainbow trout), spanning coastal watersheds from the Santa Maria River to the U.S.–Mexico border and listed as endangered. The DPS is further subdivided into five Biogeographic Population Groups (BPGs). Four sources place Jalama Creek as the northernmost watershed of the Conception Coast BPG, which extends roughly 80 km from Jalama Creek to Rincon Creek: Dagit et al. (2020), the Hunt & Associates (2008) CAP Threats Assessment prepared for NOAA Fisheries, the NOAA Fisheries 2012 Southern California Steelhead Recovery Plan, and the NOAA Fisheries 2023 5-Year Review. This BPG assignment has not been independently verified for this project and should be confirmed by a fisheries biologist. The nearest well-studied proxy watersheds — the Santa Ynez and Ventura rivers — belong to the adjacent Monte Arido Highlands BPG, the same DPS but a different sub-group, which makes their condition data the closest defensible reference values for Jalama. It is not a biological subspecies boundary.

## Drainage-Area Ratio Transfer

A fallback discharge source applied to a Creek Segment on a TNC flowline that has no corresponding NHDPlusV2 (National Hydrography Dataset Plus Version 2) reach. Because the flow model (NOAA National Water Model) publishes one discharge value per NHDPlusV2 reach, a segment with no native reach has no modeled discharge to derive a water-surface elevation from, so it must borrow the nearest reach on a neighbouring creek. Discharge is transferred using the standard USGS (United States Geological Survey) drainage-area ratio method: the neighbouring reach's discharge multiplied by the ratio of the segment's drainage area to the reach's drainage area, capped at 1. This scales the borrowed flow down to the tributary's proportional size. Unlike a routine within-reach scaling (where a segment borrows from the same creek's reach), a Drainage-Area Ratio Transfer stretches the uniform-runoff assumption across two separate catchments, making it a coarser approximation. Segments that use it are flagged `drainageAreaRatioTransfer`, so the browser can color or hide their water. A segment farther than 1 km from the borrowed reach receives no discharge (null values). Always written out in full, not abbreviated.

## Esri World Elevation

Esri's global terrain service, used as the 3D scene's far-zoom fallback ground surface beyond the ~25 km window around the creek, beneath the USGS 3DEP (3D Elevation Program) 1 m terrain the scene draws near the creek (UCS-275). It is coarser than USGS 3DEP 1 m terrain, so prepared water-surface polygons can sit slightly above or below it.

## Esri World Imagery (Base Imagery)

Esri's global aerial and satellite photography, draped on the 3D scene's ground as the base imagery everywhere, including the ocean and coast. Near the creek it is about 50 cm per pixel. Inside the Preserve at close zoom, the Preserve Aerial Imagery Overlay draws on top of it (UCS-262).

## Experience

The category of self-contained view inside the Digital Twin. This creek app is one Experience.

## Gauge datum

The published elevation of a gauge's zero reading. For the Jalama Near Lompoc gauge, the gauge datum is 83.34 ft NAVD88 (North American Vertical Datum of 1988). Adding the gauge datum to gauge height produces a water-surface elevation.

## Gauge height

The gauge's relative water reading in feet. Adding the gauge datum, the published gauge elevation (for example, 83.34 ft NAVD88), turns it into a water-surface elevation.

## Hold rule

How the browser picks a Time Series value for the selected time: the latest value at or before that time, held for at most one time step of that Time Series. Beyond one time step, the value is missing. This lets Time Series with different time steps play together.

## Jalama Near Lompoc gauge

USGS (United States Geological Survey) site 11120600. It is the real observation source for this Experience, and its readings apply to one associated Creek Segment.

## Manning's equation

A standard open-channel equation that relates flow velocity to the channel's slope, roughness, and hydraulic radius (the wet area divided by the wetted edge). The modeled water-surface elevation pipeline uses it, assuming steady uniform flow (normal depth), to turn modeled discharge into a water-surface elevation for each Creek Segment from USGS 3DEP cross-sections. The browser does not show modeled water yet.

## Modeled water

An estimated water height, kept separate from observed water. The modeled water-surface elevation pipeline produces it from modeled discharge; the browser does not show it yet.

## Observed water

A water height measured at a real gauge.

## Preserve Aerial Imagery Overlay (Overlay Imagery)

A high-resolution aerial photo layer of the Jack and Laura Dangermond Preserve, drawn over Esri World Imagery near the creek (UCS-262). The default is the January 2024 imagery donated via Vandenberg (8 cm per pixel); the imagery picker also offers the October 2019 imagery flown for Vandenberg, or no overlay. It covers only the Preserve's flight area and is hidden beyond about 1:20,000 scale, so wide and coastal views show Esri World Imagery alone. Like Esri World Imagery, it drapes on USGS 3DEP terrain.

## Prepared water-surface polygon

A polygon built ahead of time for one Creek Segment at one water-surface elevation. The build finds where that elevation meets the USGS 3DEP (3D Elevation Program) bare-earth terrain, which supplies the banks and not the underwater bed. During playback the browser selects the prepared polygon and does not build a new one.

## Publisher

The organization or model product that publishes one or more Datasets, such as USGS (United States Geological Survey), California Natural Flows, or the NOAA (National Oceanic and Atmospheric Administration) National Water Model. It is not the TNC-DigitalTwin `dataSource` adapter key and not a cloud storage host.

## Reach

A stretch of stream treated as one unit. In NHDPlusV2 (National Hydrography Dataset Plus version 2), one numbered line (COMID) for which California Natural Flows and the NOAA National Water Model report one discharge value per time step. One Reach usually spans many Creek Segments.

## Selected Creek Segment

The one Creek Segment a person picked by clicking its water on the map. Its water carries an amber highlight, and the Water-Surface Elevation Chart shows its values. Clicking another Creek Segment's water moves the selection; clicking where no water is drawn clears it. At most one Creek Segment is selected at a time (UCS-279).

## Time Series

One Dataset's values for one Variable: one timestamp list plus one value list per Creek Segment. Each Time Series keeps its own timestamps, so Variables in the same Dataset need not align.

## TNC flowline

A creek centerline published by TNC (The Nature Conservancy). Creek Segments are cut from its original vertices.

## USGS 3DEP

The USGS (United States Geological Survey) 3D Elevation Program (3DEP) bare-earth terrain model. It is the terrain used to build prepared water-surface polygons, and (UCS-275) the surface the live 3D scene draws near the creek, composited over Esri World Elevation for far zoom.

## Variable

One quantity with one unit, such as water-surface elevation (m), discharge (m³/s, shown to users as "Discharge (flow rate)"), or water speed (m/s).

## Water-surface elevation (WSE)

The absolute height of the water surface, expressed in NAVD88 (North American Vertical Datum of 1988). For the Jalama Near Lompoc gauge, it is gauge height plus the gauge datum, converted from feet to meters.

## Water-Surface Elevation Chart

Short for Water-Surface Elevation Time Series Chart. A line chart of the Selected Creek Segment's water-surface elevation over time, from the active Dataset, with a time cursor at the selected time. Hovering reads the time and value under the pointer without changing the time; clicking a time moves the time slider there, so the map follows. For an hourly modeled Dataset it shows the water year that holds the selected time (UCS-279).

## WSE Polygon Generation Method

A named, versioned way to turn modeled water-surface elevations into the water polygons drawn for each Creek Segment. Each version keeps its own saved output, so methods can be compared on the map.
