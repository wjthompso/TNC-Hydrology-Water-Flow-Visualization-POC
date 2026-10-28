# Modeled water-surface elevation methodology

This offline pipeline turns modeled discharge (flow rate) from two Publishers into a modeled water-surface elevation (WSE) Time Series for every Creek Segment in one extent. It also builds prepared water-surface polygons for those elevations and a catalog that describes the result. Every elevation is in meters NAVD88 (North American Vertical Datum of 1988). Each stage writes a `manifest.json` that records input hashes, parameters, counts, and warnings. A stage skips itself when nothing changed. Add `--force` to rerun it anyway.

Run everything with `npm run pipeline:modeled-wse:all -- --extent=<extentId>`. The runner passes every argument to all six stages and prints per-stage wall-clock time. A single stage takes the same flags, for example `npm run pipeline:modeled-wse:time-series -- --extent=jalama-gauge-reach --force`. Outputs go to `data/pipeline-working-output/<extentId>/0X-…/`, which git ignores. The NOAA National Water Model chunk cache sits at the output root and every extent shares it.

## Extents

| `--extent=` | Creek Segments | segmentNetworkVersion | Status |
| --- | --- | --- | --- |
| `jalama-gauge-reach` | 61, on TNC flowline COMID 27714637 | `jalama-27714637-v1` | Runs. Fast development extent, about 15 s with `--force` once the 61 flow-accumulation samples and the NLDI answers are cached (about 30 s before that). |
| `dangermond-preserve` | 3,338, on all 105 TNC flowlines in the preserve | `dangermond-preserve-v1` | Runs. Default. Cold run 14.3 min (Stage 0 terrain download ≈ 10 min, ~1.0 GB of overlapping 2 km 3DEP tiles) plus about 4 min of flow-accumulation samples in Stage 1 on the first run; largest browser-facing file 13.6 MB. Reruns skip unchanged stages; a full `--force` rerun with cached terrain, samples, and NLDI answers takes 5.4 min (Stage 4 and Stage 5 about 2 min each). |

Creek Segment ids stay `<tncComid>-<vertexIndex>`. A flowline with several paths keeps one vertex numbering across its paths, and no Creek Segment spans the gap between two paths. Bed slope and network distance are computed per TNC flowline. Each extent has its own tracked crosswalk, `data/source-inputs/reviewed-assignments/nhdplusv2-reach-crosswalk-<extentId>.json`. Stage 0 writes the reach assignment to `00-acquire/nhdplusv2-reach-crosswalk.json`; Stage 1 adds the drainage-area ratio and writes the tracked file. The Jalama file was renamed from `nhdplusv2-reach-crosswalk.json`.

## Stages

