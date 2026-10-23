# m2 — Multi-section Manning's depth

| Field | Value |
| --- | --- |
| Kind | Modeled WSE Derivation Method (Stage 3 on the shared Stage 0–1 output) |
| Method id | `m2-multi-section-manning-depth` |
| Method number | 2 |
| Current version | 1 (`m2-v1`) |
| Config | [`method-config.ts`](method-config.ts) |
| Code | [`stage-03-multi-section-time-series.ts`](stage-03-multi-section-time-series.ts), [`section-rating-curves.ts`](section-rating-curves.ts), [`rating-curve-lookup.ts`](rating-curve-lookup.ts) |
| Machine-readable summary | [`time-series-derivation.ts`](time-series-derivation.ts) |
| Command | `npm run pipeline:modeled-wse:m2-time-series -- --extent=<id> --modeled-wse-method=m2-multi-section-manning-depth` |
| Drawn by | [`height-above-nearest-drainage-fill`](../../wse-polygon-generation-methods/height-above-nearest-drainage-fill/METHOD.md) |
| Pipeline overview | [METHODOLOGY.md](../../METHODOLOGY.md) |

## Summary

m2 models water **depth** at three places in each Creek Segment instead of one water-surface elevation (WSE) for the whole segment. It uses the same discharge as [m1](../m1-drainage-area-ratio-manning-rating-curve/METHOD.md): the NHDPlusV2 reach discharge scaled by the drainage-area ratio. The difference is that it builds a Manning's rating curve at the first, middle, and last of the segment's five Stage 1 cross-sections. Each of those curves uses that section's own bed and a local bed slope. The middle section (the **anchor**) gives the Time Series value. The two end sections give the depth at each junction. A polygon method can then draw water at a depth above the local bed, so the surface runs parallel to the bed.

## Why

m1 gives each Creek Segment one WSE, read off one representative cross-section. That section is the one with the median wetted area, so its position in the segment is arbitrary. On a steep creek that is badly wrong.

- **Example: 27714697-045, Dangermond Preserve.** The bed at its five sections is 234.8, 229.2, 223.0, 216.4, and 208.8 m (a slope of 0.36). The representative section is index 0, at the upstream end. At 2023-02-01T00:00Z, m1 models a WSE of 234.82 m and an upstream junction WSE of 256.68 m. The junction value is borrowed from the upstream neighbour under the higher-of-the-two-neighbours rule.
- **Result.** `junction-sloped-terrain-fill` floods everything below that elevation in the 100 m corridor. That gives an 8,544 m² flat "lake" over ground that drops 26 m.

m2 models depth instead (2.7 cm at the anchor that hour). It leaves the drawing to a height-above-nearest-drainage (HAND) polygon method, the approach NOAA's flood inundation mapping uses. That method draws a 549 m² ribbon whose vertices range from 207.2 m to 237.4 m.

## Steps

1. **Discharge (as m1).** The segment discharge is the reach discharge × `drainageAreaRatio` from the tracked crosswalk. A Drainage-Area Ratio Transfer segment is flagged in the output. One whose borrowed reach is more than 1,000 m away gets null values. An unmapped segment also gets null values.
2. **Resample three sections.** Stage 1 stores only the representative section's profile. m2 resamples sections 0, 2, and 4 from the Stage 0 USGS 3DEP (3D Elevation Program) tiles at exactly Stage 1's positions:
   - Center on the chord at \(((i + 0.5)/5) \times\) segment length.
   - Run the section along the normal \((-u_y, u_x)\).
   - Sample offsets −100 to 100 m every 1 m.
   - Trim to that section's saved valley-edge offsets.

   On 477 representative sections checked, the resampled profile matched Stage 1's stored profile byte for byte.
