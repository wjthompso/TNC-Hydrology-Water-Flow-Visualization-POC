# height-above-nearest-drainage-fill — Height above nearest drainage (bed-parallel) fill

| Field | Value |
| --- | --- |
| Kind | WSE Polygon Generation Method (Stage 4) |
| Method id | `height-above-nearest-drainage-fill` (not the default) |
| Current version | 1 |
| Browser drawing | `bed-parallel-depth` |
| Config | [`method-config.ts`](method-config.ts) |
| Code | [`generate-water-surface-polygons.ts`](generate-water-surface-polygons.ts), [`corridor-geometry.ts`](corridor-geometry.ts) (copied corridor, flood-fill, and clip helpers) |
| Built from | The Time Series of [m2-multi-section-manning-depth](../../modeled-wse-derivation-methods/m2-multi-section-manning-depth/METHOD.md). It needs m2's depth fields and stops with a message on an m1 Time Series. |
| Command | `npm run pipeline:modeled-wse:water-surface-polygons -- --extent=<id> --modeled-wse-method=m2-multi-section-manning-depth --wse-polygon-method=height-above-nearest-drainage-fill` |

## ⚠️ Bucket bounds are DEPTHS

In this method's polygon sets, each bucket's `minWaterSurfaceElevationM` and `maxWaterSurfaceElevationM` are **water depths in meters above the local creek bed**. They are not elevations. The field names are kept so the file shape matches every other method. `browserDrawing: 'bed-parallel-depth'` tells the browser how to read them.

Every ring vertex is `[longitude, latitude, bedReferenceM]`:

- longitude and latitude: 7 decimals
- `bedReferenceM`: m NAVD88, 3 decimals

The browser draws each vertex at `bedReferenceM` + the depth at the selected time. It interpolates that depth between `junctionDepthUpstreamM` and `junctionDepthDownstreamM`. The bucket it picks is the one holding the anchor depth (value − `anchorBedElevationM`).

## Summary

HAND (height above nearest drainage) is the height of a cell above the creek bed it drains to. NOAA's flood inundation mapping (Zheng, Tarboton, Maidment et al., 2018) and Nobre et al. (2011) use it to map water from a stage. In a steep valley a flat elevation threshold floods everything below it. A HAND threshold instead floods a band of constant depth that follows the bed downhill.

## Steps (per Creek Segment)

1. **Reference thalweg.** Build a polyline in vertex order through:
   - the 2 Stage 1 thalweg points of the start-vertex neighbour nearest the shared vertex,
   - this segment's 5 thalweg points,
   - the 2 nearest thalweg points of the end-vertex neighbour.

   Each point carries its section's `bedElevationM`. Because the neighbours' points are included, the bed field is continuous across each junction.
2. **Reference bed and HAND.** For each corridor cell, the reference bed is the bed linearly interpolated at the nearest point of the polyline. Past either end of the polyline, the bed continues at the end grade, taken over the outermost 2 pieces. HAND = cell elevation − reference bed. Cells the polyline crosses (sampled every 0.25 m) are the drainage itself and get HAND 0, so the channel line is always wet and connected.
3. **Depth ladder.** Buckets are half-open \([min, max)\) depth ranges:
   - 0.05 m steps from 0 through the bucket that holds the segment's largest modeled depth. That depth is the largest of value − `anchorBedElevationM` and both junction depths, over every Time Series file.
   - Then 0.25 m steps until the top is 2 m above that largest depth.
4. **Trace each bucket.** A cell is wet when all of these hold:
   - Its HAND is below max(bucket minimum, 0.02 m). The 0.02 m wet floor keeps bucket 0 from being empty.
   - It is no more than 0.5 m below the reference bed. Ground lower than that drains to a different channel; see the next section.

   The polygon is then built in this order:
   - Flood-fill the wet cells (8-connected) from these seeds: the reference thalweg cells, the Stage 1 thalweg points, and the centerline cells.
   - Grow the result by the 2 m Bank-overlap margin.
   - Vectorize it with d3-contour.
   - Clip it to the corridor.

   The corridor rules are the same as `junction-sloped-terrain-fill`: ±100 m, ends cut at the junction bisectors. The helpers are copied, not shared, because they are private in the fingerprinted `water-surface-polygon-generation.ts`.
