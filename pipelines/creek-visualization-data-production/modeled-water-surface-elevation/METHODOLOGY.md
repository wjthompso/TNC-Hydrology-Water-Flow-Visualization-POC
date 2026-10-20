# Modeled water-surface elevation methodology

This offline pipeline turns modeled discharge (flow rate) from two Publishers into a modeled water-surface elevation (WSE) Time Series for every Creek Segment in one extent. It also builds prepared water-surface polygons for those elevations and a catalog that describes the result. Every elevation is in meters NAVD88 (North American Vertical Datum of 1988). Each stage writes a `manifest.json` that records input hashes, parameters, counts, and warnings. A stage skips itself when nothing changed. Add `--force` to rerun it anyway.

Run everything with `npm run pipeline:modeled-wse:all -- --extent=<extentId>`. The runner passes every argument to all six stages and prints per-stage wall-clock time. A single stage takes the same flags, for example `npm run pipeline:modeled-wse:time-series -- --extent=jalama-gauge-reach --force`. Outputs go to `data/modeled-water-surface-elevation-pipeline-output/<extentId>/0X-…/`, which git ignores. The NOAA National Water Model chunk cache sits at the output root and every extent shares it.

## Extents

| `--extent=` | Creek Segments | segmentNetworkVersion | Status |
| --- | --- | --- | --- |
| `jalama-gauge-reach` | 61, on TNC flowline COMID 27714637 | `jalama-27714637-v1` | Runs. Fast development extent, about 15 s with `--force` once the 61 flow-accumulation samples and the NLDI answers are cached (about 30 s before that). |
| `dangermond-preserve` | 3,338, on all 105 TNC flowlines in the preserve | `dangermond-preserve-v1` | Runs. Default. Cold run 14.3 min (Stage 0 terrain download ≈ 10 min, ~1.0 GB of overlapping 2 km 3DEP tiles) plus about 4 min of flow-accumulation samples in Stage 1 on the first run; largest browser-facing file 13.6 MB. Reruns skip unchanged stages; a full `--force` rerun with cached terrain, samples, and NLDI answers takes 5.4 min (Stage 4 and Stage 5 about 2 min each). |

Creek Segment ids stay `<tncComid>-<vertexIndex>`. A flowline with several paths keeps one vertex numbering across its paths, and no Creek Segment spans the gap between two paths. Bed slope and network distance are computed per TNC flowline. Each extent has its own tracked crosswalk, `data/retained-backend-source-data/reviewed-assignments/nhdplusv2-reach-crosswalk-<extentId>.json`. Stage 0 writes the reach assignment to `00-acquire/nhdplusv2-reach-crosswalk.json`; Stage 1 adds the drainage-area ratio and writes the tracked file. The Jalama file was renamed from `nhdplusv2-reach-crosswalk.json`.

## Stages

