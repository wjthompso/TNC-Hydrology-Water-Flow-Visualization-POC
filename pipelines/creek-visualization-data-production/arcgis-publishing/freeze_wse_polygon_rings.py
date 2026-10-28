"""Freeze the exact rings of one frozen channel-ribbon WSE polygons version as a supplementary table.

Why: when a ribbon version's polygon layer is published, ArcGIS splits every ring that crosses itself (a folded depth rung,
about 5% of buckets) into simple pieces. The footprint survives, but the station-ordered vertex list the browser's ribbon
drawing needs (left edge stations 0…n−1, then right edge n−1…0) does not. This script writes those rings as text, one row
per depth bucket, so a hosted browser can read them back unchanged. The polygon layer itself stays as published.

    npm run data-products:freeze-wse-polygon-rings -- --version m3-v2

Writes data/data-product-versions/wse-polygons/<method id>/<label>-rings/ (append-only, refused when it exists):

    arcgis-upload/wse-polygons-<label>-rings.gdb.zip   one table, wse_polygons_<label>_rings
    rings.json                                         what it is, the schema, the source checks, counts, file hashes

Columns: segment_id, tnc_comid, bucket_index (the depth rung, as in the polygon layer), min_depth_m, max_depth_m,
vertex_count, ring_json (the bucket's one ring as [[lon, lat, bed z], …] exactly as Stage 4 wrote it, without a closing vertex).

Checks before anything is written: the version is in the registry with a channel-ribbon drawing; every Stage 4 polygon set
file still has the SHA-256 the frozen 04-manifest.json recorded (so the rings are the frozen source); the rows, bucket bounds,
and every ring's vertices equal the frozen file geodatabase's polygon layer (same vertices, start, and direction, or the
rotation or reversal its writer applied, counted); and the written table reads back with identical text.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import shapely

sys.path.insert(0, str(Path(__file__).resolve().parent))

import data_product_versions as versions  # noqa: E402
from data_product_version_identity import SERVICE_NAME_PREFIX, WSE_POLYGONS, DataProductVersionIdentity  # noqa: E402
from file_geodatabase_tables import (  # noqa: E402
    double_column,
    integer_column,
    read_table,
    text_column,
    unzip_gdb,
    write_table,
    zip_folder,
)
from freeze_wse_polygons_version import tnc_comid_of_segment_id  # noqa: E402
from validate_wse_polygons_depth_version import closed, ring_match  # noqa: E402

RINGS_SUFFIX = "rings"
RING_JSON_WIDTH = 10000
CHANNEL_RIBBON_DRAWINGS = ("channel-ribbon-depth", "channel-ribbon-pool-filled")


def log(message: str) -> None:
    print(f"[freeze-wse-polygon-rings] {message}", flush=True)


def rings_label(version_label: str) -> str:
    return f"{version_label}-{RINGS_SUFFIX}"


def rings_table_name(identity: DataProductVersionIdentity) -> str:
    return f"{identity.arcgis_prefix}_{RINGS_SUFFIX}"


def rings_service_name(identity: DataProductVersionIdentity) -> str:
    """The polygon version's service name plus `_rings`; the browser derives it the same way from the polygons service URL."""
    return f"{SERVICE_NAME_PREFIX}_{rings_table_name(identity)}"


def rings_upload_zip_name(identity: DataProductVersionIdentity) -> str:
    return f"{identity.product}-{rings_label(identity.version_label)}.gdb.zip"


def registry_polygon_version(version_label: str) -> dict:
    matches = [entry for entry in versions.read_registry()["products"][WSE_POLYGONS]["versions"] if entry["version_label"] == version_label]
    if len(matches) != 1:
        raise SystemExit(f"Registry has {len(matches)} wse-polygons entries labelled {version_label}.")
    entry = matches[0]
    if entry.get("browser_drawing") not in CHANNEL_RIBBON_DRAWINGS:
        raise SystemExit(f"wse-polygons {version_label} is drawn {entry.get('browser_drawing')!r}, not as a channel ribbon; it needs no ring table.")
    return entry


def check_stage_4_files_are_the_frozen_source(stage_4_manifest: dict) -> list[Path]:
    """Every polygon set file the frozen Stage 4 manifest lists, after checking its SHA-256 is unchanged."""
    paths = []
    for relative_path, record in sorted(stage_4_manifest["outputs"].items()):
        if "/water-surface-polygon-sets/" not in relative_path:
            continue
        path = versions.REPOSITORY_ROOT / relative_path
        if versions.sha256_of_file(path) != record["sha256"]:
            raise SystemExit(f"{relative_path} changed since the version was frozen (SHA-256 differs). Nothing was written.")
        paths.append(path)
    return paths


