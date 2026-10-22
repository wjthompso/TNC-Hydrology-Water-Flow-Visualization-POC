"""Freeze WSE polygons m1-v1 as an append-only data-product version (UCS-285).

Copies the Stage 4 output of WSE Polygon Generation Method `junction-sloped-terrain-fill` v1
(extent dangermond-preserve, built from modeled-wse m1-v1) into

    data/data-product-versions/wse-polygons/m1-junction-sloped-terrain-fill/m1-v1/
      version.json
      source-manifests/04-manifest.json
      arcgis-upload/wse-polygons-m1-v1.gdb.zip

The zipped file geodatabase holds the two parts of ArcGIS Service B:
  - table `wse_polygon_versions`: one row describing this version
  - polygon layer `wse_polygons_m1_v1` (EPSG 4326, 2D): one Prepared water-surface polygon per
    non-empty elevation bucket

Each bucket's geometry is assembled by ring ORIENTATION (Esri convention): clockwise rings are
outer rings, counter-clockwise rings are holes. Each hole goes to the outer ring that covers it;
several outer rings make a MultiPolygon. Every feature is written as a MultiPolygon.

Afterwards the wse-polygons entry is merged into data/data-product-version-registry.json with
null ArcGIS fields (filled in later by publishing). Local only; no portal access.

Run:
    conda run --no-capture-output -p <Data-Pipeline>/conda-env python \
      pipelines/creek-visualization-data-production/arcgis-publishing/freeze_wse_polygons_version.py
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Iterator

import numpy as np
import pyarrow as pa
import pyogrio
import shapely
from pyogrio.raw import write_arrow

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data_product_versions as versions  # noqa: E402

# ---------------------------------------------------------------------------
# Version identity
# ---------------------------------------------------------------------------

PRODUCT = "wse-polygons"
METHOD_ID = "m1-junction-sloped-terrain-fill"
METHOD_NUMBER = 1
VERSION_NUMBER = 1
VERSION_LABEL = "m1-v1"
ARCGIS_PREFIX = "wse_polygons_m1_v1"
CHANGE_TYPE = "new method"
CHANGE_NOTE = (
    "First frozen version: WSE Polygon Generation Method junction-sloped-terrain-fill v1 "
    "(Stage 4 output of 2026-10-19), built from modeled-wse m1-v1."
)
INITIAL_STATUS = "active"

EXTENT_ID = "dangermond-preserve"
PIPELINE_METHOD_ID = "junction-sloped-terrain-fill"
PIPELINE_METHOD_VERSION = 1
# The modeled WSE version a polygon version was built from is read from the Stage 4 manifest
# (parameters.builtFromModeledWseVersion), which Stage 4 wrote from the Time Series it read (UCS-296).

SERVICE_TITLE = "Creek Water Visualization — WSE Polygons"
SERVICE_NAME = "creek_water_visualization_wse_polygons"
VERSIONS_TABLE_NAME = "wse_polygon_versions"
POLYGON_LAYER_NAME = ARCGIS_PREFIX
FILE_GEODATABASE_FOLDER_NAME = f"{ARCGIS_PREFIX}.gdb"
UPLOAD_ZIP_NAME = "wse-polygons-m1-v1.gdb.zip"

LONG_TEXT_WIDTH = 32000

# ---------------------------------------------------------------------------
# Source paths
# ---------------------------------------------------------------------------

EXTENT_WORKING_OUTPUT_FOLDER = versions.PIPELINE_WORKING_OUTPUT_FOLDER / EXTENT_ID
STAGE_3_FOLDER = EXTENT_WORKING_OUTPUT_FOLDER / "03-time-series"
STAGE_4_METHOD_VERSION_FOLDER = (
    EXTENT_WORKING_OUTPUT_FOLDER / "04-water-surface-polygons" / PIPELINE_METHOD_ID / f"v{PIPELINE_METHOD_VERSION}"
)
STAGE_4_MANIFEST_PATH = STAGE_4_METHOD_VERSION_FOLDER / "manifest.json"
WATER_SURFACE_POLYGON_SETS_FOLDER = STAGE_4_METHOD_VERSION_FOLDER / "water-surface-polygon-sets"
WSE_POLYGON_GENERATION_METHOD_CODE_FOLDER = (
    versions.REPOSITORY_ROOT
    / "pipelines/creek-visualization-data-production/modeled-water-surface-elevation"
    / "wse-polygon-generation-methods"
    / PIPELINE_METHOD_ID
)

GAUGE_TNC_FLOWLINE_COMID = "27714637"


def log(message: str) -> None:
    print(f"[freeze-wse-polygons] {message}", flush=True)


# ---------------------------------------------------------------------------
# Reading Stage 4 polygon sets (shared with the validation script)
# ---------------------------------------------------------------------------


def tnc_comid_of_segment_id(segment_id: str) -> str:
    return segment_id.split("-")[0]


def iterate_source_elevation_buckets() -> Iterator[dict]:
    """Every elevation bucket of every Creek Segment, empty ones included, in file order.

    Yields {segment_id, tnc_comid, bucket_index, min_wse_m, max_wse_m, rings} where rings is the
    bucket's ringsWgs84 list (each ring closed: first vertex repeated last).
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
                    "min_wse_m": bucket["minWaterSurfaceElevationM"],
                    "max_wse_m": bucket["maxWaterSurfaceElevationM"],
                    "rings": bucket["ringsWgs84"],
                }


