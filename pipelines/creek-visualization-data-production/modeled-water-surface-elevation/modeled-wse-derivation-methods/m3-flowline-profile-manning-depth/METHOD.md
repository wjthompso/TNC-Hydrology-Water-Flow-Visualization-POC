# Modeled WSE Derivation Method `m3-flowline-profile-manning-depth`

Version 2 (experimental). Data-Product Version `m3-v2` once frozen, together with WSE Polygon Generation Method `flowline-channel-ribbon` v2 (version 1, `m3-v1`, stays on disk with ribbon v1). Stages 0–2 are shared with m1. Stage 3 runs from `stage-03-flowline-profile-time-series.ts` in this folder:

```text
npm run pipeline:modeled-wse:m3-time-series -- --extent=dangermond-preserve --modeled-wse-method=m3-flowline-profile-manning-depth
npm run pipeline:modeled-wse:water-surface-polygons -- --extent=dangermond-preserve --modeled-wse-method=m3-flowline-profile-manning-depth --wse-polygon-method=flowline-channel-ribbon
```

## What it does

The discharge is the same as m1 and m2: the National Water Model or California Natural Flows reach discharge, times the drainage-area ratio, with the Drainage-Area Ratio Transfer rules. It is inverted on a divided-channel Manning rating curve built with m1's `buildRatingCurveRecord` (n 0.04 main channel, 0.07 floodplain, 2 cm ladder). What changes is where that rating curve is cut, what bed the water stands on, and how the water surface is drawn between anchors. Version 2 keeps every hydraulic rule of version 1; only the bed, the anchor, and the water surface (depth-scaled smoothing and pool filling) changed.