def ring_rows(polygon_set_paths: list[Path]) -> list[dict]:
    rows = []
    for path in polygon_set_paths:
        for polygon_set in json.loads(path.read_text(encoding="utf-8"))["waterSurfacePolygonSets"]:
            for bucket_index, bucket in enumerate(polygon_set["elevationBuckets"]):
                rings = bucket["ringsWgs84"]
                if not rings:
                    continue
                if len(rings) != 1:
                    raise SystemExit(f"{polygon_set['segmentId']} bucket {bucket_index} holds {len(rings)} rings; a ribbon bucket holds 1.")
                rows.append(
                    {
                        "segment_id": polygon_set["segmentId"],
                        "tnc_comid": tnc_comid_of_segment_id(polygon_set["segmentId"]),
                        "bucket_index": bucket_index,
                        "min_depth_m": bucket["minWaterSurfaceElevationM"],
                        "max_depth_m": bucket["maxWaterSurfaceElevationM"],
                        "vertex_count": len(rings[0]),
                        "ring_json": json.dumps(rings[0], separators=(",", ":")),
                    }
                )
    return rows


def compare_with_frozen_polygon_layer(rows: list[dict], frozen_zip: Path, polygon_layer_name: str) -> dict:
    """Same keys, bounds, and ring vertices as the frozen polygon layer; returns the ring match counts."""
    with tempfile.TemporaryDirectory(prefix="frozen-ribbon-gdb-") as temporary_folder:
        table = read_table(unzip_gdb(frozen_zip, Path(temporary_folder)), polygon_layer_name)
    frozen = table.to_pydict()
    geometry_column = next(name for name in frozen if name.lower() in ("geometry", "shape", "wkb_geometry"))
    frozen_by_key = {
        (segment_id, bucket_index): (min_depth, max_depth, wkb)
        for segment_id, bucket_index, min_depth, max_depth, wkb in zip(
            frozen["segment_id"], frozen["bucket_index"], frozen["min_depth_m"], frozen["max_depth_m"], frozen[geometry_column]
        )
    }
    if len(frozen_by_key) != len(rows) or set(frozen_by_key) != {(row["segment_id"], row["bucket_index"]) for row in rows}:
        raise SystemExit(f"The frozen polygon layer has {len(frozen_by_key):,} buckets, the rings {len(rows):,}, or the keys differ.")
    outcomes = {"exact": 0, "rotated": 0, "reversed": 0}
    for row in rows:
        min_depth, max_depth, wkb = frozen_by_key[(row["segment_id"], row["bucket_index"])]
        if (min_depth, max_depth) != (row["min_depth_m"], row["max_depth_m"]):
            raise SystemExit(f"{row['segment_id']} bucket {row['bucket_index']}: bounds differ from the frozen polygon layer.")
        stored_rings = shapely.get_rings(shapely.get_parts(shapely.from_wkb(wkb)))
        if len(stored_rings) != 1:
            raise SystemExit(f"{row['segment_id']} bucket {row['bucket_index']}: the frozen geometry has {len(stored_rings)} rings.")
        outcome = ring_match(closed(json.loads(row["ring_json"])), np.asarray(shapely.get_coordinates(stored_rings[0], include_z=True)))
        if outcome is None:
            raise SystemExit(f"{row['segment_id']} bucket {row['bucket_index']}: the ring's vertices differ from the frozen geometry.")
        outcomes[outcome] += 1
    return outcomes


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True, help="Frozen channel-ribbon WSE polygons version label, for example m3-v2.")
    parser.add_argument("--trial-folder", type=Path, help="Write the folder here instead of data/data-product-versions/ (a trial run).")
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    started = time.time()
    entry = registry_polygon_version(arguments.version)
    identity = DataProductVersionIdentity(WSE_POLYGONS, entry["method_id"], arguments.version)
    polygon_version_folder = versions.REPOSITORY_ROOT / entry["version_folder"]
    version_json = json.loads((polygon_version_folder / "version.json").read_text(encoding="utf-8"))
    stage_4_manifest = json.loads((polygon_version_folder / "source-manifests" / "04-manifest.json").read_text(encoding="utf-8"))
    frozen_zip = polygon_version_folder / "arcgis-upload" / identity.upload_zip_name
    label = rings_label(arguments.version)
    table_name = rings_table_name(identity)

    log(f"Checking the Stage 4 polygon set files against the frozen {arguments.version} manifest")
    polygon_set_paths = check_stage_4_files_are_the_frozen_source(stage_4_manifest)
    rows = ring_rows(polygon_set_paths)
    if len(rows) != version_json["counts"]["features"]:
        raise SystemExit(f"{len(rows):,} rings, but the frozen version has {version_json['counts']['features']:,} features.")
    log(f"{len(polygon_set_paths)} files unchanged; {len(rows):,} rings. Comparing with the frozen file geodatabase")
    ring_outcomes = compare_with_frozen_polygon_layer(rows, frozen_zip, identity.arcgis_prefix)
    log(f"Rings equal to the frozen geometry: {ring_outcomes}")

    columns = [
        text_column("segment_id", [row["segment_id"] for row in rows], 32),
        text_column("tnc_comid", [row["tnc_comid"] for row in rows], 16),
        integer_column("bucket_index", [row["bucket_index"] for row in rows]),
        double_column("min_depth_m", np.array([row["min_depth_m"] for row in rows], dtype=float)),
        double_column("max_depth_m", np.array([row["max_depth_m"] for row in rows], dtype=float)),
        integer_column("vertex_count", [row["vertex_count"] for row in rows]),
        text_column("ring_json", [row["ring_json"] for row in rows], RING_JSON_WIDTH),
    ]
    final_folder = arguments.trial_folder / label if arguments.trial_folder else None
    with versions.staged_version_folder(WSE_POLYGONS, identity.method_id, label, final_folder) as staging:
        upload_folder = staging / "arcgis-upload"
        upload_folder.mkdir()
        upload_zip = upload_folder / rings_upload_zip_name(identity)
        with tempfile.TemporaryDirectory(prefix=f"{label}-gdb-") as temporary_folder:
            gdb_path = Path(temporary_folder) / f"{table_name}.gdb"
            row_count = write_table(gdb_path, table_name, columns)
            read_back = read_table(gdb_path, table_name).to_pydict()
            if read_back["ring_json"] != [row["ring_json"] for row in rows] or read_back["bucket_index"] != [row["bucket_index"] for row in rows]:
                raise SystemExit("The written table does not read back with identical rings. Nothing was written.")
            zip_folder(gdb_path, upload_zip)
        record = {
            "product": WSE_POLYGONS,
            "supplementary_to": {"version_label": arguments.version, "method_id": identity.method_id, "version_folder": entry["version_folder"]},
            "label": label,
            "purpose": (
                "Exact station-ordered rings of every depth bucket of the channel ribbon, because the published polygon layer's "
                "self-crossing rings were split by ArcGIS on publishing. The hosted browser reads this table instead of the "
                "polygon layer geometry; the polygon layer stays the version's map layer."
            ),
            "frozen_at_utc": versions.utc_now_iso(),
            "frozen_from_commit": versions.git_head_commit(),
            "arcgis_table_name": table_name,
            "arcgis_service_name": rings_service_name(identity),
            "schema": {
                "segment_id": "Creek Segment id",
                "tnc_comid": "TNC flowline COMID (text)",
                "bucket_index": "depth rung, as bucket_index in the polygon layer",
                "min_depth_m": "bucket lower bound, water depth in meters (minWaterSurfaceElevationM in the Stage 4 file)",
                "max_depth_m": "bucket upper bound, water depth in meters",
                "vertex_count": "vertices in ring_json",
                "ring_json": "the bucket's one ring as [[lon, lat, bed elevation m NAVD88], …], EPSG:4326, exactly as Stage 4 wrote it; no closing vertex; left edge stations 0…n−1, then right edge n−1…0",
            },
            "source_checks": {
                "polygon_set_files_match_frozen_stage_4_manifest_sha256": len(polygon_set_paths),
                "rings_equal_frozen_polygon_layer": ring_outcomes,
                "table_reads_back_identical": True,
            },
            "counts": {
                "rows": row_count,
                "vertices": int(sum(row["vertex_count"] for row in rows)),
                "longest_ring_json_characters": max(len(row["ring_json"]) for row in rows),
            },
            "files": [
                {"path": upload_zip.relative_to(staging).as_posix(), "bytes": upload_zip.stat().st_size, "sha256": versions.sha256_of_file(upload_zip)}
            ],
        }
        versions.write_json(staging / "rings.json", record)
    log(f"Wrote {final_folder or versions.version_folder_path(WSE_POLYGONS, identity.method_id, label)}/ in {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