# ---------------------------------------------------------------------------
# Geometry assembly by ring orientation
# ---------------------------------------------------------------------------


def signed_ring_area(ring: list[list[float]]) -> float:
    """Shoelace signed area in degrees² (x = longitude, y = latitude).

    Negative = clockwise (Esri outer ring), positive = counter-clockwise (Esri hole).
    """
    coordinates = np.asarray(ring, dtype=float)
    x = coordinates[:, 0]
    y = coordinates[:, 1]
    return 0.5 * float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]) + (x[-1] * y[0] - x[0] * y[-1]))


def is_clockwise_ring(ring: list[list[float]]) -> bool:
    return signed_ring_area(ring) < 0


def assemble_prepared_water_surface_polygon(rings: list[list[list[float]]]) -> tuple[shapely.MultiPolygon, dict]:
    """Build one MultiPolygon from a bucket's rings using orientation, not ring position.

    Clockwise rings are outer rings; counter-clockwise rings are holes. Each hole goes to the
    smallest outer ring that covers it. A hole no outer ring covers (an invalid crossing) goes to
    the outer ring it overlaps most and is counted. Zero-area rings count as outer rings and are
    counted. Ring coordinates and vertex order are kept exactly as stored.
    """
    outer_rings: list[list[list[float]]] = []
    hole_rings: list[list[list[float]]] = []
    zero_area_ring_count = 0
    for ring in rings:
        area = signed_ring_area(ring)
        if area == 0:
            zero_area_ring_count += 1
        (hole_rings if area > 0 else outer_rings).append(ring)

    if not outer_rings:
        raise ValueError("Bucket has rings but no clockwise outer ring; cannot assemble a polygon.")

    holes_by_outer_index: list[list[list[list[float]]]] = [[] for _ in outer_rings]
    holes_assigned_by_overlap = 0
    if len(outer_rings) == 1:
        holes_by_outer_index[0].extend(hole_rings)
    else:
        outer_shells = [shapely.Polygon(ring) for ring in outer_rings]
        shell_areas = [shell.area for shell in outer_shells]
        for hole_ring in hole_rings:
            hole_shell = shapely.Polygon(hole_ring)
            covering = [index for index, shell in enumerate(outer_shells) if shell.covers(hole_shell)]
            if covering:
                chosen_index = min(covering, key=lambda index: shell_areas[index])
            else:
                overlaps = [shell.intersection(hole_shell).area for shell in outer_shells]
                if max(overlaps) <= 0:
                    raise ValueError("Hole ring lies outside every outer ring of its bucket.")
                chosen_index = int(np.argmax(overlaps))
                holes_assigned_by_overlap += 1
            holes_by_outer_index[chosen_index].append(hole_ring)

    polygons = [shapely.Polygon(outer, holes) for outer, holes in zip(outer_rings, holes_by_outer_index)]
    statistics = {
        "outer_ring_count": len(outer_rings),
        "hole_ring_count": len(hole_rings),
        "hole_listed_first": bool(rings) and signed_ring_area(rings[0]) > 0,
        "holes_assigned_by_overlap": holes_assigned_by_overlap,
        "zero_area_ring_count": zero_area_ring_count,
    }
    return shapely.MultiPolygon(polygons), statistics