1. **One channel per run of joined Creek Segments** (`flowline-channel.ts`). The TNC flowline is smoothed and moved sideways to the valley bottom of the 1 m lidar by a dynamic-programming fit (±30 m, a penalty on sideways bends, never looping back). Stations lie about 1 m apart along the result. That smooth line only orients the cross-sections.
2. **The bed is the raw lidar at the creek's lowest point** across every station: the lowest bilinear lidar within ±1.5 m of the line, followed downhill along the section for at most 10 m (the descent never climbs, so it cannot cross into a neighbouring gully). The station's position is that point, so its longitude/latitude and its bed describe the same spot. No Gaussian, isotonic, clamp, or median filter touches the bed ("keep the true shape of the V"). The mean lowest point lies 0.87 m from the smooth line.
3. **Barrier breaching** (`breachBarriers` in `flowline-channel.ts`). Bare-earth lidar keeps road and railroad embankments but not their culverts, so a pure pool fill makes lakes behind them (the raw bed has 82 such depressions 1.5–24 m deep). A barrier is breached when the pool it would hold is at least 1 m deep and the barrier is at most 100 m long where it stands half that depth above the pool bottom; the deepest such depression goes first, repeated until none qualifies (hybrid breaching–filling as in Lindsay 2016, Hydrological Processes 30:846). The breach lowers the bed along a straight line from the pool bottom to the first station downstream that is no higher (level to the run end when there is none). Why these numbers: natural step pools in the raw bed are almost all shallower than 1 m (4,357 of 4,505 depressions over 5 cm), while road and railroad fills hold 1.5–24 m; the barriers breached measure 1–92 m at half height (the coastal railroad fills 47–65 m), so 100 m leaves margin and keeps one 124 m-long rise (a 1.6 m pool on 27714639) as a pool. Shallower pools, step pools among them, fill.
4. **Water-surface stations** (`waterSurfaceStations`). Each segment's stations are table stations from its upstream to its downstream boundary, about 2 m apart, with the anchor station among them (neighbours share the boundary station), and each one's distance from the segment's upstream boundary along the centerline. These are the ribbon's stations too.
5. **WSE Anchor Point.** The station nearest the middle of the segment, on its lowest point. If that station lies on a breach, the nearest station of the segment that does not (77 anchors). A segment that lies wholly on a breach (43, under railroad and road fills) runs through its culvert: it has no lidar creek bed, so it gets no rating curve and its values are null; its anchor bed is still the lidar at its lowest point.
6. **Anchor cross-section** (`anchor-section.ts`). Cut through the anchor point, perpendicular to the smooth line, sampled every 1 m out to ±100 m from that point and valley-edge trimmed as in Stage 1, with the 0.5 m fallback. Its bed is the lidar at the anchor point itself, which is `anchorBedElevationM`. The slope is the least-squares slope of the bed over ±30 m, floored at 0.001.
7. **Raw anchor depth** = the rating-curve WSE − the anchor bed. A raw depth under 1 cm is dry (0).
8. **Junction depth** (the flowing depth at each end): m2-v2's rule, copied. Each shared vertex gets one number, the length-weighted mean of the wet raw anchor depths within ±100 m along the flowline. Ribbon arc lengths are the weights. A dry segment stays dry, and a segment next to a dry one keeps its own depth.
9. **Water surface: depth-scaled smoothing, then pool fill** (`pool-filled-water-surface.ts`, the one function Stage 3 and the browser both run, with `POOL_FILLED_WATER_SURFACE` in `method-config.ts`). The flowing depth at station j of n is linear between the junction depths, up + (down − up) × j ÷ (n − 1). The bed is never smoothed; the water is ("smooth the water, not the ground").
   - **Smoothing.** At every station the flowing surface (bed + flowing depth) is averaged over the stations within ±k × its own flowing depth along the centerline, k = 5 (`smoothingHalfWindowDepthMultiple`; Will chose 5 over 0 and 10). Thin steep water (7 cm: a window of ±0.35 m, shorter than the station spacing) keeps its own value and so its step pools. Deep flat water (6 m on Jalama at the January 2023 peak: ±30 m) averages over tens of meters and drowns the 0.1–0.5 m bumps of the raw bed.
   - **Floor.** A smoothed station keeps at least 1 cm above its bed (`minimumSmoothedDepthM`, the dry threshold), or its own flowing depth where that is less. A mean taken across a sharp drop can otherwise fall below the lip: at the January 2023 peak 69 stations would have been up to 2.9 m under their own bed.
   - **Pool fill.** Walking each wet stretch from its downstream end upstream, the surface at a station is max(smoothed value, surface just downstream). Pools behind a step fill level to the lip; on a smooth ramp the water follows the ramp.
   - **Where the window stops.** Each wet stretch of a run (consecutive wet segments) is one list of stations. A dry (junction depth 0) or null segment, including a segment wholly on a breach, has no water and ends the stretch: neither the window nor a pool reaches across it, and dry creeks are not filled with standing water. Near a stretch's ends (the run's ends, or a dry or null neighbour) the window shrinks to the same distance on both sides, down to the station alone at the very end, so a sloping surface is not pulled up or down there. The window crosses segment boundaries; the boundary station two neighbours share is one station of the list, so both get the identical surface and their ribbons meet at the same height. Breached stations (on the breach line through a fill) are averaged like any other: the breach line is the bed the water flows on.
   - **Exact repetition in the browser.** Station positions are the stations' distances along the centerline from `waterSurfaceStations`, rounded to centimeters (saved as `channelRibbon.stationDistancesM` by ribbon v2), and the station beds are rounded to millimeters as the ribbon stores them, so the browser repeats the computation exactly.
