"""Freeze one version of a depth-bucket WSE Polygon Generation Method as an append-only Data-Product Version.

Generic over method and version for the methods whose bucket bounds are water DEPTHS and whose ring
vertices carry the bed as Z: height-above-nearest-drainage-fill (`bed-parallel-depth`) and
flowline-channel-ribbon (`channel-ribbon-depth`, `channel-ribbon-pool-filled`). Identity, change note,
fingerprint, browser drawing, and the modeled WSE version the polygons were built from are read from
the Stage 4 manifest; names come from data_product_version_identity.py. Local only; never contacts ArcGIS.

    data/data-product-versions/wse-polygons/m<N>-<pipeline method id>/m<N>-v<pipeline version>/
      version.json
      source-manifests/04-manifest.json
      arcgis-upload/wse-polygons-<label>.gdb.zip

The registry method number of a pipeline method is the one its earlier versions already use
(junction-sloped-terrain-fill m1, height-above-nearest-drainage-fill m2), or the next free number for a
method never frozen before; the version number is the pipeline method version. --version must agree.

The file geodatabase holds:
  - table `wse_polygon_versions`: one row describing this version;
  - polygon layer `wse_polygons_<label>` (EPSG:4326, MultiPolygon Z): one Prepared water-surface polygon
    per non-empty depth bucket. min_depth_m / max_depth_m are water depths above the bed, half-open
    [min, max); geometry Z is the bed (m NAVD88) the source ring vertex carries;
  - for a channel ribbon only, table `wse_polygons_<label>_channel_ribbons`: one row per Creek Segment with
    the ribbon's channelRibbon record (anchor point and bed, anchor station, station distances, top
    widths at the anchor), which the browser needs to draw the ribbon at a depth.

Ring assembly. height-above-nearest-drainage-fill buckets may hold several outer rings and holes, so their
geometry is assembled by ring orientation (freeze_wse_polygons_version.py). A channel-ribbon bucket holds
exactly one ring, stored without the closing vertex; it is kept as the polygon's only ring with its stored
vertex order (the first vertex repeated to close it), never reoriented or repaired, because a folded
rung can make the ring cross itself or wind counter-clockwise.

    npm run data-products:freeze-wse-polygons-version -- --method flowline-channel-ribbon --version m3-v2
    npm run data-products:freeze-wse-polygons-version -- --method flowline-channel-ribbon --version m3-v2 --dry-run-into=<new folder>
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
from data_product_version_identity import WSE_POLYGONS, DataProductVersionIdentity  # noqa: E402
from freeze_modeled_wse_depth_version import verify_polygon_set_files_match_manifest  # noqa: E402
from freeze_wse_polygons_m2_version import (  # noqa: E402
    POLYGON_LAYER_ATTRIBUTE_SCHEMA,
    check_built_from_frozen_modeled_wse_version,
    check_rings_are_three_dimensional,
)
from freeze_wse_polygons_version import (  # noqa: E402
    LONG_TEXT_WIDTH,
    assemble_prepared_water_surface_polygon,
    build_versions_table_row,
    built_from_modeled_wse_version,
    describe_files,
    dry_run_version_folder,
    input_dataset_ids_and_water_years,
    method_code_files_changed_since_stage_4,
    read_json,
    repository_relative,
    signed_ring_area,
    text_field,
    tnc_comid_of_segment_id,
    verify_stage_4_time_series_inputs_match_stage_3_outputs,
    write_versions_table,
    zip_file_geodatabase,
)

EXTENT_ID = "dangermond-preserve"
INITIAL_STATUS = "active"  # the registry has no "experimental" status; the portal snippet says experimental
STAGE_4_ROOT = versions.PIPELINE_WORKING_OUTPUT_FOLDER / EXTENT_ID / "04-water-surface-polygons"

ORIENTATION_ASSEMBLY = "orientation"
SINGLE_STORED_RING = "single-stored-ring"
RING_ASSEMBLY_BY_BROWSER_DRAWING = {
    "bed-parallel-depth": ORIENTATION_ASSEMBLY,
    "channel-ribbon-depth": SINGLE_STORED_RING,
    "channel-ribbon-pool-filled": SINGLE_STORED_RING,
}
RING_ASSEMBLY_NOTE = {
    ORIENTATION_ASSEMBLY: (
        "by ring orientation: clockwise = outer ring, counter-clockwise = hole; each hole goes to the smallest outer "
        "ring covering it; ring coordinates (including Z) and vertex order unchanged"
    ),
    SINGLE_STORED_RING: (
        "each bucket's one stored ring is the polygon's only ring, in its stored vertex order (left edge stations "
        "0…n−1, then right edge n−1…0), closed by repeating the first vertex; not reoriented and not repaired, so "
        "a ring crossing itself at a folded rung stays as it is"
    ),
}
VERTEX_COUNT_NOTE = {
    ORIENTATION_ASSEMBLY: "vertices per bucket including each ring's repeated closing vertex, as stored in ringsWgs84",
    SINGLE_STORED_RING: "vertices of the bucket's ring as stored in ringsWgs84 (without a closing vertex; the geometry adds one)",
}
BUCKET_BOUNDS_NOTE = (
    "min_depth_m and max_depth_m are WATER DEPTHS in meters above the bed, half-open [min, max); they are not "
    "water-surface elevations. Stage 4's JSON calls them minWaterSurfaceElevationM / maxWaterSurfaceElevationM to "
    "keep the file shape."
)
BROWSER_DRAWING_NOTE = {
    "bed-parallel-depth": (
        "draw each vertex at z + depth, where depth is the modeled depth at the selected time interpolated between "
        "the segment's junction depths; pick the bucket that holds the anchor depth (value − anchorBedElevationM)."
    ),
    "channel-ribbon-depth": (
        "per station, depth interpolated between the segment's junction depths; draw the edges of the rungs around "
        "that depth (morphed between rungs) at z + depth."
    ),
    "channel-ribbon-pool-filled": (
        "per station, the water surface is the modeled flowing depth smoothed over ±5 × the depth along the "
        "station distances (channel_ribbons.station_distances_m) and pool-filled along the run; the edges are the "
        "rungs around each station's own depth below that surface (morphed between rungs), drawn at that surface."
    ),
}

CHANNEL_RIBBON_TABLE_SCHEMA = pa.schema(
    [
        text_field("segment_id", 32),
        text_field("tnc_comid", 16),
        pa.field("station_count", pa.int32()),
        pa.field("length_m", pa.float64()),
        pa.field("anchor_longitude", pa.float64()),
        pa.field("anchor_latitude", pa.float64()),
        pa.field("anchor_bed_elevation_m", pa.float64()),
        pa.field("anchor_station", pa.int32()),
        text_field("downstream_segment_id", 32),
        pa.field("breached_station_count", pa.int32()),
        text_field("station_distances_m_json", LONG_TEXT_WIDTH),
        text_field("true_top_width_at_anchor_m_json", 2000),
        text_field("display_top_width_at_anchor_m_json", 2000),
    ]
)
CHANNEL_RIBBON_TABLE_NOTE = (
    "One row per Creek Segment that has a ribbon, from its polygon set's channelRibbon: station_count, length_m, the "
    "anchor point (the anchor station's lowest point) and its bed, anchor_station (index among the stations), "
    "downstream_segment_id (next segment of the run, null at its end), breached_station_count, and three JSON arrays: "
    "station_distances_m_json (distance of each station from the upstream boundary station, m) and "
    "true_top_width_at_anchor_m_json / display_top_width_at_anchor_m_json (one width per depth rung, m). Fields a "
    "ribbon version does not store are null."
)


def log(message: str) -> None:
    print(f"[freeze-wse-polygons-version] {message}", flush=True)


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------


def registry_method_number(pipeline_method_id: str, registry: dict) -> int:
    """The number earlier frozen versions of this pipeline method use, or the next free one."""
    product_versions = registry.get("products", {}).get(WSE_POLYGONS, {}).get("versions", [])
    used = {version["method_number"] for version in product_versions if version.get("pipeline_method_id") == pipeline_method_id}
    if len(used) > 1:
        raise RuntimeError(f"Registry gives {pipeline_method_id} several method numbers: {sorted(used)}")
    return used.pop() if used else max((version["method_number"] for version in product_versions), default=0) + 1


def change_type_and_note(method_record: dict, built_from: dict, is_new_method: bool) -> tuple[str, str]:
    """WSE Polygon Generation Methods record no changeType; version 1 of a new method number is a new method."""
    change_type = method_record.get("changeType") or ("new method" if is_new_method else "implementation fix")
    note = method_record.get("changeNote") or method_record["parameters"].get("changeNote") or "first version"
    return change_type, (
        f"Stage 4 {method_record['id']} v{method_record['version']} built from {built_from['product']} "
        f"{built_from['version_label']}: {note}"
    )


# ---------------------------------------------------------------------------
# Reading Stage 4 polygon sets
# ---------------------------------------------------------------------------


def iterate_polygon_sets(stage_4_folder: Path) -> Iterator[dict]:
    for polygon_set_path in sorted((stage_4_folder / "water-surface-polygon-sets").glob("*.json")):
        yield from read_json(polygon_set_path)["waterSurfacePolygonSets"]


def bucket_geometry(rings: list, ring_assembly: str, segment_id: str, bucket_index: int) -> tuple[shapely.MultiPolygon, dict]:
    if ring_assembly == ORIENTATION_ASSEMBLY:
        return assemble_prepared_water_surface_polygon(rings)
    if len(rings) != 1:
        raise ValueError(f"{segment_id} bucket {bucket_index}: a channel-ribbon bucket holds {len(rings)} rings, expected 1")
    return shapely.MultiPolygon([shapely.Polygon(rings[0])]), {
        "outer_ring_count": 1,
        "hole_ring_count": 0,
        "hole_listed_first": False,
        "holes_assigned_by_overlap": 0,
        "zero_area_ring_count": int(shapely.Polygon(rings[0]).area == 0),
    }


def build_polygon_features(stage_4_folder: Path, ring_assembly: str) -> tuple[dict[str, list], list, list[dict], dict]:
    """One feature per non-empty bucket, the channelRibbon records, and every count the version records."""
    attribute_rows: dict[str, list] = {field.name: [] for field in POLYGON_LAYER_ATTRIBUTE_SCHEMA}
    geometries: list = []
    channel_ribbons: list[dict] = []
    counts = {
        "polygon_sets": 0,
        "depth_buckets": 0,
        "empty_buckets_skipped": 0,
        "features": 0,
        "rings": 0,
        "vertices_as_stored": 0,
        "buckets_with_holes": 0,
        "buckets_with_multiple_outer_rings": 0,
        "holes_assigned_by_overlap": 0,
        "zero_area_rings": 0,
        "single_rings_with_counter_clockwise_net_area": 0,
        "creek_segments_without_buckets": 0,
    }
    z_minimum, z_maximum = np.inf, -np.inf
    depth_minimum, depth_maximum = np.inf, -np.inf
    started = time.monotonic()
    for polygon_set in iterate_polygon_sets(stage_4_folder):
        segment_id = polygon_set["segmentId"]
        counts["polygon_sets"] += 1
        counts["creek_segments_without_buckets"] += not polygon_set["elevationBuckets"]
        if "channelRibbon" in polygon_set:
            channel_ribbons.append({"segment_id": segment_id, **polygon_set["channelRibbon"]})
        for bucket_index, bucket in enumerate(polygon_set["elevationBuckets"]):
            counts["depth_buckets"] += 1
            rings = bucket["ringsWgs84"]
            if not rings:
                counts["empty_buckets_skipped"] += 1
                continue
            check_rings_are_three_dimensional(rings, segment_id, bucket_index)
            geometry, statistics = bucket_geometry(rings, ring_assembly, segment_id, bucket_index)
            if not geometry.has_z:
                raise RuntimeError(f"{segment_id} bucket {bucket_index}: assembled geometry lost its Z.")
            vertex_count = sum(len(ring) for ring in rings)
            # Stage 4 keeps the m1 field names; for these methods they hold DEPTHS in meters.
            min_depth_m, max_depth_m = bucket["minWaterSurfaceElevationM"], bucket["maxWaterSurfaceElevationM"]
            for name, value in [
                ("segment_id", segment_id),
                ("tnc_comid", tnc_comid_of_segment_id(segment_id)),
                ("sub_segment_index", 0),
                ("bucket_index", bucket_index),
                ("min_depth_m", min_depth_m),
                ("max_depth_m", max_depth_m),
                ("ring_count", len(rings)),
                ("vertex_count", vertex_count),
            ]:
                attribute_rows[name].append(value)
            geometries.append(geometry)
            z_values = shapely.get_coordinates(geometry, include_z=True)[:, 2]
            z_minimum, z_maximum = min(z_minimum, float(z_values.min())), max(z_maximum, float(z_values.max()))
            depth_minimum, depth_maximum = min(depth_minimum, min_depth_m), max(depth_maximum, max_depth_m)
            counts["features"] += 1
            counts["rings"] += len(rings)
            counts["vertices_as_stored"] += vertex_count
            counts["buckets_with_holes"] += statistics["hole_ring_count"] > 0
            counts["buckets_with_multiple_outer_rings"] += statistics["outer_ring_count"] > 1
            counts["holes_assigned_by_overlap"] += statistics["holes_assigned_by_overlap"]
            counts["zero_area_rings"] += statistics["zero_area_ring_count"]
            if ring_assembly == SINGLE_STORED_RING:
                counts["single_rings_with_counter_clockwise_net_area"] += signed_ring_area(rings[0]) > 0
            if counts["depth_buckets"] % 20000 == 0:
                log(f"  assembled {counts['depth_buckets']:,} buckets ({time.monotonic() - started:.1f} s)")
    counts = {key: int(value) for key, value in counts.items()}
    counts["vertex_z_range_m"] = [round(z_minimum, 3), round(z_maximum, 3)]
    counts["bucket_depth_range_m"] = [depth_minimum, depth_maximum]
    return attribute_rows, geometries, channel_ribbons, counts


def check_counts_against_stage_4_manifest(counts: dict, stage_4_counts: dict) -> None:
    expected_buckets = stage_4_counts.get("depthBuckets", stage_4_counts.get("depthRungBuckets"))
    checks = {
        "depth buckets": (counts["depth_buckets"], expected_buckets),
        "empty buckets": (counts["empty_buckets_skipped"], stage_4_counts.get("emptyBuckets", 0)),
        "ring vertices": (counts["vertices_as_stored"], stage_4_counts["ringVertices"]),
        "Creek Segments": (counts["polygon_sets"], stage_4_counts["creekSegments"]),
    }
    if "segmentsWithoutRibbon" in stage_4_counts:
        checks["segments without a ribbon"] = (counts["creek_segments_without_buckets"], stage_4_counts["segmentsWithoutRibbon"])
    disagreeing = {name: pair for name, pair in checks.items() if pair[0] != pair[1]}
    if disagreeing:
        raise RuntimeError(f"Counts (frozen, Stage 4 manifest) disagree: {disagreeing}")


# ---------------------------------------------------------------------------
# File geodatabase writing
# ---------------------------------------------------------------------------


def write_polygon_layer(file_geodatabase_path: Path, layer_name: str, attribute_rows: dict[str, list], geometries: list) -> None:
    """Writes the layer as MultiPolygon Z (native geometry Z, EPSG:4326)."""
    attribute_table = pa.table(attribute_rows, schema=POLYGON_LAYER_ATTRIBUTE_SCHEMA)
    geometry_field = pa.field("geometry", pa.binary(), metadata={"ARROW:extension:name": "geoarrow.wkb"})
    geometry_column = pa.array(shapely.to_wkb(np.asarray(geometries, dtype=object), output_dimension=3), type=pa.binary())
    write_arrow(
        attribute_table.append_column(geometry_field, geometry_column),
        str(file_geodatabase_path),
        layer=layer_name,
        driver="OpenFileGDB",
        geometry_name="geometry",
        geometry_type="MultiPolygon Z",
        crs="EPSG:4326",
    )


def channel_ribbon_table(channel_ribbons: list[dict]) -> pa.Table:
    def json_or_none(values) -> str | None:
        return None if values is None else json.dumps(values, separators=(",", ":"))

    rows = [
        {
            "segment_id": ribbon["segment_id"],
            "tnc_comid": tnc_comid_of_segment_id(ribbon["segment_id"]),
            "station_count": ribbon["stationCount"],
            "length_m": ribbon["lengthM"],
            "anchor_longitude": ribbon["anchorLonLat"][0],
            "anchor_latitude": ribbon["anchorLonLat"][1],
            "anchor_bed_elevation_m": ribbon["anchorBedElevationM"],
            "anchor_station": ribbon.get("anchorStation"),
            "downstream_segment_id": ribbon.get("downstreamSegmentId"),
            "breached_station_count": ribbon.get("breachedStations"),
            "station_distances_m_json": json_or_none(ribbon.get("stationDistancesM")),
            "true_top_width_at_anchor_m_json": json_or_none(ribbon.get("trueTopWidthAtAnchorM")),
            "display_top_width_at_anchor_m_json": json_or_none(ribbon.get("displayTopWidthAtAnchorM")),
        }
        for ribbon in channel_ribbons
    ]
    for field in CHANNEL_RIBBON_TABLE_SCHEMA:
        width = field.metadata and int(field.metadata[b"GDAL:OGR:width"])
        longest = max((len(row[field.name]) for row in rows if isinstance(row[field.name], str)), default=0)
        if width and longest > width:
            raise RuntimeError(f"channel ribbon {field.name} needs {longest} characters; width is {width}.")
    return pa.Table.from_pylist(rows, schema=CHANNEL_RIBBON_TABLE_SCHEMA)


def write_channel_ribbon_table(file_geodatabase_path: Path, table_name: str, table: pa.Table) -> None:
    write_arrow(table, str(file_geodatabase_path), layer=table_name, driver="OpenFileGDB", geometry_name=None, geometry_type=None, crs=None)


# ---------------------------------------------------------------------------
# Version metadata
# ---------------------------------------------------------------------------


def method_code_provenance(method_record: dict) -> dict:
    """The commit and fingerprint of the code Stage 4 ran, from the working tree or, for an older version, from git."""
    changed_in_working_tree = method_code_files_changed_since_stage_4(method_record)
    if changed_in_working_tree:
        commit, basis = versions.git_oldest_commit_holding_method_code(method_record["codeSha256ByFile"])
    else:
        commit, basis = versions.git_first_commit_with_method_code(method_record["codeSha256ByFile"])
    code_paths = [versions.REPOSITORY_ROOT / path for path in method_record["codeSha256ByFile"]]
    fingerprint = versions.code_fingerprint(code_paths, commit=commit["commit"] if changed_in_working_tree else None)
    if {file["path"]: file["sha256"] for file in fingerprint["files"]} != method_record["codeSha256ByFile"]:
        raise RuntimeError("The code fingerprint does not reproduce the Stage 4 codeSha256ByFile.")
    return {
        "commit": commit,
        "date_basis": basis,
        "fingerprint": fingerprint,
        "basis": (
            "sha256 over sorted 'path:sha256' lines of the Stage 4 manifest's codeSha256ByFile files, checked equal to "
            + (f"git commit {commit['commit']} (the working tree has moved on)" if changed_in_working_tree else "the working tree at freeze")
        ),
        "files_changed_in_working_tree_since_stage_4": changed_in_working_tree,
        "working_tree_differs_from_head": versions.git_uncommitted_paths(code_paths),
    }


def build_version_record(
    identity: DataProductVersionIdentity,
    stage_4_folder: Path,
    stage_4_manifest: dict,
    counts: dict,
    source_checks: dict,
    change: tuple[str, str],
    ring_assembly: str,
    table_names: list[str],
) -> dict:
    method_record = stage_4_manifest["parameters"]["wsePolygonGenerationMethod"]
    provenance = method_code_provenance(method_record)
    dataset_ids, water_years = input_dataset_ids_and_water_years(stage_4_manifest)
    built_from = built_from_modeled_wse_version(stage_4_manifest)
    browser_drawing = method_record["browserDrawing"]
    return {
        "product": WSE_POLYGONS,
        "method_id": identity.method_id,
        "method_number": identity.method_number,
        "version_number": identity.version_number,
        "version_label": identity.version_label,
        "arcgis_prefix": identity.arcgis_prefix,
        "status": INITIAL_STATUS,
        "change_type": change[0],
        "change_note": change[1],
        "method_date_utc": provenance["commit"]["date_utc"],
        "method_date_basis": provenance["date_basis"],
        "method_commit": provenance["commit"]["commit"],
        "generated_at_utc": stage_4_manifest["completedAt"],
        "frozen_at_utc": versions.utc_now_iso(),
        "frozen_from_commit": versions.git_head_commit(),
        "code_fingerprint": provenance["fingerprint"]["sha256"],
        "code_fingerprint_basis": provenance["basis"],
        "code_fingerprint_files": provenance["fingerprint"]["files"],
        "files_changed_in_working_tree_since_stage_4": provenance["files_changed_in_working_tree_since_stage_4"],
        "working_tree_differs_from_head": provenance["working_tree_differs_from_head"],
        "segment_network_version": stage_4_manifest["parameters"]["segmentNetworkVersion"],
        "extent_id": EXTENT_ID,
        "dataset_ids": dataset_ids,
        "water_years": water_years,
        "water_years_note": (
            "Stage 4 read these Time Series files of the modeled WSE version it was built from. The modeled WSE "
            "service publishes national-water-model-hourly WY2021–WY2023 only."
        ),
        "derivation_summary": f"{method_record['description']} Built from {built_from['product']} {built_from['version_label']}.",
        "built_from_modeled_wse_version": {key: built_from[key] for key in ("product", "method_id", "version_label")},
        "built_from_modeled_wse_method_sha256": built_from["method_sha256"],
        "pipeline_method_id": method_record["id"],
        "pipeline_method_version": method_record["version"],
        "pipeline_method_label": method_record["label"],
        "browser_drawing": browser_drawing,
        "browser_drawing_rule": BROWSER_DRAWING_NOTE[browser_drawing],
        "bucket_bounds": {
            "unit": "water depth in meters above the bed (not water-surface elevation)",
            "columns": ["min_depth_m", "max_depth_m"],
            "interval": "half-open [min_depth_m, max_depth_m)",
            "note": BUCKET_BOUNDS_NOTE,
        },
        "vertex_z": {
            "meaning": "bed elevation at the vertex, m NAVD88 (North American Vertical Datum of 1988), 3 decimals",
            "storage": "native geometry Z (MultiPolygon Z in the file geodatabase)",
        },
        "method_sha256": method_record["methodSha256"],
        "method_parameters": method_record["parameters"],
        "method_code_sha256_by_file": method_record["codeSha256ByFile"],
        "arcgis_service_title": identity.service_title(method_record["label"]),
        "arcgis_service_name": identity.service_name,
        "arcgis_service_snippet": identity.service_snippet(method_record["label"]),
        "arcgis_table_names": table_names,
        "polygon_layer": {
            "name": identity.arcgis_prefix,
            "spatial_reference": "EPSG:4326",
            "geometry_type": "MultiPolygon Z (native Z = bed elevation, m NAVD88)",
            "one_feature_per": "non-empty depth bucket (Prepared water-surface polygon)",
            "bucket_bound_columns": "min_depth_m / max_depth_m are water DEPTHS in meters, not elevations",
            "geometry_assembly": RING_ASSEMBLY_NOTE[ring_assembly],
            "vertex_count_convention": VERTEX_COUNT_NOTE[ring_assembly],
            "sub_segment_index": "always 0; reserved for future downhill sub-segments",
            "bucket_index": "index in the Creek Segment's original depth-bucket array (the depth rung for a ribbon), empty buckets included",
        },
        "channel_ribbon_table": CHANNEL_RIBBON_TABLE_NOTE if len(table_names) == 3 else None,
        "counts": counts,
        "source_checks": source_checks,
        "source": {
            "stage_4_folder": repository_relative(stage_4_folder),
            "stage_4_completed_at": stage_4_manifest["completedAt"],
            "stage_4_manifest_counts": stage_4_manifest["counts"],
        },
        "published_at_utc": None,
    }


def build_registry_version_record(version_record: dict, version_folder: Path, upload_zip_path: Path) -> dict:
    return {
        "version_label": version_record["version_label"],
        "method_id": version_record["method_id"],
        "method_number": version_record["method_number"],
        "version_number": version_record["version_number"],
        "status": INITIAL_STATUS,
        "change_type": version_record["change_type"],
        "change_note": version_record["change_note"],
        "method_date_utc": version_record["method_date_utc"],
        "generated_at_utc": version_record["generated_at_utc"],
        "frozen_at_utc": version_record["frozen_at_utc"],
        "frozen_from_commit": version_record["frozen_from_commit"],
        "built_from_modeled_wse_version": version_record["built_from_modeled_wse_version"],
        "pipeline_method_id": version_record["pipeline_method_id"],
        "pipeline_method_version": version_record["pipeline_method_version"],
        "method_sha256": version_record["method_sha256"],
        "browser_drawing": version_record["browser_drawing"],
        "bucket_bounds": "water depth in meters above the bed (min_depth_m / max_depth_m), not elevation",
        "version_folder": repository_relative(version_folder),
        "arcgis_upload_sha256": versions.sha256_of_file(upload_zip_path),
        "arcgis_prefix": version_record["arcgis_prefix"],
        "arcgis_table_names": version_record["arcgis_table_names"],
        "arcgis_service_name": version_record["arcgis_service_name"],
        "arcgis_service_title": version_record["arcgis_service_title"],
        "feature_count": version_record["counts"]["features"],
        "arcgis": {
            "file_geodatabase_item_id": None,
            "service_item_id": None,
            "service_url": None,
            "layer_ids": {name: None for name in version_record["arcgis_table_names"]},
            "published_at_utc": None,
        },
    }


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--method", required=True, help="Stage 4 WSE Polygon Generation Method id, for example flowline-channel-ribbon.")
    parser.add_argument("--version", required=True, help="Version label m<registry method number>-v<pipeline method version>, for example m3-v2.")
    parser.add_argument(
        "--dry-run-into",
        type=Path,
        help="Write the version to this new scratch folder instead of data-product-versions/, and leave the registry alone.",
    )
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    started = time.monotonic()
    registry = versions.read_registry()
    method_number = registry_method_number(arguments.method, registry)
    identity = DataProductVersionIdentity(WSE_POLYGONS, f"m{method_number}-{arguments.method}", arguments.version)
    stage_4_folder = STAGE_4_ROOT / arguments.method / f"v{identity.version_number}"
    dry_run_folder: Path | None = arguments.dry_run_into.resolve() if arguments.dry_run_into else None
    final_folder = dry_run_folder or identity.version_folder
    if dry_run_folder is None and final_folder.exists():
        raise versions.VersionFolderAlreadyExistsError(f"{final_folder} already exists; versions are append-only.")
    for version in registry.get("products", {}).get(WSE_POLYGONS, {}).get("versions", []):
        if version.get("version_label") == identity.version_label and dry_run_folder is None:
            raise SystemExit(f"Registry already has {WSE_POLYGONS} {identity.version_label} ({version.get('method_id')}); versions are append-only.")
    log(f"Freezing {WSE_POLYGONS} {identity.version_label} ({identity.method_id}) into {final_folder}{' (dry run)' if dry_run_folder else ''}")

    stage_4_manifest = read_json(stage_4_folder / "manifest.json")
    method_record = stage_4_manifest["parameters"]["wsePolygonGenerationMethod"]
    if method_record["id"] != arguments.method or method_record["version"] != identity.version_number:
        raise RuntimeError(f"Stage 4 manifest is for {method_record['id']} v{method_record['version']}, not {arguments.method} v{identity.version_number}.")
    ring_assembly = RING_ASSEMBLY_BY_BROWSER_DRAWING.get(method_record["browserDrawing"])
    if ring_assembly is None:
        raise RuntimeError(f"browserDrawing {method_record['browserDrawing']} is not a depth-bucket drawing this script freezes.")
    log("Checking source integrity …")
    polygon_set_file_count = verify_polygon_set_files_match_manifest(stage_4_folder)
    time_series_input_count = verify_stage_4_time_series_inputs_match_stage_3_outputs(stage_4_manifest)
    built_from = built_from_modeled_wse_version(stage_4_manifest)
    built_from_is_registered = check_built_from_frozen_modeled_wse_version(built_from, registry)
    is_new_method = not any(
        version.get("pipeline_method_id") == arguments.method for version in registry["products"].get(WSE_POLYGONS, {}).get("versions", [])
    ) and identity.version_number == 1
    change = change_type_and_note(method_record, built_from, is_new_method)
    source_checks = {
        "polygon_set_files_match_stage_4_manifest_sha256": polygon_set_file_count,
        "stage_4_time_series_inputs_match_stage_3_output_sha256": time_series_input_count,
        "method_code_files_match_stage_4_manifest_sha256": len(method_record["codeSha256ByFile"]),
        "built_from_modeled_wse_version_in_registry_at_freeze": built_from_is_registered,
    }
    log(f"  {polygon_set_file_count} polygon-set files and {time_series_input_count} time-series inputs verified; built from {built_from['version_label']}.")

    log(f"Assembling Prepared water-surface polygons (Z kept; ring assembly: {ring_assembly}) …")
    attribute_rows, geometries, channel_ribbons, counts = build_polygon_features(stage_4_folder, ring_assembly)
    check_counts_against_stage_4_manifest(counts, stage_4_manifest["counts"])
    log(f"  {counts['features']:,} features from {counts['depth_buckets']:,} buckets ({counts['empty_buckets_skipped']:,} empty skipped).")
    log(f"  single rings with counter-clockwise net area {counts['single_rings_with_counter_clockwise_net_area']:,}; vertex Z {counts['vertex_z_range_m']} m; depths {counts['bucket_depth_range_m']} m.")

    channel_ribbon_table_name = f"{identity.arcgis_prefix}_channel_ribbons"
    table_names = [identity.versions_table_name, identity.arcgis_prefix] + ([channel_ribbon_table_name] if channel_ribbons else [])
    version_record = build_version_record(identity, stage_4_folder, stage_4_manifest, counts, source_checks, change, ring_assembly, table_names)
    versions_row = build_versions_table_row(version_record)

    folder_context = dry_run_version_folder(dry_run_folder) if dry_run_folder else versions.staged_version_folder(
        WSE_POLYGONS, identity.method_id, identity.version_label
    )
    with folder_context as staging_folder:
        (staging_folder / "source-manifests").mkdir()
        shutil.copy2(stage_4_folder / "manifest.json", staging_folder / "source-manifests" / "04-manifest.json")
        upload_zip_path = staging_folder / "arcgis-upload" / identity.upload_zip_name
        with tempfile.TemporaryDirectory(prefix=f"{WSE_POLYGONS}-{identity.version_label}-gdb-") as temporary_folder:
            file_geodatabase_path = Path(temporary_folder) / identity.upload_gdb_folder_name
            log(f"Writing {identity.upload_gdb_folder_name}: {identity.versions_table_name}, {identity.arcgis_prefix} ({len(geometries):,} features, Z) …")
            write_versions_table(file_geodatabase_path, versions_row)
            write_polygon_layer(file_geodatabase_path, identity.arcgis_prefix, attribute_rows, geometries)
            info = pyogrio.read_info(str(file_geodatabase_path), layer=identity.arcgis_prefix)
            if info["features"] != counts["features"] or info["geometry_type"] != "MultiPolygon Z":
                raise RuntimeError(f"File geodatabase layer holds {info['features']} {info['geometry_type']} features, expected {counts['features']} MultiPolygon Z.")
            if channel_ribbons:
                log(f"Writing {channel_ribbon_table_name} ({len(channel_ribbons):,} rows) …")
                write_channel_ribbon_table(file_geodatabase_path, channel_ribbon_table_name, channel_ribbon_table(channel_ribbons))
            zip_file_geodatabase(file_geodatabase_path, upload_zip_path)
        version_record["counts"]["arcgis_rows"] = {
            identity.versions_table_name: 1,
            identity.arcgis_prefix: counts["features"],
            **({channel_ribbon_table_name: len(channel_ribbons)} if channel_ribbons else {}),
        }
        version_record["files"] = describe_files(staging_folder)
        versions.write_json(staging_folder / "version.json", version_record)

    if dry_run_folder is not None:
        log(f"Dry run written to {dry_run_folder}; registry not changed. Done in {time.monotonic() - started:.1f} s.")
        return
    registry_record = build_registry_version_record(version_record, final_folder, final_folder / "arcgis-upload" / identity.upload_zip_name)
    versions.update_registry_version(WSE_POLYGONS, registry_record)
    log(f"Registry updated ({WSE_POLYGONS} {identity.version_label}). Done in {time.monotonic() - started:.1f} s.")


if __name__ == "__main__":
    main()
