# height-above-nearest-drainage-fill — Height above nearest drainage (bed-parallel) fill

| Field | Value |
| --- | --- |
| Kind | WSE Polygon Generation Method (Stage 4) |
| Method id | `height-above-nearest-drainage-fill` (not the default) |
| Current version | 4 (geometry rules of v3, rebuilt on `m2-v3`) |
| Browser drawing | `bed-parallel-depth` |
| Config | [`method-config.ts`](method-config.ts) |
| Code | [`generate-water-surface-polygons.ts`](generate-water-surface-polygons.ts), [`bed-line-tracing.ts`](bed-line-tracing.ts) (lidar bed line, v2), [`sliced-footprints.ts`](sliced-footprints.ts) and [`ring-triangulation.ts`](ring-triangulation.ts) (slicing, v3), [`corridor-geometry.ts`](corridor-geometry.ts) (copied corridor, flood-fill, and clip helpers) |
| Built from | The Time Series of [m2-multi-section-manning-depth](../../modeled-wse-derivation-methods/m2-multi-section-manning-depth/METHOD.md) (v1 was built from `m2-v1`, v2 and v3 from `m2-v2`, v4 from `m2-v3`; the manifest records it under `parameters.builtFromModeledWseVersion`). It needs m2's depth fields and stops with a message on an m1 Time Series. |
| Command | `npm run pipeline:modeled-wse:water-surface-polygons -- --extent=<id> --modeled-wse-method=m2-multi-section-manning-depth --wse-polygon-method=height-above-nearest-drainage-fill` |

## ⚠️ Bucket bounds are DEPTHS

In this method's polygon sets, each bucket's `minWaterSurfaceElevationM` and `maxWaterSurfaceElevationM` are **water depths in meters above the local creek bed**. They are not elevations. The field names are kept so the file shape matches every other method. `browserDrawing: 'bed-parallel-depth'` tells the browser how to read them.

Every ring vertex is `[longitude, latitude, bedReferenceM]`:

- longitude and latitude: 7 decimals
- `bedReferenceM`: m NAVD88, 3 decimals

The browser draws each vertex at `bedReferenceM` + the depth at the selected time. Since v3 a bucket's `ringsWgs84` can hold many outer rings (the slices, see [Version 3](#version-3-sliced-footprints)); the browser draws all rings of the bucket as one polygon with the same per-vertex rule. It interpolates that depth between `junctionDepthUpstreamM` and `junctionDepthDownstreamM`. The bucket it picks is the one holding the anchor depth (value − `anchorBedElevationM`).

## Summary

HAND (height above nearest drainage) is the height of a cell above the creek bed it drains to. NOAA's flood inundation mapping (Zheng, Tarboton, Maidment et al., 2018) and Nobre et al. (2011) use it to map water from a stage. In a steep valley a flat elevation threshold floods everything below it. A HAND threshold instead floods a band of constant depth that follows the bed downhill.

## Steps (per Creek Segment)

1. **Stage 1 thalweg chain.** List, in vertex order:
   - the 2 Stage 1 thalweg points of the start-vertex neighbour nearest the shared vertex,
   - this segment's 5 thalweg points,
   - the 2 nearest thalweg points of the end-vertex neighbour.

   Each point carries its section's `bedElevationM`. Two sections that found the same thalweg cell count once.
2. **Bed line (v2).** Between each pair of consecutive thalweg points, trace the channel on the 1 m lidar ([`bed-line-tracing.ts`](bed-line-tracing.ts)); v1 drew a straight line and interpolated the section beds:
   - **Band.** Take the lidar cells whose centers lie within `bandHalfWidthM` = 4 m of the straight chord between the two points. The band keeps the path from jumping to another gully.
   - **Least-cost path.** Find the lowest-cost 8-connected path of cells from the cell holding the first point to the cell holding the second. Entering a cell costs its step length × (its height above the lowest cell of the band + `costFloorM` = 0.05 m). Height is measured above the straight line joining the two end cells' elevations, so a steep reach does not charge more for its uphill end. The floor keeps the path from wandering where the band is flat.
   - **Resample and bed.** Join the pieces, resample every 1 m, and take the bed from the lidar elevation of the traced cells. A median filter over `bedSmoothingWindowM` = 5 m removes single-cell spikes. A median keeps a step in the channel floor, where a moving average rounds it off (on 28 test segments the worst 95th-percentile error against the lidar was 0.30 m for a 5 m median and 1.68 m for a 5 m moving average). The window shrinks toward the line ends, so the end beds stay lidar values.
   - **Tile, not crop.** The path is traced on the whole terrain tile. A very short segment has a narrow corridor, and its Stage 1 thalweg points can lie outside the cropped corridor grid (first attempt: 1,075 pieces without a lidar path; on the tile: 4).
   - **Fallback.** A piece with no lidar path (an end off the tile or on NoData) keeps the straight chord with the Stage 1 section beds and is counted in the manifest (`chordFallbackPieces`) and warned.
