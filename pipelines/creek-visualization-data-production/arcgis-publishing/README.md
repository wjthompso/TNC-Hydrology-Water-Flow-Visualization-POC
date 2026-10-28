# Publishing and updating the hosted ArcGIS data products

This folder holds the scripts that freeze pipeline output as a **Data-Product Version** and publish it to ArcGIS Enterprise (UCS-285). This page says what the scripts do **today**. Where a step is missing, it says so and gives the manual route.

Terms: a **Data-Product Version** is one frozen, append-only copy of a data product, labeled `m<method number>-v<version number>` (for example `m1-v1`). See [glossary.md](../../../docs/architecture/glossary.md) for **Held WSE Interval**, **Modeled WSE Derivation Method**, **WSE Polygon Generation Method**, **Discharge (Flow Rate) Source**, **Creek Segment**, and **Prepared water-surface polygon**. WSE means water-surface elevation, in meters NAVD88 (North American Vertical Datum of 1988). ArcGIS Enterprise is Esri's self-hosted GIS server, here at `https://dangermondpreserve-spatial.com/portal`. A hosted feature layer is a queryable web service of tables and map layers. CSV means comma-separated values (plain text table).

## 1. What this publishes

Everything lives in the portal folder **Creek Water Visualization**. Ids below are public, copied from [data-product-version-registry.json](../../../data/data-product-version-registry.json).

### Two hosted feature layers (both public)

| | Modeled WSE service | WSE Polygons service |
| --- | --- | --- |
| Service name | `creek_water_visualization_modeled_wse` | `creek_water_visualization_wse_polygons` |
| Public title | Dangermond Preserve — Inferred Creek Water Surface Elevations | Dangermond Preserve — Creek Water Outlines |
| Item id | `a1cbf72906f44070a01930ddb3e9d1f3` | `991d2270a8d74b30bfe8862a764226b9` |
| Service URL | `https://dangermondpreserve-spatial.com/server/rest/services/Hosted/creek_water_visualization_modeled_wse/FeatureServer` | `https://dangermondpreserve-spatial.com/server/rest/services/Hosted/creek_water_visualization_wse_polygons/FeatureServer` |
| Version published | `m1-v1`, 2026-10-21 | `m1-v1`, 2026-10-21 |
| Private source upload (file geodatabase item) | `a5bda4fe0cb6459a8282cc4c3e79ba97` | `cd49840b848b47fb9f61712afaf10bf1` |

The file geodatabase item is the zip the layer was published from. It stays private.

**Modeled WSE service** (`m1-v1` of the Modeled WSE Derivation Method `m1-drainage-area-ratio-manning-rating-curve`):

| Id | Name | Kind | Rows | What it holds |
| --- | --- | --- | --- | --- |
| 0 | `modeled_wse_m1_v1_creek_segments` | line layer | 3,338 | One line per Creek Segment, with its flowline, length, flow direction, neighbours, junction ids, and drainage-area numbers. |
| 1 | `modeled_wse_m1_v1_cnf_monthly_held_intervals` | table | 2,512,927 | California Natural Flows monthly WSE as Held WSE Intervals: one row per stretch of time the value stays constant, per Creek Segment and per junction. |
| 2 | `modeled_wse_m1_v1_cnf_monthly_values` | table | 3,004,200 | The same monthly WSE as one plain row per Creek Segment per month, with junction WSE at both ends. |
| 3 | `modeled_wse_m1_v1_nwm_hourly_held_intervals` | table | 2,642,107 | National Water Model hourly WSE (water years 2021–2023) as Held WSE Intervals. |
| 4 | `modeled_wse_versions` | table | 1 | One row per Data-Product Version: status, method, code fingerprint, derivation text, publish time. |

**WSE Polygons service** (`m1-v1` of the WSE Polygon Generation Method `junction-sloped-terrain-fill`, built from modeled WSE `m1-v1`):

| Id | Name | Kind | Rows | What it holds |
| --- | --- | --- | --- | --- |
| 0 | `wse_polygons_m1_v1` | polygon layer (WKID 4326) | 101,124 | One Prepared water-surface polygon per non-empty elevation bucket of each Creek Segment. The browser picks the bucket that holds the modeled WSE at the selected time. |
| 1 | `wse_polygon_versions` | table | 1 | One row per Data-Product Version, as above. |

WKID (well-known ID) 4326 is the latitude/longitude coordinate system WGS 84. Counts above were confirmed live on 2026-10-22 (section 6).

### Three zipped raw hourly CSV items (public, not layers)

Every hourly modeled WSE value for every Creek Segment, one zipped CSV per water year (WY, October 1 to September 30).

| Water year | Item id | Rows in the CSV |
| --- | --- | --- |
| WY2021 | `e6c9cd92e05f4fb1895294be9c03f748` | 29,240,880 |
| WY2022 | `68e9a0dd34d7489a8d1704561486e7c3` | 29,240,880 |
| WY2023 | `d60bb6a0b0794d239744512358a93123` | 9,857,114 |

Row counts come from the local `version.json` written by the freeze. The portal item type is `CSV Collection`.

Sharing today: the two services and three CSV items are public (`everyone`). The two file geodatabase items are private. Since 2026-10-28 the browser's production build no longer opens these two services by default (next section); the observed Jalama gauge experience still reads them.

### The production default: m5-v1 on the m3-v2 ribbon (public since 2026-10-28)

