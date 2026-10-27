"""Freeze one version of a depth-style Modeled WSE Derivation Method as an append-only Data-Product Version.

Generic over method and version: m2 through m5 write the same Time Series shape (anchor WSE `values`,
water depth at both junctions, three static beds), so one script freezes any of them. Everything that
differs is read from the Stage 3 manifest: the method's number, version, change type, change note,
description, parameters, and code fingerprint, and where its anchor point lies. Names come from
data_product_version_identity.py. Local only; never contacts ArcGIS.

    data/data-product-versions/modeled-wse/<method id>/<label>/
      version.json                      identity, provenance, schema, counts, file hashes
      source-manifests/                 copies of the Stage 1 and Stage 3 (and, for a ribbon anchor, Stage 4) manifests
      creek-segment-network.json        from export-creek-segment-network.ts (canonical TS segmentation)
      arcgis-upload/modeled-wse-<label>.gdb.zip
      raw-hourly-values/national-water-model-hourly-WY2021.csv.zip (… WY2022, WY2023)

The file geodatabase holds the tables of m2-v1 (freeze_modeled_wse_m2_version.py), renamed with the
label, plus three Creek Segment columns that apply to the channel-ribbon methods:

- Creek Segments layer: m1's columns, the anchor point (anchor_longitude, anchor_latitude), the anchor and
  junction beds, and null_values_note (the Stage 3 warning that explains a Creek Segment whose values are
  all null, for example one that lies wholly on a breached road fill). For m3, m4, and m5 the anchor point
  is channelRibbon.anchorLonLat of the flowline-channel-ribbon version built on the same channel, and
  anchor_station, station_count, breached_station_count come from the same record (null where that ribbon
  version does not store them). For m2 it is the Stage 1 section the method solves at the anchor.
- Held WSE Interval tables (NWM hourly, CNF monthly) per Creek Segment: wse_m and both junction depths;
  an interval ends when any of the three changes. Junction WSE = junction bed + junction depth.
- cnf_monthly_values: one plain row per Creek Segment per month.

An older method version whose code has since changed in the working tree (m3 v1 after m3 v2) is frozen
from the oldest git commit that holds exactly the code Stage 3 recorded; the freeze refuses when no
commit does. Refuses to write over an existing folder or registry label.

    npm run data-products:freeze-modeled-wse-version -- --method m4-flowline-profile-variable-power-depth --version m4-v1
    npm run data-products:freeze-modeled-wse-version -- --method m3-flowline-profile-manning-depth --version m3-v2 \\
      --trial-folder=<new scratch folder> --only-tnc-comids=27714697
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_version_identity import MODELED_WSE, DataProductVersionIdentity  # noqa: E402
from data_product_versions import (  # noqa: E402
    REPOSITORY_ROOT,
    code_fingerprint,
    git_first_commit_with_method_code,
    git_head_commit,
    git_oldest_commit_holding_method_code,
    git_uncommitted_paths,
    read_registry,
    repository_relative_path,
    sha256_of_file,
    staged_version_folder,
    update_registry_version,
    utc_iso_from_epoch_ms,
    utc_now_iso,
    write_json,
)
from file_geodatabase_tables import double_column, integer_column, text_column, write_table, zip_folder  # noqa: E402
from freeze_modeled_wse_m2_version import (  # noqa: E402
    DepthHeldWseIntervalRows,
    MonthlyValueRows,
    RawHourlyCsvZipWriters,
    SegmentStaticValues,
    shared_junction_statistics,
)
from freeze_modeled_wse_version import (  # noqa: E402
    DERIVATION_JSON_WIDTH,
    LONG_TEXT_WIDTH,
    check_flowline_segments_match_network,
    creek_segment_columns_and_geometry,
    export_creek_segment_network,
    file_entry,
    log,
    method_code_files_changed_since_stage_3,
    tnc_comids_in_network_order,
    versions_table_columns,
    water_years_text,
)
from modeled_wse_depth_source_series import DepthFlowlineSeries, DepthTimeSeriesFolder  # noqa: E402
from modeled_wse_m2_version_layout import anchor_points_by_segment_id  # noqa: E402
from modeled_wse_version_layout import (  # noqa: E402
    ARCGIS_UPLOAD_FOLDER_NAME,
    CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID,
    CREEK_SEGMENT_NETWORK_FILE_NAME,
    EXTENT_ID,
    EXTENT_WORKING_OUTPUT_FOLDER,
    HOUR_MS,
    NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
    NHDPLUSV2_REACH_CROSSWALK_PATH,
    PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS,
    RAW_HOURLY_VALUES_FOLDER_NAME,
    SEGMENT_NETWORK_VERSION,
    SOURCE_MANIFESTS_FOLDER_NAME,
    VERSION_JSON_NAME,
    add_one_month_ms,
    read_json,
)

STATUS = "active"  # the registry has no "experimental" status; the portal snippet says experimental
STAGE_3_ROOT = EXTENT_WORKING_OUTPUT_FOLDER / "03-time-series"
STAGE_4_ROOT = EXTENT_WORKING_OUTPUT_FOLDER / "04-water-surface-polygons"
CROSS_SECTIONS_PATH = EXTENT_WORKING_OUTPUT_FOLDER / "01-cross-sections" / "cross-sections.json"
STAGE_1_MANIFEST_PATH = EXTENT_WORKING_OUTPUT_FOLDER / "01-cross-sections" / "manifest.json"
# Read for its method-independent dataset facts only; the catalog on disk describes the default method.
CATALOG_PATH = EXTENT_WORKING_OUTPUT_FOLDER / "05-catalog" / "catalog.json"

STAGE_1_SECTION = "stage-1-section"
CHANNEL_RIBBON = "channel-ribbon"
ANCHOR_BED_TOLERANCE_M = 0.001
# m2's Stage 1 section beds were allowed to differ for 5 Creek Segments (freeze_modeled_wse_m2_version.py);
# a channel ribbon stores the very bed Stage 3 used, so none may differ.
ALLOWED_ANCHOR_BED_MISMATCHES = {STAGE_1_SECTION: 5, CHANNEL_RIBBON: 0}
NULL_VALUES_WARNING = re.compile(r"^(?P<segment_id>\d+-\d{3}) (?P<note>.*values are null\.?)$")

ANCHOR_AND_JUNCTION_BED_FIELDS = [
    "anchor_longitude",
    "anchor_latitude",
    "anchor_bed_elevation_m",
    "junction_bed_upstream_m",
    "junction_bed_downstream_m",
]
CHANNEL_RIBBON_FIELDS = ["anchor_station", "station_count", "breached_station_count"]

HELD_WSE_INTERVAL_NOTE = (
    "One row per Creek Segment and stretch of time in which wse_m, junction_depth_upstream_m, and "
    "junction_depth_downstream_m all stay constant (NaN equals NaN). valid_until_utc is exclusive. A null run "
    "is one interval with all three null. step_count is the number of time steps the interval covers."
)
JUNCTION_WSE_NOTE = (
    "Junction WSE is not stored. It is the segment's junction bed (static column) plus its junction depth "
    "(Held WSE Interval column), rounded to 3 decimals; null where the depth is null."
)
NULL_VALUES_NOTE = (
    "null_values_note is the Stage 3 warning for a Creek Segment whose values are all null (no discharge beyond "
    "the Drainage-Area Ratio Transfer distance, or a segment lying wholly on a breached road or railroad fill); "
    "null otherwise. Such a segment's wse_m and junction depths stay null in every table."
)


# ---------------------------------------------------------------------------
# Where the anchor point lies
# ---------------------------------------------------------------------------


def channel_version_of(stage_3_manifest: dict, method: dict, identity: DataProductVersionIdentity) -> dict:
    """The modeled WSE version whose channel this version solves on: its own, or channelFromModeledWseVersion (m4, m5)."""
    recorded = stage_3_manifest["parameters"].get("channelFromModeledWseVersion")
    if recorded:
        return {"method_id": recorded["methodId"], "version_label": recorded["versionLabel"], "method_sha256": recorded["methodSha256"]}
    return {"method_id": method["id"], "version_label": identity.version_label, "method_sha256": method["methodSha256"]}


def channel_ribbon_stage_4_folder(channel_version: dict) -> Path:
    """The one Stage 4 version built from the channel version (fingerprint included) whose polygon sets carry channelRibbon."""
    matches = []
    for manifest_path in sorted(STAGE_4_ROOT.glob("*/v*/manifest.json")):
        built_from = read_json(manifest_path)["parameters"].get("builtFromModeledWseVersion") or {}
        if (built_from.get("methodId"), built_from.get("versionLabel"), built_from.get("methodSha256")) != (
            channel_version["method_id"],
            channel_version["version_label"],
            channel_version["method_sha256"],
        ):
            continue
        first_polygon_set_file = next(iter(sorted((manifest_path.parent / "water-surface-polygon-sets").glob("*.json"))), None)
        if first_polygon_set_file and "channelRibbon" in read_json(first_polygon_set_file)["waterSurfacePolygonSets"][0]:
            matches.append(manifest_path.parent)
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected one Stage 4 channel-ribbon version built from {channel_version['method_id']} "
            f"{channel_version['version_label']}, found {[repository_relative_path(path) for path in matches]}."
        )
    return matches[0]


def verify_polygon_set_files_match_manifest(stage_4_folder: Path) -> int:
    recorded_outputs = read_json(stage_4_folder / "manifest.json")["outputs"]
    paths = sorted((stage_4_folder / "water-surface-polygon-sets").glob("*.json"))
    for path in paths:
        if recorded_outputs.get(repository_relative_path(path), {}).get("sha256") != sha256_of_file(path):
            raise RuntimeError(f"{repository_relative_path(path)} differs from its Stage 4 manifest (sha256).")
    return len(paths)


def channel_ribbon_anchor_points(stage_4_folder: Path) -> dict[str, dict]:
    """channelRibbon of every Creek Segment that has a ribbon; a segment without one has no anchor point here."""
    anchor_points = {}
    for path in sorted((stage_4_folder / "water-surface-polygon-sets").glob("*.json")):
        for polygon_set in read_json(path)["waterSurfacePolygonSets"]:
            ribbon = polygon_set.get("channelRibbon")
            if ribbon is None:
                continue
            longitude, latitude = ribbon["anchorLonLat"]
            anchor_points[polygon_set["segmentId"]] = {
                "anchor_longitude": float(longitude),
                "anchor_latitude": float(latitude),
                "source_anchor_bed_elevation_m": ribbon["anchorBedElevationM"],
                "anchor_station": ribbon.get("anchorStation"),
                "station_count": ribbon["stationCount"],
                "breached_station_count": ribbon.get("breachedStations"),
            }
    return anchor_points


def anchor_point_source(stage_3_manifest: dict, method: dict, identity: DataProductVersionIdentity) -> dict:
    """How this method places its WSE Anchor Point, and the point of every Creek Segment."""
    solved_sections = method["parameters"].get("solvedSections")
    if solved_sections:
        section_index = solved_sections["anchorSectionIndex"]
        points = anchor_points_by_segment_id(read_json(CROSS_SECTIONS_PATH), section_index)
        for point in points.values():
            point["source_anchor_bed_elevation_m"] = point.pop("stage_1_anchor_bed_elevation_m")
        return {
            "kind": STAGE_1_SECTION,
            "description": (
                f"Stage 1 section index {section_index}'s thalwegUtm (EPSG:32610) transformed to EPSG:4326 with pyproj, "
                "always_xy; its bedElevationM is cross-checked against the Time Series anchorBedElevationM."
            ),
            "stage_1_section_index": section_index,
            "points": points,
        }
    channel_version = channel_version_of(stage_3_manifest, method, identity)
    stage_4_folder = channel_ribbon_stage_4_folder(channel_version)
    stage_4_manifest = read_json(stage_4_folder / "manifest.json")
    ribbon_method = stage_4_manifest["parameters"]["wsePolygonGenerationMethod"]
    return {
        "kind": CHANNEL_RIBBON,
        "description": (
            f"channelRibbon.anchorLonLat (the anchor station's lowest point, WGS 84) of {ribbon_method['id']} "
            f"v{ribbon_method['version']}, the WSE Polygon Generation Method version built on modeled WSE "
            f"{channel_version['version_label']}, whose channel this version solves on; its anchorBedElevationM must "
            "equal the Time Series anchorBedElevationM. A Creek Segment without a ribbon has no anchor point (null)."
        ),
        "channel_from_modeled_wse_version": channel_version,
        "stage_4_folder": repository_relative_path(stage_4_folder),
        "stage_4_manifest_path": stage_4_folder / "manifest.json",
        "wse_polygon_generation_method": {
            "id": ribbon_method["id"],
            "version": ribbon_method["version"],
            "method_sha256": ribbon_method["methodSha256"],
        },
        "polygon_set_files_checked": verify_polygon_set_files_match_manifest(stage_4_folder),
        "points": channel_ribbon_anchor_points(stage_4_folder),
    }


def anchor_bed_cross_check(anchor_source: dict, static_values: SegmentStaticValues) -> dict:
    """The anchor source's bed vs the Time Series anchorBedElevationM, per Creek Segment with an anchor point."""
    points = anchor_source["points"]
    differences = {
        segment_id: abs(points[segment_id]["source_anchor_bed_elevation_m"] - beds[0])
        for segment_id, beds in static_values.by_segment_id.items()
        if segment_id in points
    }
    mismatched = {segment_id: difference for segment_id, difference in differences.items() if difference > ANCHOR_BED_TOLERANCE_M}
    report = {
        "anchor_point_source": anchor_source["kind"],
        "segments_compared": len(differences),
        "segments_without_anchor_point": sorted(set(static_values.by_segment_id) - set(points)),
        "tolerance_m": ANCHOR_BED_TOLERANCE_M,
        "segments_beyond_tolerance": len(mismatched),
        "maximum_difference_m": max(differences.values()) if differences else 0.0,
        "mismatches": {segment_id: round(difference, 6) for segment_id, difference in sorted(mismatched.items())},
    }
    allowed = ALLOWED_ANCHOR_BED_MISMATCHES[anchor_source["kind"]]
    if len(mismatched) > allowed:
        raise ValueError(
            f"Anchor bed of the {anchor_source['kind']} differs from the Time Series anchorBedElevationM by more than "
            f"{ANCHOR_BED_TOLERANCE_M} m for {len(mismatched)} Creek Segments (allowed {allowed}); "
            f"first: {list(report['mismatches'].items())[:5]}"
        )
    return report


