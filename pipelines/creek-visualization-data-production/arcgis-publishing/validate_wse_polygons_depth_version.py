"""Validate a frozen depth-bucket WSE polygon version (freeze_wse_polygons_depth_version.py) by reading it back.

Unzips the version's file geodatabase to a temporary folder, reads it with pyogrio, and compares it with
the Stage 4 polygon sets named in version.json. Expected counts come from the Stage 4 manifest and
version.json, not constants.

  1. The geodatabase holds exactly the tables version.json lists; the polygon layer is EPSG:4326
     MultiPolygon Z with depth-named bucket columns (min_depth_m / max_depth_m).
  2. Feature count equals the non-empty bucket count; every feature's attributes match its bucket.
  3. EVERY bucket's rings equal the source: longitude and latitude within 1e-7 degrees, Z (the bed) equal
     to 3 decimals. A ring stored from another start vertex or in reverse order (the file geodatabase
     writer may reorient a ring) still matches, and is counted.
  4. Ring and vertex totals equal the source; geometry validity (shapely, 2D) of the stored layer equals
     the validity of the source rings, so storage repaired nothing and broke nothing.
  5. A channel ribbon's channel_ribbons table equals every source channelRibbon record.
  6. The versions-table row, the zip sha256 in version.json, and (for a frozen folder) the registry entry.

Exits nonzero when a check fails. Local only; no portal access.

    npm run data-products:validate-wse-polygons-version -- --method flowline-channel-ribbon --version m3-v2
    npm run data-products:validate-wse-polygons-version -- --version-folder=<dry-run folder>
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pyogrio
import shapely

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data_product_versions as versions  # noqa: E402
from data_product_version_identity import WSE_POLYGONS, DataProductVersionIdentity  # noqa: E402
from file_geodatabase_tables import unzip_gdb  # noqa: E402
from freeze_wse_polygons_depth_version import (  # noqa: E402
    CHANNEL_RIBBON_TABLE_SCHEMA,
    POLYGON_LAYER_ATTRIBUTE_SCHEMA,
    RING_ASSEMBLY_BY_BROWSER_DRAWING,
    SINGLE_STORED_RING,
    channel_ribbon_table,
    iterate_polygon_sets,
    registry_method_number,
)
from freeze_wse_polygons_version import VERSIONS_TABLE_SCHEMA, tnc_comid_of_segment_id  # noqa: E402
from validate_wse_polygons_version import CheckResults, rings_of_geometry  # noqa: E402

COORDINATE_TOLERANCE_DEGREES = 1e-7
Z_DECIMALS = 3  # the source stores the bed with 3 decimals


def log(message: str) -> None:
    print(f"[validate-wse-polygons-version] {message}", flush=True)


def closed(ring: list[list[float]]) -> np.ndarray:
    coordinates = np.asarray(ring, dtype=float)
    return coordinates if np.array_equal(coordinates[0], coordinates[-1]) else np.vstack([coordinates, coordinates[:1]])


def ring_coordinates_equal(source_ring: np.ndarray, stored_ring: np.ndarray) -> bool:
    return (
        source_ring.shape == stored_ring.shape
        and bool(np.all(np.abs(source_ring[:, :2] - stored_ring[:, :2]) <= COORDINATE_TOLERANCE_DEGREES))
        and bool(np.all(np.round(stored_ring[:, 2], Z_DECIMALS) == np.round(source_ring[:, 2], Z_DECIMALS)))
    )


def ring_match(source_ring: np.ndarray, stored_ring: np.ndarray) -> str | None:
    """'exact', 'rotated' (other start vertex), 'reversed' (other direction, any start), or None."""
    if ring_coordinates_equal(source_ring, stored_ring):
        return "exact"
    if source_ring.shape != stored_ring.shape:
        return None
    open_stored = stored_ring[:-1]
    for outcome, candidate in (("rotated", source_ring[:-1]), ("reversed", source_ring[:-1][::-1])):
        # Align on the stored ring's first vertex instead of trying every shift.
        starts = np.flatnonzero(np.all(np.abs(candidate[:, :2] - open_stored[0, :2]) <= COORDINATE_TOLERANCE_DEGREES, axis=1))
        for start in starts:
            rolled = np.roll(candidate, -start, axis=0)
            if ring_coordinates_equal(np.vstack([rolled, rolled[:1]]), stored_ring):
                return outcome
    return None


def compare_bucket_rings(source_rings: list[np.ndarray], stored_rings: list[np.ndarray]) -> str:
    """The worst outcome over the bucket's rings, matched as a set: exact < rotated < reversed < mismatch."""
    if len(source_rings) != len(stored_rings):
        return "mismatch"
    unused = list(range(len(stored_rings)))
    worst = "exact"
    order = ["exact", "rotated", "reversed"]
    for source_ring in source_rings:
        matches = [(index, ring_match(source_ring, stored_rings[index])) for index in unused]
        matches = [(index, outcome) for index, outcome in matches if outcome]
        if not matches:
            return "mismatch"
        index, outcome = min(matches, key=lambda match: order.index(match[1]))
        unused.remove(index)
        worst = max(worst, outcome, key=order.index)
    return worst


