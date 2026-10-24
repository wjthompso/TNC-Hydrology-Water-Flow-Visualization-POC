# WSE Polygon Generation Method `flowline-channel-ribbon`

Version 1 (experimental). Built on Modeled WSE Derivation Method `m3-flowline-profile-manning-depth` v1; both are meant to freeze together as Data-Product Version `m3-v1`. Browser drawing: `channel-ribbon-depth`.

The water of a creek is drawn as one continuous ribbon along a smoothed channel centerline, not as a raster flood-fill footprint per Creek Segment. The ribbon's two edges come from one-dimensional cross-section floods of the 1 m lidar, smoothed along the creek, for a ladder of depths. The browser slides each station's edge vertices between the two depth rungs around that station's own water depth.

## What it does

1. **Channel** (shared with m3; `m3-flowline-profile-manning-depth/flowline-channel.ts`). Each run of joined Creek Segments of a TNC flowline, in flow order:
   - Resample the flowline's vertex chain every 1 m and smooth it (Gaussian, σ 5 m, odd reflection at the ends).
   - Move it sideways to the valley bottom. A dynamic program over offsets of −30…30 m (0.5 m steps) minimizes ground elevation + 0.15 × (offset change)² + 0.02 × |offset|. It changes by at most 1.5 m per station and never reaches past 0.7 × the radius on the inside of a bend. The offsets are then smoothed (σ 3 m).
   - Lay stations evenly about 1 m apart along the result. Each station has a left normal and the strongest curvature within ±8 m.
   - Channel floor per station: the lowest lidar within ±1.5 m of the centerline, followed downhill along the section for at most 10 m, then median-filtered over 5 m. This is the thalweg.
   - Bed profile: the thalweg smoothed (σ 4 m), made monotone downstream (isotonic regression), clamped to within 0.3 m of the smoothed thalweg, then smoothed again (σ 2 m).
   - Segment boundaries: the station at the same fraction of the fitted line's length as the shared vertex is of the flowline's. Two neighbours share that station exactly.
2. **Edges per depth rung**. There are 19 rungs: 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, and 8 m above the thalweg. At every station:
   - Sample the ground along the normal: every 0.5 m within 12 m, every 1 m out to 100 m.
   - Seed at the channel floor. Walk each side outward while the ground is below thalweg + rung, and stop at the first sample at or above it, interpolated linearly.
   - Per rung and side along the creek: fill the gaps (stations dry at the centerline), apply a median filter (7 m), then a Gaussian (σ 3 m).
   - Cap the top width at 3 m + 80 × depth. Record the true width. Widen to the 1 m display floor. Smooth again (σ 3 m).
   - Make the rungs monotone with depth, then apply the inside-of-bend cap of 0.7 × radius. Water lying wholly past the other side's cap keeps the floor width inside the caps.
3. **Polygon sets** (one file per TNC flowline, the published file shape):
   - Each Creek Segment gets n = 2 × ceil(length ÷ 4 m) + 1 stations (odd, at least 3), evenly spaced from its upstream boundary to its downstream boundary. The middle station is the segment's WSE Anchor Point.
   - One bucket per rung: `minWaterSurfaceElevationM` = rung depth, `maxWaterSurfaceElevationM` = next rung (100 m for the top one).
   - Each bucket holds one ring with the same 2n vertices in the same order: the left edge at stations 0…n−1, then the right edge at stations n−1…0, clockwise. Each vertex is `[lon, lat, bedProfileM]`.
   - Extra field `channelRibbon`: `stationCount`, `lengthM`, `anchorLonLat`, `anchorBedElevationM`, and `trueTopWidthAtAnchorM` / `displayTopWidthAtAnchorM` per rung. True is the smoothed lidar flood width before the floors; display is the drawn width.
4. **Check**. Stage 4 reads the m3 monthly Time Series and counts segments whose `anchorBedElevationM` differs from the bed this method computes. If they differ, the chart and the drawing would disagree. The v1 run had 0 of 3,335.

## How the browser draws it (`channel-ribbon-surface.ts`)

At the selected time the segment's two junction depths come from the m3 Time Series. Station i has depth dᵢ = up + (down − up) × i ÷ (n − 1). Each station picks the two rungs around dᵢ and interpolates its left and right vertex linearly. Below 1 cm it tapers to the midline of the first rung. Above the top rung it keeps the top rung's width. The vertex z is the bed profile + dᵢ.

