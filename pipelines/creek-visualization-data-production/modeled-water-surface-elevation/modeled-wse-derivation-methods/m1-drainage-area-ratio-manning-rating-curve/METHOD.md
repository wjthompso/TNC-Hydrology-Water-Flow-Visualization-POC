# m1 — Drainage-area ratio + Manning's rating curve

| Field | Value |
| --- | --- |
| Kind | Modeled WSE Derivation Method (Stages 0–3) |
| Method id | `m1-drainage-area-ratio-manning-rating-curve` |
| Method number | 1 |
| Current version | 1 (`m1-v1`) |
| Config | [`method-config.ts`](method-config.ts): every value below, plus `version`, `changeType`, `changeNote` |
| Machine-readable summary | [`time-series-derivation.ts`](time-series-derivation.ts), written into `catalog.json` and into each frozen `version.json` as `derivation` |
| Pipeline overview | [METHODOLOGY.md](../../METHODOLOGY.md): stages, file layout, extents, version rule |

## Summary

This method turns modeled discharge (flow rate, m³/s) into a modeled water-surface elevation (WSE, meters NAVD88, the North American Vertical Datum of 1988) for every Creek Segment and every time step. Each Publisher gives one discharge per NHDPlusV2 reach. The method scales that discharge down to each Creek Segment by the USGS drainage-area ratio, then reads the WSE that carries the scaled discharge off a rating curve. Each Creek Segment gets its own rating curve, built with Manning's equation on its USGS 3DEP (3D Elevation Program) 1 m lidar cross-sections.

## Inputs

| Role | Source |
| --- | --- |
| Discharge | California Natural Flows (monthly) and NOAA National Water Model v3.0 retrospective (hourly), per NHDPlusV2 reach |
| Terrain | USGS 3DEP 1 m bare-earth lidar |
| Creek Segments | TNC flowlines cut at their original vertices |
| Reach assignment | NLDI (Network-Linked Data Index) position lookups, checked against REACHCODE; tracked in `data/source-inputs/reviewed-assignments/nhdplusv2-reach-crosswalk-<extentId>.json` |
| Reach drainage area | NHDPlusV2 `TotDASqKm`, EPA NHDPlus flowline service |
| Segment drainage area | Dangermond Preserve 2018 flow-accumulation raster (`JLDP_Flow_Accumulation_2018`, 2 m cells) |

## Steps