# ---------------------------------------------------------------------------
# Creek Segments layer
# ---------------------------------------------------------------------------


def null_values_notes(stage_3_manifest: dict) -> dict[str, str]:
    notes = {}
    for warning in stage_3_manifest.get("warnings", []):
        match = NULL_VALUES_WARNING.match(warning)
        if match:
            notes[match["segment_id"]] = match["note"]
    return notes


def creek_segment_columns(
    network_segments: list[dict],
    crosswalk_by_id: dict[str, dict],
    anchor_source: dict,
    static_values: SegmentStaticValues,
    notes: dict[str, str],
) -> tuple[list, list]:
    """m1's Creek Segment columns, the anchor point and beds, the channel-ribbon station facts, and the null note."""
    columns, geometry_wkb = creek_segment_columns_and_geometry(network_segments, crosswalk_by_id)
    segment_ids = [segment["segmentId"] for segment in network_segments]
    points = [anchor_source["points"].get(segment_id, {}) for segment_id in segment_ids]
    anchor_bed, junction_bed_upstream, junction_bed_downstream = (
        [static_values.by_segment_id[segment_id][index] for segment_id in segment_ids] for index in range(3)
    )
    columns += [
        double_column("anchor_longitude", [point.get("anchor_longitude") for point in points]),
        double_column("anchor_latitude", [point.get("anchor_latitude") for point in points]),
        double_column("anchor_bed_elevation_m", anchor_bed),
        double_column("junction_bed_upstream_m", junction_bed_upstream),
        double_column("junction_bed_downstream_m", junction_bed_downstream),
    ]
    if anchor_source["kind"] == CHANNEL_RIBBON:
        columns += [integer_column(name, [point.get(name) for point in points]) for name in CHANNEL_RIBBON_FIELDS]
    columns.append(text_column("null_values_note", [notes.get(segment_id) for segment_id in segment_ids], LONG_TEXT_WIDTH))
    return columns, geometry_wkb