The segment is drawn only when its anchor depth is at least 1 cm, the first rung (dry stays dry). Neighbours share the boundary station and the junction depth, so their rings meet on the same edge at the same height: 3,221 of 3,229 consecutive pairs share an identical boundary edge at every rung. The other 8 pairs sit across a multi-path gap or next to the 3 segments without a ribbon.

**Display rule (labeled exaggeration; never stored).** The bed slope comes from the segment's junction beds over its chord. A smoothstep ramp goes from 0 at 3% to 1 at 8%. On the ramp, the drawn depth is max(true, ramp × 0.15 m) (true depth under 1 cm stays dry), the width follows the drawn depth, and the surface is lifted ramp × 0.3 m. Neighbours of similar slope get the same exaggeration, so they meet without a step. `?ribbonDisplayFloorM=0&ribbonDisplayLiftM=0` draws true water. The Time Series and the chart keep true values. The dev tools method line states the rule.

## Chart and drawing agreement at the WSE Anchor Point

At true depth, the drawn z at the middle station is the bed profile there plus the mean of the two junction depths. The Time Series value is the same by construction. Checked on every wet segment of the preserve at three hours of the January 2023 storm (7,771 segment-hours): worst difference 0.0005 m, from rounding to millimeters. With the display rule on, a steep segment is drawn higher than the chart by (floor − true depth, when positive) + lift. That gap is the documented exaggeration.

## Design rationale

Judged against these criteria: visual continuity and smooth edges on steep creeks, level surfaces on flat creeks, anchor agreement, honesty with thin water, data size, rendering cost, and implementation risk. The measured numbers are in "Evidence".

| Candidate | Steep continuity / edges | Flat level | Anchor agreement | Thin-water honesty | Size | Browser cost | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A. **Smoothed fill**: Chaikin or Gaussian smoothing of HAND footprints, hole removal, gap closing | Better edges, but still one blob per segment plus slices. Visibility unchanged: blotches come from the mesh hiding thin water, not only from stair-steps. | Good (as HAND) | As m2-v3 | Unchanged | ≈ HAND v3 (300 MiB) | Same | Low |
| B. **Hybrid**: ribbon when steep or thin, terrain fill when flat or deep, blended at a threshold | Good where ribbon | Good | Two surfaces must agree at the blend | Good | ≈ HAND v2 + ribbon | Two code paths | High: seams at every threshold crossing, which moves with time |
| C. **Continuous water-surface profile only**: a gradually-varied-flow-like surface per flowline, polygons from the existing fill | Surface continuous, but footprints still raster blobs | Level pools | By construction | Same thin-water burial | ≈ HAND | Same | Medium |
| D. **Better rendering primitive**: ArcGIS `Mesh` with per-vertex z, or many small quads | Fixes triangulation sag only; footprints still come from the fill | — | — | — | Larger | Mesh per segment per time step: high | Medium-high (new layer type, hit-testing, selection outline) |
| E. **Channel ribbon on a continuous channel** (chosen): 1-D cross-section floods on a smoothed centerline, edges smoothed along the creek, depth rungs as morph targets | One connected ribbon; smooth curves (median rim turn 1–15° vs 45° m1/HAND v2 and 89° HAND v3) | Level across every section; along the creek it follows a smooth monotone bed profile | By construction (≤ 0.5 mm) | True depth and width stored; exaggeration in the browser, labeled, off with two URL parameters | 94 MB (0.6 × HAND v2) | One ring per segment, recomputed only when the depth changes | Medium: new drawing mode, but small and additive |
| F. **Minimum visible width/depth** alone on top of HAND | More visible | — | — | Honest if labeled | Same | Same | Low, but blobs stay |

E won because it attacks the cause, not the symptom. A raster flood of the ground around a segment inherits every 1 m cell stair-step and every centimeter of lidar noise in a nearly flat thin-water footprint, so thin water breaks into puddles. A cross-section flood is one-dimensional and smooth along the creek by construction. It is consistent with the hydraulics: m3 cuts its anchor rating curve on the very cross-section the ribbon is drawn on. It also makes time continuous, because a deeper rung is a morph target of the shallower one and nothing pops between buckets. The ideas from C (one smooth bed profile per flowline) and F (a labeled display floor) are folded in. B and D were rejected for risk: B for seams, D for a new geometry type.

**What the first version taught (kept for the next reader).** The first channel was a least-cost path through the Stage 1 thalweg points, the HAND v2 bed line. On 244 of 3,338 segments (7%) those points sat in side gullies or out of order on flat ground, and the path turned back on itself; ribbons on those segments were loops and bow-ties. The valley-bottom fit on the flowline cannot turn back. After the switch there were 2 reversals and 1 sharp turn in 131,205 stations.

