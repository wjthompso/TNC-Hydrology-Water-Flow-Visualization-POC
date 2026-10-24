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

Sharing today: the two services and three CSV items are public (`everyone`). The two file geodatabase items are private.

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
3. **Point the freeze scripts at the new label.** The freeze reads the method's identity, change type, change note, fingerprint, and (for polygons) the modeled WSE version it was built from out of the stage manifests (UCS-296). The label and the ArcGIS names are still written in the code (next section), and parameterizing them is [UCS-298](https://linear.app/ucsb-spatial-center/issue/UCS-298/add-a-new-data-product-version-to-an-existing-hosted-service-without). Edit those places, then run the freeze commands. A freeze refuses to write over an existing label, and refuses when the method code changed since the stage ran.
4. **Validate** (section 3, steps 3 and 5). The validators import the same constants, so they follow the edit.
5. **Dry-run the publish** with the new `--version`.
6. **Publish.** The script **refuses** (next but one section). Do not run `--publish` for a new version against the existing service.

### Hard-coded `m1-v1` places (verified in code)

| File | Hard-coded |
| --- | --- |
| `modeled_wse_version_layout.py` | `METHOD_ID`, `METHOD_NUMBER`, `VERSION_NUMBER`, `VERSION_LABEL`, `ARCGIS_PREFIX` (`modeled_wse_m1_v1`, which names every layer and table), the literal `UPLOAD_GDB_ZIP_NAME` (`modeled-wse-m1-v1.gdb.zip`), and `SERVICE_TITLE` / `SERVICE_NAME`. Version folder and table names derive from these. |
| `freeze_modeled_wse_version.py` | `STATUS`, `DERIVATION_SUMMARY`, and the docstring. The change type, change note, fingerprint, and code-file list come from the Stage 3 manifest. |
| `freeze_wse_polygons_version.py` | `PRODUCT`, `METHOD_ID`, `METHOD_NUMBER`, `VERSION_NUMBER`, `VERSION_LABEL`, `ARCGIS_PREFIX`, `CHANGE_NOTE`, `CHANGE_TYPE`, `PIPELINE_METHOD_ID`, `PIPELINE_METHOD_VERSION`, `SERVICE_TITLE` / `SERVICE_NAME`, `UPLOAD_ZIP_NAME`. The modeled WSE version it was built from comes from the Stage 4 manifest. |
| `validate_wse_polygons_version.py` | `EXPECTED_NON_EMPTY_BUCKETS` (`102_607 - 1_483`) and `GAUGE_CREEK_SEGMENT_EXPECTED_BUCKETS` (137): counts that change when the output changes. |
| `validate_modeled_wse_version.py` | `EXPECTED_SEGMENT_COUNT` (3,338) through the layout file. |
| `publish_data_products_to_arcgis.py` | The `PRODUCTS` table fixes each product's `method_id` to the `m1-…` method. Another `v` of the same method works with `--version`; a new method number (`m2`) needs this table edited, so even a dry run of `m2-v1` stops (it looks for the version folder under the `m1-…` method folder). The publish script also assumes the m1 table names and columns. Publishing `m2-v1` is out of scope until [UCS-298](https://linear.app/ucsb-spatial-center/issue/UCS-298/add-a-new-data-product-version-to-an-existing-hosted-service-without). |
| Browser and checks | `creek-data-source-configuration.ts` holds `m1_v1` table names and fallback layer ids. `scripts/verify-hosted-modeled-data-equivalence.ts` reads the `m1-…/v1` Stage 3 folder and the `junction-sloped-terrain-fill/v1` Stage 4 folder. |

### m2-v1 uses separate scripts (frozen locally, not published)

The table above describes the m1 scripts, which stay hard-coded to `m1-v1` and are unchanged. `m2-v1` (the `m2-multi-section-manning-depth` modeled WSE and the `m2-height-above-nearest-drainage-fill` polygons) is frozen by separate scripts that import the generic helpers from the m1 ones, so nothing m1 depends on moves:

| Command | Script | What differs from m1 |
| --- | --- | --- |
| `npm run data-products:freeze-modeled-wse-m2` | `freeze_modeled_wse_m2_version.py` (names in `modeled_wse_m2_version_layout.py`, source reader `modeled_wse_m2_source_series.py`) | Creek Segments layer adds `anchor_longitude`, `anchor_latitude`, `anchor_bed_elevation_m`, `junction_bed_upstream_m`, `junction_bed_downstream_m`. Held WSE Interval tables are per Creek Segment (no junction rows) and hold `wse_m` plus `junction_depth_upstream_m` and `junction_depth_downstream_m`; an interval ends when any of the three changes. Junction WSE is not stored: it is junction bed + junction depth, rounded to 3 decimals. |
| `npm run data-products:validate-modeled-wse-m2` | `validate_modeled_wse_m2_version.py` | Expected counts come from `version.json` and the Stage 3 manifest. Rebuilds all three time-varying arrays and the junction WSE for every segment and time step. |
| `npm run data-products:freeze-wse-polygons-m2` | `freeze_wse_polygons_m2_version.py` | Layer `wse_polygons_m2_v1` is `MultiPolygon Z`. Columns are `min_depth_m` / `max_depth_m` (water **depths**, not elevations). Z is the local bed elevation (m NAVD88); the browser draws at Z + depth (`browserDrawing` `bed-parallel-depth`). `version.json` records all three. |
| `npm run data-products:validate-wse-polygons-m2` | `validate_wse_polygons_m2_version.py` | Expected counts come from the Stage 4 manifest. Compares Z as well as longitude and latitude. |

The m2 method code was committed after Stage 3 and Stage 4 ran, so the freeze records the earliest commit whose copies of the method files match the hashes the stages recorded, not a commit at or before `completedAt`.

### What the publish script does when the service already exists

For the same product it stops before touching the portal, in one of two ways:

1. The registry already records a `service_item_id` for that version label: it exits with "already published … Versions are append-only."
2. For a **new** label, it reads the service name from the product's registry entry (`creek_water_visualization_modeled_wse`), signs in, asks the portal whether the name is free, finds it taken, and exits with "Service name … is already taken on the portal. Nothing was changed."

There is **no flag** to add a new version's layers and tables to the existing service, and no code path that overwrites or deletes. **Not built yet: see [UCS-298](https://linear.app/ucsb-spatial-center/issue/UCS-298/add-a-new-data-product-version-to-an-existing-hosted-service-without), which adds a new version to an existing service.**

### What you can do today

- **Unverified, so ask first:** I found no route in the code or the registry that safely publishes a new version today. The nearest idea is a separately named service (a new `arcgis_service_name`). That needs an edit to the tracked registry entry and a way for the browser to find the new URL (`VITE_MODELED_WSE_SERVICE_URL` and `VITE_WSE_POLYGONS_SERVICE_URL` exist in `.env.example`). Nobody has run it end to end. **Ask before touching the existing services.**
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

Expected: **0 mismatches** in each. Flowline-index differences in the modeled check are expected (hosted boxes come from flowline paths, local ones from polygons).

### Anonymous spot check

The services are public. Replace the layer id to check others (section 1).

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

Open the app and confirm creeks, water polygons, and the time slider load. Without the variable, the dev server reads local working output; production builds default to hosted. `.env.example` shows the other `VITE_` settings.

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