def added_creek_segment_fields(anchor_source: dict) -> list[str]:
    ribbon_fields = CHANNEL_RIBBON_FIELDS if anchor_source["kind"] == CHANNEL_RIBBON else []
    return [*ANCHOR_AND_JUNCTION_BED_FIELDS, *ribbon_fields, "null_values_note"]


# ---------------------------------------------------------------------------
# Version metadata
# ---------------------------------------------------------------------------


def read_stage_3_method_record(stage_3_manifest: dict, identity: DataProductVersionIdentity) -> dict:
    method = stage_3_manifest.get("parameters", {}).get("modeledWseDerivationMethod")
    if not method:
        raise RuntimeError("The Stage 3 manifest has no modeledWseDerivationMethod record. Run Stage 3 first.")
    recorded = (method["id"], method["methodNumber"], method["version"])
    if recorded != (identity.method_id, identity.method_number, identity.version_number):
        raise RuntimeError(f"Stage 3 output is for {recorded}, but this run freezes {identity.method_id} {identity.version_label}.")
    return method


def method_code_provenance(method: dict) -> dict:
    """The commit and fingerprint of the code Stage 3 ran, from the working tree or, for an older version, from git."""
    changed_in_working_tree = method_code_files_changed_since_stage_3(method)
    if changed_in_working_tree:
        commit, basis = git_oldest_commit_holding_method_code(method["codeSha256ByFile"])
    else:
        commit, basis = git_first_commit_with_method_code(method["codeSha256ByFile"])
    code_paths = [REPOSITORY_ROOT / relative_path for relative_path in method["codeSha256ByFile"]]
    fingerprint = code_fingerprint(code_paths, commit=commit["commit"] if changed_in_working_tree else None)
    if {file["path"]: file["sha256"] for file in fingerprint["files"]} != method["codeSha256ByFile"]:
        raise RuntimeError("The code fingerprint does not reproduce the Stage 3 codeSha256ByFile.")
    return {
        "commit": commit,
        "date_basis": basis,
        "fingerprint": fingerprint,
        "basis": (
            "the Stage 3 manifest's codeSha256ByFile, checked equal to "
            + (f"git commit {commit['commit']} (the working tree has moved on)" if changed_in_working_tree else "the working tree at freeze")
        ),
        "files_changed_in_working_tree_since_stage_3": changed_in_working_tree,
        "working_tree_differs_from_head": git_uncommitted_paths(code_paths),
    }