The first bed profile was fully monotone, which floated pools up to 9 m above the ground upstream of road fills. Clamping to 0.3 m of the smoothed thalweg fixed that. Measuring depth from the lowest ground within ±1.5 m of the centerline left 27714697-044 dry all year: the centerline ran on a bank 0.38 m above a 4 m wide floor, and the first 2 cm of the rating curve carried 21 m³/s. The descent rule fixed it.

## Evidence (2023-01-10T01:00Z, emulated LOD 17 browser mesh, earcut on rim vertices as ArcGIS draws)

Scripts are in `/tmp/m3/` (`measure.ts`, `drawn-lib.ts`, `previews.ts`, `anchorcheck.ts`, `seamcheck.ts`), and they reuse `/tmp/steep-water-analysis/lib.ts`. "Visible" is the share of the whole drawn polygon whose triangulated surface is at or above the emulated mesh. HAND's 2 m Bank-overlap margin, which is below ground by design, counts against HAND here.

| Slope bin (sampled segments) | m1 + JSTF v1 | HAND v2 | HAND v3 | HAND v3 + floor 0.3 | m3 ribbon, true | m3 ribbon, display rule |
| --- | --- | --- | --- | --- | --- | --- |
| 0–1% (5) | 80% | 86% | 86% | 86% | 96% | 96% |
| 1–2% (7) | 89% | 75% | 75% | 75% | 95% | 95% |
| 2–5% (5) | 76% | 64% | 63% | 63% | 93% | 94% |
| 5–10% (5) | 69% | 48% | 52% | 52% | 77% | 93% |
| 10–20% (8) | 80% | 26% | 26% | 48% | 51% | 86% |
| 20–40% (8 / 7 m3) | 77% | 21% | 27% | 31% | 55% | 88% |

Median visible share per bin. m1 is highly "visible" because it draws corridor-wide slabs above the ground: 8,587 m² on 27714697-045, against 527 m² for the m3 ribbon. 27715641-001 is dry in m3 at that hour.

On segments 27714697-040…045:

- Drawn pieces per segment: m3 1 on every segment, HAND v3 14–51.
- Visible pieces over the reach: m3 16 (10 larger than 2 m²), HAND v3 40 (28), HAND v3 + floor 12 (7), HAND v2 15 (8).
- Visible area: m3 1,483 m², HAND v3 + floor 2,565 m², HAND v3 1,300 m².
- The m3 ribbon is narrower, about 3–7 m drawn against the 1.5–3 m true width; HAND footprints spread wider.

On flat Jalama 27714637-024…030 every method is one visible piece. m3 covers 10,882 m² against 11,028 m² for HAND v2 and 14,031 m² for m1. Previews are in `/tmp/m3-previews/*.png`, with panels in the order m1, HAND v2, HAND v3, HAND v3 + floor, m3 true, m3 display. Blue is visible and red is hidden under the emulated mesh.

## Size and runtime (dangermond-preserve)

- 105 files, 93.9 MB in all; the largest is 4.3 MB.
- 2.75 million ring vertices.
- Stage 4: 21 s, plus loading the terrain tiles.

## Known limitations

- Steep reaches are still not fully visible. Over 27714697-040…045 the drawn ribbon is one piece, but the emulated mesh hides parts of it, so the viewer sees 16 pieces. Narrow gullies are smoothed out of the 3DEP `exportImage` mesh. A bigger lift hides less but floats more.
- The cross-section flood follows only the normal of the centerline. A side pool or a backwater arm off the normal is missed. At tight bends, deep rungs are capped on the inside (folded station-rungs still occur: 36 at the first rung and 4,883 at the 8 m rung preserve-wide, where wide water fills a bending valley).
- The drawn surface rides on the smoothed bed profile. It differs from the local channel floor by a mean of 0.12 m, and up to 3.3 m at sharp road fills, where the 4 m smoothing rounds a step.
- 1,140 stations (0.9%) ended the valley-bottom fit at the ±30 m search edge: the flowline is more than 30 m from the channel there, or the valley is flat. 3 tiny segments have no ribbon because their two boundaries fall on the same station.
- The minimum drawn width is 1 m, a display floor recorded as `trueTopWidthAtAnchorM` versus `displayTopWidthAtAnchorM`.

## Version history

| Version | Change |
| --- | --- |
| 1 | First version. Built on m3-v1. |