3. **Reference bed and HAND.** For each corridor cell, the reference bed is the bed interpolated at the nearest point of the bed line. Past either end of the line, the bed continues at the end grade over the outermost 15 m (`endGradeLengthM`). HAND = cell elevation − reference bed. Cells the line crosses (sampled every 0.25 m) are the drainage itself and get HAND 0, so the channel line is always wet and connected.
4. **Depth ladder.** Buckets are half-open \([min, max)\) depth ranges:
   - 0.05 m steps from 0 through the bucket that holds the segment's largest modeled depth. That depth is the largest of value − `anchorBedElevationM` and both junction depths, over every Time Series file.
   - Then 0.25 m steps until the top is 2 m above that largest depth.
5. **Trace each bucket.** A cell is wet when all of these hold:
   - Its HAND is below max(bucket minimum, 0.02 m). The 0.02 m wet floor keeps bucket 0 from being empty.
   - It is no more than 0.5 m below the reference bed. Ground lower than that drains to a different channel; see the next section.

   The polygon is then built in this order:
   - Flood-fill the wet cells (8-connected) from these seeds: the bed line cells, the Stage 1 thalweg points, and the centerline cells.
   - Grow the result by the 2 m Bank-overlap margin.
   - Vectorize it with d3-contour.
   - Clip it to the corridor.

   The corridor rules are the same as `junction-sloped-terrain-fill`: ±100 m, ends cut at the junction bisectors. The helpers are copied, not shared, because they are private in the fingerprinted `water-surface-polygon-generation.ts`.