def derivation_summary(method: dict, stage_3_manifest: dict) -> str:
    text = (
        "Modeled water-surface elevation (m NAVD88) and junction water depth per Creek Segment. Discharge per NHDPlusV2 "
        "reach (NOAA National Water Model v3.0 retrospective, hourly; California Natural Flows, monthly) is scaled to "
        f"each Creek Segment by the USGS drainage-area ratio method ({stage_3_manifest['parameters']['dischargeScaling']}). "
        f"{method['label']}, version {method['version']}: {method['description']} "
        "Time-varying values are stored as Held WSE Intervals: a new interval starts when the anchor WSE or either "
        "junction depth changes."
    )
    if len(text) > LONG_TEXT_WIDTH:
        raise ValueError(f"derivation_summary is {len(text)} characters, more than {LONG_TEXT_WIDTH}")
    return text


def derivation_json_text(catalog: dict, method: dict, stage_3_manifest: dict, anchor_source: dict) -> str:
    """Dataset facts from the catalog (they do not depend on the method) plus this method's record."""
    datasets = {dataset["datasetId"]: dataset for dataset in catalog["datasets"]}
    parameters = method["parameters"]
    method_facts = {
        key: parameters[key]
        for key in (
            "solvedSections",
            "localBedSlope",
            "anchorPositionAlongSegment",
            "anchorSlope",
            "ratingCurve",
            "steepCreekRoughnessBlend",
            "flowResistance",
            "poolFilledWaterSurface",
            "channelFromModeledWseVersion",
            "dryBelowDepthM",
        )
        if key in parameters
    }
    value = {
        "variable": next(variable for variable in catalog["variables"] if variable["variableId"] == "water-surface-elevation"),
        "datasets": [
            {
                "datasetId": dataset_id,
                "publisherId": datasets[dataset_id]["publisherId"],
                "timeStep": datasets[dataset_id]["timeStep"],
                "accuracyNote": datasets[dataset_id]["accuracyNote"],
            }
            for dataset_id in (NATIONAL_WATER_MODEL_HOURLY_DATASET_ID, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID)
        ],
        "method": {
            "id": method["id"],
            "label": method["label"],
            "version": method["version"],
            "description": method["description"],
            "timeSeriesFields": parameters["timeSeriesFields"],
            **method_facts,
        },
        "drainageAreaRatioTransfer": parameters["drainageAreaRatioTransfer"],
        "anchorPoint": anchor_source["description"],
        "junctionWse": JUNCTION_WSE_NOTE,
        "heldWseIntervals": HELD_WSE_INTERVAL_NOTE,
        "nullValues": NULL_VALUES_NOTE,
    }
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(text) > DERIVATION_JSON_WIDTH:
        raise ValueError(f"derivation_json is {len(text)} characters, more than {DERIVATION_JSON_WIDTH}")
    return text


