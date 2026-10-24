# m2 — Multi-section Manning's depth

| Field | Value |
| --- | --- |
| Kind | Modeled WSE Derivation Method (Stage 3 on the shared Stage 0–1 output) |
| Method id | `m2-multi-section-manning-depth` |
| Method number | 2 |
| Current version | 3 (`m2-v3`) |
| Config | [`method-config.ts`](method-config.ts) |
| Code | [`stage-03-multi-section-time-series.ts`](stage-03-multi-section-time-series.ts), [`section-rating-curves.ts`](section-rating-curves.ts), [`rating-curve-lookup.ts`](rating-curve-lookup.ts), [`junction-depths.ts`](junction-depths.ts) |
| Machine-readable summary | [`time-series-derivation.ts`](time-series-derivation.ts) |
| Command | `npm run pipeline:modeled-wse:m2-time-series -- --extent=<id> --modeled-wse-method=m2-multi-section-manning-depth` |
| Drawn by | [`height-above-nearest-drainage-fill`](../../wse-polygon-generation-methods/height-above-nearest-drainage-fill/METHOD.md) |
| Pipeline overview | [METHODOLOGY.md](../../METHODOLOGY.md) |

## Summary

m2 models water **depth** instead of one water-surface elevation (WSE) for the whole segment. It uses the same discharge as [m1](../m1-drainage-area-ratio-manning-rating-curve/METHOD.md): the NHDPlusV2 reach discharge scaled by the drainage-area ratio. It builds a Manning's rating curve at the middle of the segment's five Stage 1 cross-sections (the **anchor**), with that section's own bed and a local bed slope. The depth at each junction is one number per shared vertex, a smoothed mean of the neighbouring segments' anchor depths (v2). A polygon method can then draw water at a depth above the local bed, so the surface runs parallel to the bed. **The WSE of a segment is the WSE of that smoothed surface at its anchor point (v3).** The raw Manning WSE at the anchor section is kept as `rawAnchorWseM`, for diagnosis only.