1. **Assign a reach (Stage 0).** Map each Creek Segment midpoint to the NHDPlusV2 reach whose catchment contains it. A segment on a creek with no NHDPlusV2 reach of its own keeps a neighbouring creek's reach and is marked as a [Drainage-Area Ratio Transfer](#drainage-area-ratio-transfer).
2. **Cut cross-sections (Stage 1).** Sample 5 cross-sections per Creek Segment from the terrain. Find the bed, bank tops, and valley edges, and pick one representative section. Measure the segment's drainage area and compute its [drainage-area ratio](#drainage-area-ratio).
3. **Build a rating curve (Stage 2).** Step the WSE upward from the bed and compute discharge at each step with [Manning's equation](#equation) on a [divided channel](#floodplain-divided-channel).
4. **Invert it (Stage 3).** For each time step, scale the reach discharge by the drainage-area ratio and look up the lowest WSE that carries it. Record a [junction WSE](#junction-wse) at each segment end.

## Equation

Stage 2 uses Manning's equation at normal depth:

\[ Q = \tfrac{1}{n} \cdot A \cdot R^{2/3} \cdot S^{1/2}, \qquad R = A / P \]

- \(Q\) is discharge in m³/s.
- \(n\) is Manning's roughness coefficient. It has no unit and is 0.04 in the main channel and 0.07 on the floodplains (see [Roughness sources](#roughness-sources)).
- \(A\) is the wetted cross-section area in m².
- \(P\) is the wetted perimeter, the length of wet ground across the section, in m.
- \(R\) is the hydraulic radius in m.
- \(S\) is the bed slope, the bed drop per meter downstream, with no unit.

The ladder steps WSE upward from the bed in 0.02 m increments and computes \(Q\) at each step. Stage 3 inverts the ladder. For each discharge it takes the lowest WSE that carries it, interpolated linearly between steps. A discharge of 0 or less maps to the bed. A missing discharge maps to null.

When water first spills onto a flat bench, \(P\) jumps while \(A\) barely grows, so the raw \(Q\) can dip. A real channel never carries less water at a higher WSE. Stage 2 therefore stores the running maximum as `dischargeM3s` and keeps the raw values in `rawManningDischargeM3s`. Affected Creek Segments are flagged `non-monotonic-discharge`.

### Floodplain (divided channel)

Stage 2 splits the representative section at its two bank tops into a main channel and a left and right floodplain. A **bank top** is the highest ground on one side of the thalweg within ±60 m of the TNC flowline (`bankTopSearchHalfWidthM`), clipped to the valley edge. These are the same points the former ±60 m section used as its ladder cap. Each subsection gets its own Manning's \(Q\) from its own \(A\) and \(P\). The vertical line between subsections adds nothing to \(P\). The main channel uses \(n = 0.04\) and each floodplain uses \(n = 0.07\) (`floodplainManningRoughnessN`). Total \(Q\) is the sum. A floodplain is dry until the WSE passes its bank top, so below the lower bank top \(Q\) equals the single-channel result. All 17,698 Jalama below-bank ladder steps match it exactly. Stage 2 stores each subsection's discharge, and the running maximum still applies to the total.

The method ignores momentum exchange: fast channel water drags on slow floodplain water at the interface, which a real channel loses as extra friction. Overbank estimates are therefore rougher than in-channel ones and likely overstate \(Q\) somewhat. With WY2018–WY2023, 17 of 2.85 million Jalama National Water Model values sit above their lower bank top.

### Roughness sources

Both values are the "normal" entry of the matching row in Chow (1959), *Open-Channel Hydraulics*, Table 5-6, as reproduced by [Ponce (SDSU)](https://ponce.sdsu.edu/openchannel/open_channel_hydraulics_05_manningsntable.html) and the [TxDOT Hydraulic Design Manual](https://www.txdot.gov/manuals/des/hyd/chapter-4--hydrology/section-11--time-of-concentration/manning-s-roughness-coefficient-values.html). `MANNING_ROUGHNESS_BASIS` in `method-config.ts` carries the same records into every catalog derivation.

| Case | \(n\) | Published range | Source |
| --- | --- | --- | --- |
| Main channel | 0.04 | 0.033–0.045 | Chow Table 5-6, minor streams: clean, winding, some pools and shoals. Inside the USGS WSP 2339 cobble base range (0.030–0.050) and Barnes (1967, WSP 1849) verified cobble-gravel values (0.033–0.043). |
| Floodplain | 0.07 | 0.045–0.110 | Chow Table 5-6, floodplains: medium to dense brush, winter (the wet season, when overbank flow happens). Also the [HEC-RAS 2D](https://www.hec.usace.army.mil/confluence/rasdocs/r2dum/latest/developing-a-terrain-model-and-geospatial-layers/creating-land-cover-mannings-n-values-and-impervious-layers) minimum for NLCD shrub/scrub (0.07–0.16). |

Sensitivity: at fixed \(Q\), normal depth scales as \(n^{3/5}\) for a wide channel, so ±25% roughness moves depth by about ±15% (+0.29 m or −0.32 m at 2 m depth). A 2× discharge error moves depth by about +52%, so roughness is a second-order error next to the 2–5× Publisher uncertainty.

## Parameters

All values live in [`method-config.ts`](method-config.ts).

- **Cross-sections (`CROSS_SECTION`):** 5 per Creek Segment, sampled every 1 m out to ±100 m. A valley-edge guard then trims each side at its highest point between the thalweg and that end, so a section never reaches into a neighbouring valley. Each section records its trimmed ends (`valleyEdgeLeftOffsetM`, `valleyEdgeRightOffsetM`) and bank-top offsets. At Jalama the guard trims 106 of 305 sections. The bed is the thalweg, the lowest ground within ±30 m of the flowline. A tie goes to the sample nearer the flowline. Each section records its thalweg point (`thalwegUtm`, EPSG 32610 meters), offset, and elevation. Across the 305 sections, the thalweg sits a median 6 m from the TNC flowline, with p90 15 m and max 28 m. A ±20 m search stopped 7 sections at its edge, so the search is ±30 m and none stop there. The representative section has the median wetted area at bed + 1 m. Slope is a least-squares fit over a ±150 m network window, with a floor of 0.001.
- **Shallow cross-section fallback (`valleyEdgeMinimumBankHeightM`):** To keep each cross-section inside its own valley, we trim it at the highest ground on each side of the creek. On a few very shallow channels, mostly tiny headwater gullies, that highest ground is less than 0.5 m above the creek bed. That is a problem: the rating curve cannot rise above the section edges, so even a small flow overtops it, gets clamped, and the creek shows almost no water. So on that side we use the full, untrimmed ±100 m half-section instead, which gives the water room to rise. Same data and same method; only the width of the section on that side changes. Stage 2 then caps the ladder at the other side's valley edge, or at bed + 15 m when both sides use the fallback, and water on a widened side spills past the profile end, so its area is an estimate. In the preserve, 179 of the 33,380 section sides use the fallback (33 of the 3,338 representative sections); at Jalama none do. Stage 1 warns per affected segment and its manifest counts the sides. The fallback changes the section itself, so no output carries a separate marker for it; see the clamp numbers under [Assumptions and known limitations](#assumptions-and-known-limitations).
- **Rating curve (`RATING_CURVE`):** \(n = 0.04\) main channel, \(n = 0.07\) floodplain, 0.02 m steps. The ladder top is the lower valley edge, the lower of the trimmed section's valley-edge end elevations. Bed + 15 m is only a safety cap that bounds ladder length. Jalama valley edges sit a median 15.9 m above the bed, and the deepest WY2018–WY2023 peak needs 7.1 m. 57 segments stop at bed + 15 m and 4 at the lower valley edge.
- **Drainage-area ratio (`DRAINAGE_AREA_RATIO`):** 15 m search radius around the downstream thalweg point, 2 m raster cells, 6 decimals kept on the ratio, 8 parallel sample requests.
- **Drainage-Area Ratio Transfer (`DRAINAGE_AREA_RATIO_TRANSFER`, `MAXIMUM_TRANSFER_DISTANCE_M`):** the field name and label, and the 1,000 m distance beyond which a transfer segment gets no discharge.
- **Time Series values:** rounded to 3 decimals (mm).

## COMID namespaces

COMID (common identifier) numbers come from two separate systems. Creek Segments come from NHD (National Hydrography Dataset) 1:24K COMIDs, for example 27714637 for Jalama. Both Publishers report discharge on coarser NHDPlusV2 COMIDs. The reviewed crosswalk maps each Creek Segment midpoint to its NHDPlusV2 reach with NLDI. It then checks the reach against the segment's own TNC flowline. A reach whose REACHCODE differs is reassigned to the single NLDI reach on that flowline that shares its REACHCODE. A named flowline whose reach carries a different GNIS (Geographic Names Information System) name gets a warning. All 61 Jalama Creek Segments map to 17593507; one of them, 27714637-060, was reassigned from 17593487. In the preserve, 413 of 3,338 segments sit on small tributaries that have no NHDPlusV2 reach of their own, so they are kept on the nearest reach, usually a much larger creek. These are marked as a [Drainage-Area Ratio Transfer](#drainage-area-ratio-transfer), and the drainage-area ratio below corrects their discharge.

## Drainage-area ratio

A Publisher gives one discharge per NHDPlusV2 reach, measured at the reach outlet. Without a correction, every Creek Segment on that reach, including a small tributary kept on it, would get the whole reach's flow. Stage 3 instead uses the standard USGS drainage-area ratio method (Ries, 2007, *The National Streamflow Statistics Program*, USGS Techniques and Methods 4-A6; Emerson, Vecchia, and Dahl, 2005, USGS Scientific Investigations Report 2005-5017): discharge scales with the area that drains to a point.

\[ Q_{segment} = Q_{reach} \times \min\!\left(1,\ \frac{A_{segment}}{A_{reach}}\right) \]

The cap means flow is never increased. The method assumes runoff per unit area is uniform across the reach's catchment, so a segment draining 5% of the reach's area carries 5% of its flow. The catalog derivation lists this as an assumption.

- \(A_{reach}\) is the reach's NHDPlusV2 `TotDASqKm`, read from the EPA NHDPlus flowline service in Stage 0 and stored as `reachDrainageAreaKm2`.
- \(A_{segment}\) is read from the public Dangermond Preserve 2018 flow-accumulation raster (`JLDP_Flow_Accumulation_2018` ImageServer, 2 m cells, EPSG 32611). A cell's value is the number of cells that drain into it, so km² = count × 4 m² ÷ 10⁶. Stage 1 projects each segment's downstream thalweg point (the lowest ground of the downstream-most sampled section) from EPSG 32610 to 32611 and takes the largest count within 15 m of it, because a flowline can sit off the real channel. The result is `segmentDrainageAreaKm2`. Sample results are cached in `00-acquire/flow-accumulation-samples.json` and reused while the point and radius are unchanged.
- `drainageAreaRatio` is the capped quotient. The cap matters because a segment at the very bottom of a reach can measure slightly more area than the NHDPlusV2 value because the two datasets draw the divide differently. A segment whose point falls outside the raster, or whose reach has no `TotDASqKm`, keeps ratio 1 and gets a warning.

At Jalama the 61 ratios run 0.961 to 1 (median 0.995) because the reach is one creek; the gauge segment 27714637-026 measures 52.24 km² against the reach's 53.37 km², ratio 0.979, which lowers its WY2018–WY2023 peak WSE from 32.141 m to 32.107 m. In the preserve, 3,209 of 3,338 ratios are below 1 (min 0.000009, median 0.556, max 1); the 413 kept tributary segments have a median ratio of 0.055, so they now get about 5% of the flow they inherited before. The ratio is a coarse correction: it assumes runoff per unit area is uniform across the reach, and the downstream-most segment of a tributary can still pick up the main creek's cells when the confluence is within the 15 m search.

### Drainage-Area Ratio Transfer

A Creek Segment whose TNC flowline has no NHDPlusV2 reach sharing its REACHCODE keeps the NLDI reach of a neighbouring creek. The drainage-area ratio then *transfers* that reach's discharge to the segment, which stretches the method's uniform-runoff assumption across two catchments. Such a segment is marked `drainageAreaRatioTransfer: true` in the crosswalk (every entry carries the boolean) and in every Time Series file (`segments[].drainageAreaRatioTransfer`, written only when true, to keep the files small). The name lives in one constant, `DRAINAGE_AREA_RATIO_TRANSFER` in `method-config.ts`, so it can be renamed later. Stage 0, 1, and 3 manifests count `drainageAreaRatioTransferSegments`; `catalog.json` carries a `drainageAreaRatioTransfer` note and a per-Time-Series count.

**Distance check.** Stage 0 fetches each borrowed reach's flowline geometry from the EPA NHDPlusV2 service (cached in `00-acquire/nhdplusv2-reach-geometries.json`) and records `transferDistanceM`, the distance from the segment midpoint to the nearest point of that geometry. A segment farther than `MAXIMUM_TRANSFER_DISTANCE_M` (1000 m) gets no discharge: Stage 3 writes null values, warns, and counts `transferDistanceExceededSegments`. The Stage 0 manifest reports the distance distribution under `measurements.transferDistanceM`. In the preserve the 413 transfer segments, on 27 flowlines, sit a median 494 m from the borrowed reach (p90 920 m, max 1,356 m): 50 within 50 m, 21 in 50–100 m, 54 in 100–250 m, 84 in 250–500 m, 175 in 500–1,000 m, and 29 beyond 1,000 m. Those 29, on 5 flowlines (27714605, 27714659, 27714689, 27715861, 27714675), get null values.

## Junction WSE

Each Creek Segment is solved on its own representative cross-section, so two neighbours can disagree about the WSE at the vertex they share, by up to 3 m at Jalama in the January 2023 peak. A flat polygon per segment then shows a step at every vertex, and at low flow the flat water covers only the lower end of each 30 m segment and leaves the bed dry in between (Linear UCS-271). Stage 3 therefore gives neighbours one shared number at each vertex; the WSE Polygon Generation Method decides how to draw it (see [junction-sloped-terrain-fill](../../wse-polygon-generation-methods/junction-sloped-terrain-fill/METHOD.md)).

Every segment's Time Series carries `junctionWseUpstreamM` and `junctionWseDownstreamM`, parallel to `values`: the WSE at its upstream and downstream vertex. At a vertex shared with a neighbour it is the **higher** of the two segments' values, so both sides carry the same number and neither segment's water is pulled below its own modeled level; at a flowline end, or where the neighbour's value is null, it is the segment's own value. Upstream and downstream follow Stage 1's vertex-direction rule (first sampled bed versus last), shared through `downstreamVertexDirection` in `stage-file-formats.ts`. The mean of the two values was tried first: at a low-flow hour (Dec 1 2022 12:00 UTC) it sat below the nearest lidar thalweg bed at 33 of the 60 Jalama junctions (median 0.15 m, max 0.74 m), because a segment whose bed drops steeply (27714637-016 falls 1.5 m) has a representative WSE far below its upstream end, and the mean then dragged its upstream neighbour's water under the bed too (27714637-015 lost its polygon). The higher value falls below the bed at 5 junctions, by at most 0.11 m. The Time Series files are about 2.8× larger (Jalama WY file 3.8 → 10.7 MB).

## Assumptions and known limitations

- **Bare-earth bed:** USGS 3DEP lidar cannot see under water, so the "bed" is the lowest ground or water surface on the survey date. True depths are larger than modeled ones.
- **Normal depth:** The method assumes steady, uniform flow on one representative cross-section. It ignores backwater, pools, riffles, and flood routing.
- **Two roughness values:** One \(n\) for every main channel and one for every floodplain. Roughness really varies with vegetation, substrate, and stage.
- **One hydrograph per reach:** Every Creek Segment in one NHDPlusV2 reach gets the reach's discharge scaled by its drainage-area ratio, so the shape of the hydrograph is shared and only its size and the local geometry differ. Timing lags and local storm cells are not modeled.
- **Publisher accuracy:** California Natural Flows is a monthly mean of modeled natural flow and has not been validated at this creek. The National Water Model has no gauge correction, so flow sizes may be off by 2–5×, while timing is more reliable.
- **Storm-peak clamp:** A discharge above a rating curve's top maps to the top WSE (`clamped`). With WY2018–WY2023, 4 Jalama values are clamped, down from 41 under the former bank-top cap. All 4 are in the Jan 10 2023 peak, on 27714637-009 and 27714637-049. Their lower valley edge sits under 5.2 m above the bed, so the trimmed section cannot carry the peak. Clamping is kept, with no per-value flag. In the preserve the drainage-area ratio took clamped values from 5,731 to 5,356 (California Natural Flows) and from 190,118 to 173,592 (National Water Model). Most of those sat on about 30 segments whose lower valley edge was at the bed, so their rating curve topped out at 0 m³/s and any positive flow clamped. The shallow cross-section fallback (see [Parameters](#parameters)) fixed that: the preserve now has 0 clamped California Natural Flows values and 75 clamped National Water Model values, on 10 segments in storm peaks (42 of them on 27714645-045). One segment, 27714707-000, still carries a `shallow-section` warning (down from 35) because the untrimmed end of its section is itself less than 0.5 m above the bed.
- **Plausibility:** At the Jalama Near Lompoc gauge, the observed WSE is about 26.3 m in other years. The modeled median is about 25.8 m. Treat this only as a loose plausibility check.

## Output

Stage 3 writes one WSE Time Series per Dataset and TNC flowline to `03-time-series/m1-drainage-area-ratio-manning-rating-curve/v<version>/time-series/<datasetId>/water-surface-elevation/…` (see [File layout](../../METHODOLOGY.md#file-layout)). The Stage 3 manifest records this method's fingerprint (`methodSha256`); a stage stops instead of overwriting a saved version whose code or parameters changed ([Version bump rule](../../METHODOLOGY.md#version-bump-rule)). Each Creek Segment carries `values`, `junctionWseUpstreamM`, `junctionWseDownstreamM`, and, on transfer segments only, `drainageAreaRatioTransfer: true`. The files carry no `anchorBedElevationM`. The WSE Anchor Point bed is Stage 1's `segments[].bedElevationM`, the representative section's thalweg, where the Stage 2 ladder starts. The browser's development middleware adds that bed to each served m1 Time Series segment so the Water-Surface Elevation Chart can plot Anchor Water Depth (UCS-301).

## Version history

| Version | Change type | Change note |
| --- | --- | --- |
| `m1-v1` | new method | First version: the Stage 0–3 method as of commit 54618bbb, frozen from ed267d61 and published to ArcGIS as `modeled_wse_m1_v1` (UCS-285). |