def check_registry_has_no_conflicting_version(identity: DataProductVersionIdentity) -> None:
    for version in read_registry().get("products", {}).get(MODELED_WSE, {}).get("versions", []):
        if version.get("version_label") == identity.version_label:
            raise SystemExit(
                f"Registry already has {MODELED_WSE} {identity.version_label} ({version.get('method_id')}); versions are append-only."
            )


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--method", required=True, help="Stage 3 method id, for example m4-flowline-profile-variable-power-depth.")
    parser.add_argument("--version", required=True, help="Version label m<method number>-v<version number>, for example m4-v1.")
    parser.add_argument("--trial-folder", help="Write a scratch version here instead of data/; the registry is not touched.")
    parser.add_argument("--only-tnc-comids", help="Comma-separated TNC flowline COMIDs (trial runs only).")
    arguments = parser.parse_args()
    if arguments.only_tnc_comids and not arguments.trial_folder:
        parser.error("--only-tnc-comids needs --trial-folder; a real version always holds every Creek Segment.")
    return arguments


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    arguments = parse_arguments()
    started = time.time()
    identity = DataProductVersionIdentity(MODELED_WSE, arguments.method, arguments.version)
    is_trial = bool(arguments.trial_folder)
    final_folder = Path(arguments.trial_folder).resolve() if is_trial else identity.version_folder
    if not is_trial:
        check_registry_has_no_conflicting_version(identity)

    stage_3_folder = STAGE_3_ROOT / identity.method_id / f"v{identity.version_number}"
    stage_3_manifest_path = stage_3_folder / "manifest.json"
    stage_3_manifest = read_json(stage_3_manifest_path)
    method = read_stage_3_method_record(stage_3_manifest, identity)
    provenance = method_code_provenance(method)
    log(f"Method code: {provenance['basis']}; method commit {provenance['commit']['commit'][:10]} ({provenance['commit']['date_utc']})")
    stage_1_sha256 = sha256_of_file(CROSS_SECTIONS_PATH)
    if stage_3_manifest["inputs"].get(repository_relative_path(CROSS_SECTIONS_PATH)) != stage_1_sha256:
        raise RuntimeError("Stage 1 cross-sections.json differs from the one Stage 3 read (sha256 mismatch).")
    head_commit = git_head_commit()
    catalog = read_json(CATALOG_PATH)
    crosswalk = read_json(NHDPLUSV2_REACH_CROSSWALK_PATH)
    if crosswalk["segmentNetworkVersion"] != SEGMENT_NETWORK_VERSION:
        raise ValueError("Crosswalk segmentNetworkVersion does not match")
    crosswalk_by_id = {segment["segmentId"]: segment for segment in crosswalk["segments"]}
    anchor_source = anchor_point_source(stage_3_manifest, method, identity)
    log(f"Anchor point: {anchor_source['kind']}, {len(anchor_source['points']):,} Creek Segments with a point")
    notes = null_values_notes(stage_3_manifest)
    time_series = DepthTimeSeriesFolder(stage_3_folder / "time-series")
    source_manifest_copies = {
        "01-cross-sections-manifest.json": STAGE_1_MANIFEST_PATH,
        "03-time-series-manifest.json": stage_3_manifest_path,
    }
    if anchor_source["kind"] == CHANNEL_RIBBON:
        source_manifest_copies["04-channel-ribbon-manifest.json"] = anchor_source["stage_4_manifest_path"]

    with staged_version_folder(MODELED_WSE, identity.method_id, identity.version_label, final_folder=final_folder) as staging:
        log(f"Building {MODELED_WSE} {identity.version_label} in {staging}")

        network = export_creek_segment_network(staging / CREEK_SEGMENT_NETWORK_FILE_NAME)
        network_segments = network["segments"]
        if set(crosswalk_by_id) != {segment["segmentId"] for segment in network_segments}:
            raise ValueError("Crosswalk Creek Segments do not match the network")
        if not set(anchor_source["points"]) <= set(crosswalk_by_id):
            raise ValueError("Anchor points name Creek Segments outside the network")
        tnc_comids = tnc_comids_in_network_order(network_segments)
        if arguments.only_tnc_comids:
            wanted = set(arguments.only_tnc_comids.split(","))
            tnc_comids = [comid for comid in tnc_comids if comid in wanted]
            network_segments = [segment for segment in network_segments if segment["tncComid"] in wanted]
        network_segment_by_id = {segment["segmentId"]: segment for segment in network_segments}
        network_segment_ids_by_comid: dict[str, list[str]] = {}
        for segment in network_segments:
            network_segment_ids_by_comid.setdefault(segment["tncComid"], []).append(segment["segmentId"])
        log(f"Creek Segment network: {len(network_segments)} segments on {len(tnc_comids)} TNC flowlines")

        manifests_folder = staging / SOURCE_MANIFESTS_FOLDER_NAME
        manifests_folder.mkdir()
        for copy_name, source_path in source_manifest_copies.items():
            shutil.copy2(source_path, manifests_folder / copy_name)

        nwm_intervals = DepthHeldWseIntervalRows()
        cnf_intervals = DepthHeldWseIntervalRows()
        cnf_values = MonthlyValueRows()
        static_values = SegmentStaticValues()
        raw_hourly_writers = RawHourlyCsvZipWriters(staging / RAW_HOURLY_VALUES_FOLDER_NAME, PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
        nwm_range_ms: tuple[int, int] | None = None
        cnf_range_ms: tuple[int, int] | None = None
        nwm_segment_count = 0
        cnf_segment_count = 0
        all_null_segment_ids: set[str] = set()
        # Junction depth and bed sharing is checked on the monthly series (cheap); the validator checks every value.
        monthly_flowlines_for_junction_check: list[DepthFlowlineSeries] = []
        try:
            for index, tnc_comid in enumerate(tnc_comids, start=1):
                hourly = time_series.load_national_water_model_hourly(tnc_comid, PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
                check_flowline_segments_match_network(hourly, network_segment_ids_by_comid[tnc_comid], "NWM hourly")
                hourly_range = (int(hourly.timestamps_ms[0]), int(hourly.timestamps_ms[-1]))
                if nwm_range_ms not in (None, hourly_range):
                    raise ValueError(f"{tnc_comid}: NWM hourly time range differs from other flowlines")
                nwm_range_ms = hourly_range
                static_values.add_flowline(hourly, NATIONAL_WATER_MODEL_HOURLY_DATASET_ID)
                nwm_intervals.add_flowline(hourly, hourly_range[1] + HOUR_MS)
                raw_hourly_writers.add_flowline(hourly)
                nwm_segment_count += len(hourly.segments)
                hourly_all_null = {segment.segment_id for segment in hourly.segments if np.all(np.isnan(segment.values))}
                del hourly

                monthly = time_series.load_california_natural_flows_monthly(tnc_comid)
                check_flowline_segments_match_network(monthly, network_segment_ids_by_comid[tnc_comid], "CNF monthly")
                monthly_range = (int(monthly.timestamps_ms[0]), int(monthly.timestamps_ms[-1]))
                if cnf_range_ms not in (None, monthly_range):
                    raise ValueError(f"{tnc_comid}: CNF monthly time range differs from other flowlines")
                cnf_range_ms = monthly_range
                static_values.add_flowline(monthly, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID)
                cnf_intervals.add_flowline(monthly, add_one_month_ms(monthly_range[1]))
                cnf_values.add_flowline(monthly)
                cnf_segment_count += len(monthly.segments)
                all_null_segment_ids |= hourly_all_null & {
                    segment.segment_id for segment in monthly.segments if np.all(np.isnan(segment.values))
                }
                monthly_flowlines_for_junction_check.append(monthly)
                if index % 10 == 0 or index == len(tnc_comids):
                    log(f"  read {index}/{len(tnc_comids)} TNC flowlines ({nwm_segment_count} Creek Segments)")
        finally:
            raw_hourly_writers.close()

        for label, count in [("NWM hourly", nwm_segment_count), ("CNF monthly", cnf_segment_count)]:
            if count != len(network_segments):
                raise ValueError(f"{label} has {count} Creek Segments, expected {len(network_segments)}")

        bed_cross_check = anchor_bed_cross_check(anchor_source, static_values)
        log(
            f"Anchor bed ({anchor_source['kind']}) vs Time Series anchorBedElevationM: {bed_cross_check['segments_beyond_tolerance']} of "
            f"{bed_cross_check['segments_compared']} Creek Segments differ by more than {ANCHOR_BED_TOLERANCE_M} m; "
            f"{len(bed_cross_check['segments_without_anchor_point'])} have no anchor point"
        )
        all_null_without_note = sorted(all_null_segment_ids - set(notes))
        null_values_summary = {
            "segments_with_all_values_null": len(all_null_segment_ids),
            "segments_with_note": len(all_null_segment_ids & set(notes)),
            "all_null_segments_without_note": all_null_without_note,
        }
        log(f"Creek Segments whose values are all null: {len(all_null_segment_ids)} ({len(all_null_without_note)} without a Stage 3 note)")
        junction_statistics = shared_junction_statistics(monthly_flowlines_for_junction_check, network_segment_by_id)
        del monthly_flowlines_for_junction_check
        log(
            f"Shared junctions: {junction_statistics['shared_by_two_segments']} shared by two segments, "
            f"{junction_statistics['same_bed']} with the same bed, {junction_statistics['same_depth_where_both_present']} "
            f"with the same depth wherever both are present"
        )

        creek_segments_layer_name = f"{identity.arcgis_prefix}_creek_segments"
        nwm_table_name = f"{identity.arcgis_prefix}_nwm_hourly_held_intervals"
        cnf_table_name = f"{identity.arcgis_prefix}_cnf_monthly_held_intervals"
        cnf_values_table_name = f"{identity.arcgis_prefix}_cnf_monthly_values"
        table_names = [identity.versions_table_name, creek_segments_layer_name, nwm_table_name, cnf_table_name, cnf_values_table_name]
        version_record = {
            "product": MODELED_WSE,
            "method_id": identity.method_id,
            "method_number": identity.method_number,
            "version_number": identity.version_number,
            "version_label": identity.version_label,
            "status": STATUS,
            "change_type": method["changeType"],
            "change_note": method["changeNote"],
            "method_date_utc": provenance["commit"]["date_utc"],
            "generated_at_utc": stage_3_manifest["completedAt"],
            "frozen_from_commit": head_commit,
            "code_fingerprint": provenance["fingerprint"]["sha256"],
            "segment_network_version": SEGMENT_NETWORK_VERSION,
            "extent_id": EXTENT_ID,
            "dataset_ids": [NATIONAL_WATER_MODEL_HOURLY_DATASET_ID, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID],
            "water_years": water_years_text(*nwm_range_ms, *cnf_range_ms),
            "derivation_summary": derivation_summary(method, stage_3_manifest),
            "derivation_json": derivation_json_text(catalog, method, stage_3_manifest, anchor_source),
            "arcgis_table_names": table_names,
        }

        upload_folder = staging / ARCGIS_UPLOAD_FOLDER_NAME
        upload_folder.mkdir()
        row_counts: dict[str, int] = {}
        with tempfile.TemporaryDirectory(prefix=f"{MODELED_WSE}-{identity.version_label}-gdb-") as temporary_folder:
            gdb_path = Path(temporary_folder) / identity.upload_gdb_folder_name
            log(f"Writing {identity.versions_table_name}")
            row_counts[identity.versions_table_name] = write_table(gdb_path, identity.versions_table_name, versions_table_columns(version_record))
            log(f"Writing {creek_segments_layer_name}")
            segment_columns, segment_geometry = creek_segment_columns(network_segments, crosswalk_by_id, anchor_source, static_values, notes)
            row_counts[creek_segments_layer_name] = write_table(gdb_path, creek_segments_layer_name, segment_columns, segment_geometry, "LineString")
            for name, rows in [(nwm_table_name, nwm_intervals), (cnf_table_name, cnf_intervals), (cnf_values_table_name, cnf_values)]:
                log(f"Writing {name}")
                row_counts[name] = write_table(gdb_path, name, rows.columns())
                log(f"  {row_counts[name]:,} rows")
            log("Zipping the file geodatabase")
            zip_folder(gdb_path, upload_folder / identity.upload_zip_name)

        files = [file_entry(staging, path) for path in sorted(staging.rglob("*")) if path.is_file() and path.name != VERSION_JSON_NAME]
        method_label = method["label"]
        anchor_source_record = {key: value for key, value in anchor_source.items() if key not in ("points", "stage_4_manifest_path")}
        version_json = {
            **{key: value for key, value in version_record.items() if key != "derivation_json"},
            "derivation": json.loads(version_record["derivation_json"]),
            "frozen_at_utc": utc_now_iso(),
            "arcgis_prefix": identity.arcgis_prefix,
            "arcgis_service": {
                "title": identity.service_title(method_label),
                "name": identity.service_name,
                "snippet": identity.service_snippet(method_label),
            },
            "stage_3_folder": repository_relative_path(stage_3_folder),
            "method_label": method_label,
            "method_change_note": method["changeNote"],
            "method_commit": provenance["commit"],
            "method_date_basis": provenance["date_basis"],
            "method_sha256": method["methodSha256"],
            "method_parameters": method["parameters"],
            "method_code_sha256_by_file": method["codeSha256ByFile"],
            "code_fingerprint_detail": {
                "basis": provenance["basis"],
                "commit": head_commit,
                "line_format": "sorted '<repository-relative path>:<sha256>' lines joined by newline",
                "files": provenance["fingerprint"]["files"],
                "files_changed_in_working_tree_since_stage_3": provenance["files_changed_in_working_tree_since_stage_3"],
                "working_tree_differs_from_head": provenance["working_tree_differs_from_head"],
            },
            "anchor_point_source": anchor_source_record,
            "schema": {
                "layers_and_tables": {
                    identity.versions_table_name: "one row describing this version (published_at_utc and raw_hourly_csv_item_ids filled after publishing)",
                    creek_segments_layer_name: "line layer, EPSG:4326, one Creek Segment per row (2-vertex flowline piece)",
                    nwm_table_name: "National Water Model hourly WY2021–WY2023 Held WSE Intervals",
                    cnf_table_name: "California Natural Flows monthly Held WSE Intervals",
                    cnf_values_table_name: "California Natural Flows monthly values, one row per Creek Segment per month",
                },
                "creek_segments_added_columns": added_creek_segment_fields(anchor_source),
                "anchor_point": anchor_source["description"],
                "anchor_depth": "wse_m − anchor_bed_elevation_m (the WSE Anchor Point is where the modeled WSE is solved and where the chart value applies)",
                "channel_ribbon_columns": (
                    "anchor_station (index of the anchor among the segment's ribbon stations), station_count, "
                    "breached_station_count (stations on a breached road or railroad fill), from channelRibbon; null where "
                    "the ribbon version does not store them or the segment has no ribbon"
                    if anchor_source["kind"] == CHANNEL_RIBBON
                    else None
                ),
                "held_wse_interval": HELD_WSE_INTERVAL_NOTE,
                "held_wse_interval_columns": ["segment_id", "tnc_comid", "valid_from_utc", "valid_until_utc", "wse_m",
                                              "junction_depth_upstream_m", "junction_depth_downstream_m", "step_count"],  # fmt: skip
                "raw_hourly_csv_columns": [field.name for field in RawHourlyCsvZipWriters.SCHEMA],
                "junction_wse": JUNCTION_WSE_NOTE,
                "null_values": NULL_VALUES_NOTE,
                "not_stored": (
                    "Per-segment bed slope and flow-resistance coefficients are not written by Stage 3 (only the method-wide "
                    "law in method_parameters), so they are not in this version."
                ),
            },
            "anchor_bed_cross_check": bed_cross_check,
            "null_values": null_values_summary,
            "time_ranges_utc": {
                NATIONAL_WATER_MODEL_HOURLY_DATASET_ID: {
                    "first_timestamp": utc_iso_from_epoch_ms(nwm_range_ms[0]),
                    "last_timestamp": utc_iso_from_epoch_ms(nwm_range_ms[1]),
                    "water_years": PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS,
                },
                CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID: {
                    "first_timestamp": utc_iso_from_epoch_ms(cnf_range_ms[0]),
                    "last_timestamp": utc_iso_from_epoch_ms(cnf_range_ms[1]),
                },
            },
            "source_inputs": {
                repository_relative_path(NHDPLUSV2_REACH_CROSSWALK_PATH): sha256_of_file(NHDPLUSV2_REACH_CROSSWALK_PATH),
                repository_relative_path(CROSS_SECTIONS_PATH): stage_1_sha256,
                repository_relative_path(CATALOG_PATH): sha256_of_file(CATALOG_PATH),
                **{repository_relative_path(path): sha256_of_file(path) for path in source_manifest_copies.values()},
            },
            "counts": {
                "creek_segments": len(network_segments),
                "tnc_flowlines": len(tnc_comids),
                "arcgis_rows": row_counts,
                "nwm_hourly_held_interval_segments": nwm_intervals.segment_count,
                "cnf_monthly_held_interval_segments": cnf_intervals.segment_count,
                "raw_hourly_csv_rows": {f"WY{year}": count for year, count in raw_hourly_writers.row_counts.items()},
            },
            "junction_sharing": {
                "rule": (
                    "Both Creek Segments at a shared vertex should carry the same junction depth and the same junction bed. "
                    "Counts are from the California Natural Flows monthly series; the bed is static."
                ),
                **junction_statistics,
            },
            "files": files,
            "trial": is_trial,
        }
        write_json(staging / VERSION_JSON_NAME, version_json)

    log(f"Version folder written: {final_folder}")
    if is_trial:
        log("Trial run: registry not updated")
    else:
        upload_zip = final_folder / ARCGIS_UPLOAD_FOLDER_NAME / identity.upload_zip_name
        registry_record = {
            **{key: value for key, value in version_record.items() if key != "derivation_json"},
            "version_folder": repository_relative_path(final_folder),
            "arcgis_upload_sha256": sha256_of_file(upload_zip),
            "arcgis_service_name": identity.service_name,
            "arcgis_service_title": version_json["arcgis_service"]["title"],
            "arcgis": {
                "service_item_id": None,
                "service_url": None,
                "file_geodatabase_item_id": None,
                "layer_ids": {name: None for name in table_names},
                "raw_hourly_csv_item_ids": {f"WY{year}": None for year in PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS},
                "published_at_utc": None,
            },
        }
        if "channelFromModeledWseVersion" in stage_3_manifest["parameters"]:
            registry_record["channel_from_modeled_wse_version"] = {"product": MODELED_WSE, **anchor_source["channel_from_modeled_wse_version"]}
        update_registry_version(MODELED_WSE, registry_record)
        log("Registry updated: data/data-product-version-registry.json")
    log(f"Done in {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