**Version 3 changed only `values`.** In v1 and v2, `values` was the raw Manning WSE at the anchor section, but the water drawn there is the smoothed junction depths interpolated to the anchor. On flat creeks the chart and the drawn water disagreed by up to 4.7 m (see [Why v3](#why-v3-the-wse-is-the-drawn-surface-at-the-anchor-point)). v3 writes the drawn surface as `values` and moves the raw solve to `rawAnchorWseM`. Junction depths, junction beds, junction WSEs, and `anchorBedElevationM` are byte-identical to m2-v2.

**Version 2 changed only the junction depths.** m2-v1 solved Manning's equation again at each segment's first and last section. Normal depth depends strongly on each section's shape, so adjacent sections disagreed and the water surface stepped by metres across flat reaches (see [Why v2](#why-v2-continuous-junction-depth)). v2 drops those two solves. `values`, `anchorBedElevationM`, and the junction beds are byte-identical to m2-v1 in all 735 Time Series files.

## Why

m1 gives each Creek Segment one WSE, read off one representative cross-section. That section is the one with the median wetted area, so its position in the segment is arbitrary. On a steep creek that is badly wrong.

- **Example: 27714697-045, Dangermond Preserve.** The bed at its five sections is 234.8, 229.2, 223.0, 216.4, and 208.8 m (a slope of 0.36). The representative section is index 0, at the upstream end. At 2023-02-01T00:00Z, m1 models a WSE of 234.82 m and an upstream junction WSE of 256.68 m. The junction value is borrowed from the upstream neighbour under the higher-of-the-two-neighbours rule.
- **Result.** `junction-sloped-terrain-fill` floods everything below that elevation in the 100 m corridor. That gives an 8,544 m² flat "lake" over ground that drops 26 m.

m2 models depth instead (2.7 cm at the anchor that hour). It leaves the drawing to a height-above-nearest-drainage (HAND) polygon method, the approach NOAA's flood inundation mapping uses. That method draws a 549 m² ribbon whose vertices range from 207.2 m to 237.4 m.

## Steps

1. **Discharge (as m1).** The segment discharge is the reach discharge × `drainageAreaRatio` from the tracked crosswalk. A Drainage-Area Ratio Transfer segment is flagged in the output. One whose borrowed reach is more than 1,000 m away gets null values. An unmapped segment also gets null values.
2. **Resample the anchor section.** Stage 1 stores only the representative section's profile. m2 resamples section 2 (the anchor; v1 also did sections 0 and 4) from the Stage 0 USGS 3DEP (3D Elevation Program) tiles at exactly Stage 1's positions:
   - Center on the chord at \(((i + 0.5)/5) \times\) segment length.
   - Run the section along the normal \((-u_y, u_x)\).
   - Sample offsets −100 to 100 m every 1 m.
   - Trim to that section's saved valley-edge offsets.

   On 477 representative sections checked, the resampled profile matched Stage 1's stored profile byte for byte.
3. **Local bed slope.** For the anchor section, fit a least-squares line of bed against network distance. The fit uses every Stage 1 section on the same TNC flowline within ±30 m of that section. It is oriented so a bed that falls downstream gives a positive slope, then floored at 0.001. If the window holds fewer than 3 sections (a long segment), the fit uses the 3 nearest sections. m1's ±150 m window would average a 36% drop with the flatter reach around it.
4. **Rating curves.** `buildRatingCurveRecord` (m1's Stage 2 code) runs on a one-section `CrossSectionRecord` for the anchor section. It uses the same divided channel, the same Manning's n of 0.04 and 0.07, the same 0.02 m ladder, the same cap at the lower valley edge or bed + 15 m, and the same running maximum.
5. **Invert.** For each timestamp, the anchor curve gives the raw anchor WSE in m NAVD88 (3 decimals, written as `rawAnchorWseM`; it was `values` in v1 and v2), and the **raw anchor depth** = `rawAnchorWseM` − `anchorBedElevationM`, never below 0. The inversion rules match m1's `invertRatingCurve`: Q ≤ 0 → bed, missing → null, above the curve → clamped. It uses a binary search over the running-maximum ladder so that about 150 million inversions stay fast. A segment is **dry** when its written raw anchor depth is 0, **wet** above 0, and has **no value** when the WSE is null. Every junction depth can be rebuilt from `rawAnchorWseM`, `anchorBedElevationM`, and the segment lengths.
6. **Junctions.** Segments of one TNC flowline that share vertices form a run (a flowline with several paths has one run per path). At each vertex shared by two segments:
   - **Depth (v2):** one number for both segments. When both are wet it is the length-weighted mean of the anchor depths of the wet segments within `JUNCTION_DEPTH.smoothingHalfWindowM` = 100 m (along the flowline) on each side of the vertex. Each segment counts by the length of it inside the window, so a 2 m segment weighs less than a 30 m one. The walk outward stops at a dry, missing, or absent segment, so the window never crosses one.
   - **Dry and flowline ends:** a dry segment stays 0 at both ends, so it never takes water from a wet neighbour. A wet segment next to a dry or missing neighbour, or at a flowline end, keeps its own anchor depth at that vertex. At such a vertex the two segments therefore differ by design (wet depth next to 0). Where both are wet the two numbers are identical.
   - **Bed:** the mean of the two end-section beds that meet there (unchanged from v1; the first and last sections' beds only, no rating curve).

   Upstream and downstream follow Stage 1's vertex-direction rule. The surface drop across a wet segment is then (bed drop) + (depth up − depth down), so smoothing the depth is what keeps a flat reach level.
7. **Segment WSE (v3).** `values` = `anchorBedElevationM` + the junction depths interpolated to the anchor position, rounded to 3 decimals. Stage 1 places section 2 at ((2 + 0.5) / 5) × segment length along the chord, so `ANCHOR_POSITION_ALONG_SEGMENT` = 0.5 and the anchor depth is the mean of the two junction depths. Measured on all 3,338 segments, Stage 1's `alongSegmentM` ÷ chord length is 0.5 within 0.0011. A dry segment has 0 at both junctions, so its depth is 0 and `values` = anchor bed; a wet segment next to a dry one keeps its own raw anchor depth at that vertex (step 6), so it stays wet.

## Output

Stage 3 writes to `03-time-series/m2-multi-section-manning-depth/v<version>/time-series/<datasetId>/water-surface-elevation/…`. It uses the same compact one-file-per-TNC-flowline layout as m1, with hourly files per water year. Each Creek Segment carries:

| Field | Shape | Meaning |
| --- | --- | --- |
| `values` | array | WSE of the smoothed surface at the anchor point (section 2), m NAVD88: anchor bed + mean of the two junction depths (v3) |
| `rawAnchorWseM` | array parallel to `values` | Raw Manning normal-depth WSE at the anchor section, m NAVD88; diagnostic only (v1 and v2 wrote it as `values`) |
| `anchorBedElevationM` | scalar | Section 2 bed. Anchor depth = value − anchorBedElevationM |
| `junctionDepthUpstreamM`, `junctionDepthDownstreamM` | arrays parallel to `values` | Depth at each vertex (one number shared with the neighbour, see step 6); 0 on a dry segment; null where the value is null |
| `junctionBedUpstreamM`, `junctionBedDownstreamM` | scalars | Bed at each vertex (mean of the two end-section beds; own end-section bed at a flowline end) |
| `junctionWseUpstreamM`, `junctionWseDownstreamM` | arrays | Junction bed + junction depth, so drawing code that reads junction WSEs keeps working |
| `drainageAreaRatioTransfer` | `true` or absent | As m1 |

`values` stays a WSE (and is never below the anchor bed), so Stage 5's "at or above bed" check still compares it with the Stage 1 representative bed. That check can fail when the anchor bed is below the representative section's bed; it is a warning for any non-default polygon method version.

## Parameters

All parameters live in [`method-config.ts`](method-config.ts).

- **Solved section (`SOLVED_SECTIONS`):** 2 (the anchor). v1 also solved 0 and 4.
- **Junction bed sections (`JUNCTION_BED_SECTIONS`):** 0 and 4. Their beds only.
- **Junction depth (`JUNCTION_DEPTH`):** `smoothingHalfWindowM` 100.
- **Local slope (`LOCAL_BED_SLOPE`):**
  - `halfWindowM` 30
  - `minimumSectionsInFit` 3
  - `minimumSlope` 0.001 (m1's value)
- **Everything else:** m1's `CROSS_SECTION`, `RATING_CURVE`, `MANNING_ROUGHNESS_BASIS`, `DRAINAGE_AREA_RATIO_TRANSFER`, and `MAXIMUM_TRANSFER_DISTANCE_M`, imported unchanged. m1's `method-config.ts` is in this method's `sharedCodeFiles`, so changing an m1 value also changes m2's fingerprint.

## Assumptions and known limitations

- **Manning's equation on steep creeks.** Normal-depth Manning's equation is weak above about 4–10% slope and in step-pool channels, where much of the energy is lost at steps and in hydraulic jumps. The local slope can be 0.3 or more, which gives very shallow, fast modeled flow. Treat the depth there as a shape for drawing, not a measurement.
- **Lidar bed.** Bare-earth lidar cannot see under water. The bed is the lowest ground or water surface on the survey date, so true depths are larger.
- **One solved section.** The depth between anchors is the smoothed junction depth interpolated by the polygon method. Pools and riffles between sections are not modeled.
- **The segment WSE is smoothed, not the raw solve.** From v3, `values` is the drawn surface at the anchor point, so it differs from the raw Manning WSE at the anchor (`rawAnchorWseM`) by the smoothing: at the 2023-01-10T01:00Z peak, median 0.44 m and 95th percentile 1.92 m on flat wet segments, 0.044 m and 0.41 m on steep ones. `rawAnchorWseM` is one noisy section's normal depth; it is kept for diagnosis, not for display.
- **The anchor position is the chord midpoint.** The browser measures position between the two junction bisector lines. At the anchor's chord point that fraction is within 0.05 of 0.5 for 3,291 of 3,338 segments (max 0.156); at the thalweg point, which Stage 1 may find up to 30 m off the flowline, 652 segments sit more than 0.05 from 0.5. Where the junction depths differ, the water drawn at the thalweg can then differ from `values`: by more than 0.1 m in 2,964 of 30.4 million wet National Water Model segment-hours (max 1.91 m).
- **Flat creeks are not exactly level.** At the peak, 39% of wet flat segments (bed slope under 1%) still have a surface drop that differs from the bed drop by more than 0.10 m (median 0.069 m). Anchor depths along a flat creek change along the reach (Jalama 27714637: 4.9 to 8.3 m between neighbouring segments), and a ±100 m window only removes the segment-to-segment noise, not a real trend.
- **Window edges.** Flowline ends and wet/dry boundaries keep the own anchor depth at that vertex (the spec's rule), so the end segment of a flat creek can step by up to its anchor-depth noise: 76% of the 50 flat edge segments at the peak differ by more than 0.10 m.
- **Steep reaches next to flat ones.** A vertex between a deep pool and a shallow steep reach averages both, so a shallow anchor can be drawn deeper at one end: 84 of 1,495 wet segments with an anchor depth under 0.5 m have a mean junction depth more than 0.25 m above the anchor at the peak (m2-v1: 64).
- **Discharge.** The National Water Model and California Natural Flows uncertainties, and the drainage-area ratio assumptions, are as in m1.

## Why v2: continuous junction depth

m2-v1 set each junction depth from the independent Manning solves at the end sections (0 and 4), averaged with the neighbour's. On flat creeks that is not physical. Evidence at 2023-01-10T01:00Z (the National Water Model peak hour):

| Segment | v1 junction depths (up / down) | Junction beds (up / down) | Bed drop | v1 surface drop |
| --- | --- | --- | --- | --- |
| 27714637-026 (Jalama) | 6.661 / 5.984 | 25.531 / 25.290 | 0.24 m | 0.92 m |
| 27714637-030 (Jalama) | 8.128 / 6.403 | 24.523 / 24.550 | −0.03 m | 1.70 m |

Real water-surface slope is about the smoothed bed slope (the uniform-flow assumption Manning's equation itself makes). A flat creek must stay nearly level and a steep one keep its slope.

## Choosing the junction depth rule

Candidates were compared on the saved m2-v1 anchors over the whole preserve (3,338 segments) at the peak hour (3,268 wet segments) and at a low-flow hour, 2022-10-15T12:00Z (329 wet). The measure is **surface drop − bed drop** across each wet segment, where surface drop = (junctionBedUp + junctionDepthUp) − (junctionBedDown + junctionDepthDown) and bed drop = junctionBedUp − junctionBedDown. It equals depthUp − depthDown. Bins are by bed slope: flat < 1%, moderate 1–5%, steep > 5%.

**Peak hour, 2023-01-10T01:00Z**

| Rule | Segments off by > 0.10 m | Median / 95th percentile |difference| | Flat (n = 359): off by > 0.10 m / median | Steep (n = 1,730): off by > 0.10 m | Steep: mean junction depth vs anchor, median / p95 |
| --- | --- | --- | --- | --- | --- |
| m2-v1 (end-section solves) | 1,586 (48.5%) | 0.093 / 1.248 m | 84% / 0.508 m | 31.4% | 0.043 / 0.362 m |
| (a) mean of the two adjacent anchor depths | 1,244 (38.1%) | 0.063 / 0.816 m | 75% / 0.364 m | 21.5% | 0.025 / 0.215 m |
| (b) length-weighted mean within ±30 m | 1,099 (33.6%) | 0.050 / 0.613 m | 67% / 0.237 m | 18.1% | 0.028 / 0.268 m |
| (b) ±60 m | 790 (24.2%) | 0.034 / 0.424 m | 53% / 0.125 m | 11.0% | 0.035 / 0.327 m |
| **(b) ±100 m (chosen)** | **550 (16.8%)** | **0.023 / 0.309 m** | **39% / 0.069 m** | **6.8%** | **0.043 / 0.364 m** |
| (b) ±150 m | 417 (12.8%) | 0.017 / 0.225 m | 36% / 0.059 m | 5.0% | 0.048 / 0.389 m |
| (b) ±300 m | 233 (7.1%) | 0.009 / 0.129 m | 18% / 0.024 m | 3.8% | 0.055 / 0.424 m |
| (c) local-linear fit of the anchor WSE (surface), ±30 m | 2,525 (77.3%) | 0.279 / 1.268 m | 84% / 0.421 m | 77.2% | 0.160 / 0.697 m |

- **(a), mean of adjacent anchors,** is the limit of (b) as the window shrinks. It helps but leaves 75% of flat segments off by more than 0.10 m.
- **(b), the window average of anchor depths,** gets better with the window: flat creeks level out, but a wide window also pulls deep-pool depths into shallow steep reaches (steep mean-junction-depth error: median 0.043 m at ±100 m, 0.055 m at ±300 m, p95 0.364 m to 0.424 m). ±100 m is the widest window whose steep error is no worse than m2-v1's (0.043 / 0.362 m), so it was chosen. A triangular kernel of ±150 m gave the same flat result (39% off by > 0.10 m) and a slightly better steep one (5.9% off by > 0.10 m, p95 0.352 m) for more code, and was not adopted.
- **(c), smoothing the anchor WSE instead of the depth,** was worse everywhere (77% of segments off), because depth = smoothed surface − a noisy junction bed. The junction beds jitter by ±0.1 m, and at low flow the depths are centimetres, so the surface went below the bed at 794 vertices (clamped to 0).
- **Low-flow hour (329 wet segments):** every rule, including m2-v1, keeps all surface drops within 0.10 m of the bed drop (m2-v1 median 0.010 m, p95 0.037 m; chosen rule median 0.001 m, p95 0.012 m). Low flow is not where m2-v1 failed.

Chosen rule, before and after, at the peak hour:

| Segment | Anchor depth | v1 depth up / down | v1 surface − bed drop | v2 depth up / down | v2 surface − bed drop |
| --- | --- | --- | --- | --- | --- |
| 27714637-026 | 6.190 | 6.661 / 5.984 | +0.677 m | 5.932 / 6.099 | −0.167 m |
| 27714637-030 | 8.033 | 8.128 / 6.403 | +1.725 m | 6.436 / 6.366 | +0.070 m |
| 27714697-040 | 0.068 | 0.081 / 0.097 | −0.016 m | 0.082 / 0.078 | +0.004 m |
| 27714697-041 | 0.074 | 0.097 / 0.083 | +0.014 m | 0.078 / 0.071 | +0.007 m |
| 27714697-042 | 0.059 | 0.083 / 0.056 | +0.027 m | 0.071 / 0.066 | +0.005 m |
| 27714697-043 | 0.094 | 0.056 / 0.084 | −0.028 m | 0.066 / 0.070 | −0.004 m |
| 27714697-044 | 0.053 | 0.084 / 0.105 | −0.021 m | 0.070 / 0.074 | −0.004 m |
| 27714697-045 | 0.083 | 0.105 / 0.065 | +0.040 m | 0.074 / 0.083 | −0.009 m |
| 27714697-046 | dry at this hour | | | | |

The two flat Jalama segments fell from 0.68 and 1.73 m to 0.17 and 0.07 m. 026 is still above 0.10 m; the target was met for 030 but not 026. The steep 040–045 reaches were already within 0.04 m and are now within 0.009 m. Across the preserve at the peak, wet segments off by more than 0.10 m fell from 1,586 to 550, and the 95th percentile of |difference| from 1.25 m to 0.31 m.

**Integrity of the saved v2 output** (every one of 735 Time Series files, 159 million segment-hours): `values`, `anchorBedElevationM`, and both junction beds equal m2-v1's exactly; 0 negative depths; 0 junction mismatches between two wet neighbours (29 million wet–wet vertices); 0 dry segments with water; every wet segment next to a dry one (2.2 million vertices) keeps its own anchor depth; junction WSE = junction bed + junction depth everywhere. An independent prototype of the rule matched Stage 3's output to 0.0005 m (rounding) on 9 hours × 3,338 segments.

## Why v3: the WSE is the drawn surface at the anchor point

The WSE Anchor Point is where a segment's WSE applies, and the chart must show the water that is there. In v2 the chart plotted `values` (the raw Manning anchor WSE), while the browser drew the anchor at bed + the smoothed junction depths interpolated there. At the 2023-01-10T01:00Z peak:

| Segment | Slope | v2 chart value | Water drawn at the anchor (v2 and v3) | v3 chart value | v2 chart − drawn |
| --- | --- | --- | --- | --- | --- |
| 27714637-026 (Jalama) | 1.2% | 32.080 | 31.905 | 31.905 | +0.175 m |
| 27714637-030 (Jalama) | 0.2% | 32.636 | 31.004 | 31.004 | +1.632 m |
| 27714697-040 | 24.6% | 288.304 | 288.316 | 288.316 | −0.012 m |
| 27714697-041 | 14.6% | 282.289 | 282.289 | 282.289 | 0.000 m |
| 27714697-042 | 13.5% | 276.506 | 276.515 | 276.515 | −0.009 m |
| 27714697-043 | 28.0% | 262.193 | 262.167 | 262.167 | +0.026 m |
| 27714697-044 | 37.0% | 249.910 | 249.929 | 249.929 | −0.019 m |
| 27714697-045 | 54.7% | 223.080 | 223.076 | 223.076 | +0.004 m |

Slope here is |junction bed up − junction bed down| ÷ segment length. Preserve-wide, chart − drawn at the anchor over 3,268 wet segments at the peak was median 0.076 m, 95th percentile 1.02 m, maximum 4.74 m in v2, and is at most 0.0005 m (rounding) in v3. Over every wet segment-hour (30.4 million National Water Model, 1.08 million California Natural Flows) the v3 maximum is 0.0005 m; v2 had 414,379 National Water Model segment-hours more than 0.1 m off.

**v3 `values` − v2 `values`** (wet segments; the same as drawn − raw):

| Slope bin | Peak hour: n / median / p5–p95 / max \|diff\| | Low flow 2022-10-15T12:00Z: n / median \|diff\| / max \|diff\| | All National Water Model hours: median / p1–p99 / share \|diff\| > 0.1 m |
| --- | --- | --- | --- |
| Flat (< 1%) | 283 / −0.184 m / −1.916 to +0.826 m / 3.684 m | 132 / 0.010 m / 0.048 m | −0.002 m / −0.168 to +0.083 m / 3.2% |
| Moderate (1–5%) | 1,223 / +0.013 m / −0.538 to +0.915 m / 4.736 m | 152 / 0.009 m / 0.050 m | +0.002 m / −0.075 to +0.086 m / 1.3% |
| Steep (> 5%) | 1,762 / +0.009 m / −0.200 to +0.286 m / 3.059 m | 45 / 0.003 m / 0.021 m | +0.001 m / −0.045 to +0.055 m / 0.5% |

The California Natural Flows monthly dataset moves less (all bins: median 0, p1–p99 −0.064 to +0.053 m, max 0.627 m).

**Integrity of the saved v3 output** (all 735 files, 157.7 million non-null segment-timesteps): `rawAnchorWseM` equals m2-v2 `values` exactly; junction depths, junction beds, junction WSEs, and `anchorBedElevationM` equal m2-v2 exactly; dry, wet, and null counts per timestep are unchanged (National Water Model: 30,389,500 wet, 124,348,816 dry, 1,403,310 null); 0 negative depths; 0 junction mismatches over 29.1 million wet–wet vertices; every wet segment next to a dry one or at a flowline end (2.34 million vertices) keeps its own raw anchor depth.

## Measured (Dangermond Preserve, Oct 23 2026)

| Item | m2-v1 | m2-v2 | m2-v3 |
| --- | --- | --- | --- |
| Stage 3 run time | 222 s | 166 s | 199 s |
| Solved sections | 3,338 segments × 3; 320 slopes floored | 3,338 segments × 1; 106 slopes floored | same as v2 |
| Sections without a rating curve | 0 | 0 | 0 |
| Clamped anchor values | 107 National Water Model, 0 California Natural Flows | same | same |
| Warnings | 45 | 45 (same) | 45 (same) |
| Largest file | 35.5 MB (27715677 WY2022) | 35.4 MB (27715677 WY2022) | 44.8 MB (27715677 WY2022) |
| Total size | 4.3 GB on disk | 4,362 MiB | 5,510 MiB (+26%, the `rawAnchorWseM` arrays) |

The v1 slope count of 320 was over all three solved sections of each segment; the anchors alone give the 106 of v2. The anchors themselves are unchanged.

## Version history

| Version | Change type | Change note |
| --- | --- | --- |
| `m2-v1` | new method | First version: three-section Manning's depth with local slopes and shared junction depths and beds, for bed-parallel drawing. |
| `m2-v2` | implementation fix | Junction depths come from smoothed anchor depths (one number per vertex, ±100 m, dry stays 0) instead of independent end-section Manning solves, which dropped the water surface by up to 1.7 m across flat segments. The first and last section solves are removed. Anchor WSE, anchor bed, and junction beds are unchanged. |
| `m2-v3` | implementation fix | Time Series `values` are the WSE of the smoothed surface at the anchor point (anchor bed + the mean of the two junction depths), so the chart shows the water that is drawn; the raw Manning anchor WSE moves to `rawAnchorWseM`. Junction depths, junction beds, and anchor bed are unchanged. |