# ---------------------------------------------------------------------------
# Source integrity checks
# ---------------------------------------------------------------------------


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def repository_relative(path: Path) -> str:
    return versions.repository_relative_path(path)


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


def built_from_modeled_wse_version(stage_4_manifest: dict) -> dict:
    """The modeled WSE version Stage 4 recorded as its source, in the registry's snake_case field names."""
    recorded = stage_4_manifest.get("parameters", {}).get("builtFromModeledWseVersion")
    if not recorded:
        raise RuntimeError(
            "The Stage 4 manifest has no builtFromModeledWseVersion record. Run Stage 4 (or the UCS-296 migration "
            "migrate-modeled-wse-version-folders.ts) first."
        )
    return {
        "product": recorded["product"],
        "method_id": recorded["methodId"],
        "version_label": recorded["versionLabel"],
        "method_sha256": recorded["methodSha256"],
    }


def stage_3_manifest_path(built_from: dict) -> Path:
    version_number = int(built_from["version_label"].rsplit("-v", 1)[1])
    return STAGE_3_FOLDER / built_from["method_id"] / f"v{version_number}" / "manifest.json"


def verify_stage_4_time_series_inputs_match_stage_3_outputs(stage_4_manifest: dict) -> int:
    """Shows Stage 4 was built from the Stage 3 output of the modeled WSE version it recorded."""
    built_from = built_from_modeled_wse_version(stage_4_manifest)
    stage_3_manifest = read_json(stage_3_manifest_path(built_from))
    recorded_method = stage_3_manifest["parameters"]["modeledWseDerivationMethod"]
    if recorded_method["methodSha256"] != built_from["method_sha256"]:
        raise RuntimeError(
            f"Stage 4 recorded modeled WSE fingerprint {built_from['method_sha256'][:12]}…, "
            f"but its Stage 3 manifest holds {recorded_method['methodSha256'][:12]}…."
        )
    stage_3_outputs = stage_3_manifest["outputs"]
    time_series_inputs = {key: value for key, value in stage_4_manifest["inputs"].items() if "/03-time-series/" in key}
    mismatched = [key for key, sha256 in time_series_inputs.items() if stage_3_outputs.get(key, {}).get("sha256") != sha256]
    if mismatched:
        raise RuntimeError(f"{len(mismatched)} Stage 4 time-series inputs differ from Stage 3 outputs, e.g. {mismatched[0]}.")
    return len(time_series_inputs)


def method_code_files_changed_since_stage_4(method_record: dict) -> list[str]:
    changed = []
    for relative_path, recorded_sha256 in method_record["codeSha256ByFile"].items():
        if versions.sha256_of_file(versions.REPOSITORY_ROOT / relative_path) != recorded_sha256:
            changed.append(relative_path)
    return changed


def input_dataset_ids_and_water_years(stage_4_manifest: dict) -> tuple[list[str], list[str]]:
    dataset_ids: set[str] = set()
    water_years: set[str] = set()
    for key in stage_4_manifest["inputs"]:
        parts = key.split("/")
        if "time-series" not in parts or "03-time-series" not in parts:
            continue
        dataset_ids.add(parts[parts.index("time-series") + 1])
        if parts[-1].startswith("WY"):
            water_years.add(parts[-1].removesuffix(".json"))
    return sorted(dataset_ids), sorted(water_years)


