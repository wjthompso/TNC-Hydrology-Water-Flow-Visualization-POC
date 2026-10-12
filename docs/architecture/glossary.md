# Glossary

This file is the canonical glossary. The [Linear Glossary](https://linear.app/ucsb-spatial-center/document/glossary-a3c56f69f036) is a synced copy. A term is added, renamed, or redefined only after explicit developer approval.

## Bug Check

A Feature Behavior Test that checks for the absence of one known or likely bug. Passing means the bug's user-visible behavior was not observed under the documented test methodology. Every Bug Check records its bug reference and Root Cause Analysis separately from its test methodology and is proven through a Bug Reproduction Run when safe and practical.

## Bug Reproduction Run (with bug-producing environment enabled)

A controlled test run against a safely restored bug-producing environment. The test must fail for the intended behavioral reason, proving it detects the bug, and then pass in the fixed environment. A Bug Reproduction Run is review evidence only and never replaces or updates the test's recorded release result. Remove the bug-producing environment after review unless its continued maintenance is explicitly approved.

## California Natural Flows Database

A database of modeled California stream flow rates, also called the Flow Modeler. It gives a flow rate on a coarse stream line, not a water level at a gauge. The current feature does not use it.

## COMID

COMID (common identifier) is the identifier of one source hydrography line. COMID 27714637 is the Jalama TNC (The Nature Conservancy) flowline. It is not a Creek Segment.

## Creek Segment

The stretch of creek between two adjacent original vertices on a TNC (The Nature Conservancy) flowline. This definition may change later so the shown water reads more clearly on the map.

## Digital Twin

The larger product an Experience belongs to.

## Esri World Elevation

Esri's global terrain service, used as the 3D scene's ground surface. It is coarser than USGS 3DEP (3D Elevation Program) 1 m terrain, so prepared water-surface polygons can sit slightly above or below it.

## Esri World Imagery

Esri's global aerial and satellite photography, draped on the 3D scene's ground. It is the scene's imagery and also covers the ocean and coast.

## Experience

The category of self-contained view inside the Digital Twin. This creek app is one Experience.

## Gauge datum

The published elevation of a gauge's zero reading. For the Jalama Near Lompoc gauge, the gauge datum is 83.34 ft NAVD88 (North American Vertical Datum of 1988). Adding the gauge datum to gauge height produces a water-surface elevation.

## Gauge height

The gauge's relative water reading in feet. Adding the gauge datum, the published gauge elevation (for example, 83.34 ft NAVD88), turns it into a water-surface elevation.

## Jalama Near Lompoc gauge

USGS (United States Geological Survey) site 11120600. It is the real observation source for this Experience, and its readings apply to one associated Creek Segment.

## Manning's equation

A standard open-channel equation that relates flow velocity to the channel's slope, roughness, and hydraulic radius (the wet area divided by the wetted edge). The current feature does not use it. A future estimate of modeled water could use it with a flow rate and an assumed channel shape.

## Modeled water

An estimated water height, kept separate from observed water. The current feature does not show modeled water.

## Observed water

A water height measured at a real gauge.

## Prepared water-surface polygon

A polygon built ahead of time for one Creek Segment at one water-surface elevation. The build finds where that elevation meets the USGS 3DEP (3D Elevation Program) bare-earth terrain, which supplies the banks and not the underwater bed. During playback the browser selects the prepared polygon and does not build a new one.

## TNC flowline

A creek centerline published by TNC (The Nature Conservancy). Creek Segments are cut from its original vertices.

## USGS 3DEP

The USGS (United States Geological Survey) 3D Elevation Program bare-earth terrain model. It is the terrain used to build prepared water-surface polygons.

## Water-surface elevation (WSE)

The absolute height of the water surface, expressed in NAVD88 (North American Vertical Datum of 1988). For the Jalama Near Lompoc gauge, it is gauge height plus the gauge datum, converted from feet to meters.