| Stage and command | Data in | Data out |
| --- | --- | --- |
| 0 `pipeline:modeled-wse:acquire` (network) | TNC flowline snapshot; USGS 3DEP export; NLDI and EPA NHDPlusV2 services; California Natural Flows API; NOAA National Water Model v3.0 retrospective Zarr | `00-acquire/`: USGS 3DEP 1 m terrain tile(s), NHDPlusV2 reach assignment per Creek Segment with the reach drainage area and the [Drainage-Area Ratio Transfer](#drainage-area-ratio-transfer) flag and distance, normalized discharge (m³/s) per Dataset. NLDI answers, reach attributes, and borrowed-reach geometry are cached here (`nldi-position-lookups.json`, `nhdplusv2-reach-attributes.json`, `nhdplusv2-reach-geometries.json`) because NLDI allows 3,600 requests per hour. The NLDI cache is seeded from the extent's tracked crosswalk before any request and saved every 100 lookups, so a rerun of an extent that has a tracked crosswalk makes no NLDI call and a rate-limit error keeps the answers received so far |
| 1 `pipeline:modeled-wse:cross-sections` (network for the raster samples, cached) | Flowline, terrain, reach assignment, Dangermond Preserve flow-accumulation raster | `01-cross-sections/cross-sections.json`: bed elevation, bed slope, representative valley-edge-trimmed cross-section (see [Shallow cross-section fallback](#parameters)), and one thalweg point, valley edges, and bank tops per sampled section for each Creek Segment. Also the tracked NHDPlusV2 reach crosswalk with each segment's drainage-area ratio (see [Drainage-area ratio](#drainage-area-ratio)) |
| 2 `pipeline:modeled-wse:rating-curves` | Cross-sections | `02-rating-curves/rating-curves.json`: WSE → discharge ladder per Creek Segment, with main-channel and floodplain discharge |
| 3 `pipeline:modeled-wse:time-series` | Rating curves, crosswalk, discharge, cross-sections, flowline | `03-time-series/time-series/<datasetId>/water-surface-elevation/…`: WSE Time Series, one file per TNC flowline (see [File layout](#file-layout)), with a [junction WSE](#junctions-between-creek-segments) at each segment's two vertices; a transfer segment carries `drainageAreaRatioTransfer: true` |
| 4 `pipeline:modeled-wse:water-surface-polygons` | Cross-sections, Time Series, terrain | `04-water-surface-polygons/<method-id>/v<version>/water-surface-polygon-sets/<tncComid>.json`, one per TNC flowline in the same shape as the published file, plus a ladder summary, for one [WSE Polygon Generation Method](#wse-polygon-generation-methods) (`--wse-polygon-method=<method-id>`). The default method cuts corridors at the junction bisector and slopes each bucket's wet threshold between the segment's junction WSEs (see [Junctions](#junctions-between-creek-segments)) |
| 5 `pipeline:modeled-wse:catalog-and-validate` | Everything above | `05-catalog/catalog.json` (with a `drainageAreaRatioTransfer` note, a per-Time-Series count of transfer segments, and every saved WSE Polygon Generation Method version under `wsePolygonGenerationMethods`) and `validation-report.json`. Every saved method version is validated. The stage exits non-zero on any violation in the default method's newest version; a violation in another version is a warning. |

## File layout

Browser-facing outputs are split per TNC flowline, keyed by its NHD 1:24K COMID, the part of the Creek Segment id before the dash. Each file keeps the single-file shape but holds only that flowline's Creek Segments:

- Polygons: `04-water-surface-polygons/<method-id>/v<version>/water-surface-polygon-sets/<tncComid>.json`.
- Monthly Time Series: `03-time-series/time-series/<datasetId>/water-surface-elevation/<tncComid>.json`.
- Hourly Time Series: `03-time-series/time-series/<datasetId>/water-surface-elevation/<tncComid>/WY<year>.json`.

These files are compact JSON with no indentation. Manifests, the catalog, the polygon ladders, the crosswalk, and the validation report stay indented. Stage 3 deletes its earlier output folder before writing, so a removed flowline never lingers. Stage 4 deletes only the polygon set folder of the method version it is rewriting; other methods and versions are never touched. The catalog `paths` list every Time Series file relative to `03-time-series/`. Stage 5 checks that each file holds exactly one flowline and all of its Creek Segments, that every flowline has a Dataset's full timestamp list, and that every Creek Segment has exactly one polygon set across the polygon files.

Jalama has one flowline, so each output is one file. Compaction took polygons from 22.3 MB to 13.6 MB (−39%). The hourly Time Series went from 4.37 MB to 3.82 MB per full water year (−12.5%), and the monthly Time Series from 450 KB to 393 KB. Time Series save less because their value arrays were already on one line.

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

Both values are the "normal" entry of the matching row in Chow (1959), *Open-Channel Hydraulics*, Table 5-6, as reproduced by [Ponce (SDSU)](https://ponce.sdsu.edu/openchannel/open_channel_hydraulics_05_manningsntable.html) and the [TxDOT Hydraulic Design Manual](https://www.txdot.gov/manuals/des/hyd/chapter-4--hydrology/section-11--time-of-concentration/manning-s-roughness-coefficient-values.html). `MANNING_ROUGHNESS_BASIS` in `pipeline-configuration.ts` carries the same records into every catalog derivation.

| Case | \(n\) | Published range | Source |
| --- | --- | --- | --- |
| Main channel | 0.04 | 0.033–0.045 | Chow Table 5-6, minor streams: clean, winding, some pools and shoals. Inside the USGS WSP 2339 cobble base range (0.030–0.050) and Barnes (1967, WSP 1849) verified cobble-gravel values (0.033–0.043). |
| Floodplain | 0.07 | 0.045–0.110 | Chow Table 5-6, floodplains: medium to dense brush, winter (the wet season, when overbank flow happens). Also the [HEC-RAS 2D](https://www.hec.usace.army.mil/confluence/rasdocs/r2dum/latest/developing-a-terrain-model-and-geospatial-layers/creating-land-cover-mannings-n-values-and-impervious-layers) minimum for NLCD shrub/scrub (0.07–0.16). |

Sensitivity: at fixed \(Q\), normal depth scales as \(n^{3/5}\) for a wide channel, so ±25% roughness moves depth by about ±15% (+0.29 m or −0.32 m at 2 m depth). A 2× discharge error moves depth by about +52%, so roughness is a second-order error next to the 2–5× Publisher uncertainty.

## Parameters

All values live in `pipeline-configuration.ts`, except each WSE Polygon Generation Method's own parameters, which live in its `method-config.ts`.

- **Cross-sections:** 5 per Creek Segment, sampled every 1 m out to ±100 m. A valley-edge guard then trims each side at its highest point between the thalweg and that end, so a section never reaches into a neighbouring valley. Each section records its trimmed ends (`valleyEdgeLeftOffsetM`, `valleyEdgeRightOffsetM`) and bank-top offsets. At Jalama the guard trims 106 of 305 sections. The bed is the thalweg, the lowest ground within ±30 m of the flowline. A tie goes to the sample nearer the flowline. Each section records its thalweg point (`thalwegUtm`, EPSG 32610 meters), offset, and elevation. Across the 305 sections, the thalweg sits a median 6 m from the TNC flowline, with p90 15 m and max 28 m. A ±20 m search stopped 7 sections at its edge, so the search is ±30 m and none stop there. The representative section has the median wetted area at bed + 1 m. Slope is a least-squares fit over a ±150 m network window, with a floor of 0.001.
- **Shallow cross-section fallback:** To keep each cross-section inside its own valley, we trim it at the highest ground on each side of the creek. On a few very shallow channels, mostly tiny headwater gullies, that highest ground is less than 0.5 m above the creek bed (`valleyEdgeMinimumBankHeightM`). That is a problem: the rating curve cannot rise above the section edges, so even a small flow overtops it, gets clamped, and the creek shows almost no water. So on that side we use the full, untrimmed ±100 m half-section instead, which gives the water room to rise. Same data and same method; only the width of the section on that side changes. Stage 2 then caps the ladder at the other side's valley edge, or at bed + 15 m when both sides use the fallback, and water on a widened side spills past the profile end, so its area is an estimate. In the preserve, 179 of the 33,380 section sides use the fallback (33 of the 3,338 representative sections); at Jalama none do. Stage 1 warns per affected segment and its manifest counts the sides. The fallback changes the section itself, so no output carries a separate marker for it; see the clamp numbers under [Assumptions and known limitations](#assumptions-and-known-limitations).
- **Rating curve:** \(n = 0.04\) main channel, \(n = 0.07\) floodplain, 0.02 m steps. The ladder top is the lower valley edge, the lower of the trimmed section's valley-edge end elevations. Bed + 15 m is only a safety cap that bounds ladder length. Jalama valley edges sit a median 15.9 m above the bed, and the deepest WY2018–WY2023 peak needs 7.1 m. 57 segments stop at bed + 15 m and 4 at the lower valley edge.
- **Polygon ladder** (`junction-sloped-terrain-fill` method, `wse-polygon-generation-methods/junction-sloped-terrain-fill/method-config.ts`): 0.05 m buckets run from the bed through the bucket that holds the highest WSE in any modeled Time Series. 0.25 m buckets then continue until the top is at least 2 m above that WSE. Polygons reuse publish's 100 m corridor, 8-connected flood fill, and 2 m Bank-overlap margin. The flood fill seeds from the centerline cells and from the Creek Segment's 5 Stage 1 thalweg points. Publish passes no thalweg points, so its output does not change.
- **Drainage-area ratio:** 15 m search radius around the downstream thalweg point, 2 m raster cells, 8 parallel sample requests (`DRAINAGE_AREA_RATIO`).
- **National Water Model window:** WY2018–WY2023. A water year (WY) runs from Oct 1 through Sep 30. The v3.0 retrospective record ends Feb 1 2023 00:00 UTC, so `WY2023.json` covers only Oct 1 2022 through Feb 1 2023 and is not padded. Stage 0 records `lastWaterYearPartial` and warns.

## Junctions between Creek Segments

Each Creek Segment is solved on its own representative cross-section, so two neighbours can disagree about the WSE at the vertex they share, by up to 3 m at Jalama in the January 2023 peak. A flat polygon per segment then shows a step at every vertex, and at low flow the flat water covers only the lower end of each 30 m segment and leaves the bed dry in between (Linear UCS-271). Two changes make neighbours meet:

- **Junction WSE (Stage 3).** Every segment's Time Series carries `junctionWseUpstreamM` and `junctionWseDownstreamM`, parallel to `values`: the WSE at its upstream and downstream vertex. At a vertex shared with a neighbour it is the **higher** of the two segments' values, so both sides carry the same number and neither segment's water is pulled below its own modeled level; at a flowline end, or where the neighbour's value is null, it is the segment's own value. Upstream and downstream follow Stage 1's vertex-direction rule (first sampled bed versus last), shared through `downstreamVertexDirection` in `stage-file-formats.ts`. The mean of the two values was tried first: at a low-flow hour (Dec 1 2022 12:00 UTC) it sat below the nearest lidar thalweg bed at 33 of the 60 Jalama junctions (median 0.15 m, max 0.74 m), because a segment whose bed drops steeply (27714637-016 falls 1.5 m) has a representative WSE far below its upstream end, and the mean then dragged its upstream neighbour's water under the bed too (27714637-015 lost its polygon). The higher value falls below the bed at 5 junctions, by at most 0.11 m. The Time Series files are about 2.8× larger (Jalama WY file 3.8 → 10.7 MB).
- **Sloped wet threshold (Stage 4).** For each bucket, Stage 4 averages the junction WSEs of every modeled value that fell in that bucket and traces the polygon with a wet threshold that runs linearly from the upstream junction WSE on the corridor's upstream boundary line to the downstream junction WSE on its downstream boundary line, never below the bucket minimum. The polygon therefore contains the flat one and reaches the bed up to the upstream junction. A bucket no value falls in (headroom buckets) is traced flat as before. The ladder summary counts `slopedBuckets` per segment (3,169 of 7,498 at Jalama). The position between the two boundaries is `fractionBetweenBoundaries` in `water-surface-polygon-generation.ts`: 0 on the upstream boundary, 1 on the downstream one, the ratio of the two perpendicular distances in between. On a straight corridor with square ends this is the along-axis fraction; at a bend it keeps the whole slanted bisector line at the junction WSE, where an axis projection would not (see the next point).
- **Bisector corridor ends (Stage 4).** A corridor end at a shared vertex is cut at the angle bisector of the two segments' directions (the perpendicular to their mean direction), so the upstream segment's downstream boundary and the downstream segment's upstream boundary are one line and no wedge of bed is left uncovered on the outside of a bend. A slanted end may reach at most 100 m past the vertex along the axis, and a hairpin keeps the perpendicular. Corridors still never exceed ±100 m laterally. Publish passes no neighbours, so its corridor and output are unchanged.

- **Sloped drawing (browser).** The browser lifts every ring vertex of a drawn polygon to the height interpolated between the segment's two junction WSEs at the selected time (`junctionWseUpstreamM`, `junctionWseDownstreamM`), using the same between-boundaries rule as Stage 4 (`sloped-water-surface.ts`). The dev middleware's `creek-segment-paths.json` gives each segment its flowline vertices in flow order and the ids of its two neighbours, from which the browser rebuilds the junction bisectors. Measuring the slope between the bisector lines rather than by projecting onto the segment axis is what closes the seam: at a bend the bisector is slanted, so an axis projection put the upstream segment's edge at its junction WSE for every point on the line (clamped) while the downstream segment's edge, whose axis projection of the same points is already a little way along, sat lower. On side creek 27714669 at the 007/008 junction (2023-01-01T11:00Z) that crack was about 0.3 m, and a camera looking up the creek at a grazing angle saw the ground through it (FBT-012 Part B). With both polygons holding the junction WSE on the whole line, the two sheets meet exactly.
- **Junction rule and shelves.** The higher-value rule holds a steep segment's water at its own level all the way to its downstream vertex, so where the thalweg drops several meters inside the segment the drawn surface stands that far above the bed at the boundary, and the neighbour's surface falls steeply from the shared junction to its own level (27714669-008: 5.1 m over 14.6 m at the hour above). An alternative, the creek-bed elevation at the shared vertex plus the mean depth of the two neighbours, was worked through for UCS-271 and not adopted: it would put 27714669-007's water about 3 m below the bank the developer clicked in FBT-012 Part B (water 159.6 m against ground 162.4 m at 76 m along the segment, modeled depth 0.18 m), and a straight slope between two bed-level junctions runs under a convex thalweg profile (27714697-044 drops 3.1, 3.7, 4.6, and 5.6 m per 10.8 m, leaving the mid-segment bed about 1.5 m above the line). Covering the bed in such segments would need the surface to follow the Stage 1 thalweg profile within the segment, which the published files do not carry today.

## WSE Polygon Generation Methods

A **WSE Polygon Generation Method** is a named, versioned way to turn modeled water-surface elevations into the water polygons drawn for each Creek Segment. Each version keeps its own saved output, so methods can be compared on the map. Stages 0–3 (terrain, cross-sections, rating curves, Time Series) are shared by every method; only Stage 4 differs. The registry starts with one method:

| Method id | Label | Version | Browser drawing |
| --- | --- | --- | --- |
| `junction-sloped-terrain-fill` (default) | Junction-sloped terrain fill | 1 | Sloped between junction WSEs |

`junction-sloped-terrain-fill` v1 is the Stage 4 behaviour described above (polygon ladder, bisector corridor ends, sloped wet threshold). Its output is byte-identical to the Stage 4 output written before methods existed: 1 of 1 polygon set file plus the ladder at Jalama, 105 of 105 plus the ladder in the preserve (SHA-256 compared, Oct 19 2026).

### Folder layout

```text
modeled-water-surface-elevation/wse-polygon-generation-methods/
  wse-polygon-generation-method.ts            config and recorded-method types (no pipeline code)
  wse-polygon-generation-method-registry.ts   every method config, the default, --wse-polygon-method= parsing
  wse-polygon-generation-method-generators.ts method id → generator; the shared inputs and result shape
  wse-polygon-generation-method-fingerprint.ts SHA-256 of a method's code files and parameters
  wse-polygon-generation-method-outputs.ts    lists saved versions on disk (Stage 5 and the dev server)
  <method-id>/
    method-config.ts                          { id, label, version, description, browserDrawing, sharedCodeFiles, parameters }
    generate-water-surface-polygons.ts        the method's code

data/modeled-water-surface-elevation-pipeline-output/<extentId>/04-water-surface-polygons/
  <method-id>/v<version>/
    manifest.json                             parameters.wsePolygonGenerationMethod records id, label, version, description,
                                              browserDrawing, parameters, codeSha256ByFile, and methodSha256
    water-surface-polygon-ladders.json
    water-surface-polygon-sets/<tncComid>.json
```

`browserDrawing` tells the browser how to draw the method's polygons at the selected time: `sloped-between-junctions` lifts every ring vertex between the segment's two junction WSEs (`sloped-water-surface.ts`), and `flat-at-bucket-minimum` draws the polygon flat at its bucket minimum. Files left directly in `04-water-surface-polygons/` by the layout before methods existed (`manifest.json`, `water-surface-polygon-ladders.json`, `water-surface-polygon-sets/`) are ignored by Stage 5 and the browser, and can be deleted once nothing older reads them.

### Version bump rule

Every change to a method's output-affecting code or parameters gets a new version. Stage 4 fingerprints the method: SHA-256 of every file in its folder, of each repository file listed in `sharedCodeFiles` (for `junction-sloped-terrain-fill`, `water-surface-polygon-generation.ts`), and of its `parameters` and `browserDrawing`. The fingerprint (`methodSha256`) goes into the version's manifest. When `04-water-surface-polygons/<method-id>/v<version>/` already holds output with a different fingerprint, Stage 4 stops, even with `--force`, names the changed files, and asks for a bump: raise `version` in that method's `method-config.ts` and rerun. Stage 4 then writes a new `v<version+1>/` folder and leaves the older one on disk, so both can be compared on the map. A comment-only edit in a fingerprinted file also counts as a change; bump the version or revert the edit. The same fingerprint skips the stage as before, unless the Stage 0–3 inputs changed, in which case that version is rewritten in place.

### Adding a method

1. Copy `wse-polygon-generation-methods/junction-sloped-terrain-fill/` to `wse-polygon-generation-methods/<new-method-id>/`, using a plain descriptive kebab-case id that is never reused for anything else.
2. In its `method-config.ts`, set `id`, `label`, `version: 1`, a one- or two-sentence `description`, `browserDrawing`, `sharedCodeFiles`, and `parameters`. Change the generator; it receives the shared Stage 0–3 inputs (`WsePolygonMethodInputs`) and returns polygon sets, a ladder summary, counts, and warnings (`WsePolygonMethodResult`). Stage 5 checks that every Creek Segment has one polygon set and that every modeled value is at or below the ladder's `ceilingM`.
3. Register the config in `wse-polygon-generation-method-registry.ts` and the generator in `wse-polygon-generation-method-generators.ts`.
4. Run `npm run pipeline:modeled-wse:water-surface-polygons -- --extent=jalama-gauge-reach --wse-polygon-method=<new-method-id>`, then `npm run pipeline:modeled-wse:catalog-and-validate -- --extent=jalama-gauge-reach`.
5. Open the modeled experience with `?devtools=1` and choose the method in Dev tools → Dataset and time → **Polygon method**, or open `?wsePolygonMethod=<new-method-id>@v1` directly.

Change `DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID` only when the new method should become what the browser opens and what Stage 5 fails on; that decision changes what the Feature Behavior Tests check.

### Browser

The dev middleware serves `/modeled-water-surface-elevation-data/<extent>/wse-polygon-methods.json`, the saved method versions read from each version's manifest, plus a computed `flowline-index.json` inside every version folder. The modeled experience opens the newest version of the default method, or the version named by `?wsePolygonMethod=<method-id>@v<version>` (`<method-id>` alone means its newest version; an unknown value falls back to the default with a console warning). The dev tools **Polygon method** select switches the drawn version live, keeping the camera and the selected time, shows its label and description, and writes the choice to the URL. Copy all JSON includes `wsePolygonMethod` and `wsePolygonMethodLabel` in its `dataset` object.

## COMID namespaces

COMID (common identifier) numbers come from two separate systems. Creek Segments come from NHD (National Hydrography Dataset) 1:24K COMIDs, for example 27714637 for Jalama. Both Publishers report discharge on coarser NHDPlusV2 COMIDs. The reviewed crosswalk maps each Creek Segment midpoint to its NHDPlusV2 reach with NLDI (Network-Linked Data Index). It then checks the reach against the segment's own TNC flowline. A reach whose REACHCODE differs is reassigned to the single NLDI reach on that flowline that shares its REACHCODE. A named flowline whose reach carries a different GNIS (Geographic Names Information System) name gets a warning. All 61 Jalama Creek Segments map to 17593507; one of them, 27714637-060, was reassigned from 17593487. In the preserve, 413 of 3,338 segments sit on small tributaries that have no NHDPlusV2 reach of their own, so they are kept on the nearest reach, usually a much larger creek. These are marked as a [Drainage-Area Ratio Transfer](#drainage-area-ratio-transfer), and the drainage-area ratio below corrects their discharge.

## Drainage-area ratio

A Publisher gives one discharge per NHDPlusV2 reach, measured at the reach outlet. Without a correction, every Creek Segment on that reach, including a small tributary kept on it, would get the whole reach's flow. Stage 3 instead uses the standard USGS drainage-area ratio method (Ries, 2007, *The National Streamflow Statistics Program*, USGS Techniques and Methods 4-A6; Emerson, Vecchia, and Dahl, 2005, USGS Scientific Investigations Report 2005-5017): discharge scales with the area that drains to a point.

\[ Q_{segment} = Q_{reach} \times \min\!\left(1,\ \frac{A_{segment}}{A_{reach}}\right) \]

The cap means flow is never increased. The method assumes runoff per unit area is uniform across the reach's catchment, so a segment draining 5% of the reach's area carries 5% of its flow. The catalog derivation lists this as an assumption.

- \(A_{reach}\) is the reach's NHDPlusV2 `TotDASqKm`, read from the EPA NHDPlus flowline service in Stage 0 and stored as `reachDrainageAreaKm2`.
- \(A_{segment}\) is read from the public Dangermond Preserve 2018 flow-accumulation raster (`JLDP_Flow_Accumulation_2018` ImageServer, 2 m cells, EPSG 32611). A cell's value is the number of cells that drain into it, so km² = count × 4 m² ÷ 10⁶. Stage 1 projects each segment's downstream thalweg point (the lowest ground of the downstream-most sampled section) from EPSG 32610 to 32611 and takes the largest count within 15 m of it, because a flowline can sit off the real channel. The result is `segmentDrainageAreaKm2`. Sample results are cached in `00-acquire/flow-accumulation-samples.json` and reused while the point and radius are unchanged.
- `drainageAreaRatio` is the capped quotient. The cap matters because a segment at the very bottom of a reach can measure slightly more area than the NHDPlusV2 value because the two datasets draw the divide differently. A segment whose point falls outside the raster, or whose reach has no `TotDASqKm`, keeps ratio 1 and gets a warning.

At Jalama the 61 ratios run 0.961 to 1 (median 0.995) because the reach is one creek; the gauge segment 27714637-026 measures 52.24 km² against the reach's 53.37 km², ratio 0.979, which lowers its WY2018–WY2023 peak WSE from 32.141 m to 32.107 m. In the preserve, 3,209 of 3,338 ratios are below 1 (min 0.000009, median 0.556, max 1); the 413 kept tributary segments have a median ratio of 0.055, so they now get about 5% of the flow they inherited before. The ratio is a coarse correction: it assumes runoff per unit area is uniform across the reach, and the downstream-most segment of a tributary can still pick up the main creek's cells when the confluence is within the 15 m search.

### Drainage-Area Ratio Transfer

A Creek Segment whose TNC flowline has no NHDPlusV2 reach sharing its REACHCODE keeps the NLDI reach of a neighbouring creek. The drainage-area ratio then *transfers* that reach's discharge to the segment, which stretches the method's uniform-runoff assumption across two catchments. Such a segment is marked `drainageAreaRatioTransfer: true` in the crosswalk (every entry carries the boolean) and in every Time Series file (`segments[].drainageAreaRatioTransfer`, written only when true, to keep the files small). The name lives in one constant, `DRAINAGE_AREA_RATIO_TRANSFER` in `pipeline-configuration.ts`, so it can be renamed later. Stage 0, 1, and 3 manifests count `drainageAreaRatioTransferSegments`; `catalog.json` carries a `drainageAreaRatioTransfer` note and a per-Time-Series count.

**Distance check.** Stage 0 fetches each borrowed reach's flowline geometry from the EPA NHDPlusV2 service (cached in `00-acquire/nhdplusv2-reach-geometries.json`) and records `transferDistanceM`, the distance from the segment midpoint to the nearest point of that geometry. A segment farther than `MAXIMUM_TRANSFER_DISTANCE_M` (1000 m) gets no discharge: Stage 3 writes null values, warns, and counts `transferDistanceExceededSegments`. The Stage 0 manifest reports the distance distribution under `measurements.transferDistanceM`. In the preserve the 413 transfer segments, on 27 flowlines, sit a median 494 m from the borrowed reach (p90 920 m, max 1,356 m): 50 within 50 m, 21 in 50–100 m, 54 in 100–250 m, 84 in 250–500 m, 175 in 500–1,000 m, and 29 beyond 1,000 m. Those 29, on 5 flowlines (27714605, 27714659, 27714689, 27715861, 27714675), get null values.

## Assumptions and known limitations

- **Bare-earth bed:** USGS 3DEP lidar cannot see under water, so the "bed" is the lowest ground or water surface on the survey date. True depths are larger than modeled ones.
- **Normal depth:** The method assumes steady, uniform flow on one representative cross-section. It ignores backwater, pools, riffles, and flood routing.
- **Two roughness values:** One \(n\) for every main channel and one for every floodplain. Roughness really varies with vegetation, substrate, and stage.
- **One hydrograph per reach:** Every Creek Segment in one NHDPlusV2 reach gets the reach's discharge scaled by its drainage-area ratio, so the shape of the hydrograph is shared and only its size and the local geometry differ. Timing lags and local storm cells are not modeled.
- **Publisher accuracy:** California Natural Flows is a monthly mean of modeled natural flow and has not been validated at this creek. The National Water Model has no gauge correction, so flow sizes may be off by 2–5×, while timing is more reliable.
- **Flowline offset:** The TNC flowline often sits 6–15 m off the channel's lowest ground. Seeding only from the centerline left 1,026 of 3,122 buckets empty, and about 57% of modeled values fell into them. With thalweg seeds, 9 buckets stay empty at Jalama (569 of 102,847 in the preserve). Each is a floor bucket that starts up to 5 cm below the bed, where no connected terrain cell is that low. Zero-discharge values map to the bed and land in these buckets, which accounts for most of the remaining 3–6% of values in empty buckets. Stage 4 lists them as warnings. A thalweg seed can add a separate wet pocket inside the corridor, and 10 buckets gained a second ring this way.
- **Storm-peak clamp:** A discharge above a rating curve's top maps to the top WSE (`clamped`). With WY2018–WY2023, 4 Jalama values are clamped, down from 41 under the former bank-top cap. All 4 are in the Jan 10 2023 peak, on 27714637-009 and 27714637-049. Their lower valley edge sits under 5.2 m above the bed, so the trimmed section cannot carry the peak. Clamping is kept, with no per-value flag. In the preserve the drainage-area ratio took clamped values from 5,731 to 5,356 (California Natural Flows) and from 190,118 to 173,592 (National Water Model). Most of those sat on about 30 segments whose lower valley edge was at the bed, so their rating curve topped out at 0 m³/s and any positive flow clamped. The shallow cross-section fallback (see [Parameters](#parameters)) fixed that: the preserve now has 0 clamped California Natural Flows values and 75 clamped National Water Model values, on 10 segments in storm peaks (42 of them on 27714645-045). One segment, 27714707-000, still carries a `shallow-section` warning (down from 35) because the untrimmed end of its section is itself less than 0.5 m above the bed.
- **Plausibility:** At the Jalama Near Lompoc gauge, the observed WSE is about 26.3 m in other years. The modeled median is about 25.8 m. Treat this only as a loose plausibility check.

## Widening the National Water Model window

Run `npm run pipeline:modeled-wse:all -- --extent=jalama-gauge-reach --water-years=2010-2023`. Stage 3 writes one file per water year. Each later stage reruns because its inputs changed. Stage 0 keeps every compressed Zarr chunk in `national-water-model-zarr-chunk-cache/` at the output root, so a wider window or another extent downloads only chunks it has not seen. One chunk holds 672 hours × 30,000 reaches, about 1.5 MB. Delete that folder to force a fresh download.

## Dangermond Preserve feasibility

Measured Oct 15 2026, before any heavy download. The working files are in `dangermond-preserve/feasibility/`.

- **Boundary:** `jldp_boundary` FeatureServer layer 2, "The Dangermond Preserve", 1 ring, 346 vertices, 24,459 acres. It is the same layer TNC-DigitalTwin uses. The Data Catalog FeatureServer holds only catalog tables.
- **Flowlines:** All 105 features of the TNC flowline layer intersect the boundary; the layer is already clipped to the preserve. Total length is 125.1 km. By FCODE (feature code): 84 intermittent (99.1 km), 20 perennial (25.8 km), 1 connector (0.2 km), and no ephemeral. Named creeks are Jalama, Espada, Escondido, and Gasper, 42.6 km together. 3 flowlines have several paths.
- **Creek Segments (current original-vertex rule):** 3,338, with median length 30.5 m, p90 73 m, and max 247 m.
- **NHDPlusV2 reaches:** 79 distinct. They were found by point-in-polygon matching each segment midpoint against EPA NHDPlusV2 catchments, 160 polygons in one 0.4 s request. NLDI uses the same catchment rule and agrees on all 61 Jalama segments, including the 27714637-060 confluence snap. Per-segment NLDI calls would take about 3,338 × 0.5 s ÷ 4 workers ≈ 7 min.
  - REACHCODE differs on 455 segments across 56 flowlines. Of those, 42 segments on 29 flowlines would be reassigned, and 22 flowlines have no matching reach.
  - GNIS name differs on 143 segments, mostly unnamed NHDPlusV2 reaches under named Espada and Escondido flowlines.
  - 2 reaches are coastline (FCODE 56600), are not NWM features, and would have null discharge.
- **NOAA National Water Model:** 77 of the 79 reaches are NWM features. All fall in feature-column chunks 59 and 60, so WY2018–WY2023 needs 2 × 70 = 140 chunks, about 210 MB, 104 MB of it already cached for Jalama. That is about 15 s of download.
- **Terrain:** Corridor-touching 1 km tiles: 111, about 505 MB (~4.2 MB and ~2.3 s each). Using 500 m tiles: 354, about 403 MB. The whole preserve bounding box at 1 m is about 780 MB. A single 4,000 px export failed with HTTP 500, so tiles must stay small. That is about 4–5 min of terrain download.
- **Run time:** Stage 4 is about 2–6 min, depending on bucket count. A cold run is about 10–15 min, near the limit.
- **Browser-facing file sizes (over budget):**
  - `water-surface-polygon-sets.json`: about 150–400 MB in one file. Jalama costs 86 bytes per segment-meter per bucket. Bucket count scales with drainage area: about 37 buckets per segment if peak depth scales as (area ratio)^0.6, versus 120 at Jalama.
  - National Water Model WSE Time Series: about 240 MB per water-year file for 3,338 segments × 8,760 hours.
  - California Natural Flows: about 25 MB.

Both largest estimates exceeded the approved 100 MB per browser-facing file. Option 1 (per-flowline files, compact JSON) was chosen and `dangermond-preserve` is unblocked; the measured largest file is 13.6 MB. The options considered were:

1. **Per-watershed or per-flowline files.** Now adopted per TNC COMID; see [File layout](#file-layout). Split polygons and Time Series by TNC COMID or by NHDPlusV2 reach. The largest file becomes Jalama-sized (≤ 25 MB), and the browser loads only what is in view.
2. **One value per NHDPlusV2 reach for the Time Series.** Discharge is already per reach (79 reaches). Store discharge per reach and the rating curve per segment, and let the browser compute WSE. Time Series drop to about 6 MB per water year.
3. **Filter creeks.** Named or perennial only: 52 km and 1,425 segments, about 45% of the work. Perennial only: 26 km and 638 segments.
4. **Coarser polygon ladder.** 0.10 m fine steps halve the polygon size. Compact JSON is now adopted; it saved 39% on Jalama polygons.
5. **Shorter National Water Model window** for the preserve, for example WY2022–WY2023 only.