| Stage and command | Data in | Data out |
| --- | --- | --- |
| 0 `pipeline:modeled-wse:acquire` (network) | TNC flowline snapshot; USGS 3DEP export; NLDI and EPA NHDPlusV2 services; California Natural Flows API; NOAA National Water Model v3.0 retrospective Zarr | `00-acquire/`: USGS 3DEP 1 m terrain tile(s), NHDPlusV2 reach assignment per Creek Segment with the reach drainage area and the [Drainage-Area Ratio Transfer](modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/METHOD.md#drainage-area-ratio-transfer) flag and distance, normalized discharge (m³/s) per Dataset. NLDI answers, reach attributes, and borrowed-reach geometry are cached here (`nldi-position-lookups.json`, `nhdplusv2-reach-attributes.json`, `nhdplusv2-reach-geometries.json`) because NLDI allows 3,600 requests per hour. The NLDI cache is seeded from the extent's tracked crosswalk before any request and saved every 100 lookups, so a rerun of an extent that has a tracked crosswalk makes no NLDI call and a rate-limit error keeps the answers received so far |
| 1 `pipeline:modeled-wse:cross-sections` (network for the raster samples, cached) | Flowline, terrain, reach assignment, Dangermond Preserve flow-accumulation raster | `01-cross-sections/cross-sections.json`: bed elevation, bed slope, representative valley-edge-trimmed cross-section (see [Shallow cross-section fallback](modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/METHOD.md#parameters)), and one thalweg point, valley edges, and bank tops per sampled section for each Creek Segment. Also the tracked NHDPlusV2 reach crosswalk with each segment's drainage-area ratio (see [Drainage-area ratio](modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/METHOD.md#drainage-area-ratio)) |
| 2 `pipeline:modeled-wse:rating-curves` | Cross-sections | `02-rating-curves/rating-curves.json`: WSE → discharge ladder per Creek Segment, with main-channel and floodplain discharge |
| 3 `pipeline:modeled-wse:time-series` | Rating curves, crosswalk, discharge, cross-sections, flowline | `03-time-series/<method-id>/v<version>/time-series/<datasetId>/water-surface-elevation/…` for one [Modeled WSE Derivation Method](#modeled-wse-derivation-methods) version: WSE Time Series, one file per TNC flowline (see [File layout](#file-layout)), with a [junction WSE](modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/METHOD.md#junction-wse) at each segment's two vertices; a transfer segment carries `drainageAreaRatioTransfer: true` |
| 4 `pipeline:modeled-wse:water-surface-polygons` | Cross-sections, the current modeled WSE version's Time Series, terrain | `04-water-surface-polygons/<method-id>/v<version>/water-surface-polygon-sets/<tncComid>.json`, one per TNC flowline in the same shape as the published file, plus a ladder summary, for one [WSE Polygon Generation Method](#wse-polygon-generation-methods) (`--wse-polygon-method=<method-id>`). The manifest records the modeled WSE version it was built from under `parameters.builtFromModeledWseVersion`. The default method, `flowline-channel-ribbon`, lays a ribbon of depth rungs along the creek's raw lidar bed (see [its METHOD.md](wse-polygon-generation-methods/flowline-channel-ribbon/METHOD.md)); `junction-sloped-terrain-fill`, the default until 2026-10-28, cuts corridors at the junction bisector and slopes each bucket's wet threshold between the segment's junction WSEs |
| 5 `pipeline:modeled-wse:catalog-and-validate` | Everything above | `05-catalog/catalog.json` (with `modeledWseVersion`, a `drainageAreaRatioTransfer` note, a per-Time-Series count of transfer segments, and every saved WSE Polygon Generation Method version under `wsePolygonGenerationMethods`) and `validation-report.json`. Every saved method version is validated against one modeled WSE version: `--modeled-wse-method=<id>` when given, otherwise the default pairing's Time Series (the default Modeled WSE Derivation Method, m5, when it was solved on the channel the default polygon version was built on; else the current method). The stage exits non-zero on any violation in the default method's newest version; a violation in another version is a warning. A depth-layout Time Series (m2–m5) is checked against its own `anchorBedElevationM`, not Stage 1's bed, and for a channel ribbon a value above the ladder ceiling is a warning (drawn at the top rung's width). |

## File layout

Browser-facing outputs are split per TNC flowline, keyed by its NHD 1:24K COMID, the part of the Creek Segment id before the dash. Each file keeps the single-file shape but holds only that flowline's Creek Segments:

- Polygons: `04-water-surface-polygons/<method-id>/v<version>/water-surface-polygon-sets/<tncComid>.json`.
- Monthly Time Series: `03-time-series/<method-id>/v<version>/time-series/<datasetId>/water-surface-elevation/<tncComid>.json`.
- Hourly Time Series: `03-time-series/<method-id>/v<version>/time-series/<datasetId>/water-surface-elevation/<tncComid>/WY<year>.json`.

These files are compact JSON with no indentation. Manifests, the catalog, the polygon ladders, the crosswalk, and the validation report stay indented. Stage 3 deletes only the Time Series folder of the version it is rewriting, so a removed flowline never lingers; other versions are never touched. Stage 4 deletes only the polygon set folder of the method version it is rewriting; other methods and versions are never touched. The catalog `paths` list every Time Series file relative to `03-time-series/`, starting with the version folder. Stage 5 checks that each file holds exactly one flowline and all of its Creek Segments, that every flowline has a Dataset's full timestamp list, and that every Creek Segment has exactly one polygon set across the polygon files.

Jalama has one flowline, so each output is one file. Compaction took polygons from 22.3 MB to 13.6 MB (−39%). The hourly Time Series went from 4.37 MB to 3.82 MB per full water year (−12.5%), and the monthly Time Series from 450 KB to 393 KB. Time Series save less because their value arrays were already on one line.

## Methods

Stages 0–3 run one **Modeled WSE Derivation Method** and Stage 4 runs one **WSE Polygon Generation Method**. Each method has its own folder with two files that belong together:

- `method-config.ts`: its identity (id, version) and every output-affecting value. Stage code imports these constants, and the fingerprint hashes them.
- `METHOD.md`: what the method does and why, written for a person or an LLM: inputs, steps, equations, parameter sources, assumptions, known limitations, and version history.

| Method | Kind | Stages | Description |
| --- | --- | --- | --- |
| `m1-drainage-area-ratio-manning-rating-curve` v1 | Modeled WSE Derivation Method | 0–3 | [METHOD.md](modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/METHOD.md): drainage-area ratio, Manning's equation, roughness sources, Drainage-Area Ratio Transfer, junction WSE |
| `m2-multi-section-manning-depth` v2 | Modeled WSE Derivation Method | 0–3 | [METHOD.md](modeled-wse-derivation-methods/m2-multi-section-manning-depth/METHOD.md): Manning's equation inverted for water depth at the middle (anchor) cross-section of each Creek Segment with a local bed slope; the junction depth is one smoothed number per shared vertex (mean of the neighbouring anchor depths within ±100 m) and the junction beds come from the first and last sections; drawn by `height-above-nearest-drainage-fill` |
| `m4-flowline-profile-variable-power-depth` v1 | Modeled WSE Derivation Method | 0–3 | [METHOD.md](modeled-wse-derivation-methods/m4-flowline-profile-variable-power-depth/METHOD.md): m3 v2 on m3 v2's channel with a steep-creek roughness, the Ferguson & Recking (2025) variable-power law (D84 assumed from slope) blended from Manning's n over 2–8% slope; drawn by `flowline-channel-ribbon` v2 through a channel pairing |
| `m5-flowline-profile-jarrett-depth` v1 | Modeled WSE Derivation Method | 0–3 | [METHOD.md](modeled-wse-derivation-methods/m5-flowline-profile-jarrett-depth/METHOD.md): m4 with Jarrett's (1984) roughness, n = 0.32 S^0.38 R^−0.16, which needs no grain size; drawn by `flowline-channel-ribbon` v2 through a channel pairing |
| `junction-sloped-terrain-fill` v1 | WSE Polygon Generation Method | 4 | [METHOD.md](wse-polygon-generation-methods/junction-sloped-terrain-fill/METHOD.md): polygon ladder, sloped wet threshold, bisector corridor ends, sloped drawing; the default until 2026-10-28 |
| `flowline-channel-ribbon` v2 (default) | WSE Polygon Generation Method | 4 | [METHOD.md](wse-polygon-generation-methods/flowline-channel-ribbon/METHOD.md): a ribbon of depth rungs along the raw lidar bed, built from m3 v2; drawn by default with m5 v1 through a channel pairing |
| `height-above-nearest-drainage-fill` v2 (experimental) | WSE Polygon Generation Method | 4 | [METHOD.md](wse-polygon-generation-methods/height-above-nearest-drainage-fill/METHOD.md): bed-parallel fill by height above nearest drainage, measured against a bed line traced on the 1 m lidar; bucket bounds are water depths and ring vertices carry the bed elevation as `[lon, lat, bedReferenceM]`; needs an m2 Time Series |

Each published version of a method becomes a Data-Product Version (`m<N>-v<N>`); see [data/README.md](../../../data/README.md#versioning).

Settings that are not part of a method (extents, folders, data-source endpoints, caches, the National Water Model window, and the catalog) stay in `pipeline-configuration.ts`.

- **National Water Model window:** WY2018–WY2023. A water year (WY) runs from Oct 1 through Sep 30. The v3.0 retrospective record ends Feb 1 2023 00:00 UTC, so `WY2023.json` covers only Oct 1 2022 through Feb 1 2023 and is not padded. Stage 0 records `lastWaterYearPartial` and warns.

## Modeled WSE Derivation Methods

A **Modeled WSE Derivation Method** is a named, versioned way to turn modeled discharge into a modeled WSE Time Series for each Creek Segment (Stages 0–3). The registry starts with one method, `m1-drainage-area-ratio-manning-rating-curve` v1, published as Data-Product Version `m1-v1`. Versions `m2-v1`, `m3-v1`, `m3-v2`, `m4-v1`, and `m5-v1` are frozen as Data-Product Versions, and each is published, or ready to publish, as its own private hosted service ([arcgis-publishing/README.md](../arcgis-publishing/README.md), section 1).

### Folder layout

```text
modeled-water-surface-elevation/modeled-wse-derivation-methods/
  modeled-wse-derivation-method.ts            config type and the m<N>-v<N> label (no pipeline code)
  modeled-wse-derivation-method-registry.ts   every method config and the current one
  <method-id>/                                m<N>-<plain descriptive kebab-case name>
    method-config.ts                          { id, methodNumber, version, label, description, changeType, changeNote,
                                                sharedCodeFiles, parameters } plus the constants Stages 0–3 import
    METHOD.md                                 the full human- and LLM-readable description
    time-series-derivation.ts                 the machine-readable summary written into catalog.json and version.json
```

### Version bump rule

Every change to a method's output-affecting code or parameters gets a new version. Stages 0–3 fingerprint the method: SHA-256 of every non-Markdown file in its folder, of each repository file listed in `sharedCodeFiles` (the Stage 0–3 code and everything it imports that can change output), and of its `parameters`. The fingerprint (`methodSha256`) and the full method record go into the Stage 3 manifest under `parameters.modeledWseDerivationMethod`. When `03-time-series/<method-id>/v<version>/` already holds output with a different fingerprint, **every stage from 0 to 5 stops**, even with `--force`, names the changed files, and asks for a bump: raise `version` in that method's `method-config.ts`, set `changeType` and a one-line `changeNote`, add a row to the method's METHOD.md version history, and rerun. Stage 3 then writes a new `v<version+1>/` folder and leaves the older one on disk, so both can coexist and be published side by side. A comment-only edit in a fingerprinted file also counts as a change; bump the version or revert the edit. Editing METHOD.md never needs a bump. The same fingerprint skips Stage 3 as before, unless its inputs changed, in which case that version is rewritten in place.

Stages 0–2 write to their own folders and skip on unchanged input files; they do not hash code. After a bump, rerun them with `--force` if you changed their code (`npm run pipeline:modeled-wse:all -- --force` does all six). Stage 4 and Stage 5 read the current version's Time Series and refuse to run unless it exists and matches the code.

**Which version a polygon version came from.** Stage 4 writes the modeled WSE version it read into its manifest as `parameters.builtFromModeledWseVersion` (`{ product, methodId, versionLabel, version, methodSha256 }`). The freeze step reads that record instead of a typed-in label. A new modeled WSE version therefore needs a Stage 4 rerun, and Stage 4 writes its polygon version folder again (same polygon method version, new source), after which the polygon method's version should be bumped too if you want to keep the old polygons for the old modeled version.

**Channel pairing: one polygon version drawn with another Time Series.** A polygon version normally draws only the Time Series it was built from. Methods that solve on another version's channel and change only the hydraulics (m4 and m5 on m3 v2's channel, which `flowline-channel-ribbon` v2 was built on) reuse those polygons instead of writing duplicates, because the ribbon's geometry depends only on the channel. To keep that honest:

- The method's Stage 3 rebuilds the channel with the m3 code in the working tree and refuses to run unless m3's current fingerprint equals the saved m3 v2 manifest's `methodSha256`; it then records that version as `parameters.channelFromModeledWseVersion` (`{ product, methodId, versionLabel, version, methodSha256 }`, the same record Stage 4 writes as `builtFromModeledWseVersion`).
- The dev middleware lists the channel source of each saved modeled WSE version (`channelFromModeledWsePath` in `wse-polygon-methods.json`) only while that source is still saved with the recorded fingerprint. The browser then offers every polygon version built from the source with this Time Series: Dev tools → Derived data products, or `?wsePolygonMethod=flowline-channel-ribbon@v2&modeledWse=m4-flowline-profile-variable-power-depth@v1`.
- Stage 4 is not rerun and the polygon version's manifest is unchanged: it still names the version it was built from. Stage 5 validates polygons against one Time Series, the default pairing's (below) unless `--modeled-wse-method=` names another.
- Freezing: m4 and m5 are frozen as their own modeled WSE Data-Product Versions (`m4-v1`, `m5-v1`). Their freeze reads `channelFromModeledWseVersion` to find the ribbon version built on that channel and takes each WSE Anchor Point from it; the ribbon is frozen once, as WSE polygons `m3-v2`, whose `built_from_modeled_wse_version` still names m3 v2. No separate polygon version is frozen for the m4 or m5 pairing.

**Default pairing.** `DEFAULT_MODELED_WSE_DERIVATION_METHOD_ID` (`m5-flowline-profile-jarrett-depth`, in `modeled-wse-derivation-method-registry.ts`) names the Time Series the browser draws on the default WSE Polygon Generation Method's newest version when the URL names neither `?wsePolygonMethod=` nor `?modeledWse=`, through a channel pairing; on `dangermond-preserve` that is `flowline-channel-ribbon` v2 drawn with m5 v1. An extent without m5 saved on that version's channel (for example `jalama-gauge-reach`) opens the polygons with their own Time Series. It is not the method Stages 0–3 run (`CURRENT_MODELED_WSE_DERIVATION_METHOD`, still m1). The production build opens the same pairing from the hosted services (modeled WSE `m5-v1`, WSE polygons `m3-v2` and its exact-rings service); see [arcgis-publishing/README.md](../arcgis-publishing/README.md).

**Files saved before UCS-296.** Output written to the flat `03-time-series/` layout is moved into its version folder by `migrate-modeled-wse-version-folders.ts` (see [data/README.md](../../../data/README.md#migrating-an-old-checkout)); every stage tells you to run it when it finds the flat layout.

## WSE Polygon Generation Methods

A **WSE Polygon Generation Method** is a named, versioned way to turn modeled water-surface elevations into the water polygons drawn for each Creek Segment. Each version keeps its own saved output, so methods can be compared on the map. Stages 0–3 (terrain, cross-sections, rating curves, Time Series) are shared by every method; only Stage 4 differs. The registry starts with one method:

| Method id | Label | Version | Browser drawing |
| --- | --- | --- | --- |
| `junction-sloped-terrain-fill` | Junction-sloped terrain fill | 1 | Sloped between junction WSEs (the default until 2026-10-28) |
| `flowline-channel-ribbon` (default) | Flowline channel ribbon | 2 | Depth rungs along the raw bed, pool-filled water surface (`channel-ribbon-pool-filled`) |
| `height-above-nearest-drainage-fill` (experimental) | Height above nearest drainage (bed-parallel) fill | 2 | Bed-parallel: each vertex at its bed reference plus the modeled depth (`bed-parallel-depth`) |

[`junction-sloped-terrain-fill` METHOD.md](wse-polygon-generation-methods/junction-sloped-terrain-fill/METHOD.md) describes what v1 does, its assumptions, and its version history.

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
    METHOD.md                                 the full human- and LLM-readable description
    generate-water-surface-polygons.ts        the method's code

data/pipeline-working-output/<extentId>/04-water-surface-polygons/
  <method-id>/v<version>/
    manifest.json                             parameters.wsePolygonGenerationMethod records id, label, version, description,
                                              browserDrawing, parameters, codeSha256ByFile, and methodSha256
    water-surface-polygon-ladders.json
    water-surface-polygon-sets/<tncComid>.json
```

`browserDrawing` tells the browser how to draw the method's polygons at the selected time: `sloped-between-junctions` lifts every ring vertex between the segment's two junction WSEs (`sloped-water-surface.ts`), and `flat-at-bucket-minimum` draws the polygon flat at its bucket minimum. Files left directly in `04-water-surface-polygons/` by the layout before methods existed (`manifest.json`, `water-surface-polygon-ladders.json`, `water-surface-polygon-sets/`) are ignored by Stage 5 and the browser, and can be deleted once nothing older reads them.

### Version bump rule

Every change to a method's output-affecting code or parameters gets a new version. Stage 4 fingerprints the method: SHA-256 of every file in its folder except Markdown (editing METHOD.md never needs a bump), of each repository file listed in `sharedCodeFiles` (for `junction-sloped-terrain-fill`, `water-surface-polygon-generation.ts`), and of its `parameters` and `browserDrawing`. The fingerprint (`methodSha256`) goes into the version's manifest. When `04-water-surface-polygons/<method-id>/v<version>/` already holds output with a different fingerprint, Stage 4 stops, even with `--force`, names the changed files, and asks for a bump: raise `version` in that method's `method-config.ts` and rerun. Stage 4 then writes a new `v<version+1>/` folder and leaves the older one on disk, so both can be compared on the map. A comment-only edit in a fingerprinted file also counts as a change; bump the version or revert the edit. The same fingerprint skips the stage as before, unless the Stage 0–3 inputs changed, in which case that version is rewritten in place.

### Adding a method

1. Copy `wse-polygon-generation-methods/junction-sloped-terrain-fill/` to `wse-polygon-generation-methods/<new-method-id>/`, using a plain descriptive kebab-case id that is never reused for anything else.
2. Rewrite its METHOD.md. In its `method-config.ts`, set `id`, `label`, `version: 1`, a one- or two-sentence `description`, `browserDrawing`, `sharedCodeFiles`, and `parameters`. Change the generator; it receives the shared Stage 0–3 inputs (`WsePolygonMethodInputs`) and returns polygon sets, a ladder summary, counts, and warnings (`WsePolygonMethodResult`). Stage 5 checks that every Creek Segment has one polygon set and that every modeled value is at or below the ladder's `ceilingM`.
3. Register the config in `wse-polygon-generation-method-registry.ts` and the generator in `wse-polygon-generation-method-generators.ts`.
4. Run `npm run pipeline:modeled-wse:water-surface-polygons -- --extent=jalama-gauge-reach --wse-polygon-method=<new-method-id>`, then `npm run pipeline:modeled-wse:catalog-and-validate -- --extent=jalama-gauge-reach`.
5. Open the modeled experience on the development server with `?devtools=1` and choose the method in Dev tools → Dataset and time → **Polygon method**, or open `?wsePolygonMethod=<new-method-id>@v1` directly. A production build ignores `?devtools` unless `VITE_SHOW_DEV_TOOLS=true`.

Change `DEFAULT_WSE_POLYGON_GENERATION_METHOD_ID` (or `DEFAULT_MODELED_WSE_DERIVATION_METHOD_ID`) only when the new method should become what the browser opens and what Stage 5 fails on; that decision changes what the Feature Behavior Tests check. On 2026-10-28 Will made `flowline-channel-ribbon` the default polygon method, drawn with m5, because its raw-bed ribbon with Jarrett's slope-dependent roughness keeps steep-creek water on the ground the map draws.

### Browser

The dev middleware serves `/modeled-water-surface-elevation-data/<extent>/wse-polygon-methods.json`, the saved method versions read from each version's manifest, plus a computed `flowline-index.json` inside every version folder. The modeled experience opens the default pairing (the newest version of the default method, drawn with the default Modeled WSE Derivation Method when that was solved on its channel), or the version named by `?wsePolygonMethod=<method-id>@v<version>` (`<method-id>` alone means its newest version; an unknown value falls back to the default with a console warning). The dev tools **Polygon method** select switches the drawn version live, keeping the camera and the selected time, shows its label and description, and writes the choice to the URL. Copy all JSON includes `wsePolygonMethod` and `wsePolygonMethodLabel` in its `dataset` object.

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