# ---------------------------------------------------------------------------
# File geodatabase writing (Arrow tables give explicit field types and text widths)
# ---------------------------------------------------------------------------


def text_field(name: str, width: int) -> pa.Field:
    return pa.field(name, pa.string(), metadata={"GDAL:OGR:width": str(width)})


def utc_timestamp_ms(iso_text: str | None) -> int | None:
    if iso_text is None:
        return None
    parsed = dt.datetime.fromisoformat(iso_text.replace("Z", "+00:00"))
    return int(parsed.timestamp() * 1000)


VERSIONS_TABLE_SCHEMA = pa.schema(
    [
        text_field("product", 64),
        text_field("method_id", 128),
        pa.field("method_number", pa.int16()),
        pa.field("version_number", pa.int16()),
        text_field("version_label", 32),
        text_field("status", 32),
        text_field("change_type", 32),
        text_field("change_note", 1024),
        pa.field("method_date_utc", pa.timestamp("ms", tz="UTC")),
        pa.field("generated_at_utc", pa.timestamp("ms", tz="UTC")),
        text_field("frozen_from_commit", 64),
        text_field("code_fingerprint", 64),
        text_field("segment_network_version", 64),
        text_field("extent_id", 64),
        text_field("dataset_ids", 256),
        text_field("water_years", 256),
        text_field("derivation_summary", 4000),
        text_field("derivation_json", LONG_TEXT_WIDTH),
        text_field("arcgis_table_names", 1024),
        text_field("raw_hourly_csv_item_ids", 1024),
        pa.field("published_at_utc", pa.timestamp("ms", tz="UTC")),
        text_field("built_from_modeled_wse_version", 128),
        text_field("pipeline_method_id", 128),
        pa.field("pipeline_method_version", pa.int16()),
        text_field("browser_drawing", 64),
        text_field("method_sha256", 64),
        text_field("parameters_json", LONG_TEXT_WIDTH),
        pa.field("empty_buckets_skipped", pa.int32()),
    ]
)

POLYGON_LAYER_ATTRIBUTE_SCHEMA = pa.schema(
    [
        text_field("segment_id", 32),
        text_field("tnc_comid", 16),
        pa.field("sub_segment_index", pa.int16()),
        pa.field("bucket_index", pa.int32()),
        pa.field("min_wse_m", pa.float64()),
        pa.field("max_wse_m", pa.float64()),
        pa.field("ring_count", pa.int32()),
        pa.field("vertex_count", pa.int32()),
    ]
)


def write_versions_table(file_geodatabase_path: Path, versions_row: dict) -> None:
    columns = {}
    for field in VERSIONS_TABLE_SCHEMA:
        value = versions_row[field.name]
        if pa.types.is_timestamp(field.type):
            value = utc_timestamp_ms(value)
        columns[field.name] = [value]
    table = pa.table(columns, schema=VERSIONS_TABLE_SCHEMA)
    write_arrow(
        table,
        str(file_geodatabase_path),
        layer=VERSIONS_TABLE_NAME,
        driver="OpenFileGDB",
        geometry_name=None,
        geometry_type=None,
        crs=None,
    )


def write_polygon_layer(file_geodatabase_path: Path, attribute_rows: dict[str, list], geometries: list) -> None:
    attribute_table = pa.table(attribute_rows, schema=POLYGON_LAYER_ATTRIBUTE_SCHEMA)
    geometry_field = pa.field("geometry", pa.binary(), metadata={"ARROW:extension:name": "geoarrow.wkb"})
    geometry_column = pa.array(shapely.to_wkb(np.asarray(geometries, dtype=object), output_dimension=2), type=pa.binary())
    table = attribute_table.append_column(geometry_field, geometry_column)
    write_arrow(
        table,
        str(file_geodatabase_path),
        layer=POLYGON_LAYER_NAME,
        driver="OpenFileGDB",
        geometry_name="geometry",
        geometry_type="MultiPolygon",
        crs="EPSG:4326",
    )