10. **Time Series** (one compact file per flowline, the m2 field names, so the browser's depth readers work unchanged):

| Field | Meaning |
| --- | --- |
| `values` | The smoothed, pool-filled water surface at the anchor station: what the browser draws there, with no display exaggeration. A dry segment holds `anchorBedElevationM`; a segment wholly on a breach holds null. |
| `anchorBedElevationM` | The bilinear 1 m lidar at the WSE Anchor Point (`channelRibbon.anchorLonLat` of ribbon v2). |
| `junctionDepthUpstreamM` / `junctionDepthDownstreamM` | True flowing depths (before pool filling) at the two ends of the segment's ribbon. |
| `junctionBedUpstreamM` / `junctionBedDownstreamM` | The bed at the two boundary stations (the breach line on a breached station). |

`rawAnchorWseM`, the junction WSEs and the station surfaces are not written; the browser recomputes the surfaces from the junction depths and the ribbon's station beds.

## Why a new method number, not an m2 version

The idea changed: one continuous channel per flowline instead of five chord sections per segment. The anchor cross-section moved to the channel. The bed under the drawn water changed from the Stage 1 section beds to a smooth profile, and depths are measured from a different floor. The polygon method needs those fields to be consistent with its own geometry; the chart then equals the drawing by construction. The hydraulics (discharge, roughness, ladder, inversion, junction smoothing) are deliberately unchanged from m2-v2, so a difference between m2 and m3 comes from geometry, not from new physics.

## Design rationale (hydraulics side)

The full comparison of the water-drawing approaches is in `wse-polygon-generation-methods/flowline-channel-ribbon/METHOD.md`, "Design rationale". On the modeled WSE side, four options were weighed:

1. **Keep m2-v3 and draw on it.** Its anchor bed is a Stage 1 chord-section bed, which the ribbon's bed does not pass through, so chart and drawing would disagree by the bed difference: a median of about 0.45 m on flat creeks in m2-v2.
2. **Gradually varied flow (standard step) per flowline.** Physically better in pools. It needs boundary conditions and flow regimes on 15–36% slopes where Manning already strains, and it would be a new physics change on top of the geometry change. Deferred.
3. **A normal depth at every station, smoothed along the flowline.** About 60 times more inversions and Time Series values, for a surface the ±100 m junction smoothing already makes smooth.
4. **The chosen one**: m2's hydraulics on the ribbon's own anchor cross-section and bed profile. It is consistent by construction and cheap: Stage 3 takes 2.5 minutes on the preserve.

## Results (dangermond-preserve, v2)

- 3,338 Creek Segments on 105 flowlines; 46 slopes floored (84 in v1). 152 barriers breached; 77 anchors moved off a breach; 43 segments lie wholly on a breach and are null.
- Every anchor bed equals the 1 m lidar (bilinear, read independently with `geotiff` and `proj4`) at the saved anchor position within 1.0 mm (median 0.3 mm); in v1 only 266 of 3,335 were within 1 cm (median 7.7 cm, worst 6.05 m).
- Anchors sit a median 5.9 m (90th percentile 16.5 m) from the TNC chord midpoint and a median 0.7 m (90th percentile 1.6 m, worst 45 m) from the v1 anchor. 39 anchors sit where the valley-bottom fit reached its ±30 m search edge, 38 where the lowest point was followed to the 10 m descent limit.
- Chart and drawing at the anchor agree within 0.5 mm on every wet segment at 2023-01-09T12Z, 2023-01-10T01Z, 2023-01-14T12Z and 2019-01-17T13Z (11,621 segment-hours), computed with the browser's own drawing functions.
- Pools at zero flow: 4,961 on the water-surface stations, all under 1 m deep except one (1.58 m behind the unbreached 124 m rise on 27714639).
- 27714697-044: anchor bed 249.042 m (v1 249.267 m on the smoothed profile, 0.43 m below the lidar there), peak WSE 249.111 m.
- Water-surface smoothing on runs flatter than 1%, at the January 2023 peak (2023-01-10T01Z), against the same surface without smoothing: steps over 10 cm 2.1% of station steps (4.1%), over 25 cm 0.23% (0.63%), 99th percentile 0.13 m (0.20 m). On Jalama no segment has a step over 10 cm (30 of 61), and the gauge segment 026's largest step is 0.032 m (0.404 m). At the 2019-01-17T13Z low flow: over 10 cm 1.6% (2.7%), Jalama 15 of 61 segments (33), 026 0.19 m (0.55 m).
- What it costs at the peak: 402 of 69,799 stations get less than half their flowing depth (none without smoothing), 70 of them held at the 1 cm floor (53 segments, 3 anchors); 17.9% of steep stations (segment bed slope over 15%) sit more than 1 cm above bed + flowing depth, against 6.0%. The steep reach 27714697-040…045 is unchanged to the millimeter.
- 27714637-026 (Jalama gauge): peak WSE 31.414 m (v1 31.596 m). The anchor bed rose from v1's 25.654 m to the lidar's 25.884 m, a local high of the raw bed; the ±30 m smoothing window averages over lower bed around it, so the depth at the anchor (5.53 m) is 0.42 m less than the flowing depth there (5.95 m). Low flow (2019-01-17T13Z): 26.887 m (v1 26.613 m).
- Run neighbours are drawn at exactly the same height at their shared station (every wet pair at the four hours above).
- Output: 2.0 GB of Time Series under `03-time-series/m3-flowline-profile-manning-depth/v2/`. Stage 3 takes 172 s.

## Results (dangermond-preserve, v1)

- 3,338 Creek Segments on 105 flowlines. Every anchor has a rating curve; 84 slopes are floored.
- The centerline moved a mean 6.7 m sideways from the smoothed flowline; Stage 1 found the thalweg a median 6 m away. 1,140 stations (0.9%) ended at the ±30 m search edge.
- The bed profile differs from the lowest ground along the centerline by a mean of 0.12 m and at most 3.3 m (sharp road fills).
- 27714697-045: anchor bed 220.6 m, bed 237.4 → 204.2 m over the ribbon, largest junction depth in WY2023 0.085 m.
- 27714697-044: dry all year in the first run (see the ribbon METHOD.md); with the floor descent its peak is 0.077 m.
- 27714637-026 (Jalama gauge): peak depth 5.94 m against 6.19 m in m2-v2.
- Output: 2.0 GB of Time Series under `03-time-series/m3-flowline-profile-manning-depth/v1/`. The largest browser-facing file (one flowline, one water year) is 15.3 MB. Stage 3 takes 153 s.

## Known limitations

- Manning's normal depth on 15–36% slopes (step pools) remains a weak model, as in m1 and m2 (phase 3 adds slope-dependent roughness).
- The anchor is one cross-section per segment. The junction smoothing hides section-to-section noise but does not remove it.
- Thin water keeps the steps of the raw bed by design (its smoothing window is shorter than the station spacing). Shallow flat creeks therefore still show riffle steps at low flow: on Jalama at 2019-01-17T13Z, 15 of 61 segments have a step over 10 cm, the largest 0.19 m on 026. Deep water drowns them.
- The smoothed surface no longer stands exactly level: on runs under 1% slope at the peak 39% of station steps are exactly level against 70% without smoothing, because the water now slopes gently over bumps instead of standing in level pools between riffle steps.
- On a deep creek the value at the anchor reflects the bed within ±5 × the depth, not only the anchor's own bed. At 026 at the peak the depth at the anchor is 0.42 m less than its Manning flowing depth, and the WSE 0.64 m lower than without smoothing. The gauge there (USGS 11120600) records discharge only, so no observed stage says which is closer.
- At a sharp drop the 1 cm floor holds the lip station, so the drawn ribbon narrows to its 1 cm width there (70 stations at the January 2023 peak).
- The browser draws with the current code's `POOL_FILLED_WATER_SURFACE` and `pool-filled-water-surface.ts`, not with values read from the data: a later m3 version that changes either would also change how ribbon v2 on m3-v2 is drawn.
- The lowest point is found from the smooth line (±1.5 m, then downhill up to 10 m). Where the flowline is far from the channel the lowest point can be a low spot beside it; the descent never climbs, so it stays in the same valley.
- **Known issue, not fixed (Will's decision):** barrier breaching cannot tell a fill from a natural rise. On 27714645 the run's last 200 m are higher than a 3 m-deep low upstream (station 1280); this looks like the flowline leaving the channel near the mouth, not a fill. The breach runs level for 199 m to the run end, and seven segments (27714645-046…-052) lie wholly on it and are null.
- A segment wholly on a breach (43 preserve-wide) has no water and no chart value (null); its culvert hydraulics are not modeled. Will accepted this.
- `time-series-derivation.ts` (the catalog `derivation` block a freeze would publish) is not written yet; Stage 5 uses m1's for every method.

## Version history

| Version | Change |
| --- | --- |
| 1 | New method. |
| 2 | Implementation fix: the raw 1 m lidar at the lowest point of every station is the bed (no Gaussian, isotonic, clamp, or median); the anchor, its bed, and its cross-section sit on that lowest point; barriers at least 1 m deep and at most 100 m long at half height are breached; `values` is the water surface at the anchor station, smoothed over ±5 × the flowing depth along the run (never the bed; at least 1 cm above the bed) and then pool-filled (`pool-filled-water-surface.ts` and `POOL_FILLED_WATER_SURFACE`, shared with the browser). Discharge, roughness, ladder, inversion, and the junction-depth rule are unchanged. A pre-smoothing draft of v2 existed only during development; it was never frozen. |
