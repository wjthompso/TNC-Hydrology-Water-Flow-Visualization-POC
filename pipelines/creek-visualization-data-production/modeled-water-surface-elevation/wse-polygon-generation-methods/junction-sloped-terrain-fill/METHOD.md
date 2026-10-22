# junction-sloped-terrain-fill — Junction-sloped terrain fill

| Field | Value |
| --- | --- |
| Kind | WSE Polygon Generation Method (Stage 4) |
| Method id | `junction-sloped-terrain-fill` (default) |
| Current version | 1; published as Data-Product Version `m1-v1` of `wse-polygons` (`m1-junction-sloped-terrain-fill`) |
| Browser drawing | `sloped-between-junctions` |
| Config | [`method-config.ts`](method-config.ts): `version`, `description`, `browserDrawing`, `sharedCodeFiles`, `parameters` |
| Code | [`generate-water-surface-polygons.ts`](generate-water-surface-polygons.ts) and the shared `water-surface-polygon-generation.ts` |
| Built from | Modeled WSE Time Series of a [Modeled WSE Derivation Method](../../modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/METHOD.md) |
| Pipeline overview | [METHODOLOGY.md](../../METHODOLOGY.md#wse-polygon-generation-methods): folder layout, version bump rule, adding a method |

## Summary

For each Creek Segment, this method builds a ladder of elevation buckets and traces one water polygon per bucket by flood-filling the USGS 3DEP 1 m terrain below a wet threshold. The threshold slopes from the segment's upstream junction WSE to its downstream junction WSE, so neighbouring segments' water meets at their shared vertex. The browser picks the bucket that holds the selected time's WSE and draws its polygon sloped between the same two junction WSEs.

## Polygon ladder

0.05 m buckets run from the bed through the bucket that holds the highest WSE in any modeled Time Series. 0.25 m buckets then continue until the top is at least 2 m above that WSE. Buckets are half-open `[min, max)`, and each polygon is built at its bucket minimum. Polygons reuse publish's 100 m corridor, 8-connected flood fill, and 2 m Bank-overlap margin. The flood fill seeds from the centerline cells and from the Creek Segment's 5 Stage 1 thalweg points. Publish no longer traces polygons: it copies a reviewed snapshot of this method's v1 polygon set for the gauge's Creek Segment, 27714637-026, so observed water draws these polygons too (see the [publish README](../../../README.md#observed-water-surface-polygons)).

## Sloped wet threshold

For each bucket, Stage 4 averages the junction WSEs of every modeled value that fell in that bucket and traces the polygon with a wet threshold that runs linearly from the upstream junction WSE on the corridor's upstream boundary line to the downstream junction WSE on its downstream boundary line, never below the bucket minimum. The polygon therefore contains the flat one and reaches the bed up to the upstream junction. A bucket no value falls in (headroom buckets) is traced flat as before. The ladder summary counts `slopedBuckets` per segment (3,169 of 7,498 at Jalama). The position between the two boundaries is `fractionBetweenBoundaries` in `water-surface-polygon-generation.ts`: 0 on the upstream boundary, 1 on the downstream one, the ratio of the two perpendicular distances in between. On a straight corridor with square ends this is the along-axis fraction; at a bend it keeps the whole slanted bisector line at the junction WSE, where an axis projection would not (see the next section).

## Bisector corridor ends

A corridor end at a shared vertex is cut at the angle bisector of the two segments' directions (the perpendicular to their mean direction), so the upstream segment's downstream boundary and the downstream segment's upstream boundary are one line and no wedge of bed is left uncovered on the outside of a bend. A slanted end may reach at most 100 m past the vertex along the axis, and a hairpin keeps the perpendicular. Corridors still never exceed ±100 m laterally. Publish measures this bisector-cut corridor for 27714637-026 only to check the copied observed polygons against its bounding box.

## Sloped drawing (browser)

The browser lifts every ring vertex of a drawn polygon to the height interpolated between the segment's two junction WSEs at the selected time (`junctionWseUpstreamM`, `junctionWseDownstreamM`), using the same between-boundaries rule as Stage 4 (`sloped-water-surface.ts`). The dev middleware's `creek-segment-paths.json` gives each segment its flowline vertices in flow order and the ids of its two neighbours, from which the browser rebuilds the junction bisectors. Measuring the slope between the bisector lines rather than by projecting onto the segment axis is what closes the seam: at a bend the bisector is slanted, so an axis projection put the upstream segment's edge at its junction WSE for every point on the line (clamped) while the downstream segment's edge, whose axis projection of the same points is already a little way along, sat lower. On side creek 27714669 at the 007/008 junction (2023-01-01T11:00Z) that crack was about 0.3 m, and a camera looking up the creek at a grazing angle saw the ground through it (FBT-012 Part B). With both polygons holding the junction WSE on the whole line, the two sheets meet exactly.

## Assumptions and known limitations

- **Junction rule and shelves.** The higher-value junction rule (see the [modeled WSE method](../../modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/METHOD.md#junction-wse)) holds a steep segment's water at its own level all the way to its downstream vertex, so where the thalweg drops several meters inside the segment the drawn surface stands that far above the bed at the boundary, and the neighbour's surface falls steeply from the shared junction to its own level (27714669-008: 5.1 m over 14.6 m at the hour above). An alternative, the creek-bed elevation at the shared vertex plus the mean depth of the two neighbours, was worked through for UCS-271 and not adopted: it would put 27714669-007's water about 3 m below the bank the developer clicked in FBT-012 Part B (water 159.6 m against ground 162.4 m at 76 m along the segment, modeled depth 0.18 m), and a straight slope between two bed-level junctions runs under a convex thalweg profile (27714697-044 drops 3.1, 3.7, 4.6, and 5.6 m per 10.8 m, leaving the mid-segment bed about 1.5 m above the line). Covering the bed in such segments would need the surface to follow the Stage 1 thalweg profile within the segment, which the published files do not carry today.
- **Flowline offset:** The TNC flowline often sits 6–15 m off the channel's lowest ground. Seeding only from the centerline left 1,026 of 3,122 buckets empty, and about 57% of modeled values fell into them. With thalweg seeds, 9 buckets stay empty at Jalama (569 of 102,847 in the preserve). Each is a floor bucket that starts up to 5 cm below the bed, where no connected terrain cell is that low. Zero-discharge values map to the bed and land in these buckets, which accounts for most of the remaining 3–6% of values in empty buckets. Stage 4 lists them as warnings. A thalweg seed can add a separate wet pocket inside the corridor, and 10 buckets gained a second ring this way.

## Version history

| Version | Change note |
| --- | --- |
| v1 | The UCS-271 Stage 4 behaviour. Byte-identical to the Stage 4 output written before methods existed: 1 of 1 polygon set file plus the ladder at Jalama, 105 of 105 plus the ladder in the preserve (SHA-256 compared, Oct 19 2026). |
