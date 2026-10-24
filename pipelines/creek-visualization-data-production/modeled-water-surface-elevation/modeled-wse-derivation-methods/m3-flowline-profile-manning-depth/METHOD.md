# Modeled WSE Derivation Method `m3-flowline-profile-manning-depth`

Version 1 (experimental). Data-Product Version `m3-v1` once frozen, together with WSE Polygon Generation Method `flowline-channel-ribbon` v1. Stages 0–2 are shared with m1. Stage 3 runs from `stage-03-flowline-profile-time-series.ts` in this folder:

```text
npm run pipeline:modeled-wse:m3-time-series -- --extent=dangermond-preserve --modeled-wse-method=m3-flowline-profile-manning-depth
npm run pipeline:modeled-wse:water-surface-polygons -- --extent=dangermond-preserve --modeled-wse-method=m3-flowline-profile-manning-depth --wse-polygon-method=flowline-channel-ribbon
```

## What it does

The discharge is the same as m1 and m2: the National Water Model or California Natural Flows reach discharge, times the drainage-area ratio, with the Drainage-Area Ratio Transfer rules. It is inverted on a divided-channel Manning rating curve built with m1's `buildRatingCurveRecord` (n 0.04 main channel, 0.07 floodplain, 2 cm ladder). What changes is where that rating curve is cut and what bed the water stands on.

1. **One channel per run of joined Creek Segments** (`flowline-channel.ts`). The TNC flowline is smoothed and moved sideways to the valley bottom of the 1 m lidar by a dynamic-programming fit. The channel floor at every station is the lowest nearby ground, followed downhill. The bed profile is that floor smoothed, made monotone downstream within 0.3 m, and smoothed again. Details and numbers are in `flowline-channel-ribbon/METHOD.md`.
2. **Anchor cross-section** (`anchor-section.ts`). It is cut perpendicular to the smoothed centerline at the middle of each segment's stretch of channel: the WSE Anchor Point, the same point the ribbon's middle station sits on.
   - Sampled every 1 m out to ±100 m and valley-edge trimmed as in Stage 1, with the 0.5 m fallback.
   - The bed is the channel floor of that section.
   - The slope is the least-squares slope of the bed profile over ±30 m, floored at 0.001.
3. **Raw anchor depth** = the rating-curve WSE − the floor. A raw depth under 1 cm is dry (0).
4. **Junction depth**: m2-v2's rule, copied. Each shared vertex gets one number, the length-weighted mean of the wet raw anchor depths within ±100 m along the flowline. Ribbon arc lengths are the weights. A dry segment stays dry, and a segment next to a dry one keeps its own depth.
5. **Time Series** (one compact file per flowline, the m2 field names, so the browser's depth readers work unchanged):

| Field | Meaning |
| --- | --- |
| `values` | `anchorBedElevationM` + the mean of the two junction depths: the WSE of the drawn surface at the anchor point, with no display exaggeration. |
| `anchorBedElevationM` | The bed profile at the anchor point. |
| `junctionDepthUpstreamM` / `junctionDepthDownstreamM` | True depths at the two ends of the segment's ribbon. |
| `junctionBedUpstreamM` / `junctionBedDownstreamM` | The bed profile at the two ends. |

`rawAnchorWseM` and the junction WSEs are not written; the raw depth is an intermediate.

## Why a new method number, not an m2 version

The idea changed: one continuous channel per flowline instead of five chord sections per segment. The anchor cross-section moved to the channel. The bed under the drawn water changed from the Stage 1 section beds to a smooth profile, and depths are measured from a different floor. The polygon method needs those fields to be consistent with its own geometry; the chart then equals the drawing by construction. The hydraulics (discharge, roughness, ladder, inversion, junction smoothing) are deliberately unchanged from m2-v2, so a difference between m2 and m3 comes from geometry, not from new physics.

## Design rationale (hydraulics side)

The full comparison of the water-drawing approaches is in `wse-polygon-generation-methods/flowline-channel-ribbon/METHOD.md`, "Design rationale". On the modeled WSE side, four options were weighed:

1. **Keep m2-v3 and draw on it.** Its anchor bed is a Stage 1 chord-section bed, which the ribbon's bed does not pass through, so chart and drawing would disagree by the bed difference: a median of about 0.45 m on flat creeks in m2-v2.
2. **Gradually varied flow (standard step) per flowline.** Physically better in pools. It needs boundary conditions and flow regimes on 15–36% slopes where Manning already strains, and it would be a new physics change on top of the geometry change. Deferred.
3. **A normal depth at every station, smoothed along the flowline.** About 60 times more inversions and Time Series values, for a surface the ±100 m junction smoothing already makes smooth.
4. **The chosen one**: m2's hydraulics on the ribbon's own anchor cross-section and bed profile. It is consistent by construction and cheap: Stage 3 takes 2.5 minutes on the preserve.

## Results (dangermond-preserve, v1)

- 3,338 Creek Segments on 105 flowlines. Every anchor has a rating curve; 84 slopes are floored.
- The centerline moved a mean 6.7 m sideways from the smoothed flowline; Stage 1 found the thalweg a median 6 m away. 1,140 stations (0.9%) ended at the ±30 m search edge.
- The bed profile differs from the lowest ground along the centerline by a mean of 0.12 m and at most 3.3 m (sharp road fills).
- 27714697-045: anchor bed 220.6 m, bed 237.4 → 204.2 m over the ribbon, largest junction depth in WY2023 0.085 m.
- 27714697-044: dry all year in the first run (see the ribbon METHOD.md); with the floor descent its peak is 0.077 m.
- 27714637-026 (Jalama gauge): peak depth 5.94 m against 6.19 m in m2-v2.
- Output: 2.0 GB of Time Series under `03-time-series/m3-flowline-profile-manning-depth/v1/`. The largest browser-facing file (one flowline, one water year) is 15.3 MB. Stage 3 takes 153 s.

## Known limitations

- Manning's normal depth on 15–36% slopes (step pools) remains a weak model, as in m1 and m2.
- The anchor is one cross-section per segment. The junction smoothing hides section-to-section noise but does not remove it.
- The bed profile is a display reference: it smooths 0.1–0.3 m step-pool steps and sharp road fills.
- `time-series-derivation.ts` (the catalog `derivation` block a freeze would publish) is not written yet; Stage 5 uses m1's for every method.

## Version history

| Version | Change |
| --- | --- |
| 1 | New method. |