3. **Local bed slope.** For each solved section, fit a least-squares line of bed against network distance. The fit uses every Stage 1 section on the same TNC flowline within ±30 m of that section. It is oriented so a bed that falls downstream gives a positive slope, then floored at 0.001. If the window holds fewer than 3 sections (a long segment), the fit uses the 3 nearest sections. m1's ±150 m window would average a 36% drop with the flatter reach around it.
4. **Rating curves.** `buildRatingCurveRecord` (m1's Stage 2 code) runs on a one-section `CrossSectionRecord` for each solved section. It uses the same divided channel, the same Manning's n of 0.04 and 0.07, the same 0.02 m ladder, the same cap at the lower valley edge or bed + 15 m, and the same running maximum.
5. **Invert.** For each timestamp, the anchor curve gives `values`, the anchor WSE in m NAVD88 (3 decimals). The end curves give a depth near each end: WSE − that section's bed, never below 0. If an end section has no usable curve, the anchor depth stands in (this did not happen in the preserve). The inversion rules match m1's `invertRatingCurve`: Q ≤ 0 → bed, missing → null, above the curve → clamped. It uses a binary search over the running-maximum ladder so that about 460 million inversions stay fast.
6. **Junctions.** At a vertex shared with a neighbour, both segments get the same two numbers:
   - **Depth:** the mean of this segment's end-section depth and the neighbour's end-section depth at that vertex. At a flowline end, or where the neighbour's value is null, the segment keeps its own end depth.
   - **Bed:** the mean of the two end-section beds that meet there.

   Upstream and downstream follow Stage 1's vertex-direction rule.

## Output

Stage 3 writes to `03-time-series/m2-multi-section-manning-depth/v<version>/time-series/<datasetId>/water-surface-elevation/…`. It uses the same compact one-file-per-TNC-flowline layout as m1, with hourly files per water year. Each Creek Segment carries:

| Field | Shape | Meaning |
| --- | --- | --- |
| `values` | array | Anchor (section 2) WSE, m NAVD88 |
| `anchorBedElevationM` | scalar | Section 2 bed. Anchor depth = value − anchorBedElevationM |
| `junctionDepthUpstreamM`, `junctionDepthDownstreamM` | arrays parallel to `values` | Depth at each vertex (shared mean, see step 6); null where the value is null |
| `junctionBedUpstreamM`, `junctionBedDownstreamM` | scalars | Bed at each vertex (mean of the two end-section beds; own end-section bed at a flowline end) |
| `junctionWseUpstreamM`, `junctionWseDownstreamM` | arrays | Junction bed + junction depth, so drawing code that reads junction WSEs keeps working |
| `drainageAreaRatioTransfer` | `true` or absent | As m1 |

`values` stays a WSE, so Stage 5's "at or above bed" check still compares it with the Stage 1 representative bed. That check can fail when the anchor bed is below the representative section's bed; it is a warning for any non-default polygon method version.

## Parameters

All parameters live in [`method-config.ts`](method-config.ts).

- **Solved sections (`SOLVED_SECTIONS`):** 0, 2 (anchor), and 4.
- **Local slope (`LOCAL_BED_SLOPE`):**
  - `halfWindowM` 30
  - `minimumSectionsInFit` 3
  - `minimumSlope` 0.001 (m1's value)
- **Everything else:** m1's `CROSS_SECTION`, `RATING_CURVE`, `MANNING_ROUGHNESS_BASIS`, `DRAINAGE_AREA_RATIO_TRANSFER`, and `MAXIMUM_TRANSFER_DISTANCE_M`, imported unchanged. m1's `method-config.ts` is in this method's `sharedCodeFiles`, so changing an m1 value also changes m2's fingerprint.

## Assumptions and known limitations

- **Manning's equation on steep creeks.** Normal-depth Manning's equation is weak above about 4–10% slope and in step-pool channels, where much of the energy is lost at steps and in hydraulic jumps. The local slope can be 0.3 or more, which gives very shallow, fast modeled flow. Treat the depth there as a shape for drawing, not a measurement.
- **Lidar bed.** Bare-earth lidar cannot see under water. The bed is the lowest ground or water surface on the survey date, so true depths are larger.
- **Three sections.** The depth between sections is interpolated by the polygon method. Pools and riffles between sections are not modeled.
- **Shared depth at a junction.** Averaging the depths can lower one side's depth at the junction below its own end-section value. That is intended: one number per vertex.
- **Discharge.** The National Water Model and California Natural Flows uncertainties, and the drainage-area ratio assumptions, are as in m1.

## Measured (Dangermond Preserve, Oct 23 2026)

| Item | Value |
| --- | --- |
| Stage 3 run time | 222 s |
| Solved sections | 3,338 segments × 3 sections; 320 slopes floored; 0 sections without a rating curve |
| Clamped anchor values | 107 National Water Model, 0 California Natural Flows |
| Largest file | 35.5 MB (27715677 WY2022) |
| Total size | 4.3 GB on disk |

The largest Time Series file is 35.5 MB, against m1's 28.4 MB, because of the two depth arrays.

| Segment (2023-02-01T00:00Z) | Anchor WSE | Anchor bed | Depth up / down | Bed up / down |
| --- | --- | --- | --- | --- |
| 27714697-043 | 262.130 | 262.099 | 0.016 / 0.026 | 268.155 / 257.190 |
| 27714697-044 | 249.869 | 249.857 | 0.026 / 0.036 | 257.190 / 237.236 |
| 27714697-045 | 223.024 | 222.997 | 0.036 / 0.024 | 237.236 / 208.799 |

## Version history

| Version | Change type | Change note |
| --- | --- | --- |
| `m2-v1` | new method | First version: three-section Manning's depth with local slopes and shared junction depths and beds, for bed-parallel drawing. |