6. **Slice the footprint (v3).** Where the triangulated surface of the polygon would deviate from bed reference + depth by more than the tolerance, cut the polygon into short slices across the flow; see [Version 3](#version-3-sliced-footprints). A footprint within tolerance stays the one polygon of v2.
7. **Ring vertex height.** Each ring vertex stores `bedReferenceM`, computed with the same function as step 3 (the bed at the nearest point of the bed line). A position shared by two slices gets one value.
8. **Ladder summary** (`water-surface-polygon-ladders.json`): `bedElevationM` = anchor bed, `maxModeledWaterSurfaceElevationM` = anchor bed + largest modeled depth, `ceilingM` = anchor bed + ladder top depth. These are elevations, so Stage 5's "value ≤ ceiling" check still applies to the WSE `values`.

## Below-bed guard (`maximumDepthBelowReferenceBedM`)

HAND assumes each cell drains to the nearest point of this creek. At the downstream end of 27714697-045 that is false. Out to 90 m from the creek, the corridor holds 563 cells more than 2 m *below* the local bed: the floor of the valley the creek drops into. With HAND < 0.02 m alone, those cells were "wet" at every depth, and bucket 0 was a 122 m × 56 m blob (1,552 m²). Excluding cells more than 0.5 m below the reference bed brings it to 549 m². On 27714697-044 and on the Jalama gauge segment 27714637-026, no cell that is wet at the floor depth sits below −0.5 m, so the guard does not change them. A proper fix would compute the drainage each cell actually flows to, with D8 (eight-direction) flow routing on the terrain. That is the textbook HAND method.

## Version 3: sliced footprints

**Why.** ArcGIS draws a polygon by triangulating its rim vertices only (earcut) and interpolating the surface inside each triangle between the three vertex heights. Nothing inside is read from the terrain or the bed. A footprint of hundreds of m² with about 60 rim vertices on a 29% bed has an interior that sits 0.35–0.7 m (95th percentile) off the ideal surface (bed reference at the point + depth), and 6–12 m off on 27714697-045. On 27714697-044 the visible share of the wet area falls from 52% (ideal) to 2% (triangulated). Version 3 changes only the geometry encoding; corridor, depth ladder, seeds, below-bed guard, rim dilation, and bed line are those of v2.

**Rule** ([`sliced-footprints.ts`](sliced-footprints.ts), [`ring-triangulation.ts`](ring-triangulation.ts)):

1. The footprint is v2's polygon: d3-contour of the footprint cells, clipped to the corridor, collinear vertices removed. It is the union of one small piece per 2 × 2 block of neighbouring cell centers (what marching squares draws inside a block).
2. Every block gets a position along the bed line: the mean arc length of the nearest bed-line point of its wet cell centers. A slice is a run of blocks in that order. Neighbouring slices meet on lines between cell centers, so they share those vertices exactly, and together they are exactly the v2 polygon.
3. Start with one slice. While the slice with the largest deviation is over the tolerance, is at least 2 × `minimumSliceLengthM` long along the bed line, and fewer than `maximumSlicesPerBucket` slices exist, cut it at the middle of its arc-length interval. Each depth bucket is cut independently.
4. **Deviation** of a slice = the 95th percentile of |triangulated surface − bed reference at the cell center| over the wet cells it covers. The surface is earcut (the copy bundled in `@arcgis/core`) on the slice's rim vertices with the vertex z's the file stores. The depth is the same on both sides and cancels.

| Parameter | Value | Meaning |
| --- | --- | --- |
| `toleranceM` | 0.3 m | Allowed deviation, floor. |
| `toleranceDepthFraction` | 1.0 | Allowed deviation is at least this fraction of the bucket's minimum depth. The tolerance is max(0.3 m, bucket depth). |
| `tolerancePercentile` | 0.95 | Of the slice's wet cells. |
| `minimumSliceLengthM` | 1 m | No cut makes a slice shorter than this along the bed line (it is also one cell). |
| `maximumSlicesPerBucket` | 64 | Per depth bucket polygon, not per Creek Segment: each bucket is cut independently. |

A flat bucket comes out as one slice, the same polygon as v2: 93,472 of 113,743 non-empty buckets (82%) have exactly v2's vertices. About 70 more differ by 1 mm in z at one corridor-clip vertex, because the clip's intersection is computed from the other end of the same edge and rounds the other way.

**No cracks.** A cut vertex is computed once and used by both slices; a vertex that appears in more than one slice is never removed as collinear; one stored position (7 decimals) gets one `bedReferenceM`, computed once. Over the whole preserve: 0 positions with two different z, 0 crossing edges (clear of 2 cm rounding), 0 shared cut vertices lying on another ring's edge without being its vertex, and 0 empty-bucket differences from v2 (the same 370 buckets are empty).

**Tolerance versus size (whole preserve, v2 = 158.4 MiB, largest file 9.8 MiB; budget: total ≤ 2 × v2, largest ≤ 25 MiB).** Visible share is the mean over the 21 sampled segments with slope ≥ 5%, wet cells, LOD 17 emulation, no raise, at the highest WY2023 depth (v2 52%, ideal surface 74%). The first tolerance, a constant 0.05 m, wrote 15.6 × v2:

| Tolerance | Total MiB | × v2 | Largest MiB | Visible share | r90 (m) | Deviation p95 mean (m) | Vertices per used bucket |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v2 | 158.4 | 1.00 | 9.8 | 52% | 0.83 | 1.27 | 64 |
| constant 0.05 m | 2,464 | 15.6 | 164.0 | 73% | 0.24 | 0.21 | 903 |
| constant 0.10 m | 1,678 | 10.6 | 86.0 | 73% | 0.25 | 0.23 | 736 |
| constant 0.20 m | 971 | 6.1 | 41.5 | 72% | 0.25 | 0.28 | 546 |
| constant 0.30 m | 672 | 4.2 | 27.6 | 71% | 0.25 | 0.35 | 435 |
| constant 0.50 m | 415 | 2.6 | 17.2 | 64% | 0.32 | 0.47 | 245 |
| constant 1.00 m | 249 | 1.57 | 13.1 | 58% | 0.45 | 0.69 | 138 |
| 0.15 m or depth | 358 | 2.26 | 14.4 | 72% | 0.26 | 0.32 | 536 |
| 0.20 m or depth | 339 | 2.14 | 13.2 | 71% | 0.26 | 0.32 | 488 |
| 0.25 m or depth | 323 | 2.04 | 12.3 | 70% | 0.27 | 0.34 | 446 |
| **0.30 m or depth (v3)** | **308** | **1.95** | **12.1** | **70%** | **0.27** | **0.37** | **413** |
| 0.40 m or depth | 282 | 1.78 | 11.9 | 67% | 0.30 | 0.42 | 302 |

"or depth" means max(tolerance, bucket minimum depth). Most of the size at a constant tolerance is spent on buckets deeper than 1 m (61% of the vertices at a constant 0.2 m), where a 0.2–1 m surface error rarely decides whether a point shows. The depth term spares them; the thin buckets keep the constant tolerance. At 0.3 m or depth, 17.7% of the buckets are cut; 3,356 buckets (2.9%) still deviate more than their tolerance at 64 slices or the 1 m minimum, mostly where the ideal surface itself steps (a 0.5 m step in the bed line inside 1 m).

**Why blocks.** Two simpler encodings were built and rejected:
- *Vectorize the cells of each along-line bin separately* (d3-contour per bin). Marching squares cuts the corner of every cell step, so each cut leaves a V-shaped notch of 0.25 m² at its end and the slices lose area: 3.7% on 27714697-044, and the rim is serrated. Blocks keep the corner cuts of the whole polygon.
- *Straight cuts perpendicular to the bed line* (polygon split with exactly shared crossings). The slices are exact, but a slice has only 2 vertices per cut. The ideal surface is the bed at the nearest bed-line point, a function of arc length, and across a zigzagging line it is jagged (|gradient| up to 3.4 m/m against a 0.29 m/m bed slope). A straight cut misses that structure: on 27714697-044 the 95th percentile deviation was 1.18 m (v2: 0.96 m), against 0.26 m with blocks.

**Measured against v2** (38 sampled segments, LOD 17 emulation, highest WY2023 depth; the "fixed time" of the earlier analysis, 2023-01-10T01, is that same timestamp for these segments). `r90` is the raise that puts 90% of the wet area at or above the mesh. Medians over segments per bin:

| Slope bin | Segments | Deviation p95 v2 → v3 (m) | Visible, no raise v2 → v3 | Raise +0.1 m | Raise +0.3 m | Ideal surface | r90 v2 → v3 (m) | Vertices v2 → v3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0–1% | 5 | 0.17 → 0.17 | 99% → 99% | 99% → 99% | 100% → 100% | 99% | 0.00 → 0.00 | 65 → 114 |
| 1–2% | 7 | 0.20 → 0.13 | 85% → 84% | 91% → 91% | 92% → 92% | 91% | 0.06 → 0.02 | 35 → 35 |
| 2–5% | 5 | 0.19 → 0.19 | 91% → 91% | 93% → 93% | 94% → 94% | 92% | 0.00 → 0.00 | 39 → 39 |
| 5–10% | 5 | 0.49 → 0.27 | 78% → 90% | 86% → 92% | 94% → 96% | 91% | 0.17 → 0.00 | 63 → 125 |
| 10–20% | 8 | 0.72 → 0.30 | 50% → 62% | 58% → 79% | 82% → 95% | 75% | 0.45 → 0.20 | 54 → 439 |
| 20–40% | 8 | 1.27 → 0.33 | 42% → 69% | 47% → 78% | 59% → 88% | 72% | 0.66 → 0.33 | 58 → 551 |

27714697-044 (28.7%): visible 15% → 57% (ideal 56%), p95 0.96 → 0.26 m, r90 0.73 → 0.27 m. 27714697-045 (36.1%): visible 21% → 18% (ideal 18%), p95 1.79 → 0.29 m, r90 1.46 → 0.68 m: the triangulation is no longer the limit there, the ideal surface is. Flat bins change little: v2 already drew them within a few cm of the ideal surface.

**Display floor after v3.** Thin water drawn at depth f (footprint of the bucket holding f), share of the wet area at or above the LOD 17 mesh, median per bin, v2 → v3 (ideal): at f = 0.3 m 20–40%: 52% → 81% (84%), 10–20%: 63% → 87% (89%), 5–10%: 62% → 78% (79%); at 0.5 m 52% → 86% (90%), 74% → 87% (91%), 71% → 82% (87%). A constant 0.3 m raise brings 62% of the slope ≥ 5% segments to ≥ 90% visible wet area (v2: 38%), 0.5 m 81% (v2: 48%). A raise proportional to slope fits worse than a constant (r90 ≈ 1.53 × slope, R² 0.16). Densification removes the triangulation part of the floor, not the 3DEP mesh part: a display floor of about 0.3 m, constant, is still needed.

**Runtime and size.** Stage 4 takes 428 s (v2 143 s). Ring vertices 9,407,679 (v2 4,701,369, 2.0 ×); polygon set files 308.5 MiB (323,480,617 bytes, 1.95 × v2), largest 12.1 MiB. 20,201 buckets are cut, into 223,630 slices.

**Validity (all 3,338 segments, 114,113 buckets).** 0 edges cross by more than 2 cm; 0 ring orientation errors; no ring under 4 points; area equal to v2 within 0.5% (rounding of lon and lat to 1 cm: 91 sliced buckets differ by more than 0.1%). Edges the corridor clip leaves along the corridor line (a clip artifact v2 has too: collinear edges bridge separate parts) carry other vertices (1,042 cases); those are zero-width overlaps, not gaps. One unshared corridor-clip vertex (27715611-004, bucket 6) lies 0.4 mm from a 0.5 m edge of another slice: two clip vertices that rounded 1 cm apart, not a gap along a cut.

**What the browser needs.** Nothing: `bedParallelRingsWgs84` maps every ring of the bucket, and every consumer in `apps/` (`modeled-water-data-store.ts`, `modeled-creek-experience.ts`, `selected-time-creek-state-resolver.ts`, `creek-data-contract.ts`, the Vite plugin's bounding box) treats `ringsWgs84` as a list. Only `arcgis-scene-renderer.ts` `elevationOnGraphic` reads `rings[0][0][2]`, on the uniform-elevation path this method does not use.

**Emulation.** The deviation, visible share, and r90 come from an emulation: the triangulation is the earcut code bundled in `@arcgis/core` 4.34.8 run on the rim vertices in UTM meters, not the renderer; the mesh is a bilinear surface through 3DEP `exportImage` tiles at LOD 17 requested the way `usgs-elevation-layer.ts` does, not the SceneView's actual tiles; the samples are on a 0.5 m grid, and "wet" is the lidar cell passing the Stage 4 test. The earlier analysis validated the mesh against the HUD ground heights; nothing here has been compared with a real SceneView.

## Was the 5-point line a problem? (v1 vs v2)

Short answer: a small problem on most segments and a large one on a few, and it barely changed the polygons. Metrics are over 28 segments (27714697-040…045, 27714637-026 and -030, and 20 others across five slope bins; 27714697-046 does not exist, the flowline ends at 045), plus the whole preserve for areas. Working files are in `/tmp/m2v2-metrics/` (not tracked).

**Bed against the lidar along the channel.** For every 1 m point of the traced path, the v1 bed (the 5 section beds, interpolated) minus the lidar ground at that point:

| Slope bin (segments) | v1 median / 95th percentile | v1 worst | v2 median / 95th percentile | v2 worst |
| --- | --- | --- | --- | --- |
| all (28) | 0.075 / 0.353 m | 3.83 m | 0.020 / 0.114 m | 2.83 m |
| under 2% (10) | 0.029 / 0.161 m | 3.83 m | 0.013 / 0.060 m | 0.83 m |
| 2–10% (4) | 0.068 / 0.358 m | 1.78 m | 0.013 / 0.061 m | 0.49 m |
| 10% and over (14) | 0.126 / 0.450 m | 3.49 m | 0.036 / 0.190 m | 2.83 m |
| 27714697-040…045 (6) | 0.075 / 0.347 m | 2.75 m | 0.056 / 0.132 m | 0.55 m |

The v2 error is the median filter and resampling only, because v2's bed is the lidar along its own path; the v1 numbers are the real error of the 5-point line. v1's median error of 0.075 m (typical 0.1–0.2 m, as measured earlier) is small. Its tail is not: 27714697-045 reaches 1.97 m at the 95th percentile (v2: 0.38 m), 27714731-004 (a flat segment) 3.22 m (v2: 0.08 m), and 27715631-058 2.46 m (v2: 0.32 m). Tracing moved the line more than 2 m sideways on 17 of 28 segments (at most 3.97 m). The residual v2 maximum of 2.83 m (27715631-058, slope 0.24) was not examined further; the median filter tests above point to a step in the channel floor.

**Footprint and drawn height.** Ring vertices drawn at `bedReferenceM` + depth, against the lidar, over the whole preserve:

| At depth | Footprint area v1 → v2 | Ring vertices more than 0.5 m below the lidar | Median drawn − lidar |
| --- | --- | --- | --- |
| 0.10 m | 1,391,757 → 1,442,578 m² (+3.7%) | 104,899 of 141,980 (73.9%) → 102,474 of 134,591 (76.1%) | −1.03 → −1.03 m |
| 0.50 m | 1,790,409 → 1,824,865 m² (+1.9%) | 105,676 of 136,438 (77.4%) → 106,934 of 135,191 (79.1%) | −1.12 → −1.14 m |

Single segments move more: at 0.10 m, 27714735-000 grows from 126 to 242 m², 27715617-029 from 1,815 to 2,307 m² (+27%), 27714697-043 from 365 to 454 m² (+24%), and 27714731-004 shrinks at 0.50 m from 711 to 328 m². Typical segments change by under 5%. The vertices sit about 1 m below the lidar in both versions because of the 2 m Bank-overlap margin, which grows the polygon into rising ground; the bed line does not change that. Interior points more than 3 m inside a footprint, drawn at the inverse-distance mean of the ring vertices' beds plus the depth, are buried more than 5 cm in 0–95% of cases per segment (steep ribbons such as 044 and 045 stay at 91–95% in both versions); counts per segment are 2–470 points, and no consistent gain or loss showed.

**What did change.** The drawn surface along the channel now sits on the lidar (v2 median 0.02 m, v1 0.075 m), which matters on steep reaches with steps. Everywhere else v2 is within a few percent of v1. It does not fix a wrong thalweg: Stage 1's thalweg points are still the end points of every piece (see limitations).

## Measured (Dangermond Preserve, Oct 23 2026)

| Item | v1 (built from m2-v1) | v2 (built from m2-v2) |
| --- | --- | --- |
| Stage 4 run time | 133 s | 143 s (bed-line tracing itself is about 3 s of it) |
| Depth buckets | 117,599 (238 empty) | 114,113 (370 empty) |
| Ring vertices | 4,953,669 | 4,701,369 |
| Bed line points | 5–9 thalweg points per segment | 254,269 points at 1 m; 4 pieces without a lidar path |
| Polygon set files | 105, 166.7 MB total (174.8 MB as bytes), largest 10.3 MB | 105, 158.4 MB total (166.1 MB as bytes), largest 9.8 MB |
| Warnings | 48 | 54 (3 more segments with empty buckets, 3 segments with a piece that had no lidar path) |

The ladder has 3,486 fewer buckets because m2-v2's largest modeled depths are smaller overall (sum over segments 4,284 m against 4,457 m; smaller on 1,606 segments, larger on 918). For comparison, `junction-sloped-terrain-fill` v1 is 105 MB total.

| 2023-02-01T00:00Z (v1 numbers, from m2-v1) | Anchor depth | Bucket | Area (this method) | Ring z range | Area (`junction-sloped-terrain-fill` v1 on m1) |
| --- | --- | --- | --- | --- | --- |
| 27714697-043 | 0.031 m | 0–0.05 | 327 m² | 257.1–268.3 m | 1,196 m² |
| 27714697-044 | 0.012 m | 0–0.05 | 512 m² | 237.0–257.7 m | 3,009 m² |
| 27714697-045 | 0.027 m | 0–0.05 | 549 m² | 207.2–237.4 m | 8,544 m² |

**Empty buckets: v2 has more (370 against 238).** 117 of the 132 added come from 3 segments that were empty in no bucket before, and 27714619-007 alone is empty in all 111. It is a 2.6 m segment whose Stage 1 thalweg points lie about 20 m away in a neighbouring gully (bed 106 m near, 109.5 m beyond). v1 drew a 3-vertex sliver for it with a bed of 107.5 m interpolated between the two gullies, which was not a channel either. The other changes are on segments that were already empty in v1 (for example 27714597-045 went from 7 to 36 of 42 buckets, 27714679-013 from 40 to 18 of 46). No segment that was empty in v1 became fully populated.

**Stage 5.** The plain run (default method, m1 Time Series) passes. It lists both `height-above-nearest-drainage-fill` versions as failing, as it did for v1 before: the check compares each m1 WSE value with the ladder ceiling, which here is the m2 anchor bed plus the largest depth, so m1 values exceed it (v1: 4,105,227 violations, v2: 4,057,011). That is a cross-method comparison, and a violation in a non-default method is only a warning. An independent check of the m2-v2 values against the v2 ladders found 0 of 157,715,516 values above the ceiling and 0 junction depths above the ladder top. v3 (plain run again, Oct 23 2026) passes the same way and lists v3 as failing the same check with the same 4,057,011 violations as v2, because the ladder is unchanged.

## Assumptions and known limitations

- **v3: the ideal surface is jagged on steep beds.** The bed reference is the bed at the nearest bed-line point, so a 1 m zigzag of the traced line gives |gradient| of the reference bed above 3 m/m beside a 0.3 m/m bed. A slice of 1 m cannot follow a 0.5 m step inside 1 m; 3,356 buckets stay above their tolerance. Fixing that means a smoother reference bed (a change for a later version), not smaller slices.
- **v3: the tolerance is not the 0.05 m first tried.** It is max(0.3 m, bucket depth), chosen to stay within twice v2's size; the whole curve is above.
- **v3: the triangulation is measured with `@arcgis/core`'s bundled earcut.** The ArcGIS version is not in the method fingerprint, so an upgrade that changes the triangulation needs a version bump.
- **Nearest drainage is geometric.** The bed reference is the nearest point of the bed line, not the drainage each cell flows to. The below-bed guard catches the worst failures (side valleys, confluence floors). A low bench on the far side of a ridge within the corridor can still be marked wet if it is less than 0.5 m below the local bed.
- **The bed line starts at Stage 1's thalweg points.** v2 follows the lowest ground between them, so a pool or step between sections is represented. The band (±4 m of the chord) keeps the path from jumping to another gully, but Stage 1's thalweg search (±30 m of the flowline) can itself lock onto a neighbouring gully, and then the band follows that gully. v2 does not fix this; it shows up as the short-segment empty buckets below and needs a Stage 1 change.
- **Steps.** A median-filtered bed keeps a step in the channel floor, but the HAND of the cells beside a tall step is still measured against the nearest bed point. Whether that dries cells at the foot of a 2–3 m step under the below-bed guard was not measured.
- **Empty buckets on very short segments.** 370 buckets on 21 segments stay empty in v2 (v1: 238 on 18). Most are 1.7–4.4 m segments (for example 27714665-066, 27714679-013, 27714727-000). Their Stage 1 thalweg points sit about 20 m off the flowline, outside their own narrow bisector-cut corridor, so no wet cell connects to a seed. `junction-sloped-terrain-fill` v1 leaves the same segments empty (27714665-066: 20 of 20). 30 segments have no modeled depths (Drainage-Area Ratio Transfer beyond the maximum distance, or unmapped). Their ladder covers 0 m + headroom only, and Stage 4 warns.
- **Depth at the vertex.** The browser interpolates depth between the two shared junction depths, while the polygon was traced at the anchor depth's bucket. At low flow these differ by millimetres to centimetres.

## Version history

| Version | Change note |
| --- | --- |
| v1 | First version: HAND fill against a Stage 1 thalweg polyline (with 2 neighbour sections each side), depth ladder, below-bed guard 0.5 m, bed-parallel drawing. Built from m2-v1. |
| v2 | The bed line is traced on the 1 m lidar between the Stage 1 thalweg points (least-cost path in a ±4 m band, 1 m spacing, 5 m median filter, lidar bed) instead of straight lines with the 5 section beds; HAND and ring-vertex beds are measured against it. Corridor, depth ladder, below-bed guard, rim dilation, seeds, and file shape are unchanged. Built from m2-v2. |
| v3 | Footprints are cut into slices across the flow where the ArcGIS-style triangulation (earcut on rim vertices) deviates from bed reference + depth by more than max(0.3 m, bucket depth) at the 95th percentile of wet cells; slices are runs of 2 × 2 cell-center blocks ordered along the bed line, at least 1 m long, at most 64 per bucket, and share their cut vertices and z exactly. Flat buckets keep v2's polygon. Corridor, depth ladder, seeds, below-bed guard, rim dilation, and bed line are unchanged. Built from `m2-v2`. |
| v4 | Rebuilt on the `m2-v3` Time Series, whose `values` are the smoothed surface at the anchor point instead of the raw Manning anchor WSE. Geometry rules (corridor, bed line, slicing, ladder rule, below-bed guard, seeds, rim dilation) are unchanged from v3; only the largest modeled depth per segment, which sizes the depth ladder, can move. Built from `m2-v3`. |
