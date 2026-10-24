"""Freeze WSE polygons m2-v1 as an append-only data-product version.

Copies the Stage 4 output of WSE Polygon Generation Method `height-above-nearest-drainage-fill` v1
(extent dangermond-preserve, built from modeled-wse m2-v1) into

    data/data-product-versions/wse-polygons/m2-height-above-nearest-drainage-fill/m2-v1/
      version.json
      source-manifests/04-manifest.json
      arcgis-upload/wse-polygons-m2-v1.gdb.zip

The zipped file geodatabase holds the two parts of ArcGIS Service B:
  - table `wse_polygon_versions`: one row describing this version
  - polygon layer `wse_polygons_m2_v1` (EPSG 4326, MultiPolygon Z): one Prepared water-surface polygon
    per non-empty depth bucket

BUCKET BOUNDS ARE WATER DEPTHS. The layer columns are `min_depth_m` / `max_depth_m`: meters of water
above the local creek bed, as half-open [min, max) buckets. They are not elevations (Stage 4's JSON
keeps the name `minWaterSurfaceElevationM` for file-shape reasons). Every ring vertex is
[longitude, latitude, bedReferenceM] in the source and is stored as geometry Z = bedReferenceM
(m NAVD88, the local bed reference). The browser draws each vertex at z + depth
(browserDrawing `bed-parallel-depth`).

Each bucket's geometry is assembled by ring ORIENTATION as in freeze_wse_polygons_version.py
(clockwise = outer ring, counter-clockwise = hole; several outer rings make a MultiPolygon), with
Z carried through unchanged.

Afterwards the wse-polygons entry is merged into data/data-product-version-registry.json with null
ArcGIS fields. Local only; no portal access. Generic helpers are imported from
freeze_wse_polygons_version.py, which this script leaves untouched.

    npm run data-products:freeze-wse-polygons-m2
    npm run data-products:freeze-wse-polygons-m2 -- --dry-run-into=/tmp/wse-polygons-m2-trial
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

import numpy as np
import pyarrow as pa
import pyogrio
import shapely
from pyogrio.raw import write_arrow

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data_product_versions as versions  # noqa: E402
from freeze_wse_polygons_version import (  # noqa: E402
    GAUGE_TNC_FLOWLINE_COMID,  # noqa: F401  (used by validate_wse_polygons_m2_version.py)
    VERSIONS_TABLE_NAME,
    VERSIONS_TABLE_SCHEMA,  # noqa: F401  (used by validate_wse_polygons_m2_version.py)
    assemble_prepared_water_surface_polygon,
    build_versions_table_row,
    built_from_modeled_wse_version,
    describe_files,
    dry_run_version_folder,
    input_dataset_ids_and_water_years,
    method_code_files_changed_since_stage_4,
    read_json,
    repository_relative,
    text_field,
    tnc_comid_of_segment_id,
    verify_stage_4_time_series_inputs_match_stage_3_outputs,
    write_versions_table,
    zip_file_geodatabase,
)

# ---------------------------------------------------------------------------
# Version identity
# ---------------------------------------------------------------------------

PRODUCT = "wse-polygons"
# The registry method id adds the modeled WSE method number to the pipeline method id (data/README.md).
METHOD_ID = "m2-height-above-nearest-drainage-fill"
METHOD_NUMBER = 2
VERSION_NUMBER = 1
VERSION_LABEL = "m2-v1"
ARCGIS_PREFIX = "wse_polygons_m2_v1"
CHANGE_TYPE = "new method"
CHANGE_NOTE = (
    "First version of the HAND (height above nearest drainage) bed-parallel polygons (experimental): Stage 4 "
    "height-above-nearest-drainage-fill v1 built from modeled-wse m2-v1; bucket bounds are water depths and ring "
    "vertices carry the bed as Z; output looks fragmented where modeled depth is a few centimeters on 1 m terrain."
)
# The registry has no "experimental" status; experimental is said in change_note.
INITIAL_STATUS = "active"

EXTENT_ID = "dangermond-preserve"
PIPELINE_METHOD_ID = "height-above-nearest-drainage-fill"
PIPELINE_METHOD_VERSION = 1

SERVICE_TITLE = "Creek Water Visualization — WSE Polygons"
SERVICE_NAME = "creek_water_visualization_wse_polygons"
POLYGON_LAYER_NAME = ARCGIS_PREFIX
FILE_GEODATABASE_FOLDER_NAME = f"{ARCGIS_PREFIX}.gdb"
UPLOAD_ZIP_NAME = "wse-polygons-m2-v1.gdb.zip"

BUCKET_BOUNDS_NOTE = (
    "min_depth_m and max_depth_m are WATER DEPTHS in meters above the local bed reference, half-open [min, max); "
    "they are not water-surface elevations. Stage 4's JSON calls them minWaterSurfaceElevationM / "
    "maxWaterSurfaceElevationM to keep the file shape."
)
VERTEX_Z_NOTE = (
    "Geometry Z of every vertex is the local bed reference elevation (m NAVD88, 3 decimals), the third number of the "
    "source ring vertex [longitude, latitude, bedReferenceM]. Z is the bed, not the water surface."
)
BROWSER_DRAWING_NOTE = (
    "browserDrawing bed-parallel-depth: draw each vertex at z + depth, where depth is the modeled depth at the selected "
    "time interpolated between the segment's junction depths; pick the bucket that holds the anchor depth "
    "(value − anchorBedElevationM)."
)
Z_STORAGE_NOTE = "native geometry Z (MultiPolygon Z in the file geodatabase); read-back verified by validate_wse_polygons_m2_version.py"

# ---------------------------------------------------------------------------
# Source paths
# ---------------------------------------------------------------------------

EXTENT_WORKING_OUTPUT_FOLDER = versions.PIPELINE_WORKING_OUTPUT_FOLDER / EXTENT_ID
STAGE_4_METHOD_VERSION_FOLDER = (
    EXTENT_WORKING_OUTPUT_FOLDER / "04-water-surface-polygons" / PIPELINE_METHOD_ID / f"v{PIPELINE_METHOD_VERSION}"
)
STAGE_4_MANIFEST_PATH = STAGE_4_METHOD_VERSION_FOLDER / "manifest.json"
WATER_SURFACE_POLYGON_SETS_FOLDER = STAGE_4_METHOD_VERSION_FOLDER / "water-surface-polygon-sets"

POLYGON_LAYER_ATTRIBUTE_SCHEMA = pa.schema(
    [
        text_field("segment_id", 32),
        text_field("tnc_comid", 16),
        pa.field("sub_segment_index", pa.int16()),
        pa.field("bucket_index", pa.int32()),
        pa.field("min_depth_m", pa.float64()),
        pa.field("max_depth_m", pa.float64()),
        pa.field("ring_count", pa.int32()),
        pa.field("vertex_count", pa.int32()),
    ]
)


def log(message: str) -> None:
    print(f"[freeze-wse-polygons-m2] {message}", flush=True)


# ---------------------------------------------------------------------------
# Reading Stage 4 polygon sets (shared with the validation script)
# ---------------------------------------------------------------------------


def iterate_source_depth_buckets() -> Iterator[dict]:
    """Every depth bucket of every Creek Segment, empty ones included, in file order.

    Yields {segment_id, tnc_comid, bucket_index, min_depth_m, max_depth_m, rings}. Each ring is closed
    (first vertex repeated last) and each vertex is [longitude, latitude, bedReferenceM].
    """
    for polygon_set_path in sorted(WATER_SURFACE_POLYGON_SETS_FOLDER.glob("*.json")):
        polygon_set_file = json.loads(polygon_set_path.read_text(encoding="utf-8"))
        for polygon_set in polygon_set_file["waterSurfacePolygonSets"]:
            segment_id = polygon_set["segmentId"]
            for bucket_index, bucket in enumerate(polygon_set["elevationBuckets"]):
                yield {
                    "segment_id": segment_id,
                    "tnc_comid": tnc_comid_of_segment_id(segment_id),
                    "bucket_index": bucket_index,
                    # Stage 4 keeps the m1 field names; for this method they hold DEPTHS in meters.
                    "min_depth_m": bucket["minWaterSurfaceElevationM"],
                    "max_depth_m": bucket["maxWaterSurfaceElevationM"],
                    "rings": bucket["ringsWgs84"],
                }


def check_rings_are_three_dimensional(rings: list[list[list[float]]], segment_id: str, bucket_index: int) -> None:
    for ring in rings:
        coordinates = np.asarray(ring, dtype=float)
        if coordinates.ndim != 2 or coordinates.shape[1] != 3 or not np.all(np.isfinite(coordinates)):
            raise ValueError(f"{segment_id} bucket {bucket_index}: ring vertices must be finite [lon, lat, bedReferenceM]")


# ---------------------------------------------------------------------------
# Source integrity checks
# ---------------------------------------------------------------------------


def verify_polygon_set_files_match_stage_4_manifest(stage_4_manifest: dict) -> int:
    """Every polygon-set file on disk must hash to the value Stage 4 recorded for it."""
    recorded_outputs = stage_4_manifest["outputs"]
    polygon_set_paths = sorted(WATER_SURFACE_POLYGON_SETS_FOLDER.glob("*.json"))
    for polygon_set_path in polygon_set_paths:
        relative_path = repository_relative(polygon_set_path)
        recorded = recorded_outputs.get(relative_path)
        if recorded is None:
            raise RuntimeError(f"{relative_path} is not listed in the Stage 4 manifest outputs.")
        if versions.sha256_of_file(polygon_set_path) != recorded["sha256"]:
            raise RuntimeError(f"{relative_path} changed since Stage 4 completed (sha256 differs from manifest).")
    recorded_polygon_set_count = sum(1 for key in recorded_outputs if "/water-surface-polygon-sets/" in key)
    if recorded_polygon_set_count != len(polygon_set_paths):
        raise RuntimeError(
            f"Stage 4 manifest lists {recorded_polygon_set_count} polygon-set files, disk has {len(polygon_set_paths)}."
        )
    return len(polygon_set_paths)


# ---------------------------------------------------------------------------
# File geodatabase writing (Arrow tables give explicit field types and text widths)
# ---------------------------------------------------------------------------


def write_polygon_layer(file_geodatabase_path: Path, attribute_rows: dict[str, list], geometries: list) -> None:
    """Writes the layer as MultiPolygon Z (native geometry Z, EPSG:4326)."""
    attribute_table = pa.table(attribute_rows, schema=POLYGON_LAYER_ATTRIBUTE_SCHEMA)
    geometry_field = pa.field("geometry", pa.binary(), metadata={"ARROW:extension:name": "geoarrow.wkb"})
    geometry_column = pa.array(shapely.to_wkb(np.asarray(geometries, dtype=object), output_dimension=3), type=pa.binary())
    table = attribute_table.append_column(geometry_field, geometry_column)
    write_arrow(
        table,
        str(file_geodatabase_path),
        layer=POLYGON_LAYER_NAME,
        driver="OpenFileGDB",
        geometry_name="geometry",
        geometry_type="MultiPolygon Z",
        crs="EPSG:4326",
    )


# ---------------------------------------------------------------------------
# Building the version
# ---------------------------------------------------------------------------


def build_polygon_features() -> tuple[dict[str, list], list, dict]:
    """Assemble one feature per non-empty bucket and count everything the version records."""
    attribute_rows: dict[str, list] = {field.name: [] for field in POLYGON_LAYER_ATTRIBUTE_SCHEMA}
    geometries: list = []
    counts = {
        "depth_buckets": 0,
        "empty_buckets_skipped": 0,
        "features": 0,
        "rings": 0,
        "vertices_including_ring_closure": 0,
        "buckets_with_holes": 0,
        "buckets_with_multiple_outer_rings": 0,
        "buckets_with_hole_listed_first": 0,
        "holes_assigned_by_overlap": 0,
        "zero_area_rings": 0,
        "creek_segments": 0,
    }
    z_minimum, z_maximum = np.inf, -np.inf
    depth_minimum, depth_maximum = np.inf, -np.inf
    started = time.monotonic()
    last_segment_id = None
    for bucket in iterate_source_depth_buckets():
        counts["depth_buckets"] += 1
        if bucket["segment_id"] != last_segment_id:
            counts["creek_segments"] += 1
            last_segment_id = bucket["segment_id"]
        rings = bucket["rings"]
        if not rings:
            counts["empty_buckets_skipped"] += 1
            continue
        check_rings_are_three_dimensional(rings, bucket["segment_id"], bucket["bucket_index"])
        geometry, statistics = assemble_prepared_water_surface_polygon(rings)
        if not geometry.has_z:
            raise RuntimeError(f"{bucket['segment_id']} bucket {bucket['bucket_index']}: assembled geometry lost its Z.")
        vertex_count = sum(len(ring) for ring in rings)
        attribute_rows["segment_id"].append(bucket["segment_id"])
        attribute_rows["tnc_comid"].append(bucket["tnc_comid"])
        attribute_rows["sub_segment_index"].append(0)
        attribute_rows["bucket_index"].append(bucket["bucket_index"])
        attribute_rows["min_depth_m"].append(bucket["min_depth_m"])
        attribute_rows["max_depth_m"].append(bucket["max_depth_m"])
        attribute_rows["ring_count"].append(len(rings))
        attribute_rows["vertex_count"].append(vertex_count)
        geometries.append(geometry)
        z_values = shapely.get_coordinates(geometry, include_z=True)[:, 2]
        z_minimum, z_maximum = min(z_minimum, float(z_values.min())), max(z_maximum, float(z_values.max()))
        depth_minimum, depth_maximum = min(depth_minimum, bucket["min_depth_m"]), max(depth_maximum, bucket["max_depth_m"])
        counts["features"] += 1
        counts["rings"] += len(rings)
        counts["vertices_including_ring_closure"] += vertex_count
        counts["buckets_with_holes"] += statistics["hole_ring_count"] > 0
        counts["buckets_with_multiple_outer_rings"] += statistics["outer_ring_count"] > 1
        counts["buckets_with_hole_listed_first"] += statistics["hole_listed_first"]
        counts["holes_assigned_by_overlap"] += statistics["holes_assigned_by_overlap"]
        counts["zero_area_rings"] += statistics["zero_area_ring_count"]
        if counts["depth_buckets"] % 20000 == 0:
            log(f"  assembled {counts['depth_buckets']:,} buckets ({time.monotonic() - started:.1f} s)")
    counts = {key: int(value) for key, value in counts.items()}
    counts["vertex_z_range_m"] = [round(z_minimum, 3), round(z_maximum, 3)]
    counts["bucket_depth_range_m"] = [depth_minimum, depth_maximum]
    return attribute_rows, geometries, counts


def build_version_record(stage_4_manifest: dict, counts: dict, extra: dict) -> dict:
    method_record = stage_4_manifest["parameters"]["wsePolygonGenerationMethod"]
    if method_record["id"] != PIPELINE_METHOD_ID or method_record["version"] != PIPELINE_METHOD_VERSION:
        raise RuntimeError(f"Stage 4 manifest is for {method_record['id']} v{method_record['version']}, not v{PIPELINE_METHOD_VERSION}.")
    if method_record["browserDrawing"] != "bed-parallel-depth":
        raise RuntimeError(f"Stage 4 browserDrawing is {method_record['browserDrawing']}, expected bed-parallel-depth.")
    method_commit, method_date_basis = versions.git_first_commit_with_method_code(method_record["codeSha256ByFile"])
    method_code_paths = [versions.REPOSITORY_ROOT / path for path in method_record["codeSha256ByFile"]]
    fingerprint = versions.code_fingerprint(method_code_paths)
    dataset_ids, water_years = input_dataset_ids_and_water_years(stage_4_manifest)
    built_from = built_from_modeled_wse_version(stage_4_manifest)
    built_from_label = f"{built_from['product']} {built_from['version_label']}"

    return {
        "product": PRODUCT,
        "method_id": METHOD_ID,
        "method_number": METHOD_NUMBER,
        "version_number": VERSION_NUMBER,
        "version_label": VERSION_LABEL,
        "arcgis_prefix": ARCGIS_PREFIX,
        "status": INITIAL_STATUS,
        "change_type": CHANGE_TYPE,
        "change_note": CHANGE_NOTE,
        "method_date_utc": method_commit["date_utc"],
        "method_date_basis": method_date_basis,
        "method_commit": method_commit["commit"],
        "generated_at_utc": stage_4_manifest["completedAt"],
        "frozen_at_utc": versions.utc_now_iso(),
        "frozen_from_commit": versions.git_head_commit(),
        "code_fingerprint": fingerprint["sha256"],
        "code_fingerprint_basis": (
            "sha256 over sorted 'path:sha256' lines of the Stage 4 manifest's codeSha256ByFile files, "
            "hashed from the working tree at freeze (verified equal to the manifest hashes)"
        ),
        "code_fingerprint_files": fingerprint["files"],
        "working_tree_differs_from_head": versions.git_uncommitted_paths(method_code_paths),
        "segment_network_version": stage_4_manifest["parameters"]["segmentNetworkVersion"],
        "extent_id": EXTENT_ID,
        "dataset_ids": dataset_ids,
        "water_years": water_years,
        "water_years_note": (
            "Stage 4 built each Creek Segment's depth-bucket ladder from every modeled depth it read: "
            "national-water-model-hourly WY2018–WY2023 and california-natural-flows-monthly 1950–2024. "
            "Service A publishes national-water-model-hourly WY2021–WY2023 only."
        ),
        "derivation_summary": f"{method_record['description']} Built from {built_from_label}.",
        "built_from_modeled_wse_version": {key: built_from[key] for key in ("product", "method_id", "version_label")},
        "built_from_modeled_wse_method_sha256": built_from["method_sha256"],
        "pipeline_method_id": method_record["id"],
        "pipeline_method_version": method_record["version"],
        "pipeline_method_label": method_record["label"],
        "browser_drawing": method_record["browserDrawing"],
        "browser_drawing_rule": BROWSER_DRAWING_NOTE,
        "bucket_bounds": {
            "unit": "water depth in meters above the local bed reference (not water-surface elevation)",
            "columns": ["min_depth_m", "max_depth_m"],
            "interval": "half-open [min_depth_m, max_depth_m)",
            "note": BUCKET_BOUNDS_NOTE,
        },
        "vertex_z": {
            "meaning": "local bed reference elevation, m NAVD88 (North American Vertical Datum of 1988), 3 decimals",
            "drawn_at": "z + depth",
            "storage": Z_STORAGE_NOTE,
            "side_column_fallback_used": False,
            "note": VERTEX_Z_NOTE,
        },
        "method_sha256": method_record["methodSha256"],
        "method_parameters": method_record["parameters"],
        "method_code_sha256_by_file": method_record["codeSha256ByFile"],
        "arcgis_service_title": SERVICE_TITLE,
        "arcgis_service_name": SERVICE_NAME,
        "arcgis_table_names": [VERSIONS_TABLE_NAME, POLYGON_LAYER_NAME],
        "polygon_layer": {
            "name": POLYGON_LAYER_NAME,
            "spatial_reference": "EPSG:4326",
            "geometry_type": "MultiPolygon Z (native Z = local bed reference elevation, m NAVD88)",
            "one_feature_per": "non-empty depth bucket (Prepared water-surface polygon)",
            "bucket_bound_columns": "min_depth_m / max_depth_m are water DEPTHS in meters, not elevations; draw at z + depth",
            "geometry_assembly": (
                "by ring orientation: clockwise = outer ring, counter-clockwise = hole; each hole goes to the "
                "smallest outer ring covering it; ring coordinates (including Z) and vertex order unchanged"
            ),
            "vertex_count_convention": "vertices per ring including the repeated closing vertex, as stored in ringsWgs84",
            "sub_segment_index": "always 0; reserved for future downhill sub-segments",
            "bucket_index": "index in the Creek Segment's original depth-bucket array, empty buckets included",
        },
        "counts": counts,
        "source_checks": extra,
        "source": {
            "stage_4_folder": repository_relative(STAGE_4_METHOD_VERSION_FOLDER),
            "stage_4_completed_at": stage_4_manifest["completedAt"],
            "stage_4_manifest_counts": stage_4_manifest["counts"],
        },
        "published_at_utc": None,
    }


def build_registry_version_record(version_record: dict, version_folder: Path, upload_zip_path: Path) -> dict:
    return {
        "version_label": VERSION_LABEL,
        "method_id": METHOD_ID,
        "method_number": METHOD_NUMBER,
        "version_number": VERSION_NUMBER,
        "status": INITIAL_STATUS,
        "change_type": CHANGE_TYPE,
        "change_note": CHANGE_NOTE,
        "method_date_utc": version_record["method_date_utc"],
        "generated_at_utc": version_record["generated_at_utc"],
        "frozen_at_utc": version_record["frozen_at_utc"],
        "frozen_from_commit": version_record["frozen_from_commit"],
        "built_from_modeled_wse_version": version_record["built_from_modeled_wse_version"],
        "pipeline_method_id": PIPELINE_METHOD_ID,
        "pipeline_method_version": PIPELINE_METHOD_VERSION,
        "method_sha256": version_record["method_sha256"],
        "browser_drawing": version_record["browser_drawing"],
        "bucket_bounds": "water depth in meters above the local bed reference (min_depth_m / max_depth_m), not elevation",
        "version_folder": repository_relative(version_folder),
        "arcgis_upload_sha256": versions.sha256_of_file(upload_zip_path),
        "arcgis_prefix": ARCGIS_PREFIX,
        "arcgis_table_names": [VERSIONS_TABLE_NAME, POLYGON_LAYER_NAME],
        "feature_count": version_record["counts"]["features"],
        "arcgis": {
            "file_geodatabase_item_id": None,
            "service_item_id": None,
            "service_url": None,
            "versions_table_layer_id": None,
            "polygon_layer_id": None,
            "published_at_utc": None,
        },
    }


def check_built_from_frozen_modeled_wse_version(built_from: dict, registry: dict) -> bool:
    """True when the modeled WSE version is registered; its frozen version.json must carry the fingerprint Stage 4 recorded."""
    modeled_versions = registry.get("products", {}).get(built_from["product"], {}).get("versions", [])
    entry = next(
        (v for v in modeled_versions if v.get("version_label") == built_from["version_label"] and v.get("method_id") == built_from["method_id"]),
        None,
    )
    if entry is None:
        return False
    frozen_version_json = versions.REPOSITORY_ROOT / entry["version_folder"] / "version.json"
    if frozen_version_json.exists():
        recorded = json.loads(frozen_version_json.read_text(encoding="utf-8")).get("method_sha256")
        if recorded != built_from["method_sha256"]:
            raise RuntimeError(
                f"Stage 4 was built from {built_from['product']} {built_from['version_label']} fingerprint "
                f"{built_from['method_sha256'][:12]}…, but the frozen version.json holds {str(recorded)[:12]}…."
            )
    return True


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--dry-run-into",
        type=Path,
        help="Write the version to this new scratch folder instead of data-product-versions/, and leave the registry alone.",
    )
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    dry_run_folder: Path | None = arguments.dry_run_into.resolve() if arguments.dry_run_into else None
    started = time.monotonic()
    final_folder = dry_run_folder or versions.version_folder_path(PRODUCT, METHOD_ID, VERSION_LABEL)
    if dry_run_folder is None and final_folder.exists():
        raise versions.VersionFolderAlreadyExistsError(
            f"{final_folder} already exists; versions are append-only. Freeze a new version label instead."
        )
    log(f"Freezing {PRODUCT} {VERSION_LABEL} into {final_folder}{' (dry run)' if dry_run_folder else ''}")

    stage_4_manifest = read_json(STAGE_4_MANIFEST_PATH)
    method_record = stage_4_manifest["parameters"]["wsePolygonGenerationMethod"]
    log("Checking source integrity …")
    polygon_set_file_count = verify_polygon_set_files_match_stage_4_manifest(stage_4_manifest)
    time_series_input_count = verify_stage_4_time_series_inputs_match_stage_3_outputs(stage_4_manifest)
    changed_code_files = method_code_files_changed_since_stage_4(method_record)
    if changed_code_files:
        raise RuntimeError(
            "WSE Polygon Generation Method code changed since Stage 4 ran; the frozen code fingerprint would not "
            f"describe this output: {changed_code_files}"
        )
    registry = versions.read_registry()
    for version in registry.get("products", {}).get(PRODUCT, {}).get("versions", []):
        if version.get("version_label") == VERSION_LABEL:
            raise SystemExit(f"Registry already has {PRODUCT} {VERSION_LABEL} ({version.get('method_id')}); versions are append-only.")
    built_from = built_from_modeled_wse_version(stage_4_manifest)
    built_from_is_registered = check_built_from_frozen_modeled_wse_version(built_from, registry)
    source_checks = {
        "polygon_set_files_match_stage_4_manifest_sha256": polygon_set_file_count,
        "stage_4_time_series_inputs_match_stage_3_output_sha256": time_series_input_count,
        "method_code_files_match_stage_4_manifest_sha256": len(method_record["codeSha256ByFile"]),
        "built_from_modeled_wse_version_in_registry_at_freeze": built_from_is_registered,
    }
    log(f"  {polygon_set_file_count} polygon-set files and {time_series_input_count} time-series inputs verified.")
    if not built_from_is_registered:
        log(f"  note: {built_from['product']} {built_from['version_label']} is not in the registry yet (the freeze still records the dependency).")

    log("Assembling Prepared water-surface polygons (Z kept) by ring orientation …")
    attribute_rows, geometries, counts = build_polygon_features()
    expected_buckets = stage_4_manifest["counts"]["depthBuckets"]
    expected_empty = stage_4_manifest["counts"]["emptyBuckets"]
    if counts["depth_buckets"] != expected_buckets or counts["empty_buckets_skipped"] != expected_empty:
        raise RuntimeError(f"Bucket counts {counts} disagree with Stage 4 manifest counts {stage_4_manifest['counts']}.")
    if counts["vertices_including_ring_closure"] != stage_4_manifest["counts"]["ringVertices"]:
        raise RuntimeError("Vertex count disagrees with Stage 4 manifest ringVertices.")
    if counts["creek_segments"] != stage_4_manifest["counts"]["creekSegments"]:
        raise RuntimeError("Creek Segment count disagrees with Stage 4 manifest creekSegments.")
    log(f"  {counts['features']:,} features from {counts['depth_buckets']:,} buckets ({counts['empty_buckets_skipped']:,} empty skipped).")
    log(
        f"  buckets with holes {counts['buckets_with_holes']:,}, multiple outer rings "
        f"{counts['buckets_with_multiple_outer_rings']:,}, hole listed first {counts['buckets_with_hole_listed_first']:,}, "
        f"holes assigned by overlap {counts['holes_assigned_by_overlap']}, zero-area rings {counts['zero_area_rings']}."
    )
    log(f"  vertex Z (bed reference) {counts['vertex_z_range_m'][0]}–{counts['vertex_z_range_m'][1]} m; bucket depths {counts['bucket_depth_range_m']} m.")

    version_record = build_version_record(stage_4_manifest, counts, source_checks)
    versions_row = build_versions_table_row(version_record)

    if dry_run_folder is not None:
        version_folder_context = dry_run_version_folder(dry_run_folder)
    else:
        version_folder_context = versions.staged_version_folder(PRODUCT, METHOD_ID, VERSION_LABEL)
    with version_folder_context as staging_folder:
        source_manifests_folder = staging_folder / "source-manifests"
        source_manifests_folder.mkdir()
        shutil.copy2(STAGE_4_MANIFEST_PATH, source_manifests_folder / "04-manifest.json")

        upload_zip_path = staging_folder / "arcgis-upload" / UPLOAD_ZIP_NAME
        with tempfile.TemporaryDirectory(prefix="wse-polygons-m2-gdb-") as temporary_folder:
            file_geodatabase_path = Path(temporary_folder) / FILE_GEODATABASE_FOLDER_NAME
            log(f"Writing {FILE_GEODATABASE_FOLDER_NAME}: table {VERSIONS_TABLE_NAME} …")
            write_versions_table(file_geodatabase_path, versions_row)
            log(f"Writing {FILE_GEODATABASE_FOLDER_NAME}: polygon layer {POLYGON_LAYER_NAME} ({len(geometries):,} features, Z) …")
            write_polygon_layer(file_geodatabase_path, attribute_rows, geometries)
            layer_info = pyogrio.read_info(str(file_geodatabase_path), layer=POLYGON_LAYER_NAME)
            if layer_info["features"] != counts["features"]:
                raise RuntimeError(f"File geodatabase holds {layer_info['features']} features, expected {counts['features']}.")
            if layer_info["geometry_type"] != "MultiPolygon Z":
                raise RuntimeError(f"File geodatabase layer geometry type is {layer_info['geometry_type']}, expected MultiPolygon Z.")
            log(f"Zipping into arcgis-upload/{UPLOAD_ZIP_NAME} …")
            zip_file_geodatabase(file_geodatabase_path, upload_zip_path)

        version_record["files"] = describe_files(staging_folder)
        versions.write_json(staging_folder / "version.json", version_record)

    if dry_run_folder is not None:
        log(f"Dry run written to {dry_run_folder}; registry not changed. Done in {time.monotonic() - started:.1f} s.")
        return
    log(f"Version folder written: {repository_relative(final_folder)}/")
    registry_record = build_registry_version_record(version_record, final_folder, final_folder / "arcgis-upload" / UPLOAD_ZIP_NAME)
    versions.update_registry_version(
        PRODUCT,
        registry_record,
        product_fields={"title": SERVICE_TITLE, "arcgis_service_name": SERVICE_NAME},
    )
    log(f"Registry updated: {repository_relative(versions.DATA_PRODUCT_VERSION_REGISTRY_PATH)} ({PRODUCT} {VERSION_LABEL}).")
    log(f"Done in {time.monotonic() - started:.1f} s.")


if __name__ == "__main__":
    main()