5. **Ring vertex height.** Each ring vertex stores `bedReferenceM`, computed with the same function as step 2.
6. **Ladder summary** (`water-surface-polygon-ladders.json`): `bedElevationM` = anchor bed, `maxModeledWaterSurfaceElevationM` = anchor bed + largest modeled depth, `ceilingM` = anchor bed + ladder top depth. These are elevations, so Stage 5's "value ≤ ceiling" check still applies to the WSE `values`.

## Below-bed guard (`maximumDepthBelowReferenceBedM`)

HAND assumes each cell drains to the nearest point of this creek. At the downstream end of 27714697-045 that is false. Out to 90 m from the creek, the corridor holds 563 cells more than 2 m *below* the local bed: the floor of the valley the creek drops into. With HAND < 0.02 m alone, those cells were "wet" at every depth, and bucket 0 was a 122 m × 56 m blob (1,552 m²). Excluding cells more than 0.5 m below the reference bed brings it to 549 m². On 27714697-044 and on the Jalama gauge segment 27714637-026, no cell that is wet at the floor depth sits below −0.5 m, so the guard does not change them. A proper fix would compute the drainage each cell actually flows to, with D8 (eight-direction) flow routing on the terrain. That is the textbook HAND method.

## Measured (Dangermond Preserve, Oct 23 2026, built from m2-v1)

| Item | Value |
| --- | --- |
| Stage 4 run time | 133 s |
| Depth buckets | 117,599 (238 empty) |
| Ring vertices | 4,953,669 |
| Polygon set files | 105, 166.7 MB total, largest 10.3 MB (27714637) |

For comparison, `junction-sloped-terrain-fill` v1 is 105 MB total.

| 2023-02-01T00:00Z | Anchor depth | Bucket | Area (this method) | Ring z range | Area (`junction-sloped-terrain-fill` v1 on m1) |
| --- | --- | --- | --- | --- | --- |
| 27714697-043 | 0.031 m | 0–0.05 | 327 m² | 257.1–268.3 m | 1,196 m² |
| 27714697-044 | 0.012 m | 0–0.05 | 512 m² | 237.0–257.7 m | 3,009 m² |
| 27714697-045 | 0.027 m | 0–0.05 | 549 m² | 207.2–237.4 m | 8,544 m² |

## Assumptions and known limitations

- **Nearest drainage is geometric.** The bed reference is the nearest point of the thalweg polyline, not the drainage each cell flows to. The below-bed guard catches the worst failures (side valleys, confluence floors). A low bench on the far side of a ridge within the corridor can still be marked wet if it is less than 0.5 m below the local bed.
- **Five points per segment.** Between Stage 1 sections, the bed is a straight line. A pool or step between sections is not represented.
- **Empty buckets on very short segments.** 238 buckets on 18 segments stay empty. Most are 1.7–4.4 m segments (for example 27714665-066, 27714679-013, 27714727-000). Their Stage 1 thalweg points sit about 20 m off the flowline, outside their own narrow bisector-cut corridor, so no wet cell connects to a seed. `junction-sloped-terrain-fill` v1 leaves the same segments empty (27714665-066: 20 of 20). 30 segments have no modeled depths (Drainage-Area Ratio Transfer beyond the maximum distance, or unmapped). Their ladder covers 0 m + headroom only, and Stage 4 warns.
- **Depth at the vertex.** The browser interpolates depth between the two shared junction depths, while the polygon was traced at the anchor depth's bucket. At low flow these differ by millimetres to centimetres.

## Version history

| Version | Change note |
| --- | --- |
| v1 | First version: HAND fill against a Stage 1 thalweg polyline (with 2 neighbour sections each side), depth ladder, below-bed guard 0.5 m, bed-parallel drawing. Built from m2-v1. |