def validate(version_folder: Path, check_registry: bool) -> CheckResults:
    checks = CheckResults()
    version_record = json.loads((version_folder / "version.json").read_text(encoding="utf-8"))
    identity = DataProductVersionIdentity(WSE_POLYGONS, version_record["method_id"], version_record["version_label"])
    stage_4_folder = versions.REPOSITORY_ROOT / version_record["source"]["stage_4_folder"]
    stage_4_counts = version_record["source"]["stage_4_manifest_counts"]
    ring_assembly = RING_ASSEMBLY_BY_BROWSER_DRAWING[version_record["browser_drawing"]]
    table_names = version_record["arcgis_table_names"]
    upload_zip_path = version_folder / "arcgis-upload" / identity.upload_zip_name

    for entry in version_record["files"]:
        path = version_folder / entry["path"]
        checks.record(f"sha256 of {entry['path']}", path.exists() and versions.sha256_of_file(path) == entry["sha256"], entry["sha256"][:16] + "…")
    if check_registry:
        registry = versions.read_registry()
        registry_record = next(
            (v for v in registry["products"][WSE_POLYGONS]["versions"] if v.get("version_label") == identity.version_label), None
        )
        checks.record(
            "registry entry present with matching upload sha256, method id, and method number",
            registry_record is not None
            and registry_record.get("arcgis_upload_sha256") == versions.sha256_of_file(upload_zip_path)
            and registry_record.get("method_id") == identity.method_id
            and registry_method_number(version_record["pipeline_method_id"], registry) == identity.method_number,
            "found" if registry_record else "missing",
        )

    log("Reading Stage 4 source buckets …")
    source_rings_by_key: dict[tuple[str, int], list[np.ndarray]] = {}
    source_attributes_by_key: dict[tuple[str, int], tuple] = {}
    source_ribbons: list[dict] = []
    source_totals = collections.Counter()
    for polygon_set in iterate_polygon_sets(stage_4_folder):
        segment_id = polygon_set["segmentId"]
        source_totals["polygon_sets"] += 1
        if "channelRibbon" in polygon_set:
            source_ribbons.append({"segment_id": segment_id, **polygon_set["channelRibbon"]})
        for bucket_index, bucket in enumerate(polygon_set["elevationBuckets"]):
            source_totals["buckets"] += 1
            rings = bucket["ringsWgs84"]
            if not rings:
                source_totals["empty_buckets"] += 1
                continue
            source_totals["rings"] += len(rings)
            source_totals["vertices_as_stored"] += sum(len(ring) for ring in rings)
            source_rings_by_key[(segment_id, bucket_index)] = [closed(ring) for ring in rings]
            source_attributes_by_key[(segment_id, bucket_index)] = (
                tnc_comid_of_segment_id(segment_id), bucket["minWaterSurfaceElevationM"], bucket["maxWaterSurfaceElevationM"],
                len(rings), sum(len(ring) for ring in rings),
            )  # fmt: skip
    checks.record(
        "source buckets agree with the Stage 4 manifest counts",
        source_totals["buckets"] == stage_4_counts.get("depthBuckets", stage_4_counts.get("depthRungBuckets"))
        and source_totals["empty_buckets"] == stage_4_counts.get("emptyBuckets", 0)
        and source_totals["vertices_as_stored"] == stage_4_counts["ringVertices"]
        and source_totals["polygon_sets"] == stage_4_counts["creekSegments"],
        f"{source_totals['buckets']:,} buckets, {source_totals['empty_buckets']:,} empty, {source_totals['vertices_as_stored']:,} vertices",
    )

    with tempfile.TemporaryDirectory(prefix=f"validate-{WSE_POLYGONS}-{identity.version_label}-") as temporary_folder:
        file_geodatabase_path = str(unzip_gdb(upload_zip_path, Path(temporary_folder)))
        stored_layer_names = {str(name) for name, _ in pyogrio.list_layers(file_geodatabase_path)}
        checks.record("geodatabase holds exactly the tables version.json lists", stored_layer_names == set(table_names), ", ".join(sorted(stored_layer_names)))

        versions_table = pyogrio.read_dataframe(file_geodatabase_path, layer=identity.versions_table_name)
        versions_row = versions_table.iloc[0] if len(versions_table) == 1 else None
        checks.record(
            "versions table has one row with every field and matching identity",
            versions_row is not None
            and {field.name for field in VERSIONS_TABLE_SCHEMA} <= set(versions_table.columns)
            and versions_row["version_label"] == identity.version_label
            and versions_row["method_id"] == identity.method_id
            and versions_row["browser_drawing"] == version_record["browser_drawing"]
            and versions_row["method_sha256"] == version_record["method_sha256"]
            and versions_row["change_note"] == version_record["change_note"]
            and json.loads(versions_row["parameters_json"]) == version_record["method_parameters"],
            f"{len(versions_table)} row(s), {len(versions_table.columns)} columns",
        )

        layer_info = pyogrio.read_info(file_geodatabase_path, layer=identity.arcgis_prefix)
        checks.record(
            "polygon layer is EPSG:4326 MultiPolygon Z",
            layer_info["crs"] == "EPSG:4326" and layer_info["geometry_type"] == "MultiPolygon Z",
            f"{layer_info['crs']}, {layer_info['geometry_type']}",
        )
        checks.record(
            "polygon layer columns are named as depths (min_depth_m, max_depth_m)",
            list(layer_info["fields"]) == [field.name for field in POLYGON_LAYER_ATTRIBUTE_SCHEMA],
            ", ".join(layer_info["fields"]),
        )
        log("Reading the polygon layer back …")
        features = pyogrio.read_dataframe(file_geodatabase_path, layer=identity.arcgis_prefix)

        ribbon_table_name = f"{identity.arcgis_prefix}_channel_ribbons"
        if ribbon_table_name in table_names:
            stored_ribbons = pyogrio.read_dataframe(file_geodatabase_path, layer=ribbon_table_name)
            expected = channel_ribbon_table(source_ribbons).to_pylist()
            stored = stored_ribbons[[field.name for field in CHANNEL_RIBBON_TABLE_SCHEMA]].to_dict("records")

            def same(left, right) -> bool:
                left_missing = left is None or (isinstance(left, float) and np.isnan(left))
                right_missing = right is None or (isinstance(right, float) and np.isnan(right))
                return left_missing == right_missing and (left_missing or left == right)

            differing = [row["segment_id"] for row, source in zip(stored, expected) if not all(same(row[k], source[k]) for k in source)]
            checks.record(
                f"{ribbon_table_name} equals every source channelRibbon",
                len(stored) == len(expected) and not differing,
                f"{len(stored):,} rows, source {len(expected):,}, {len(differing)} differ {differing[:3]}",
            )

    checks.record(
        "feature count equals non-empty bucket count and version.json",
        len(features) == len(source_rings_by_key) == version_record["counts"]["features"],
        f"{len(features):,} features, {len(source_rings_by_key):,} non-empty buckets",
    )
    geometries = features.geometry.values
    checks.record("every geometry has Z (the bed)", bool(np.all(shapely.has_z(geometries))), f"{int(np.sum(shapely.has_z(geometries))):,} with Z")

    log("Comparing attributes and rings of every feature …")
    feature_keys = list(zip(features["segment_id"], features["bucket_index"].astype(int)))
    attribute_mismatches, outcomes = [], collections.Counter()
    for position, key in enumerate(feature_keys):
        source = source_attributes_by_key.get(key)
        stored = (
            features["tnc_comid"].iat[position], float(features["min_depth_m"].iat[position]), float(features["max_depth_m"].iat[position]),
            int(features["ring_count"].iat[position]), int(features["vertex_count"].iat[position]),
        )  # fmt: skip
        if source != stored or int(features["sub_segment_index"].iat[position]) != 0:
            attribute_mismatches.append(key)
        outcomes[compare_bucket_rings(source_rings_by_key.get(key, []), rings_of_geometry(geometries[position]))] += 1
    duplicate_keys = len(feature_keys) - len(set(feature_keys))
    checks.record(
        "every feature's attributes match its source bucket; every bucket has exactly one feature",
        not attribute_mismatches and duplicate_keys == 0 and set(feature_keys) == set(source_rings_by_key),
        f"{len(attribute_mismatches)} mismatched, {duplicate_keys} duplicated, first {attribute_mismatches[:3]}",
    )
    checks.record(
        f"every bucket's rings equal the source (lon/lat within {COORDINATE_TOLERANCE_DEGREES:g}°, Z to {Z_DECIMALS} decimals)",
        outcomes["mismatch"] == 0,
        f"{sum(outcomes.values()):,} buckets: {outcomes['exact']:,} exact, {outcomes['rotated']:,} other start vertex, "
        f"{outcomes['reversed']:,} reversed, {outcomes['mismatch']:,} mismatched",
    )
    parts = shapely.get_parts(geometries)
    stored_rings = shapely.get_rings(parts)
    stored_vertices = int(np.sum(shapely.get_num_coordinates(stored_rings)))
    closing_vertices = len(stored_rings) if ring_assembly == SINGLE_STORED_RING else 0
    checks.record(
        "ring and vertex totals equal the source",
        len(stored_rings) == source_totals["rings"] and stored_vertices - closing_vertices == source_totals["vertices_as_stored"],
        f"rings {len(stored_rings):,} / {source_totals['rings']:,}; vertices {stored_vertices:,} stored "
        f"(− {closing_vertices:,} added closing vertices) / {source_totals['vertices_as_stored']:,} source",
    )

    log("Geometry validity (2D; nothing repaired) …")
    stored_validity = shapely.is_valid(geometries)
    if ring_assembly == SINGLE_STORED_RING:
        source_validity = shapely.is_valid(np.array([shapely.Polygon(source_rings_by_key[key][0]) for key in feature_keys], dtype=object))
        checks.record(
            "stored validity equals source-ring validity for every feature (storage repaired nothing)",
            bool(np.array_equal(stored_validity, source_validity)),
            f"stored invalid {int((~stored_validity).sum()):,}, source invalid {int((~source_validity).sum()):,} of {len(geometries):,}",
        )
    else:
        log(f"  valid {int(stored_validity.sum()):,} / {len(geometries):,}; invalid {int((~stored_validity).sum()):,} (report only)")
    return checks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--method", help="Stage 4 WSE Polygon Generation Method id; with --version names the frozen folder.")
    parser.add_argument("--version", help="Version label, for example m3-v2.")
    parser.add_argument("--version-folder", type=Path, help="A frozen or dry-run version folder. A dry-run folder skips the registry check.")
    arguments = parser.parse_args()
    if arguments.version_folder:
        version_folder = arguments.version_folder.resolve()
    elif arguments.method and arguments.version:
        method_number = registry_method_number(arguments.method, versions.read_registry())
        version_folder = DataProductVersionIdentity(WSE_POLYGONS, f"m{method_number}-{arguments.method}", arguments.version).version_folder
    else:
        parser.error("Give --method and --version, or --version-folder.")
    started = time.monotonic()
    log(f"Validating {version_folder}")
    is_frozen_folder = version_folder.is_relative_to(versions.DATA_PRODUCT_VERSIONS_FOLDER)
    checks = validate(version_folder, check_registry=is_frozen_folder)
    failed = [name for name, passed, _ in checks.results if not passed]
    log(f"{len(checks.results) - len(failed)} of {len(checks.results)} checks passed in {time.monotonic() - started:.1f} s.")
    if failed:
        log(f"FAILED: {failed}")
        sys.exit(1)


if __name__ == "__main__":
    main()
