# Data

Everything the pipelines read or write outside the browser app. The browser itself reads only `apps/creek-visualization-browser/public/published-creek-visualization-data/` and, in development, the pipeline working output served by the Vite dev middleware.

## Layout

```
data/
  README.md
  source-inputs/                      tracked: saved source inputs (TNC flowlines, gauge snapshot, reviewed crosswalks, terrain window)
  pipeline-working-output/            git-ignored scratch, regenerable: <extent>/00-acquire … 05-catalog/, national-water-model-zarr-chunk-cache/
                                      03-time-series/<method-id>/v<N>/ and 04-water-surface-polygons/<method-id>/v<N>/ keep every version side by side
  data-product-versions/              git-ignored, append-only frozen copies of published data-product versions
    modeled-wse/<method-id>/<version>/        e.g. m1-drainage-area-ratio-manning-rating-curve/m1-v1/
    wse-polygons/<method-id>/<version>/       e.g. m1-junction-sloped-terrain-fill/m1-v1/
  data-product-version-registry.json  tracked: every version → ArcGIS item/layer ids, status
```

| Folder or file | In git | Written by | Safe to delete |
| --- | --- | --- | --- |
| `source-inputs/` | tracked | `npm run pipeline:acquire`, `retain-dangermond-preserve-flowlines.ts`, reviewed by hand | no; changes are reviewed commits |
| `pipeline-working-output/` | ignored | `npm run pipeline:modeled-wse:all -- --extent=<extentId>` | yes; rerun the pipeline (Stage 0 downloads for about 30 minutes) |
| `data-product-versions/` | ignored | the ArcGIS publishing workflow | no; it is the local frozen copy of what was published |
| `data-product-version-registry.json` | tracked | the ArcGIS publishing workflow | no |

The ArcGIS publishing workflow in `pipelines/creek-visualization-data-production/arcgis-publishing/` ([UCS-285](https://linear.app/ucsb-spatial-center/issue/UCS-285/publish-versioned-creek-water-visualization-datasets-as-hosted-arcgis)) writes `data-product-versions/` by freezing a copy of the pipeline working output, and fills the registry with ArcGIS ids when it publishes. Since [UCS-296](https://linear.app/ucsb-spatial-center/issue/UCS-296/make-the-modeled-wse-pipeline-write-versioned-append-only-output) the pipeline also writes versioned, append-only output itself: each Modeled WSE Derivation Method version gets its own `03-time-series/<method-id>/v<N>/` folder, each WSE Polygon Generation Method version its own `04-water-surface-polygons/<method-id>/v<N>/` folder, and a stage stops instead of overwriting a saved version whose method code or parameters changed (a SHA-256 fingerprint, `methodSha256`). The freeze step reads the method's identity, change note, fingerprint, and (for polygons) the modeled WSE version it was built from out of the stage manifests, not from typed-in constants.

## Publishing to ArcGIS

Each version moves through the same steps; every command prints what it does and refuses to overwrite an existing version.

```sh
npm run data-products:freeze-modeled-wse      # or freeze-wse-polygons
npm run data-products:validate-modeled-wse    # or validate-wse-polygons
npm run data-products:publish-arcgis -- --product modeled-wse --version m1-v1                            # dry run: prints the plan
npm run data-products:publish-arcgis -- --product modeled-wse --version m1-v1 --upload-raw-csv --publish # private hosted feature layer
```

Step-by-step publishing, updating, verification, and troubleshooting are in [arcgis-publishing/README.md](../pipelines/creek-visualization-data-production/arcgis-publishing/README.md).

Published items live in the portal folder **Creek Water Visualization** (the two services and the raw CSV items are public; the script itself publishes private). The registry records each version's service item id, service URL, layer and table ids, row counts, and raw CSV item ids. The publish script never deletes portal items; the portal has no recycle bin.

## Two data products

1. **Modeled WSE**: one modeled water-surface elevation Time Series per Creek Segment, from a Modeled WSE Derivation Method (discharge → drainage-area ratio → Manning's equation rating curve).
2. **WSE polygons**: prepared water-surface polygons per Creek Segment, from a WSE Polygon Generation Method applied to one modeled WSE version.

Dependency chain: TNC flowlines → Creek Segments (cut at the flowline's original vertices) → modeled WSE versions → WSE polygon versions. A new modeled WSE version needs new WSE polygon versions built from it; a new WSE polygon version can reuse an existing modeled WSE version.

## Where each method is described

A frozen `version.json` records what a version is. Each method's folder holds its config and a description for people and LLMs:

| Product | Method folder | Config | Description |
| --- | --- | --- | --- |
| `modeled-wse` | `pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods/<method-id>/` | `method-config.ts` | [`METHOD.md`](../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods/m1-drainage-area-ratio-manning-rating-curve/METHOD.md) |
| `wse-polygons` | `pipelines/creek-visualization-data-production/modeled-water-surface-elevation/wse-polygon-generation-methods/<pipeline-method-id>/` | `method-config.ts` | [`METHOD.md`](../pipelines/creek-visualization-data-production/modeled-water-surface-elevation/wse-polygon-generation-methods/junction-sloped-terrain-fill/METHOD.md) |

The modeled WSE method folder name is its Data-Product Version `method_id`. The WSE polygon `method_id` adds the `m<N>-` prefix to the pipeline method id (`junction-sloped-terrain-fill` → `m1-junction-sloped-terrain-fill`).

## Versioning

- **Method number `m<N>`** changes when the idea changes: a different approach, not a fix or a new setting.
- **Version `v<N>`** increments on any change that affects output: an implementation fix or a parameter change. A version id carries its method number, for example `m1-v1`, `m1-v2`, `m2-v1`.
- Each version records `change_type` (new method, implementation fix, or parameter change) and a one-line `change_note`.
- Append-only: a version is never overwritten or deleted. Retiring one sets its registry `status` to `superseded`.
- ArcGIS names follow `<product>_m<N>_v<N>`, for example `modeled_wse_m1_v1` and `wse_polygons_m1_v1`.

## Migrating an old checkout

Before UCS-295 these folders were `data/retained-backend-source-data/` (now `source-inputs/`) and `data/modeled-water-surface-elevation-pipeline-output/` (now `pipeline-working-output/`). After merging, git moves the tracked folder. Move the ignored one by hand, then rewrite the paths recorded in its stage manifests so stages skip instead of rerunning:

```sh
mv data/modeled-water-surface-elevation-pipeline-output data/pipeline-working-output
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  pipelines/creek-visualization-data-production/migrate-data-folder-names.ts
```

The script changes only the folder prefix of recorded paths; hashes and other fields stay as they were. Running it again changes nothing.

### Moving Stage 3 output into version folders (UCS-296)

Stage 3 output saved before UCS-296 sits directly in `03-time-series/`. Every stage stops and names this command when it finds that layout. It renames the files into `03-time-series/<method-id>/v<N>/` (no recompute, no download), rewrites the recorded paths in the Stage 4 and Stage 5 manifests, writes the method's fingerprint into the Stage 3 manifest, and records which modeled WSE version Stage 4 was built from after checking that every Time Series hash matches. Stages 0–4 then skip; Stage 5 reruns once because the catalog's Time Series paths gain the version folder.

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  pipelines/creek-visualization-data-production/migrate-modeled-wse-version-folders.ts [--extent=<extentId>]
```

Running it again changes nothing.
