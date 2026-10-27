"""Check one published Data-Product Version on the portal against its frozen folder and the pipeline output (read-only).

Signs in (credentials from ARCGIS_DOTENV_PATH, never printed) and only reads:

  - every item the registry records for the version (service, file geodatabase, raw hourly CSV zips) is
    shared with its owner only (access "private");
  - the service's capabilities are exactly "Query" (the publish step's brief Update toggle was undone);
  - every layer and table: id, name, row count equal to the frozen count, and every field of the frozen
    file geodatabase present;
  - modeled WSE: for a seeded random sample of Creek Segments, the hosted National Water Model hourly Held WSE
    Intervals give the Stage 3 `values` and junction depths at sampled hours (nulls as nulls);
  - WSE polygons: for a seeded random sample of features, the hosted rings (with Z) equal the Stage 4 rings.

Writes the findings as JSON to --output and exits nonzero on a mismatch.

    npm run data-products:verify-arcgis-version -- --product wse-polygons --version m2-v1 --output <file.json>
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pyogrio

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_version_identity import MODELED_WSE, PRODUCTS, DataProductVersionIdentity  # noqa: E402
from data_product_versions import REPOSITORY_ROOT, write_json  # noqa: E402
from file_geodatabase_tables import unzip_gdb  # noqa: E402
from freeze_wse_polygons_depth_version import iterate_polygon_sets  # noqa: E402
from modeled_wse_depth_source_series import DepthTimeSeriesFolder  # noqa: E402
from modeled_wse_version_layout import PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS  # noqa: E402
from publish_data_product_version_service import EXPECTED_CAPABILITIES, registry_version  # noqa: E402
from publish_data_products_to_arcgis import all_layers_and_tables, load_portal_credentials  # noqa: E402
from validate_wse_polygons_depth_version import closed, ring_match  # noqa: E402

SAMPLE_SEED = 298
HOURS_PER_SEGMENT = 6
STAGE_3_ROOT = REPOSITORY_ROOT / "data" / "pipeline-working-output" / "dangermond-preserve" / "03-time-series"


def expected_row_counts(product: str, version_json: dict, identity: DataProductVersionIdentity) -> dict[str, int]:
    counts = version_json["counts"]
    if "arcgis_rows" in counts:
        return counts["arcgis_rows"]
    # m2-v1 polygons were frozen before arcgis_rows existed: one versions row and one feature per non-empty bucket.
    return {identity.versions_table_name: 1, identity.arcgis_prefix: counts["features"]}


def frozen_field_names(version_folder: Path, identity: DataProductVersionIdentity) -> dict[str, list[str]]:
    with tempfile.TemporaryDirectory(prefix=f"verify-{identity.version_label}-") as temporary_folder:
        gdb_path = unzip_gdb(version_folder / "arcgis-upload" / identity.upload_zip_name, Path(temporary_folder))
        return {str(name): list(pyogrio.read_info(str(gdb_path), layer=str(name))["fields"]) for name, _ in pyogrio.list_layers(str(gdb_path))}


def same_value(hosted, source: float) -> bool:
    return (hosted is None and np.isnan(source)) or (hosted is not None and not np.isnan(source) and float(hosted) == float(source))


def check_modeled_sample(service_item, identity: DataProductVersionIdentity, version_json: dict, sample_size: int) -> dict:
    stage_3_folder = REPOSITORY_ROOT / version_json.get("stage_3_folder", f"{STAGE_3_ROOT.relative_to(REPOSITORY_ROOT)}/{identity.method_id}/v{identity.version_number}")
    time_series = DepthTimeSeriesFolder(stage_3_folder / "time-series")
    intervals_table = next(
        table for table in all_layers_and_tables(service_item) if table.properties.name == f"{identity.arcgis_prefix}_nwm_hourly_held_intervals"
    )
    network = json.loads((identity.version_folder / "creek-segment-network.json").read_text(encoding="utf-8"))
    segment_ids = sorted(segment["segmentId"] for segment in network["segments"])
    generator = random.Random(SAMPLE_SEED)
    sample = sorted(generator.sample(segment_ids, sample_size))
    comparisons, mismatches = [], []
    for segment_id in sample:
        flowline = time_series.load_national_water_model_hourly(segment_id.split("-")[0], PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
        segment = next(s for s in flowline.segments if s.segment_id == segment_id)
        intervals = [
            feature.attributes
            for feature in intervals_table.query(
                where=f"segment_id = '{segment_id}'",
                out_fields="valid_from_utc,valid_until_utc,wse_m,junction_depth_upstream_m,junction_depth_downstream_m",
                return_geometry=False,
                order_by_fields="valid_from_utc",
            ).features
        ]
        # The wettest hour, so a sample is not all dry, plus random hours.
        peak = int(np.nanargmax(segment.values)) if not np.all(np.isnan(segment.values)) else 0
        steps = [peak, *generator.sample(range(len(flowline.timestamps_ms)), HOURS_PER_SEGMENT - 1)]
        for step in steps:
            timestamp = int(flowline.timestamps_ms[step])
            interval = next((row for row in intervals if row["valid_from_utc"] <= timestamp < row["valid_until_utc"]), None)
            hosted = None if interval is None else (interval["wse_m"], interval["junction_depth_upstream_m"], interval["junction_depth_downstream_m"])
            source = (segment.values[step], segment.junction_depth_upstream_m[step], segment.junction_depth_downstream_m[step])
            equal = hosted is not None and all(same_value(h, s) for h, s in zip(hosted, source))
            comparison = {
                "segment_id": segment_id,
                "time_utc": np.datetime_as_string(np.datetime64(timestamp, "ms"), unit="s") + "Z",
                "hosted": hosted,
                "stage_3": [None if np.isnan(value) else float(value) for value in source],
                "equal": equal,
            }
            comparisons.append(comparison)
            if not equal:
                mismatches.append(comparison)
    return {"segments_sampled": sample, "hours_compared": len(comparisons), "mismatches": mismatches, "comparisons": comparisons}


def check_polygon_sample(service_item, identity: DataProductVersionIdentity, version_json: dict, sample_size: int) -> dict:
    polygon_layer = next(layer for layer in service_item.layers if layer.properties.name == identity.arcgis_prefix)
    object_id_field = polygon_layer.properties.objectIdField
    object_ids = sorted(polygon_layer.query(where="1=1", return_ids_only=True)["objectIds"])
    sample_ids = sorted(random.Random(SAMPLE_SEED).sample(object_ids, sample_size))
    features = polygon_layer.query(object_ids=",".join(map(str, sample_ids)), out_fields="*", return_z=True).features
    wanted = {(feature.attributes["segment_id"], int(feature.attributes["bucket_index"])) for feature in features}
    source_rings = {}
    for polygon_set in iterate_polygon_sets(REPOSITORY_ROOT / version_json["source"]["stage_4_folder"]):
        for bucket_index, bucket in enumerate(polygon_set["elevationBuckets"]):
            if (polygon_set["segmentId"], bucket_index) in wanted:
                source_rings[(polygon_set["segmentId"], bucket_index)] = [closed(ring) for ring in bucket["ringsWgs84"]]
    comparisons, mismatches = [], []
    for feature in features:
        key = (feature.attributes["segment_id"], int(feature.attributes["bucket_index"]))
        hosted_rings = [np.asarray(ring, dtype=float) for ring in feature.geometry["rings"]]
        source = source_rings.get(key, [])
        outcomes = []
        for source_ring in source:
            outcomes.append(next((outcome for ring in hosted_rings if (outcome := ring_match(source_ring, ring))), "mismatch"))
        equal = len(hosted_rings) == len(source) and "mismatch" not in outcomes
        comparison = {"object_id": feature.attributes[object_id_field], "segment_id": key[0], "bucket_index": key[1],
                      "rings": len(hosted_rings), "ring_outcomes": outcomes, "equal": equal}  # fmt: skip
        comparisons.append(comparison)
        if not equal:
            mismatches.append(comparison)
    return {"features_sampled": len(features), "mismatches": mismatches, "comparisons": comparisons}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--product", required=True, choices=PRODUCTS)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path, help="JSON file to write the findings to.")
    parser.add_argument("--sample-size", type=int, default=20)
    arguments = parser.parse_args()
    started = time.time()

    from arcgis.features import FeatureLayerCollection
    from arcgis.gis import GIS

    entry = registry_version(arguments.product, arguments.version)
    arcgis_record = entry["arcgis"]
    if not arcgis_record.get("service_item_id"):
        raise SystemExit(f"{arguments.product} {arguments.version} has no published service in the registry.")
    identity = DataProductVersionIdentity(arguments.product, entry["method_id"], arguments.version)
    version_folder = REPOSITORY_ROOT / entry["version_folder"]
    version_json = json.loads((version_folder / "version.json").read_text(encoding="utf-8"))

    portal_url, username, password = load_portal_credentials()
    gis = GIS(portal_url, username, password)
    findings: dict = {"product": arguments.product, "version_label": arguments.version, "checked_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    failures: list[str] = []

    item_ids = {"service": arcgis_record["service_item_id"], "file_geodatabase": arcgis_record["file_geodatabase_item_id"]}
    item_ids.update({f"raw_hourly_csv_{year}": item_id for year, item_id in (arcgis_record.get("raw_hourly_csv_item_ids") or {}).items()})
    findings["items"] = {}
    for role, item_id in item_ids.items():
        item = gis.content.get(item_id)
        findings["items"][role] = {"id": item_id, "title": item.title, "type": item.type, "access": item.access, "size_bytes": item.size}
        if item.access != "private":
            failures.append(f"{role} item {item_id} access is {item.access}, expected private")
    service_item = gis.content.get(arcgis_record["service_item_id"])
    findings["service_url"] = service_item.url
    capabilities = FeatureLayerCollection.fromitem(service_item).properties.capabilities
    findings["capabilities"] = capabilities
    if capabilities != EXPECTED_CAPABILITIES:
        failures.append(f"capabilities {capabilities}, expected {EXPECTED_CAPABILITIES}")

    expected_counts = expected_row_counts(arguments.product, version_json, identity)
    frozen_fields = frozen_field_names(version_folder, identity)
    findings["layers"] = []
    for layer in all_layers_and_tables(service_item):
        name = layer.properties.name
        count = layer.query(where="1=1", return_count_only=True)
        hosted_fields = [field["name"] for field in layer.properties.fields]
        missing_fields = [field for field in frozen_fields.get(name, []) if field.lower() not in {f.lower() for f in hosted_fields}]
        findings["layers"].append(
            {"id": layer.properties.id, "name": name, "rows": count, "expected_rows": expected_counts.get(name),
             "fields": hosted_fields, "frozen_fields_missing": missing_fields}  # fmt: skip
        )
        if count != expected_counts.get(name):
            failures.append(f"{name}: {count} rows, frozen {expected_counts.get(name)}")
        if missing_fields:
            failures.append(f"{name}: frozen fields missing on the portal {missing_fields}")
    if sorted(layer["name"] for layer in findings["layers"]) != sorted(expected_counts):
        failures.append(f"hosted layers {sorted(layer['name'] for layer in findings['layers'])} differ from frozen {sorted(expected_counts)}")

    if arguments.product == MODELED_WSE:
        findings["value_sample"] = check_modeled_sample(service_item, identity, version_json, arguments.sample_size)
        if findings["value_sample"]["mismatches"]:
            failures.append(f"{len(findings['value_sample']['mismatches'])} sampled hourly values differ from Stage 3")
    else:
        findings["geometry_sample"] = check_polygon_sample(service_item, identity, version_json, arguments.sample_size)
        if findings["geometry_sample"]["mismatches"]:
            failures.append(f"{len(findings['geometry_sample']['mismatches'])} sampled features differ from Stage 4")

    findings["failures"] = failures
    findings["passed"] = not failures
    findings["seconds"] = round(time.time() - started, 1)
    write_json(arguments.output, findings)
    for layer in findings["layers"]:
        print(f"  {layer['id']}  {layer['name']}: {layer['rows']:,} rows (frozen {layer['expected_rows']:,})")
    access_text = ", ".join(f"{role} {item['access']}" for role, item in findings["items"].items())
    print(f"  capabilities {capabilities}; access {access_text}")
    sample = findings.get("value_sample") or findings.get("geometry_sample")
    print(f"  sample: {sample.get('hours_compared', sample.get('features_sampled'))} compared, {len(sample['mismatches'])} mismatched")
    print(f"{'PASSED' if not failures else 'FAILED'} in {findings['seconds']} s; findings written to {arguments.output}")
    for failure in failures:
        print(f"  FAIL {failure}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
