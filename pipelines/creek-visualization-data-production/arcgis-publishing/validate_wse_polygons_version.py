"""Validate frozen WSE polygons m1-v1 by reading the file geodatabase back (UCS-285).

Unzips arcgis-upload/wse-polygons-m1-v1.gdb.zip to a temporary folder, reads it with pyogrio,
and compares it with the Stage 4 water-surface polygon sets it was built from:

  1. Feature count equals the non-empty elevation bucket count.
  2. Every feature's segment_id, tnc_comid, sub_segment_index, bucket_index, min_wse_m, max_wse_m,
     ring_count, and vertex_count match its source bucket (all features).
  3. Ring coordinates equal the source within 1e-7 degrees for every bucket of TNC flowline
     27714637 (includes the gauge Creek Segment 27714637-026) and a seeded random sample of
     other buckets. Rings are matched as a set per bucket, since the geodatabase stores each
     outer ring followed by its holes rather than the source's ring order.
  4. Total ring and vertex counts equal the source. Both sides count the closing vertex, so a
     ring of N distinct vertices counts N + 1.
  5. Reports buckets with holes, with several outer rings, and with a hole listed first.
  6. Reports geometry validity (shapely.is_valid) with reason counts. Nothing is repaired.

Also checks the versions table row, the zip sha256 recorded in version.json, and the registry.
Exits nonzero when a check fails. Local only; no portal access.
"""

from __future__ import annotations

import argparse
import collections
import json
import random
import re
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
import pyogrio
import shapely

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data_product_versions as versions  # noqa: E402
import freeze_wse_polygons_version as freeze  # noqa: E402

COORDINATE_TOLERANCE_DEGREES = 1e-7
DEFAULT_RANDOM_SAMPLE_SIZE = 2500
RANDOM_SAMPLE_SEED = 285
GAUGE_CREEK_SEGMENT_ID = "27714637-026"
GAUGE_CREEK_SEGMENT_EXPECTED_BUCKETS = 137
EXPECTED_NON_EMPTY_BUCKETS = 102_607 - 1_483


def log(message: str) -> None:
    print(f"[validate-wse-polygons] {message}", flush=True)


class CheckResults:
    def __init__(self) -> None:
        self.results: list[tuple[str, bool, str]] = []

    def record(self, name: str, passed: bool, detail: str) -> None:
        self.results.append((name, passed, detail))
        log(f"{'PASS' if passed else 'FAIL'}  {name}: {detail}")

    @property
    def all_passed(self) -> bool:
        return all(passed for _, passed, _ in self.results)


def rings_of_geometry(geometry: shapely.Geometry) -> list[np.ndarray]:
    """Rings in stored order: each polygon's exterior, then its interiors."""
    rings = []
    for polygon in shapely.get_parts(geometry):
        rings.append(np.asarray(polygon.exterior.coords))
        rings.extend(np.asarray(interior.coords) for interior in polygon.interiors)
    return rings


def coordinates_equal(first: np.ndarray, second: np.ndarray) -> bool:
    return first.shape == second.shape and bool(np.all(np.abs(first - second) <= COORDINATE_TOLERANCE_DEGREES))


def equal_up_to_start_vertex(source_ring: np.ndarray, stored_ring: np.ndarray) -> bool:
    """Same closed ring, same direction, different starting vertex."""
    if source_ring.shape != stored_ring.shape:
        return False
    open_source = source_ring[:-1]
    open_stored = stored_ring[:-1]
    for shift in range(len(open_source)):
        if coordinates_equal(np.roll(open_source, -shift, axis=0), open_stored):
            return True
    return False


def compare_bucket_rings(source_rings: list[list[list[float]]], stored_rings: list[np.ndarray]) -> str:
    """'exact' when every source ring has a stored ring with identical vertex sequence (within
    tolerance); 'rotated' when some ring only matches after shifting its start vertex; else 'mismatch'."""
    if len(source_rings) != len(stored_rings):
        return "mismatch"
    unused = list(range(len(stored_rings)))
    needed_rotation = False
    for source_ring in (np.asarray(ring, dtype=float) for ring in source_rings):
        match = next((index for index in unused if coordinates_equal(source_ring, stored_rings[index])), None)
        if match is None:
            match = next((index for index in unused if equal_up_to_start_vertex(source_ring, stored_rings[index])), None)
            needed_rotation = match is not None
        if match is None:
            return "mismatch"
        unused.remove(match)
    return "rotated" if needed_rotation else "exact"


