# Dangermond Preserve Digital Twin: Hydrology / Water Visualization Context

### Goal

We want to create a 3D visualization which approximates real-life creek water levels rising and falling over time, showing changes in the shape of the creek over time and also the rise and fall of the creek's water level over time. We want to be able to correlate our 3D visualization with real-life water level data and imagery to verify the accuracy.

### High Level Plan

- Calculate creek segments by:
   1. Finding WSE (Water Surface Elevation) values at every centerpoint, sampling enough centerpoints to smooth out polygon.
   2. Finding the creek width by crosswalking to the left and right edge at the bank for every centerpoint.
   3. Treating each centerpoint as a shared edge between two
   segments in order to show a smoothly sloping creek rather than awkward stair step water segments.


### High Level Questions This POC Should Answer

1. (i) Can the water level in a creek be reasonably visualized in web-based 3D, at least in a proximate way, by breaking it apart into flat horizontal polygons? 
   (ii) If so, what is the best way to determine the shape of creek segments at different water levels? 
   (iii) If not, are there better ways of creating web-friendly 3D visualizations of the water within a creek?
2. If the answer to 1.i is yes, assuming that the creek / river banks visually cut off the flat horizontal water surface billboards, would these creek segments need to change shape as the water levels go up and down? If so, what kind of algorithms could we use to accurately change these shapes?
3. What kind of geographic, topological data already exists, which could help us identify the shape of different creek segments, which we could then use to create horizontal water surface billboards? The question restated: Has someone already thought of this question and provided data for it? And if not, what data do we already have for the Dangermond Preserve which we could use to build these segments?
4. Would this approach provide a 3D visualization which looks close enough to reality to use in comparison between real-life measurements (creek camera + creek water level sensor) and modeled water levels within creeks to test model performance? Are there time-efficient and quantifiable approaches we can take to quantify the visual accuracy above and beyond manual visual inspection?
5. If the creek segment approach isn't ideal as a web-based 3D visualization, are there other web-based 3D approaches that might be a better idea? Or no?
6. Our team also wants the visualization approach that we use to be able to effectively show a flood simulation. Could our approach show a flood simulation?

### Additional Questions

...

### Notes

- Dan is down to provide required data.
- The 2018 DP LiDAR survey was taken during the dry season, Sept 22-Oct 1, before the first real fall storm on Oct 2nd. Can provide a reasonable approximation of creek bathymetry.
- Problem: A fixed-width ribbon will be too skinny in wide spots, too fat in narrow spots, and can spill into nearby dry side channels. Accurate viz needs water footprints that follow the actual banks at each water-surface elevation — precomputed, not guessed as a constant width.

### Previously Identified Approach

We are developing a browser-based Digital Twin for the Dangermond Preserve using ArcGIS Enterprise and web GIS technologies. One goal is to move beyond a static scientific data catalog toward a system that can visualize environmental processes through time, including monitoring, prediction, and eventually simulation.

For hydrology, we previously discussed combining several related datasets:

Precipitation and storm events
Groundwater well measurements
Groundwater recharge
Surface runoff
Creek/streamflow
Evapotranspiration
Groundwater-stream interactions

A major visualization concept was time-varying groundwater levels across multiple wells. Individual wells could be represented as 3D vertical cylinders/columns whose water height changes through time.

More ambitiously, measurements from multiple wells could be interpolated into a 3D groundwater/potentiometric surface. Imagine a semi-transparent underground surface or mesh passing through the measured groundwater elevations at the wells. As time advances, that surface rises, falls, and changes shape. This could reveal groundwater gradients, likely groundwater-flow direction, recharge events, and relationships between groundwater and nearby streams.

The experience would therefore have a time dimension. A user could move backward through historical measurements, view current sensor conditions, and potentially move forward into modeled or forecast conditions.

We also discussed surface-water flow visualization. ArcGIS can represent flow using animated particles/lines and time-enabled raster or vector outputs, but it does not provide Unreal Engine-style physically simulated volumetric water. For scientific hydrology, the better architecture is generally to run the actual hydrologic/hydraulic model separately, such as HEC-HMS/HEC-RAS or another scientific model, and publish its outputs into ArcGIS for visualization.

This creates an important separation:

Observed data → scientific/modeling pipeline → derived predictions/simulations → Digital Twin visualization

The Digital Twin itself does not necessarily perform the hydrologic physics. It can provide the interface for exploring inputs, model outputs, scenarios, and change through time.

One conceptual framework we discussed was a water budget connecting:

precipitation → infiltration/recharge + runoff → groundwater/aquifer storage → wells/streams → evapotranspiration/outflow

We were particularly interested in visualizing process rather than merely pattern. For example, instead of showing only a map saying that groundwater is low, show a storm arriving, subsequent recharge after a time lag, the groundwater surface rising, and resulting changes in creek flow.

The architecture should remain based around ArcGIS/Esri services and be scalable rather than building a bespoke game-engine simulation for every environmental process.