With no environment variable, the production build opens WSE polygons `m3-v2` (the channel ribbon) drawn with modeled WSE `m5-v1` (Jarrett steep-creek roughness, solved on m3-v2's channel), the same default pairing as the development server. Three services feed it, all **public (Everyone)**, Query-only:

| Role | Service name | Service item | What the browser reads |
| --- | --- | --- | --- |
| Modeled WSE `m5-v1` | `creek_water_visualization_modeled_wse_m5_v1` | [`74a40189cae34caaa1a96ee877a29d32`](https://dangermondpreserve-spatial.com/portal/home/item.html?id=74a40189cae34caaa1a96ee877a29d32) | Creek Segments (with the anchor and junction beds), Held WSE Intervals (WSE and both junction depths), the versions row |
| WSE polygons `m3-v2` | `creek_water_visualization_wse_polygons_m3_v2` | [`eb16de9e9196430698645036f0a4417c`](https://dangermondpreserve-spatial.com/portal/home/item.html?id=eb16de9e9196430698645036f0a4417c) | the versions row and the `…_channel_ribbons` table; not the polygon layer's geometry |
| Exact ribbon rings for `m3-v2` (supplementary) | `creek_water_visualization_wse_polygons_m3_v2_rings` | [`e3f2fd43751a417695dd7ea5d7afb159`](https://dangermondpreserve-spatial.com/portal/home/item.html?id=e3f2fd43751a417695dd7ea5d7afb159) | table 0 `wse_polygons_m3_v2_rings`, 63,365 rows: `segment_id`, `bucket_index`, `min_depth_m`, `max_depth_m`, `ring_json` (the station-ordered ring with bed z, exactly as Stage 4 wrote it) |

**Why a rings service.** ArcGIS stores only simple rings, so on publishing it split the 3,197 `m3-v2` ribbon outlines that cross themselves into pieces and lost their station order (section 5, "Schema of a channel-ribbon polygon version"). The ribbon drawing needs that order, so the browser reads each ring as text from the rings table instead. The polygon layer stays as published, for map use. `freeze_wse_polygon_rings.py` (`data-products:freeze-wse-polygon-rings`) builds the table from the Stage 4 files after proving them equal to the frozen `m3-v2` source hashes and the frozen file geodatabase rings (63,005 identical, 360 stored reversed by the geodatabase writer, 0 different); it writes the additive folder `data/data-product-versions/wse-polygons/m3-flowline-channel-ribbon/m3-v2-rings/`. `publish_wse_polygon_rings_service.py` (`data-products:publish-wse-polygon-rings`) publishes it as its own service and adds its ids to the `m3-v2` registry record under `arcgis.exact_rings_service`. File geodatabase item `762b2c0c5d404e7eb1c0c015642e51ef`, private.

**What is public and what is not.** `share_default_pairing_services.py` (`data-products:share-default-pairing-services`, dry run without `--publish`) shared exactly these three service items with Everyone on 2026-10-28, put a plain-language description above the technical one, saved the public item text in [item-metadata/](item-metadata/) (`modeled-wse-m5-v1-service.json`, `wse-polygons-m3-v2-service.json`, `wse-polygons-m3-v2-rings-service.json`), and recorded `public_sharing` (before and after) in each registry record. Their file geodatabase items and the `m5-v1` raw hourly CSV items stay private, as does every other later version.

**Repointing production.** `VITE_MODELED_WSE_SERVICE_URL` and `VITE_WSE_POLYGONS_SERVICE_URL` choose the two services; set them together. `VITE_WSE_POLYGON_RINGS_SERVICE_URL` defaults to the polygons service name plus `_rings` and is read only for channel-ribbon versions. To reopen the first published version (`m1-v1`, junction-sloped), set the two URLs to `creek_water_visualization_modeled_wse` and `creek_water_visualization_wse_polygons` (see the browser's `.env.example`). Hosted layer ids and table names come from each service's layer list, so no id is configured.

**Equality check.** `npm run data-products:verify-hosted-default-modeled-data` (section 6) rebuilds the default pairing through the browser's hosted adapters and compares it with the local working output; add `-- --anonymous` to prove the services are readable without signing in.

### One service per later version (2026-10-27)

Every version after `m1-v1` gets its own hosted service, published by `data-products:publish-arcgis-version` (section 5, "Generic commands"). These items are **private** (owner only) and Query-only, except the three default-pairing services above, which were made public on 2026-10-28. Ids are also in the registry under each version's `arcgis` record.

| Version | Service name | Service item | File geodatabase item | Layer id, name, rows | State |
| --- | --- | --- | --- | --- | --- |
| WSE polygons `m2-v1` (HAND, built from modeled `m2-v1`) | `creek_water_visualization_wse_polygons_m2_v1` | `a017262235664344bf6cdb51ecf386a9` | `d6066021b79e4b6694217244cc844138` | 0 `wse_polygons_m2_v1` 117,361; 1 `wse_polygon_versions` 1 | published, verified |
| WSE polygons `m3-v1` (channel ribbon, built from modeled `m3-v1`) | `creek_water_visualization_wse_polygons_m3_v1` | `8a4d3ba24e084661aa65f8f586d284f4` | `ba4117d33e2d4d7f8168a678ca0d9dbc` | 0 `wse_polygons_m3_v1` 63,365; 1 `wse_polygon_versions` 1; 2 `wse_polygons_m3_v1_channel_ribbons` 3,335 | published, verified |
| WSE polygons `m3-v2` (channel ribbon, built from modeled `m3-v2`; also draws `m4-v1` and `m5-v1`) | `creek_water_visualization_wse_polygons_m3_v2` | `eb16de9e9196430698645036f0a4417c` | `b33ee56fc0294ed6be919f58478ee3d4` | 0 `wse_polygons_m3_v2` 63,365; 1 `wse_polygon_versions` 1; 2 `wse_polygons_m3_v2_channel_ribbons` 3,335 | published, verified; **public** since 2026-10-28 (production default) |
| Exact rings of WSE polygons `m3-v2` | `creek_water_visualization_wse_polygons_m3_v2_rings` | `e3f2fd43751a417695dd7ea5d7afb159` | `762b2c0c5d404e7eb1c0c015642e51ef` | 0 `wse_polygons_m3_v2_rings` 63,365 | published 2026-10-28; **public** (production default) |
| Modeled WSE `m2-v1` | `creek_water_visualization_modeled_wse_m2_v1` | `2d1d8d11c06b4b1a943d075ecc7baae9` | `80961efac0f2476ca46c5f19b7d29a83` | 0 `…_creek_segments` 3,338; 1 `…_cnf_monthly_held_intervals` 1,352,759; 2 `…_cnf_monthly_values` 3,004,200; 3 `…_nwm_hourly_held_intervals` 1,426,933; 4 `modeled_wse_versions` 1 | **incomplete**: the service is up with the frozen row counts, but the raw hourly CSV upload failed (file name already used by `m1-v1`'s CSV item), so no CSV items, versions-table row unfilled, ids not in the registry. Finish with `--resume-from-items 80961efac0f2476ca46c5f19b7d29a83,2d1d8d11c06b4b1a943d075ecc7baae9` |
| Modeled WSE `m3-v1`, `m3-v2`, `m4-v1`, `m5-v1` | `creek_water_visualization_modeled_wse_<label>` | `m3-v1` `fc1a015b5735488f8dc05b71267fd0c5`, `m3-v2` `ae84ac31e2614aa18ca3e168ed400d9b`, `m4-v1` `3f4adb92e4cf400a884d021483856b31`, `m5-v1` `74a40189cae34caaa1a96ee877a29d32` | `5c29922f0342479b973287faadd1260c`, `76ce5fed8ea946ec97af101b7fb97ed4`, `241150cabc5c491eb21583618db72f92`, `b7ceb2343e7642b793072449b2bd88e0` | same five layers as `m2-v1`, renamed with the label; row counts in the registry | published; `m5-v1` **public** since 2026-10-28 (production default), the others private |

Service URLs follow `https://dangermondpreserve-spatial.com/server/rest/services/Hosted/<service name>/FeatureServer`. For a private one, an anonymous `curl` returns an error; sign in, or use `data-products:verify-arcgis-version` (section 6).

## 2. Prerequisites

1. **Conda environment** with `arcgis`, `pyogrio`, `pyarrow`, `shapely`, `numpy`, and `python-dotenv`. The npm scripts use `../../Data-Pipeline/conda-env`. Override the path with `ARCGIS_PYTHON_ENV`.
2. **Credential file** outside this repository: `../../Data-Pipeline/.env`. Override the path with `ARCGIS_DOTENV_PATH`. It must define three variables, by name only:
   - `ARCGIS_URL` (the portal address)
   - `ARCGIS_USERNAME`
   - `ARCGIS_PASSWORD`

   Never copy values into the repo, chat, tickets, or logs. The scripts never print them.
3. **Portal role**: an org administrator, or a role with the privileges `portal:user:createItem` and `portal:publisher:publishFeatures`.
4. **Pipeline working output** under `data/pipeline-working-output/dangermond-preserve/` (git-ignored). Section 3, step 1 produces it.
5. **Ask Dan** if Enterprise publishing is blocked: a sign-in failure, a missing privilege, or a server error that does not clear on retry.

Freeze and validate scripts are local only. Only `data-products:publish-arcgis --publish`, the verify command for modeled data, and the portal snippets in section 4 talk to the portal as a signed-in user.

## 3. Publish a first version, step by step

Run everything from the repository root. The example is `m1-v1`. Times were observed on 2026-10-21 on one machine.

1. **Run the pipeline stages** that produce the working output. Each stage writes a `manifest.json` and skips itself when its inputs are unchanged.

   ```sh
   npm run pipeline:modeled-wse:all -- --extent=dangermond-preserve
   ```

   This runs Stages 0–5 (acquire, cross-sections, rating curves, time series, water-surface polygons, catalog and validate). [METHODOLOGY.md](../modeled-water-surface-elevation/METHODOLOGY.md) lists each stage and its single-stage command. A cold run needs the network and took about 14 minutes plus about 4 minutes of first-run flow-accumulation sampling (METHODOLOGY.md). Modeled WSE needs Stages 0–3; the polygon freeze also needs Stage 4.

2. **Freeze modeled WSE.** Copies the Stage 0–3 output into `data/data-product-versions/modeled-wse/m1-drainage-area-ratio-manning-rating-curve/m1-v1/` and adds the version to the registry with empty ArcGIS fields. It also builds the zipped file geodatabase (`arcgis-upload/modeled-wse-m1-v1.gdb.zip`), the three raw hourly CSV zips, `creek-segment-network.json`, copies of the stage manifests, and `version.json`. About 2 minutes.

   ```sh
   npm run data-products:freeze-modeled-wse
   ```

   It refuses if the version folder or a different registry record already exists. A failed run deletes its staging folder, so no half-written version remains. For a scratch trial, add `-- --trial-folder=/tmp/modeled-wse-trial --only-tnc-comids=27714637` (the registry stays untouched).

3. **Validate modeled WSE.** Reads the geodatabase and CSVs back and compares every value with the Stage 3 JSON: hourly and monthly arrays, junction series, 3,338 Creek Segments, field types, text widths, and EPSG:4326. Exits nonzero on any failure.

   ```sh
   npm run data-products:validate-modeled-wse
   ```

4. **Freeze WSE polygons.** Checks the Stage 4 files against the Stage 4 manifest, then assembles one Prepared water-surface polygon per non-empty bucket. Expect 101,124 features from 102,607 buckets (1,483 empty buckets skipped). It writes `data/data-product-versions/wse-polygons/m1-junction-sloped-terrain-fill/m1-v1/` and updates the registry. It stops if the method code changed since Stage 4 ran. Add `-- --dry-run-into=<new scratch folder>` to leave the registry alone.

   ```sh
   npm run data-products:freeze-wse-polygons
   ```

5. **Validate WSE polygons.** Compares counts, attributes, ring coordinates (1e-7 degrees tolerance), and geometry validity with the Stage 4 source. Exits nonzero on a failed check.

   ```sh
   npm run data-products:validate-wse-polygons
   ```

6. **Dry-run the publish.** Prints the plan, the geodatabase contents with row counts, and each CSV size. Writes nothing to the portal.

   ```sh
   npm run data-products:publish-arcgis -- --product modeled-wse --version m1-v1
   npm run data-products:publish-arcgis -- --product wse-polygons --version m1-v1
   ```

7. **Publish for real.** Without `--publish` nothing is written.

   ```sh
   npm run data-products:publish-arcgis -- --product modeled-wse --version m1-v1 --upload-raw-csv --publish
   npm run data-products:publish-arcgis -- --product wse-polygons --version m1-v1 --publish
   ```

   Observed: about 12 minutes for modeled WSE (with raw CSVs), about 2 minutes for polygons. The script:
   1. Signs in and checks the service name is free.
   2. Gets or creates the portal folder **Creek Water Visualization**.
   3. Uploads the file geodatabase item and publishes it as a hosted feature layer (`maxRecordCount` 10000, Query-only).
   4. Sets title, snippet, description, tags, access information, and license text on the service item.
   5. Adds attribute indexes, and time settings on the Held WSE Interval tables.
   6. Prints each layer's id and row count.
   7. With `--upload-raw-csv`, uploads the CSV zips.
   8. Fills the versions-table row and the registry with the ids.

   Compare the printed row counts with section 1.

### Known first-run caveats

- **The script publishes PRIVATE.** The service item stays owner-only. Section 4 makes it public.
- **The versions-table row is filled after publishing.** The frozen upload holds `published_at_utc` and the CSV item ids as empty values. The script edits that one row afterwards (it briefly allows Update on the Query-only service, then restores Query). If the edit fails it prints `versions table update error`; the registry is still written.
- **Attribute index names must be unique across the whole hosted data store.** The script names each `ix_<6-character hash of the table name>_<field>`, cut to 30 characters. A name collision makes ArcGIS reject the index. Index failures are printed as notes and do not stop the run.
- **A failed run deletes nothing.** It prints the item ids it created. Inspect them in the portal.
- **Registry ids for layers.** `versions_table_layer_id` and `polygon_layer_id` in the polygon registry entry stay `null`. The ids are in `layer_ids`.

## 4. Make it public and set the item text

**Gap:** the publish script leaves items private and writes technical placeholder text (the snippet says "Private until the Creek Water Visualization experience is released"). On 2026-10-21/22 the items were made public and given plain-language titles and descriptions by one-off scripts that are **not in this repository**. Do this by hand, or with the snippets below. The snippets are copy-paste starting points; they were not run from this repository, so test on a throwaway item first.

### Manual route (portal website)

1. Sign in to the portal and open **Content**, then the folder **Creek Water Visualization**.
2. Open the item. Choose **Share**, then **Everyone (public)**, then **Save**.
3. Choose **Edit** next to the title or summary. Set the title, summary, description, tags, terms of use, and credits to the text in [item-metadata/](item-metadata/).
4. Do not share the file geodatabase items.

The per-version services published on 2026-10-27 (section 1) and their raw hourly CSV items are private. Their titles and snippets are plain language, and each snippet ends with "Experimental, private." To make one public, share the service item and its CSV items as above and edit the snippet so it no longer says private. Their item text is not saved in [item-metadata/](item-metadata/); that folder mirrors the public `m1-v1` items only.

### Python route

```python
import os
from arcgis.gis import GIS
from dotenv import load_dotenv

load_dotenv(os.environ["ARCGIS_DOTENV_PATH"])  # absolute path to the credential file
gis = GIS(os.environ["ARCGIS_URL"], os.environ["ARCGIS_USERNAME"], os.environ["ARCGIS_PASSWORD"])
print("Signed in as", gis.users.me.username)  # never print the password

item = gis.content.get("<itemId>")  # an id from section 1
item.sharing.sharing_level = "EVERYONE"  # make it public
item.update(item_properties={
    "title": "…",
    "snippet": "…",              # the one-sentence summary
    "description": "<p>…</p>",   # HTML
    "tags": ["…"],
    "accessInformation": "…",    # shown as Credits
    "licenseInfo": "…",          # shown as Terms of use
})
```

### Saved public item text

The current public wording of the five public items is saved as JSON in [item-metadata/](item-metadata/), fetched anonymously on 2026-10-22 from `https://dangermondpreserve-spatial.com/portal/sharing/rest/content/items/<itemId>?f=json`. The description HTML is kept exactly as the portal returned it.

| File | Item |
| --- | --- |
| [modeled-wse-service.json](item-metadata/modeled-wse-service.json) | Modeled WSE service |
| [wse-polygons-service.json](item-metadata/wse-polygons-service.json) | WSE Polygons service |
| [raw-hourly-csv-WY2021.json](item-metadata/raw-hourly-csv-WY2021.json) | Raw hourly CSV, WY2021 |
| [raw-hourly-csv-WY2022.json](item-metadata/raw-hourly-csv-WY2022.json) | Raw hourly CSV, WY2022 |
| [raw-hourly-csv-WY2023.json](item-metadata/raw-hourly-csv-WY2023.json) | Raw hourly CSV, WY2023 |

**These files mirror the portal. Update them in both places**: edit the item on the portal and edit the file here in the same change. Nothing syncs them automatically.

## 5. Update flow: publishing a new Data-Product Version

### Which number to bump

Rules from [data/README.md](../../../data/README.md):

- **Method number `m<N>`** changes when the idea changes: a different approach, not a fix or a new setting.
- **Version `v<N>`** increments on any change that affects output: an implementation fix or a parameter change. Examples: `m1-v2`, `m2-v1`.
- Record `change_type` (new method, implementation fix, or parameter change) and a one-line `change_note`.
- A new modeled WSE version needs new WSE polygon versions built from it. A new WSE polygon version can reuse an existing modeled WSE version.

### Steps

1. **Change the code or parameters.** Raise `version` in the method's `method-config.ts` (for a Modeled WSE Derivation Method, also set `changeType` and `changeNote`, and add a row to its METHOD.md version history). Stages 0–5 stop and ask for the bump when the method fingerprint changed ([METHODOLOGY.md](../modeled-water-surface-elevation/METHODOLOGY.md), "Version bump rule").
2. **Rerun the pipeline stages** (section 3, step 1), with `--force` for Stages 0–2 if you changed their code. Stage 3 writes the new version to its own `03-time-series/<method-id>/v<N>/` folder; the older version stays beside it. A new modeled WSE version also needs a polygon method version bump, so Stage 4 keeps the old polygons beside the new ones. The frozen `m1-v1` copy under `data/data-product-versions/` is not touched. That folder is git-ignored, so it exists only on the machine that froze it.
3. **Point the freeze scripts at the new label.** The freeze reads the method's identity, change type, change note, fingerprint, and (for polygons) the modeled WSE version it was built from out of the stage manifests (UCS-296). The label and the ArcGIS names are still written in the code (next section), and parameterizing them is [UCS-298](https://linear.app/ucsb-spatial-center/issue/UCS-298/add-a-new-data-product-version-to-an-existing-hosted-service-without). For the m1 scripts, edit those places, then run the freeze commands; for any later version use the generic commands ("Generic commands" below), which need no edit. A freeze refuses to write over an existing label, and refuses when the method code changed since the stage ran.
4. **Validate** (section 3, steps 3 and 5). The validators import the same constants, so they follow the edit.
5. **Dry-run the publish** with the new `--version`.
6. **Publish.** `data-products:publish-arcgis` **refuses** a new version ("What the publish script does when the service already exists" below). Do not run it with `--publish` for a new version against the existing service. Publish the new version as its own service with `data-products:publish-arcgis-version` ("Generic commands" below).

### Hard-coded `m1-v1` places (verified in code)

| File | Hard-coded |
| --- | --- |
| `modeled_wse_version_layout.py` | `METHOD_ID`, `METHOD_NUMBER`, `VERSION_NUMBER`, `VERSION_LABEL`, `ARCGIS_PREFIX` (`modeled_wse_m1_v1`, which names every layer and table), the literal `UPLOAD_GDB_ZIP_NAME` (`modeled-wse-m1-v1.gdb.zip`), and `SERVICE_TITLE` / `SERVICE_NAME`. Version folder and table names derive from these. |
| `freeze_modeled_wse_version.py` | `STATUS`, `DERIVATION_SUMMARY`, and the docstring. The change type, change note, fingerprint, and code-file list come from the Stage 3 manifest. |
| `freeze_wse_polygons_version.py` | `PRODUCT`, `METHOD_ID`, `METHOD_NUMBER`, `VERSION_NUMBER`, `VERSION_LABEL`, `ARCGIS_PREFIX`, `CHANGE_NOTE`, `CHANGE_TYPE`, `PIPELINE_METHOD_ID`, `PIPELINE_METHOD_VERSION`, `SERVICE_TITLE` / `SERVICE_NAME`, `UPLOAD_ZIP_NAME`. The modeled WSE version it was built from comes from the Stage 4 manifest. |
| `validate_wse_polygons_version.py` | `EXPECTED_NON_EMPTY_BUCKETS` (`102_607 - 1_483`) and `GAUGE_CREEK_SEGMENT_EXPECTED_BUCKETS` (137): counts that change when the output changes. |
| `validate_modeled_wse_version.py` | `EXPECTED_SEGMENT_COUNT` (3,338) through the layout file. |
| `publish_data_products_to_arcgis.py` | The `PRODUCTS` table fixes each product's `method_id` to the `m1-…` method. Another `v` of the same method works with `--version`; a new method number (`m2`) needs this table edited, so even a dry run of `m2-v1` stops (it looks for the version folder under the `m1-…` method folder). The publish script also assumes the m1 table names and columns. It still cannot publish `m2-v1` or later; `publish_data_product_version_service.py` publishes those, each as its own service. |
| Browser and checks | `creek-data-source-configuration.ts` holds `m1_v1` table names and fallback layer ids. `scripts/verify-hosted-modeled-data-equivalence.ts` reads the `m1-…/v1` Stage 3 folder and the `junction-sloped-terrain-fill/v1` Stage 4 folder. |

### m2-v1 uses separate freeze scripts

The table above describes the m1 scripts, which stay hard-coded to `m1-v1` and are unchanged. `m2-v1` (the `m2-multi-section-manning-depth` modeled WSE and the `m2-height-above-nearest-drainage-fill` polygons) was frozen by separate scripts that import the generic helpers from the m1 ones, so nothing m1 depends on moves. It was published on 2026-10-27 by the generic publish command (next section):

| Command | Script | What differs from m1 |
| --- | --- | --- |
| `npm run data-products:freeze-modeled-wse-m2` | `freeze_modeled_wse_m2_version.py` (names in `modeled_wse_m2_version_layout.py`, source reader `modeled_wse_m2_source_series.py`) | Creek Segments layer adds `anchor_longitude`, `anchor_latitude`, `anchor_bed_elevation_m`, `junction_bed_upstream_m`, `junction_bed_downstream_m`. Held WSE Interval tables are per Creek Segment (no junction rows) and hold `wse_m` plus `junction_depth_upstream_m` and `junction_depth_downstream_m`; an interval ends when any of the three changes. Junction WSE is not stored: it is junction bed + junction depth, rounded to 3 decimals. |
| `npm run data-products:validate-modeled-wse-m2` | `validate_modeled_wse_m2_version.py` | Expected counts come from `version.json` and the Stage 3 manifest. Rebuilds all three time-varying arrays and the junction WSE for every segment and time step. |
| `npm run data-products:freeze-wse-polygons-m2` | `freeze_wse_polygons_m2_version.py` | Layer `wse_polygons_m2_v1` is `MultiPolygon Z`. Columns are `min_depth_m` / `max_depth_m` (water **depths**, not elevations). Z is the local bed elevation (m NAVD88); the browser draws at Z + depth (`browserDrawing` `bed-parallel-depth`). `version.json` records all three. |
| `npm run data-products:validate-wse-polygons-m2` | `validate_wse_polygons_m2_version.py` | Expected counts come from the Stage 4 manifest. Compares Z as well as longitude and latitude. |

The m2 method code was committed after Stage 3 and Stage 4 ran, so the freeze records the earliest commit whose copies of the method files match the hashes the stages recorded, not a commit at or before `completedAt`.

### Generic commands: any version as its own service

Since 2026-10-27 every version after `m1-v1` is frozen, validated, and published by six method-agnostic commands. They take the method and the version label, read every fact (identity, change type and note, fingerprint, counts, the modeled WSE version a polygon version was built from) from the stage manifests, and derive every name from the label in `data_product_version_identity.py`. No code edit is needed for a new version. Because no code path adds a version to an existing service ([UCS-298](https://linear.app/ucsb-spatial-center/issue/UCS-298/add-a-new-data-product-version-to-an-existing-hosted-service-without)), **each version gets its own hosted service**, named `creek_water_visualization_modeled_wse_<label>` or `creek_water_visualization_wse_polygons_<label>` with underscores (`m4-v1` → `creek_water_visualization_modeled_wse_m4_v1`). The m1 and m2 scripts and commands are unchanged.

```sh
# Modeled WSE (depth-style methods m2–m5): freeze, validate
npm run data-products:freeze-modeled-wse-version -- --method m4-flowline-profile-variable-power-depth --version m4-v1
npm run data-products:validate-modeled-wse-version -- --method m4-flowline-profile-variable-power-depth --version m4-v1
# WSE polygons (depth-bucket methods): --method is the Stage 4 method id; the label's method number comes from the registry
npm run data-products:freeze-wse-polygons-version -- --method flowline-channel-ribbon --version m3-v2
npm run data-products:validate-wse-polygons-version -- --method flowline-channel-ribbon --version m3-v2
# Publish: dry run, then for real; then the read-only check
npm run data-products:publish-arcgis-version -- --product modeled-wse --version m4-v1 --upload-raw-csv
npm run data-products:publish-arcgis-version -- --product modeled-wse --version m4-v1 --upload-raw-csv --publish
npm run data-products:verify-arcgis-version -- --product modeled-wse --version m4-v1 --output <findings.json>
```

| Command | Script | What it does |
| --- | --- | --- |
| `freeze-modeled-wse-version` | `freeze_modeled_wse_depth_version.py` (reader `modeled_wse_depth_source_series.py`) | Freezes any version whose Time Series hold the anchor WSE, both junction depths, and the three beds (m2 to m5). Same tables as `m2-v1`, renamed with the label. Takes the WSE Anchor Point from where the Stage 3 manifest says it lies: a Stage 1 section (m2) or `channelRibbon.anchorLonLat` of the `flowline-channel-ribbon` version built on the same channel (m3, m4, m5; m4 and m5 name that channel in `channelFromModeledWseVersion`), and checks that source's bed equals the Time Series anchor bed. About 90–100 s per version. Accepts `--trial-folder=<path> --only-tnc-comids=<ids>`. |
| `validate-modeled-wse-version` | `validate_modeled_wse_depth_version.py` | Reads the geodatabase and CSVs back and compares every value with Stage 3, as the m2 validator does, plus the anchor point source, the channel-ribbon columns, and `null_values_note`. About 35 s. |
| `freeze-wse-polygons-version` | `freeze_wse_polygons_depth_version.py` | Freezes a depth-bucket polygon version (`height-above-nearest-drainage-fill`, `flowline-channel-ribbon`). The registry method number is the one the pipeline method already has (junction-sloped `m1`, HAND `m2`) or the next free one (`flowline-channel-ribbon` became `m3`); the version number is the pipeline version. A ribbon also gets a `<prefix>_channel_ribbons` table. About 11 s. Accepts `--dry-run-into=<new folder>`. |
| `validate-wse-polygons-version` | `validate_wse_polygons_depth_version.py` | Compares every feature's attributes and rings (with Z) with Stage 4, ring and vertex totals, geometry validity before and after storage, and the channel-ribbons table. About 10 s. |
| `publish-arcgis-version` | `publish_data_product_version_service.py` | Publishes one frozen version as its own private, Query-only service with a plain-language title and snippet, then fills only that version's null ArcGIS fields in the registry. Never touches the product-level registry fields (the live `m1-v1` services). |
| `verify-arcgis-version` | `verify_published_data_product_version.py` | Read-only, signed in: every item private, capabilities `Query`, layer ids, row counts, and fields equal the frozen version, and 20 seeded random Creek Segments (6 hours each) or 20 polygons equal the pipeline output. Writes JSON. |

**Older method versions.** When the working tree holds newer method code than the stage ran (`m3-v1` after `m3-v2` was written), the freeze looks for the oldest git commit whose copies of every method file equal the hashes the stage recorded, and fingerprints the code from that commit. It refuses when no commit holds that code.

**Schema of a depth-style modeled WSE version** (also in each `version.json` under `schema`):

- `<prefix>_creek_segments` (line layer): m1's columns (flowline, length, flow direction, neighbours, junction ids, NHDPlusV2 COMID, drainage areas, Drainage-Area Ratio Transfer), then `anchor_longitude`, `anchor_latitude` (the WSE Anchor Point), `anchor_bed_elevation_m`, `junction_bed_upstream_m`, `junction_bed_downstream_m`; for the channel-ribbon methods also `anchor_station`, `station_count`, `breached_station_count` (stations on a breached road or railroad fill; null where the ribbon version does not store them); and `null_values_note`, the Stage 3 warning for a Creek Segment whose values are all null (for example one lying wholly on a breached fill). Such a segment stays null in every table. Three Creek Segments have no ribbon and so no anchor point (null).
- `<prefix>_nwm_hourly_held_intervals` and `<prefix>_cnf_monthly_held_intervals`: per Creek Segment, `wse_m` and both junction depths; an interval ends when any of the three changes. Junction WSE = junction bed + junction depth.
- `<prefix>_cnf_monthly_values`: one row per Creek Segment per month.
- `modeled_wse_versions`: one row; `derivation_json` holds the method record, including the flow-resistance law for m4 and m5.
- Raw hourly CSV zips: `segment_id, tnc_comid, time_utc, wse_m, junction_depth_upstream_m, junction_depth_downstream_m`.
- Not stored: per-segment bed slope and flow-resistance coefficients (Stage 3 does not write them).

**Schema of a channel-ribbon polygon version:** `<prefix>` is `MultiPolygon Z`, one feature per depth rung of a Creek Segment (19 rungs, 0.01 m to 8 m; the top bucket reaches 100 m), with `min_depth_m` / `max_depth_m` as water depths and Z the station bed. Each bucket's single ring is kept exactly as stored, never reoriented or repaired: about 5% of rings cross themselves at a folded rung, and the file geodatabase writer stores about 0.6% of rings in reverse vertex order (same vertices). **The hosted layer is not ring-for-ring identical:** ArcGIS stores only simple rings, so on publishing it splits each ring that crosses itself into simple rings (3,255 of 63,365 features of `m3-v1`, 3,197 of `m3-v2`; every other ring is stored exactly). The footprint stays the same (at most 2e-5 of the area differs from the shapely `make_valid` repair of the Stage 4 ring), but the station order of those rings is lost. Use the frozen file geodatabase (`arcgis-upload/`, also the private file geodatabase item) when you need the exact rings. The HAND `m2-v1` service shows the same effect on 22 of 117,361 features (touching rings regrouped, footprint equal to 2e-9). `<prefix>_channel_ribbons` holds each Creek Segment's `channelRibbon` record (anchor point and bed, anchor station, station distances, top widths at the anchor), which the browser needs to draw the ribbon at a depth.

### What stays hard-coded in the generic commands

- `PLAIN_TEXT_BY_VERSION` in `data_product_version_identity.py`: the title words and one-sentence summary of each published version. A new version without an entry falls back to the stage's method label; add an entry before publishing.
- The extent (`dangermond-preserve`), the published National Water Model water years (WY2021–WY2023), and the portal folder, as in the m1 scripts.
- The ring-assembly rule per `browserDrawing` in `freeze_wse_polygons_depth_version.py`. A new polygon drawing needs an entry there.

### What the publish script does when the service already exists

For the same product it stops before touching the portal, in one of two ways:

1. The registry already records a `service_item_id` for that version label: it exits with "already published … Versions are append-only."
2. For a **new** label, it reads the service name from the product's registry entry (`creek_water_visualization_modeled_wse`), signs in, asks the portal whether the name is free, finds it taken, and exits with "Service name … is already taken on the portal. Nothing was changed."

There is **no flag** to add a new version's layers and tables to the existing service, and no code path that overwrites or deletes. **Not built yet: see [UCS-298](https://linear.app/ucsb-spatial-center/issue/UCS-298/add-a-new-data-product-version-to-an-existing-hosted-service-without), which adds a new version to an existing service.**

### What you can do today

- **Publish a new version as its own service** (done for `m2-v1` to `m5-v1` on 2026-10-27): `data-products:publish-arcgis-version` ("Generic commands" above). It never touches the two live services or the product-level registry fields. The browser's hosted adapters read both layouts (m1's elevation buckets, and the depth layout of m2–m5 with channel ribbons); the production build opens `m5-v1` on `m3-v2` by default (section 1), and `VITE_MODELED_WSE_SERVICE_URL` with `VITE_WSE_POLYGONS_SERVICE_URL` (`.env.example`) repoint it. **Ask before touching the existing services.**
- **Always safe:** freezing, validating, and dry-running a new version. They write only to the git-ignored `data/data-product-versions/` folder and, for a real freeze, the registry.
- **Constraints that hold on any route:**
  - Service names are unique across the portal.
  - The portal has no recycle bin. A deleted item is gone.
  - Never overwrite or delete a published item or an older version.
  - Retire a version by setting its `status` to `superseded` in the versions-table row (and in the registry). No script does this yet; edit the row through the portal or the ArcGIS API with the same brief Update-capability toggle `update_versions_table_row` uses.

## 6. Verify after publishing

Both commands are read-only. A mismatch exits nonzero.

| Command | Compares | Sign-in |
| --- | --- | --- |
| `npm run data-products:verify-hosted-modeled-data` | The browser's hosted adapters, run against the live modeled WSE and WSE polygon services, rebuild the Time Series, polygon sets, reach crosswalk, and Creek Segment paths. These are compared with the local `dangermond-preserve` working output. | Yes. Gets a short-lived credential from `print_portal_token_for_child_process.py` via the conda environment and `ARCGIS_DOTENV_PATH`. It stays in memory. |
| `npm run data-products:verify-hosted-observed-data` | The hosted observed-gauge adapter (public Creek Gauge Data service) rebuilds the Jalama Near Lompoc Time Series, gauge-segment polygons, and segment paths. These are compared with the shipped files in `public/published-creek-visualization-data`. It also reports Provisional and Approved reading counts. | No. |

Expected: **0 mismatches** in each. Flowline-index differences in the modeled check are expected (hosted boxes come from flowline paths, local ones from polygons). Both commands check the live `m1-v1` services only.

**The production default** (modeled WSE `m5-v1` on the WSE polygons `m3-v2` ribbon, section 1) has its own check:

```sh
npm run data-products:verify-hosted-default-modeled-data                 # signed in
npm run data-products:verify-hosted-default-modeled-data -- --anonymous  # no token; the services must be public
```

It rebuilds, through the browser's hosted adapters, every National Water Model hourly Time Series file the service publishes (105 flowlines × WY2021–WY2023, every value and both junction depths), California Natural Flows monthly files of three flowlines, every ribbon polygon set (63,365 buckets, 2,748,084 ring vertices with z, read from the rings service, plus the `channelRibbon` summary), the method list's default pairing, the catalog fields the browser reads, the reach crosswalk, and Creek Segment paths, and compares each as a deep JSON equality with the local `dangermond-preserve` working output. It names the expected differences: the hosted version publishes WY2021–WY2023 hours only (local also has WY2018–WY2020), the hosted catalog has no per-Dataset derivation text, the hosted method list names only the published versions, and the hosted catalog lists Datasets in another order. On 2026-10-28 it passed signed in (private) and anonymously (public): 7 of 7 comparisons, 0 mismatches, about 1,625 requests and 388 MB in 75–92 s.

For a version published with its own service (section 5, "Generic commands"), run the read-only check:

```sh
npm run data-products:verify-arcgis-version -- --product modeled-wse --version m4-v1 --output <findings.json>
```

It signs in, confirms every item is private and the service is Query-only, compares layer ids, row counts, and fields with the frozen version, and compares 20 seeded random Creek Segments (6 hours each, one of them the wettest hour) or 20 polygons with the pipeline output. A polygon whose rings ArcGIS split (section 5) passes as "normalized by the server" when its footprint matches within 1e-4 of its area, and is counted.

### Anonymous spot check

The `m1-v1` services are public, and so are the three default-pairing services (section 1). Replace the service name and layer id to check others.

```sh
B=https://dangermondpreserve-spatial.com/server/rest/services/Hosted
curl -s "$B/creek_water_visualization_modeled_wse/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json"
curl -s "$B/creek_water_visualization_wse_polygons/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json"
```

Confirmed on 2026-10-22: `{"count":3338}` (Creek Segments) and `{"count":101124}` (polygons). Tables confirmed the same day: modeled layer 1 = 2,512,927; layer 2 = 3,004,200; layer 3 = 2,642,107; layer 4 = 1; polygons layer 1 = 1.

### Browser check

```sh
VITE_CREEK_DATA_SOURCE=hosted npm run dev
```

Open the app and confirm creeks, water polygons, and the time slider load. Without the variable, the dev server reads local working output; production builds default to hosted, on the default pairing (`m3-v2` ribbon drawn with `m5-v1`). `.env.example` shows the other `VITE_` settings.

## 7. Safety rules and known limits

- The publish script **never deletes** a portal item, including ones it created. The portal has **no recycle bin**.
- It is a dry run unless `--publish` is passed. It refuses already-published versions and taken service names.
- Practice on a throwaway service name and a throwaway folder, never on the two live services.
- Hosted tables page at `standardMaxRecordCount` **16,000** rows per request; the two feature layers (the line and polygon layers) return **2,000** per request. The browser reads the limit from each layer and pages with up to 4 requests at once.
- The browser times out a request after **15 s** and retries once (about 30 s worst case).
- Startup waits at most **3 s** for the USGS 3DEP terrain preflight tile, and **1 s** for a World Elevation sample.
- California Natural Flows monthly is hidden in the browser unless `VITE_SHOW_CALIFORNIA_NATURAL_FLOWS_MONTHLY=true`.
- The published services are Query-only. Do not leave Update enabled.

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Index name 'idx_…' is invalid` | ArcGIS needs index names unique across the whole data store. | Fixed: the script now names indexes `ix_<hash of table name>_<field>`. Do not rename them back. |
| Versions-table row not updated after publish (`versions table update error`) | The service is Query-only, so edits fail. | The script enables `Query,Update`, edits, and restores `Query`. If it still fails, check the printed error and confirm the capability is back to `Query` in the service settings. |
| `Credential file not found at …` or `Missing credential variables` | `load_dotenv()` with no path finds nothing under `conda run`; the working directory differs. | Set `ARCGIS_DOTENV_PATH` to the absolute path of the credential file. |
| `ogr2ogr` (GDAL command-line converter) fails or is missing | The conda GDAL command-line tools are broken. | Not needed. The scripts write geodatabases with `pyogrio` (Python GDAL bindings). |
| `Service name … is already taken` | The service exists. | Expected for a new version; see section 5. Nothing was changed. |
| `… is already published … Versions are append-only` | The registry already has a service id for that label. | Freeze and publish a new label, never rerun the old one. |
| First anonymous query returns `503 … couldn't access this resource … mapserver` | Seen once on 2026-10-22 on the first request to the modeled service; the retry succeeded. | Retry after a few seconds. If it persists, ask Dan. |
| `Version folder already exists … append-only` on freeze | The label is already frozen. | Edit the constants to the new label (section 5). Never delete a frozen folder to make a run pass. |
| `WSE Polygon Generation Method code changed since Stage 4 ran` | The polygon method code differs from what Stage 4 recorded. | Rerun Stage 4 (bump the method `version` if the output should change). |