def zip_file_geodatabase(file_geodatabase_path: Path, zip_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for member in sorted(file_geodatabase_path.rglob("*")):
            if member.is_file() and not member.name.endswith(".lock"):
                archive.write(member, f"{file_geodatabase_path.name}/{member.relative_to(file_geodatabase_path).as_posix()}")


# ---------------------------------------------------------------------------
# Building the version
# ---------------------------------------------------------------------------


def build_polygon_features() -> tuple[dict[str, list], list, dict]:
    """Assemble one feature per non-empty bucket and count everything the version records."""
    attribute_rows: dict[str, list] = {field.name: [] for field in POLYGON_LAYER_ATTRIBUTE_SCHEMA}
    geometries: list = []
    counts = {
        "elevation_buckets": 0,
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
    started = time.monotonic()
    last_segment_id = None
    for bucket in iterate_source_elevation_buckets():
        counts["elevation_buckets"] += 1
        if bucket["segment_id"] != last_segment_id:
            counts["creek_segments"] += 1
            last_segment_id = bucket["segment_id"]
        rings = bucket["rings"]
        if not rings:
            counts["empty_buckets_skipped"] += 1
            continue
        geometry, statistics = assemble_prepared_water_surface_polygon(rings)
        vertex_count = sum(len(ring) for ring in rings)
        attribute_rows["segment_id"].append(bucket["segment_id"])
        attribute_rows["tnc_comid"].append(bucket["tnc_comid"])
        attribute_rows["sub_segment_index"].append(0)
        attribute_rows["bucket_index"].append(bucket["bucket_index"])
        attribute_rows["min_wse_m"].append(bucket["min_wse_m"])
        attribute_rows["max_wse_m"].append(bucket["max_wse_m"])
        attribute_rows["ring_count"].append(len(rings))
        attribute_rows["vertex_count"].append(vertex_count)
        geometries.append(geometry)
        counts["features"] += 1
        counts["rings"] += len(rings)
        counts["vertices_including_ring_closure"] += vertex_count
        counts["buckets_with_holes"] += statistics["hole_ring_count"] > 0
        counts["buckets_with_multiple_outer_rings"] += statistics["outer_ring_count"] > 1
        counts["buckets_with_hole_listed_first"] += statistics["hole_listed_first"]
        counts["holes_assigned_by_overlap"] += statistics["holes_assigned_by_overlap"]
        counts["zero_area_rings"] += statistics["zero_area_ring_count"]
        if counts["elevation_buckets"] % 20000 == 0:
            log(f"  assembled {counts['elevation_buckets']:,} buckets ({time.monotonic() - started:.1f} s)")
    counts = {key: int(value) for key, value in counts.items()}
    return attribute_rows, geometries, counts


def build_version_record(stage_4_manifest: dict, counts: dict, extra: dict) -> dict:
    method_record = stage_4_manifest["parameters"]["wsePolygonGenerationMethod"]
    if method_record["id"] != PIPELINE_METHOD_ID or method_record["version"] != PIPELINE_METHOD_VERSION:
        raise RuntimeError(f"Stage 4 manifest is for {method_record['id']} v{method_record['version']}, not v1.")
    method_commit = versions.git_last_commit(
        [repository_relative(WSE_POLYGON_GENERATION_METHOD_CODE_FOLDER)], before_iso=stage_4_manifest["completedAt"]
    )
    if method_commit is None:
        raise RuntimeError("No git commit touches the WSE Polygon Generation Method folder before Stage 4 completed.")
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
        "method_date_basis": (
            "committer date of the latest git commit touching "
            f"{repository_relative(WSE_POLYGON_GENERATION_METHOD_CODE_FOLDER)}/ at or before Stage 4 completedAt"
        ),
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
        "segment_network_version": stage_4_manifest["parameters"]["segmentNetworkVersion"],
        "extent_id": EXTENT_ID,
        "dataset_ids": dataset_ids,
        "water_years": water_years,
        "water_years_note": (
            "Stage 4 built each Creek Segment's elevation-bucket ladder from every modeled WSE value it read: "
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
        "method_sha256": method_record["methodSha256"],
        "method_parameters": method_record["parameters"],
        "method_code_sha256_by_file": method_record["codeSha256ByFile"],
        "arcgis_service_title": SERVICE_TITLE,
        "arcgis_service_name": SERVICE_NAME,
        "arcgis_table_names": [VERSIONS_TABLE_NAME, POLYGON_LAYER_NAME],
        "polygon_layer": {
            "name": POLYGON_LAYER_NAME,
            "spatial_reference": "EPSG:4326",
            "geometry_type": "MultiPolygon (2D)",
            "one_feature_per": "non-empty elevation bucket (Prepared water-surface polygon)",
            "geometry_assembly": (
                "by ring orientation: clockwise = outer ring, counter-clockwise = hole; each hole goes to the "
                "smallest outer ring covering it; ring coordinates and vertex order unchanged"
            ),
            "vertex_count_convention": "vertices per ring including the repeated closing vertex, as stored in ringsWgs84",
            "sub_segment_index": "always 0; reserved for future downhill sub-segments",
            "bucket_index": "index in the Creek Segment's original elevationBuckets array, empty buckets included",
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


def build_versions_table_row(version_record: dict) -> dict:
    built_from = version_record["built_from_modeled_wse_version"]
    derivation = {
        "wse_polygon_generation_method": {
            "pipeline_method_id": version_record["pipeline_method_id"],
            "pipeline_method_version": version_record["pipeline_method_version"],
            "label": version_record["pipeline_method_label"],
            "browser_drawing": version_record["browser_drawing"],
            "method_sha256": version_record["method_sha256"],
            "code_sha256_by_file": version_record["method_code_sha256_by_file"],
        },
        "built_from_modeled_wse_version": built_from,
        "polygon_layer": version_record["polygon_layer"],
    }
    row = {
        "product": version_record["product"],
        "method_id": version_record["method_id"],
        "method_number": version_record["method_number"],
        "version_number": version_record["version_number"],
        "version_label": version_record["version_label"],
        "status": version_record["status"],
        "change_type": version_record["change_type"],
        "change_note": version_record["change_note"],
        "method_date_utc": version_record["method_date_utc"],
        "generated_at_utc": version_record["generated_at_utc"],
        "frozen_from_commit": version_record["frozen_from_commit"],
        "code_fingerprint": version_record["code_fingerprint"],
        "segment_network_version": version_record["segment_network_version"],
        "extent_id": version_record["extent_id"],
        "dataset_ids": ",".join(version_record["dataset_ids"]),
        "water_years": ",".join(version_record["water_years"]),
        "derivation_summary": version_record["derivation_summary"],
        "derivation_json": json.dumps(derivation, ensure_ascii=False, sort_keys=True),
        "arcgis_table_names": ",".join(version_record["arcgis_table_names"]),
        "raw_hourly_csv_item_ids": None,
        "published_at_utc": None,
        "built_from_modeled_wse_version": f"{built_from['product']}/{built_from['method_id']}/{built_from['version_label']}",
        "pipeline_method_id": version_record["pipeline_method_id"],
        "pipeline_method_version": version_record["pipeline_method_version"],
        "browser_drawing": version_record["browser_drawing"],
        "method_sha256": version_record["method_sha256"],
        "parameters_json": json.dumps(version_record["method_parameters"], ensure_ascii=False, sort_keys=True),
        "empty_buckets_skipped": version_record["counts"]["empty_buckets_skipped"],
    }
    for field in VERSIONS_TABLE_SCHEMA:
        width = field.metadata and field.metadata.get(b"GDAL:OGR:width")
        value = row[field.name]
        if width and isinstance(value, str) and len(value) > int(width):
            raise RuntimeError(f"{VERSIONS_TABLE_NAME}.{field.name} is {len(value)} characters; width is {int(width)}.")
    return row


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


def describe_files(folder: Path) -> list[dict]:
    return [
        {"path": path.relative_to(folder).as_posix(), "bytes": path.stat().st_size, "sha256": versions.sha256_of_file(path)}
        for path in sorted(folder.rglob("*"))
        if path.is_file()
    ]


@contextlib.contextmanager
def dry_run_version_folder(dry_run_folder: Path) -> Iterator[Path]:
    """Stand-in for versions.staged_version_folder that writes to a scratch folder instead."""
    if dry_run_folder.exists():
        raise RuntimeError(f"Dry-run folder already exists: {dry_run_folder}")
    dry_run_folder.mkdir(parents=True)
    yield dry_run_folder


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
    built_from = built_from_modeled_wse_version(stage_4_manifest)
    modeled_wse_versions = registry.get("products", {}).get(built_from["product"], {}).get("versions", [])
    built_from_registry_entry = next((v for v in modeled_wse_versions if v.get("version_label") == built_from["version_label"]), None)
    built_from_is_registered = built_from_registry_entry is not None
    if built_from_is_registered and built_from_registry_entry.get("method_sha256") not in (None, built_from["method_sha256"]):
        raise RuntimeError(
            f"{built_from['product']} {built_from['version_label']} is registered with a different fingerprint than the one "
            "Stage 4 recorded; the polygons were not built from the frozen modeled WSE version."
        )
    source_checks = {
        "polygon_set_files_match_stage_4_manifest_sha256": polygon_set_file_count,
        "stage_4_time_series_inputs_match_stage_3_output_sha256": time_series_input_count,
        "method_code_files_match_stage_4_manifest_sha256": len(method_record["codeSha256ByFile"]),
        "built_from_modeled_wse_version_in_registry_at_freeze": built_from_is_registered,
    }
    log(f"  {polygon_set_file_count} polygon-set files and {time_series_input_count} time-series inputs verified.")
    if not built_from_is_registered:
        log(f"  note: {built_from['product']} {built_from['version_label']} is not in the registry yet (the freeze still records the dependency).")

    log("Assembling Prepared water-surface polygons by ring orientation …")
    attribute_rows, geometries, counts = build_polygon_features()
    expected_buckets = stage_4_manifest["counts"]["elevationBuckets"]
    expected_empty = stage_4_manifest["counts"]["emptyBuckets"]
    if counts["elevation_buckets"] != expected_buckets or counts["empty_buckets_skipped"] != expected_empty:
        raise RuntimeError(f"Bucket counts {counts} disagree with Stage 4 manifest counts {stage_4_manifest['counts']}.")
    if counts["vertices_including_ring_closure"] != stage_4_manifest["counts"]["ringVertices"]:
        raise RuntimeError("Vertex count disagrees with Stage 4 manifest ringVertices.")
    log(f"  {counts['features']:,} features from {counts['elevation_buckets']:,} buckets ({counts['empty_buckets_skipped']:,} empty skipped).")
    log(
        f"  buckets with holes {counts['buckets_with_holes']:,}, multiple outer rings "
        f"{counts['buckets_with_multiple_outer_rings']:,}, hole listed first {counts['buckets_with_hole_listed_first']:,}, "
        f"holes assigned by overlap {counts['holes_assigned_by_overlap']}, zero-area rings {counts['zero_area_rings']}."
    )

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
        with tempfile.TemporaryDirectory(prefix="wse-polygons-gdb-") as temporary_folder:
            file_geodatabase_path = Path(temporary_folder) / FILE_GEODATABASE_FOLDER_NAME
            log(f"Writing {FILE_GEODATABASE_FOLDER_NAME}: table {VERSIONS_TABLE_NAME} …")
            write_versions_table(file_geodatabase_path, versions_row)
            log(f"Writing {FILE_GEODATABASE_FOLDER_NAME}: polygon layer {POLYGON_LAYER_NAME} ({len(geometries):,} features) …")
            write_polygon_layer(file_geodatabase_path, attribute_rows, geometries)
            written_count = pyogrio.read_info(str(file_geodatabase_path), layer=POLYGON_LAYER_NAME)["features"]
            if written_count != counts["features"]:
                raise RuntimeError(f"File geodatabase holds {written_count} features, expected {counts['features']}.")
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