def resolve_upload_zip(version_folder: Path) -> Path:
    return version_folder / "arcgis-upload" / freeze.UPLOAD_ZIP_NAME


def validate(version_folder: Path, random_sample_size: int, check_registry: bool) -> CheckResults:
    checks = CheckResults()
    version_record = json.loads((version_folder / "version.json").read_text(encoding="utf-8"))
    upload_zip_path = resolve_upload_zip(version_folder)

    recorded_zip = next(f for f in version_record["files"] if f["path"] == f"arcgis-upload/{freeze.UPLOAD_ZIP_NAME}")
    actual_zip_sha256 = versions.sha256_of_file(upload_zip_path)
    checks.record("upload zip sha256 matches version.json", actual_zip_sha256 == recorded_zip["sha256"], actual_zip_sha256[:16] + "…")
    if check_registry:
        registry_versions = versions.read_registry().get("products", {}).get(freeze.PRODUCT, {}).get("versions", [])
        registry_record = next((v for v in registry_versions if v.get("version_label") == freeze.VERSION_LABEL), None)
        checks.record(
            "registry entry present with matching upload sha256",
            registry_record is not None and registry_record.get("arcgis_upload_sha256") == actual_zip_sha256,
            "found" if registry_record else "missing",
        )

    log("Reading Stage 4 source buckets …")
    source_buckets: dict[tuple[str, int], dict] = {}
    source_totals = collections.Counter()
    for bucket in freeze.iterate_source_elevation_buckets():
        source_totals["buckets"] += 1
        rings = bucket["rings"]
        if not rings:
            source_totals["empty_buckets"] += 1
            continue
        source_buckets[(bucket["segment_id"], bucket["bucket_index"])] = bucket
        source_totals["rings"] += len(rings)
        source_totals["vertices_including_ring_closure"] += sum(len(ring) for ring in rings)
        orientations = [freeze.is_clockwise_ring(ring) for ring in rings]
        source_totals["buckets_with_holes"] += not all(orientations)
        source_totals["buckets_with_multiple_outer_rings"] += sum(orientations) > 1
        source_totals["buckets_with_hole_listed_first"] += not orientations[0]
        source_totals["unclosed_rings"] += sum(ring[0] != ring[-1] for ring in rings)
    log(
        f"  {source_totals['buckets']:,} buckets, {source_totals['empty_buckets']:,} empty, "
        f"{len(source_buckets):,} non-empty, {source_totals['rings']:,} rings, "
        f"{source_totals['vertices_including_ring_closure']:,} vertices, {source_totals['unclosed_rings']} unclosed rings."
    )

    with tempfile.TemporaryDirectory(prefix="validate-wse-polygons-") as temporary_folder:
        with zipfile.ZipFile(upload_zip_path) as archive:
            archive.extractall(temporary_folder)
        file_geodatabase_path = Path(temporary_folder) / freeze.FILE_GEODATABASE_FOLDER_NAME
        layer_names = {name for name, _ in pyogrio.list_layers(str(file_geodatabase_path))}
        checks.record(
            "geodatabase holds exactly the versions table and the polygon layer",
            layer_names == {freeze.VERSIONS_TABLE_NAME, freeze.POLYGON_LAYER_NAME},
            ", ".join(sorted(layer_names)),
        )

        versions_table = pyogrio.read_dataframe(str(file_geodatabase_path), layer=freeze.VERSIONS_TABLE_NAME)
        versions_row = versions_table.iloc[0] if len(versions_table) == 1 else None
        expected_versions_columns = {field.name for field in freeze.VERSIONS_TABLE_SCHEMA}
        checks.record(
            "versions table has one row with every field and matching identity",
            versions_row is not None
            and expected_versions_columns <= set(versions_table.columns)
            and versions_row["version_label"] == freeze.VERSION_LABEL
            and versions_row["method_sha256"] == version_record["method_sha256"]
            and int(versions_row["empty_buckets_skipped"]) == source_totals["empty_buckets"]
            and json.loads(versions_row["parameters_json"]) == version_record["method_parameters"],
            f"{len(versions_table)} row(s), {len(versions_table.columns)} columns",
        )

        polygon_layer_info = pyogrio.read_info(str(file_geodatabase_path), layer=freeze.POLYGON_LAYER_NAME)
        checks.record(
            "polygon layer is EPSG:4326 2D MultiPolygon",
            polygon_layer_info["crs"] == "EPSG:4326" and polygon_layer_info["geometry_type"] == "MultiPolygon",
            f"{polygon_layer_info['crs']}, {polygon_layer_info['geometry_type']}",
        )

        log("Reading the polygon layer back …")
        started = time.monotonic()
        features = pyogrio.read_dataframe(str(file_geodatabase_path), layer=freeze.POLYGON_LAYER_NAME)
        log(f"  read {len(features):,} features in {time.monotonic() - started:.1f} s.")

    checks.record(
        "feature count equals non-empty bucket count",
        len(features) == len(source_buckets) == EXPECTED_NON_EMPTY_BUCKETS,
        f"{len(features):,} features, {len(source_buckets):,} non-empty buckets, expected {EXPECTED_NON_EMPTY_BUCKETS:,}",
    )
    geometries = features.geometry.values
    checks.record(
        "every geometry is 2D",
        not bool(np.any(shapely.has_z(geometries))),
        f"{int(np.sum(shapely.has_z(geometries)))} with Z",
    )

    log("Comparing attributes of every feature …")
    feature_keys = list(zip(features["segment_id"], features["bucket_index"].astype(int)))
    duplicate_keys = len(feature_keys) - len(set(feature_keys))
    attribute_mismatches = []
    stored_rings_by_key: dict[tuple[str, int], int] = {}
    for row_position, key in enumerate(feature_keys):
        source = source_buckets.get(key)
        if source is None:
            attribute_mismatches.append((key, "no source bucket"))
            continue
        stored_rings_by_key[key] = row_position
        source_vertex_count = sum(len(ring) for ring in source["rings"])
        if (
            features["tnc_comid"].iat[row_position] != source["tnc_comid"]
            or int(features["sub_segment_index"].iat[row_position]) != 0
            or float(features["min_wse_m"].iat[row_position]) != source["min_wse_m"]
            or float(features["max_wse_m"].iat[row_position]) != source["max_wse_m"]
            or int(features["ring_count"].iat[row_position]) != len(source["rings"])
            or int(features["vertex_count"].iat[row_position]) != source_vertex_count
        ):
            attribute_mismatches.append((key, "attribute differs"))
    missing_keys = set(source_buckets) - set(feature_keys)
    checks.record(
        "every feature's attributes match its source bucket; every bucket has one feature",
        not attribute_mismatches and not missing_keys and duplicate_keys == 0,
        f"{len(attribute_mismatches)} mismatched, {len(missing_keys)} missing, {duplicate_keys} duplicated"
        + (f"; first {attribute_mismatches[:3]}" if attribute_mismatches else ""),
    )

    log("Counting stored rings and vertices …")
    parts, part_feature_index = shapely.get_parts(geometries, return_index=True)
    rings, _ = shapely.get_rings(parts, return_index=True)
    stored_vertex_total = int(np.sum(shapely.get_num_coordinates(rings)))
    stored_interior_counts = shapely.get_num_interior_rings(parts)
    parts_per_feature = np.bincount(part_feature_index, minlength=len(features))
    holes_per_feature = np.bincount(part_feature_index, weights=stored_interior_counts, minlength=len(features))
    checks.record(
        "total ring count equals source",
        len(rings) == source_totals["rings"],
        f"stored {len(rings):,}, source {source_totals['rings']:,}",
    )
    checks.record(
        "total vertex count (closing vertex included on both sides) equals source",
        stored_vertex_total == source_totals["vertices_including_ring_closure"],
        f"stored {stored_vertex_total:,}, source {source_totals['vertices_including_ring_closure']:,}",
    )
    stored_buckets_with_holes = int(np.sum(holes_per_feature > 0))
    stored_buckets_with_multiple_outer_rings = int(np.sum(parts_per_feature > 1))
    checks.record(
        "stored hole and outer-ring structure matches source orientation",
        stored_buckets_with_holes == source_totals["buckets_with_holes"]
        and stored_buckets_with_multiple_outer_rings == source_totals["buckets_with_multiple_outer_rings"],
        f"with holes stored {stored_buckets_with_holes:,} / source {source_totals['buckets_with_holes']:,}; "
        f"multiple outer rings stored {stored_buckets_with_multiple_outer_rings:,} / "
        f"source {source_totals['buckets_with_multiple_outer_rings']:,}; "
        f"hole listed first in source {source_totals['buckets_with_hole_listed_first']:,}",
    )

    log("Comparing ring coordinates …")
    gauge_flowline_keys = [key for key in source_buckets if key[0].startswith(f"{freeze.GAUGE_TNC_FLOWLINE_COMID}-")]
    gauge_segment_bucket_count = sum(
        1 for bucket in freeze.iterate_source_elevation_buckets() if bucket["segment_id"] == GAUGE_CREEK_SEGMENT_ID
    )
    other_keys = sorted(key for key in source_buckets if not key[0].startswith(f"{freeze.GAUGE_TNC_FLOWLINE_COMID}-"))
    random_sample_keys = random.Random(RANDOM_SAMPLE_SEED).sample(other_keys, min(random_sample_size, len(other_keys)))
    comparison_outcomes = {"gauge flowline": collections.Counter(), "random sample": collections.Counter()}
    mismatched_examples = []
    for group_name, keys in (("gauge flowline", gauge_flowline_keys), ("random sample", random_sample_keys)):
        for key in keys:
            row_position = stored_rings_by_key.get(key)
            outcome = (
                "mismatch"
                if row_position is None
                else compare_bucket_rings(source_buckets[key]["rings"], rings_of_geometry(geometries[row_position]))
            )
            comparison_outcomes[group_name][outcome] += 1
            if outcome != "exact" and len(mismatched_examples) < 5:
                mismatched_examples.append((key, outcome))
    for group_name, outcomes in comparison_outcomes.items():
        total = sum(outcomes.values())
        checks.record(
            f"ring coordinates within {COORDINATE_TOLERANCE_DEGREES:g}° ({group_name})",
            outcomes["mismatch"] == 0 and total > 0,
            f"{total:,} buckets: {outcomes['exact']:,} exact order, {outcomes['rotated']:,} start-vertex shifted, "
            f"{outcomes['mismatch']:,} mismatched",
        )
    checks.record(
        f"gauge Creek Segment {GAUGE_CREEK_SEGMENT_ID} has {GAUGE_CREEK_SEGMENT_EXPECTED_BUCKETS} buckets, all compared when non-empty",
        gauge_segment_bucket_count == GAUGE_CREEK_SEGMENT_EXPECTED_BUCKETS,
        f"{gauge_segment_bucket_count} buckets, "
        f"{sum(1 for key in gauge_flowline_keys if key[0] == GAUGE_CREEK_SEGMENT_ID)} non-empty compared; "
        f"flowline {freeze.GAUGE_TNC_FLOWLINE_COMID} total {len(gauge_flowline_keys):,} non-empty",
    )
    if mismatched_examples:
        log(f"  first non-exact comparisons: {mismatched_examples}")

    log("Geometry validity (report only; nothing repaired) …")
    validity = shapely.is_valid(geometries)
    invalid_reasons = collections.Counter(
        re.sub(r"\[.*\]", "", shapely.is_valid_reason(geometry)).strip() for geometry in geometries[~validity]
    )
    log(f"  valid {int(validity.sum()):,} / {len(geometries):,}; invalid {int((~validity).sum()):,}")
    for reason, count in invalid_reasons.most_common():
        log(f"    {count:,}  {reason}")
    gauge_flowline_positions = [stored_rings_by_key[key] for key in gauge_flowline_keys if key in stored_rings_by_key]
    log(
        f"  flowline {freeze.GAUGE_TNC_FLOWLINE_COMID}: invalid "
        f"{int((~validity[gauge_flowline_positions]).sum()):,} / {len(gauge_flowline_positions):,}"
    )
    return checks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--version-folder",
        type=Path,
        default=versions.version_folder_path(freeze.PRODUCT, freeze.METHOD_ID, freeze.VERSION_LABEL),
        help="Version folder to validate (default: the frozen m1-v1 folder). A dry-run folder skips the registry check.",
    )
    parser.add_argument("--random-sample-size", type=int, default=DEFAULT_RANDOM_SAMPLE_SIZE)
    arguments = parser.parse_args()
    version_folder = arguments.version_folder.resolve()
    is_frozen_folder = version_folder == versions.version_folder_path(freeze.PRODUCT, freeze.METHOD_ID, freeze.VERSION_LABEL)
    started = time.monotonic()
    log(f"Validating {version_folder}")
    checks = validate(version_folder, arguments.random_sample_size, check_registry=is_frozen_folder)
    failed = [name for name, passed, _ in checks.results if not passed]
    log(f"{len(checks.results) - len(failed)} of {len(checks.results)} checks passed in {time.monotonic() - started:.1f} s.")
    if failed:
        log(f"FAILED: {failed}")
        sys.exit(1)


if __name__ == "__main__":
    main()
