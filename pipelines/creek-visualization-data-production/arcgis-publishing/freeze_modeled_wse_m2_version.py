"""Freeze modeled WSE m2-v1 into an append-only data-product version folder.

Local only: reads the Stage 1 and Stage 3 pipeline working output of the Modeled WSE Derivation
Method `m2-multi-section-manning-depth` (v1) and writes

    data/data-product-versions/modeled-wse/m2-multi-section-manning-depth/m2-v1/
      version.json
      source-manifests/                 copies of the Stage 1 and Stage 3 manifests
      creek-segment-network.json        from export-creek-segment-network.ts (canonical TS segmentation)
      arcgis-upload/modeled-wse-m2-v1.gdb.zip
      raw-hourly-values/national-water-model-hourly-WY2021.csv.zip (… WY2022, WY2023)

and adds the version to data/data-product-version-registry.json (ArcGIS fields null).

What differs from m1-v1 (freeze_modeled_wse_version.py, which this script leaves untouched):

- Creek Segments layer: adds anchor_longitude / anchor_latitude (WGS84, from Stage 1 section index 2's
  thalwegUtm), anchor_bed_elevation_m, junction_bed_upstream_m, junction_bed_downstream_m.
- Held WSE Interval tables hold, per Creek Segment, the anchor WSE (wse_m) and the water depth at both
  junctions. An interval ends when ANY of the three changes. No junction rows: junction WSE is junction
  bed + junction depth.
- The raw hourly CSVs and the monthly values table carry the same three time-varying columns.

Generic helpers (Creek Segment base columns, versions table, network export, file entries) are imported
from freeze_modeled_wse_version.py. Refuses to run if the version folder or a different registry
record already exists, or if the method code changed since Stage 3 ran.

    npm run data-products:freeze-modeled-wse-m2
    npm run data-products:freeze-modeled-wse-m2 -- --trial-folder=/tmp/modeled-wse-m2-trial --only-tnc-comids=27714697
"""

from __future__ import annotations

import argparse
import io
import json
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.csv as pyarrow_csv

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_versions import (  # noqa: E402
    REPOSITORY_ROOT,
    code_fingerprint,
    git_head_commit,
    git_first_commit_with_method_code,
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
from file_geodatabase_tables import (  # noqa: E402
    double_column,
    integer_column,
    text_column,
    utc_date_column,
    write_table,
    zip_folder,
)
from freeze_modeled_wse_version import (  # noqa: E402
    DERIVATION_JSON_WIDTH,
    SEGMENT_ID_WIDTH,
    TNC_COMID_WIDTH,
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
from held_wse_intervals import held_intervals_of_columns  # noqa: E402
from modeled_wse_m2_source_series import (  # noqa: E402
    DepthFlowlineSeries,
    load_california_natural_flows_monthly,
    load_national_water_model_hourly,
)
from modeled_wse_m2_version_layout import (  # noqa: E402
    ANCHOR_AND_JUNCTION_BED_FIELDS,
    ANCHOR_SECTION_INDEX,
    ARCGIS_LAYER_AND_TABLE_NAMES,
    ARCGIS_PREFIX,
    ARCGIS_UPLOAD_FOLDER_NAME,
    CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID,
    CATALOG_PATH,
    CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME,
    CNF_MONTHLY_VALUES_TABLE_NAME,
    CREEK_SEGMENT_NETWORK_FILE_NAME,
    CREEK_SEGMENTS_LAYER_NAME,
    CROSS_SECTIONS_PATH,
    EXTENT_ID,
    HOUR_MS,
    MAXIMUM_STAGE_1_VS_TIME_SERIES_BED_DIFFERENCE_M,
    METHOD_ID,
    METHOD_NUMBER,
    NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
    NHDPLUSV2_REACH_CROSSWALK_PATH,
    NWM_HOURLY_HELD_INTERVALS_TABLE_NAME,
    PRODUCT,
    PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS,
    RAW_HOURLY_VALUES_FOLDER_NAME,
    SEGMENT_NETWORK_VERSION,
    SERVICE_NAME,
    SERVICE_TITLE,
    SOURCE_MANIFEST_COPIES,
    SOURCE_MANIFESTS_FOLDER_NAME,
    STAGE_3_MANIFEST_PATH,
    UPLOAD_GDB_FOLDER_NAME,
    UPLOAD_GDB_ZIP_NAME,
    VERSION_FOLDER,
    VERSION_JSON_NAME,
    VERSION_LABEL,
    VERSION_NUMBER,
    VERSIONS_TABLE_NAME,
    add_one_month_ms,
    anchor_points_by_segment_id,
    junction_id,
    raw_hourly_csv_name,
    raw_hourly_csv_zip_name,
    read_json,
    upstream_and_downstream_vertex_index,
)

STATUS = "active"  # the registry has no "experimental" status; experimental is said in change_note
# One line for the registry and the versions table. Stage 3's own changeNote (method_change_note in
# version.json) describes the method; this one also names the paired polygon method, as asked at freeze time.
CHANGE_NOTE = (
    "First version of method m2 (experimental): multi-section Manning depth, anchor WSE at the mid section "
    "and shared junction depths and beds, for bed-parallel drawing by m2-height-above-nearest-drainage-fill."
)
# How many segments may disagree between Stage 1 section 2's bed and the Time Series anchor bed before the freeze fails.
MAXIMUM_ANCHOR_BED_MISMATCHES = 5

DERIVATION_SUMMARY = (
    "Modeled water-surface elevation (m NAVD88) and junction water depth per Creek Segment. Discharge per "
    "NHDPlusV2 reach (NOAA National Water Model v3.0 retrospective, hourly, WY2021–WY2023; California Natural "
    "Flows, monthly, 1950–2024) is scaled to each Creek Segment by the USGS drainage-area ratio method (capped "
    "at 1; Drainage-Area Ratio Transfer from the nearest reach, and no discharge beyond 1000 m), then inverted on "
    "divided-channel Manning's equation rating curves (n = 0.04 main channel, 0.07 floodplain) at the first, "
    "middle, and last USGS 3DEP 1 m cross-section of the segment, each with its own bed and a local bed slope. "
    "The middle (anchor) section gives the WSE (wse_m); the end sections give the water depth at each junction, "
    "shared with the neighbouring segment as the mean of the two end-section depths. The anchor point and the "
    "junction beds are static columns of the Creek Segments layer. Time-varying values are stored as Held WSE "
    "Intervals: a new interval starts when the anchor WSE or either junction depth changes."
)
JUNCTION_WSE_NOTE = (
    "Junction WSE is not stored. It is the segment's junction bed (static column) plus its junction depth "
    "(Held WSE Interval column), rounded to 3 decimals; null where the depth is null. The validator rebuilds it "
    "for every segment and time step and compares it with the Stage 3 junctionWse arrays."
)
HELD_WSE_INTERVAL_NOTE = (
    "One row per Creek Segment and stretch of time in which wse_m, junction_depth_upstream_m, and "
    "junction_depth_downstream_m all stay constant (NaN equals NaN). valid_until_utc is exclusive. A null run "
    "is one interval with all three null. step_count is the number of time steps the interval covers."
)
ANCHOR_POINT_NOTE = (
    "anchor_longitude / anchor_latitude are Stage 1 section index 2's thalwegUtm (EPSG:32610) transformed to "
    "EPSG:4326; the anchor point is not stored in the Time Series. anchor_bed_elevation_m is the Time Series "
    "anchorBedElevationM; junction_bed_upstream_m / junction_bed_downstream_m are its junctionBed scalars. "
    "Anchor depth = wse_m − anchor_bed_elevation_m."
)


# ---------------------------------------------------------------------------
# Accumulators
# ---------------------------------------------------------------------------


class DepthHeldWseIntervalRows:
    """Held WSE Interval rows of every Creek Segment of one Dataset."""

    def __init__(self) -> None:
        self.segment_id: list[np.ndarray] = []
        self.tnc_comid: list[np.ndarray] = []
        self.valid_from_ms: list[np.ndarray] = []
        self.valid_until_ms: list[np.ndarray] = []
        self.wse_m: list[np.ndarray] = []
        self.junction_depth_upstream_m: list[np.ndarray] = []
        self.junction_depth_downstream_m: list[np.ndarray] = []
        self.step_count: list[np.ndarray] = []
        self.segment_count = 0

    def add_flowline(self, flowline: DepthFlowlineSeries, end_timestamp_ms: int) -> None:
        for segment in flowline.segments:
            intervals = held_intervals_of_columns(
                {
                    "wse_m": segment.values,
                    "junction_depth_upstream_m": segment.junction_depth_upstream_m,
                    "junction_depth_downstream_m": segment.junction_depth_downstream_m,
                },
                flowline.timestamps_ms,
                end_timestamp_ms,
            )
            row_count = len(intervals["valid_from_ms"])
            self.segment_id.append(np.full(row_count, segment.segment_id, dtype=object))
            self.tnc_comid.append(np.full(row_count, flowline.tnc_comid, dtype=object))
            self.valid_from_ms.append(intervals["valid_from_ms"])
            self.valid_until_ms.append(intervals["valid_until_ms"])
            self.wse_m.append(intervals["wse_m"])
            self.junction_depth_upstream_m.append(intervals["junction_depth_upstream_m"])
            self.junction_depth_downstream_m.append(intervals["junction_depth_downstream_m"])
            self.step_count.append(intervals["step_count"])
            self.segment_count += 1

    def columns(self) -> list:
        def joined(parts: list[np.ndarray]) -> np.ndarray:
            return np.concatenate(parts) if parts else np.array([])

        return [
            text_column("segment_id", joined(self.segment_id), SEGMENT_ID_WIDTH),
            text_column("tnc_comid", joined(self.tnc_comid), TNC_COMID_WIDTH),
            utc_date_column("valid_from_utc", joined(self.valid_from_ms).astype(np.int64)),
            utc_date_column("valid_until_utc", joined(self.valid_until_ms).astype(np.int64)),
            double_column("wse_m", joined(self.wse_m).astype(np.float64)),
            double_column("junction_depth_upstream_m", joined(self.junction_depth_upstream_m).astype(np.float64)),
            double_column("junction_depth_downstream_m", joined(self.junction_depth_downstream_m).astype(np.float64)),
            integer_column("step_count", joined(self.step_count).astype(np.int32)),
        ]


class MonthlyValueRows:
    """One plain row per Creek Segment per month."""

    def __init__(self) -> None:
        self.segment_id: list[np.ndarray] = []
        self.tnc_comid: list[np.ndarray] = []
        self.month_start_ms: list[np.ndarray] = []
        self.wse_m: list[np.ndarray] = []
        self.junction_depth_upstream_m: list[np.ndarray] = []
        self.junction_depth_downstream_m: list[np.ndarray] = []

    def add_flowline(self, flowline: DepthFlowlineSeries) -> None:
        step_count = len(flowline.timestamps_ms)
        for segment in flowline.segments:
            self.segment_id.append(np.full(step_count, segment.segment_id, dtype=object))
            self.tnc_comid.append(np.full(step_count, flowline.tnc_comid, dtype=object))
            self.month_start_ms.append(flowline.timestamps_ms)
            self.wse_m.append(segment.values)
            self.junction_depth_upstream_m.append(segment.junction_depth_upstream_m)
            self.junction_depth_downstream_m.append(segment.junction_depth_downstream_m)

    def columns(self) -> list:
        return [
            text_column("segment_id", np.concatenate(self.segment_id), SEGMENT_ID_WIDTH),
            text_column("tnc_comid", np.concatenate(self.tnc_comid), TNC_COMID_WIDTH),
            utc_date_column("month_start_utc", np.concatenate(self.month_start_ms)),
            double_column("wse_m", np.concatenate(self.wse_m)),
            double_column("junction_depth_upstream_m", np.concatenate(self.junction_depth_upstream_m)),
            double_column("junction_depth_downstream_m", np.concatenate(self.junction_depth_downstream_m)),
        ]


class RawHourlyCsvZipWriters:
    """One zipped CSV per water year, streamed flowline by flowline."""

    SCHEMA = pa.schema(
        [
            ("segment_id", pa.string()),
            ("tnc_comid", pa.string()),
            ("time_utc", pa.string()),
            ("wse_m", pa.float64()),
            ("junction_depth_upstream_m", pa.float64()),
            ("junction_depth_downstream_m", pa.float64()),
        ]
    )

    def __init__(self, folder: Path, water_years: list[int]) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        self.paths: dict[int, Path] = {}
        self.row_counts: dict[int, int] = {}
        self._archives: dict[int, zipfile.ZipFile] = {}
        self._streams: dict[int, io.BufferedIOBase] = {}
        self._writers: dict[int, pyarrow_csv.CSVWriter] = {}
        for water_year in water_years:
            path = folder / raw_hourly_csv_zip_name(water_year)
            archive = zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6)
            stream = archive.open(raw_hourly_csv_name(water_year), "w", force_zip64=True)
            self.paths[water_year] = path
            self.row_counts[water_year] = 0
            self._archives[water_year] = archive
            self._streams[water_year] = stream
            self._writers[water_year] = pyarrow_csv.CSVWriter(
                stream, self.SCHEMA, write_options=pyarrow_csv.WriteOptions(quoting_style="needed")
            )

    def add_flowline(self, flowline: DepthFlowlineSeries) -> None:
        iso_times = np.char.add(np.datetime_as_string(flowline.timestamps_ms.astype("datetime64[ms]"), unit="s"), "Z")
        for water_year, (start, end) in flowline.water_year_slices.items():
            step_count = end - start
            segment_count = len(flowline.segments)
            table = pa.Table.from_arrays(
                [
                    pa.array(np.repeat([segment.segment_id for segment in flowline.segments], step_count)),
                    pa.array(np.full(step_count * segment_count, flowline.tnc_comid)),
                    pa.array(np.tile(iso_times[start:end], segment_count)),
                    pa.array(np.concatenate([s.values[start:end] for s in flowline.segments]), from_pandas=True),
                    pa.array(
                        np.concatenate([s.junction_depth_upstream_m[start:end] for s in flowline.segments]), from_pandas=True
                    ),
                    pa.array(
                        np.concatenate([s.junction_depth_downstream_m[start:end] for s in flowline.segments]), from_pandas=True
                    ),
                ],
                schema=self.SCHEMA,
            )
            self._writers[water_year].write_table(table)
            self.row_counts[water_year] += table.num_rows

    def close(self) -> None:
        for water_year in self._writers:
            self._writers[water_year].close()
            self._streams[water_year].close()
            self._archives[water_year].close()


# ---------------------------------------------------------------------------
# Static per-segment columns and consistency checks
# ---------------------------------------------------------------------------


class SegmentStaticValues:
    """Anchor bed and junction beds per Creek Segment, read from the Time Series scalars."""

    def __init__(self) -> None:
        self.by_segment_id: dict[str, tuple[float, float, float]] = {}

    def add_flowline(self, flowline: DepthFlowlineSeries, dataset_id: str) -> None:
        for segment in flowline.segments:
            beds = (segment.anchor_bed_elevation_m, segment.junction_bed_upstream_m, segment.junction_bed_downstream_m)
            known = self.by_segment_id.setdefault(segment.segment_id, beds)
            if known != beds:
                raise ValueError(f"{segment.segment_id}: static bed scalars of {dataset_id} differ from the other Dataset")


def anchor_bed_cross_check(anchor_points: dict[str, dict], static_values: SegmentStaticValues) -> dict:
    """Stage 1 section 2 bed vs the Time Series anchorBedElevationM, per Creek Segment."""
    differences = {
        segment_id: abs(anchor_points[segment_id]["stage_1_anchor_bed_elevation_m"] - beds[0])
        for segment_id, beds in static_values.by_segment_id.items()
    }
    mismatched = {segment_id: difference for segment_id, difference in differences.items() if difference > MAXIMUM_STAGE_1_VS_TIME_SERIES_BED_DIFFERENCE_M}
    report = {
        "segments_compared": len(differences),
        "tolerance_m": MAXIMUM_STAGE_1_VS_TIME_SERIES_BED_DIFFERENCE_M,
        "segments_beyond_tolerance": len(mismatched),
        "maximum_difference_m": max(differences.values()) if differences else 0.0,
        "mismatches": {segment_id: round(difference, 6) for segment_id, difference in sorted(mismatched.items())},
    }
    if len(mismatched) > MAXIMUM_ANCHOR_BED_MISMATCHES:
        raise ValueError(
            f"Stage 1 section {ANCHOR_SECTION_INDEX} bed differs from the Time Series anchorBedElevationM by more than "
            f"{MAXIMUM_STAGE_1_VS_TIME_SERIES_BED_DIFFERENCE_M} m for {len(mismatched)} Creek Segments "
            f"(allowed {MAXIMUM_ANCHOR_BED_MISMATCHES}); first: {list(report['mismatches'].items())[:5]}"
        )
    return report


def same_where_both_present(left: np.ndarray, right: np.ndarray) -> bool:
    both_present = ~np.isnan(left) & ~np.isnan(right)
    return bool(np.all(left[both_present] == right[both_present]))


def shared_junction_statistics(flowlines: list[DepthFlowlineSeries], network_segment_by_id: dict[str, dict]) -> dict:
    """At a vertex shared by two Creek Segments both should carry the same junction bed and depth (METHOD.md step 6)."""
    statistics = {
        "junctions": 0,
        "shared_by_two_segments": 0,
        "same_bed": 0,
        "same_depth_where_both_present": 0,
        "same_null_pattern": 0,
        "ids_with_different_bed_or_depth": [],
    }
    for flowline in flowlines:
        contributions_by_vertex: dict[int, list[tuple[np.ndarray, float]]] = {}
        for segment in flowline.segments:
            upstream_vertex, downstream_vertex = upstream_and_downstream_vertex_index(network_segment_by_id[segment.segment_id])
            contributions_by_vertex.setdefault(upstream_vertex, []).append(
                (segment.junction_depth_upstream_m, segment.junction_bed_upstream_m)
            )
            contributions_by_vertex.setdefault(downstream_vertex, []).append(
                (segment.junction_depth_downstream_m, segment.junction_bed_downstream_m)
            )
        for vertex_index, contributions in contributions_by_vertex.items():
            statistics["junctions"] += 1
            if len(contributions) != 2:
                continue
            statistics["shared_by_two_segments"] += 1
            (first_depth, first_bed), (second_depth, second_bed) = contributions
            same_bed = first_bed == second_bed
            same_depth = same_where_both_present(first_depth, second_depth)
            statistics["same_bed"] += same_bed
            statistics["same_depth_where_both_present"] += same_depth
            statistics["same_null_pattern"] += bool(np.array_equal(np.isnan(first_depth), np.isnan(second_depth)))
            if not (same_bed and same_depth):
                statistics["ids_with_different_bed_or_depth"].append(junction_id(flowline.tnc_comid, vertex_index))
    statistics["ids_with_different_bed_or_depth"] = statistics["ids_with_different_bed_or_depth"][:20]
    return statistics


# ---------------------------------------------------------------------------
# Creek Segments layer
# ---------------------------------------------------------------------------


def m2_creek_segment_columns_and_geometry(
    network_segments: list[dict],
    crosswalk_by_id: dict[str, dict],
    anchor_points: dict[str, dict],
    static_values: SegmentStaticValues,
) -> tuple[list, list]:
    """m1's Creek Segment columns plus the static anchor point and junction beds."""
    columns, geometry_wkb = creek_segment_columns_and_geometry(network_segments, crosswalk_by_id)
    segment_ids = [segment["segmentId"] for segment in network_segments]
    anchor_bed, junction_bed_upstream, junction_bed_downstream = (
        [static_values.by_segment_id[segment_id][index] for segment_id in segment_ids] for index in range(3)
    )
    columns += [
        double_column("anchor_longitude", [anchor_points[segment_id]["anchor_longitude"] for segment_id in segment_ids]),
        double_column("anchor_latitude", [anchor_points[segment_id]["anchor_latitude"] for segment_id in segment_ids]),
        double_column("anchor_bed_elevation_m", anchor_bed),
        double_column("junction_bed_upstream_m", junction_bed_upstream),
        double_column("junction_bed_downstream_m", junction_bed_downstream),
    ]
    assert [field.name for field, _ in columns[-5:]] == ANCHOR_AND_JUNCTION_BED_FIELDS
    return columns, geometry_wkb


# ---------------------------------------------------------------------------
# Version metadata
# ---------------------------------------------------------------------------


def derivation_json_text(catalog: dict, method: dict) -> str:
    """Dataset facts from the catalog (they do not depend on the method) plus the m2 method record."""
    datasets = {dataset["datasetId"]: dataset for dataset in catalog["datasets"]}
    published = [NATIONAL_WATER_MODEL_HOURLY_DATASET_ID, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID]
    parameters = method["parameters"]
    value = {
        "variable": next(v for v in catalog["variables"] if v["variableId"] == "water-surface-elevation"),
        "datasets": [
            {
                "datasetId": dataset_id,
                "publisherId": datasets[dataset_id]["publisherId"],
                "timeStep": datasets[dataset_id]["timeStep"],
                "accuracyNote": datasets[dataset_id]["accuracyNote"],
            }
            for dataset_id in published
        ],
        "method": {
            "id": method["id"],
            "label": method["label"],
            "description": method["description"],
            "solvedSections": parameters["solvedSections"],
            "localBedSlope": parameters["localBedSlope"],
            "timeSeriesFields": parameters["timeSeriesFields"],
        },
        "drainageAreaRatioTransfer": parameters["drainageAreaRatioTransfer"],
        "anchorPoint": ANCHOR_POINT_NOTE,
        "junctionWse": JUNCTION_WSE_NOTE,
        "heldWseIntervals": HELD_WSE_INTERVAL_NOTE,
    }
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(text) > DERIVATION_JSON_WIDTH:
        raise ValueError(f"derivation_json is {len(text)} characters, more than {DERIVATION_JSON_WIDTH}")
    return text


def read_stage_3_method_record(stage_3_manifest: dict) -> dict:
    """The Modeled WSE Derivation Method record Stage 3 saved, checked against this script's version label."""
    method = stage_3_manifest.get("parameters", {}).get("modeledWseDerivationMethod")
    if not method:
        raise RuntimeError("The Stage 3 manifest has no modeledWseDerivationMethod record. Run Stage 3 first.")
    if (method["id"], method["methodNumber"], method["version"]) != (METHOD_ID, METHOD_NUMBER, VERSION_NUMBER):
        raise RuntimeError(
            f"Stage 3 output is for {method['id']} v{method['version']}, but this script freezes {METHOD_ID} v{VERSION_NUMBER} "
            f"({VERSION_LABEL})."
        )
    anchor_index = method["parameters"]["solvedSections"]["anchorSectionIndex"]
    if anchor_index != ANCHOR_SECTION_INDEX:
        raise RuntimeError(f"Stage 3 anchorSectionIndex is {anchor_index}, this script reads Stage 1 section {ANCHOR_SECTION_INDEX}.")
    return method


def check_registry_has_no_conflicting_version() -> None:
    product_entry = read_registry().get("products", {}).get(PRODUCT)
    for version in (product_entry or {}).get("versions", []):
        if version.get("version_label") == VERSION_LABEL and version.get("method_id") == METHOD_ID:
            raise SystemExit(f"Registry already has {PRODUCT} {METHOD_ID} {VERSION_LABEL}; versions are append-only.")
        if version.get("version_label") == VERSION_LABEL:
            raise SystemExit(
                f"Registry already has {PRODUCT} {VERSION_LABEL} ({version.get('method_id')}); a version label is unique per product."
            )


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--trial-folder", help="Write a scratch version here instead of data/; registry is not touched.")
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
    is_trial = bool(arguments.trial_folder)
    final_folder = Path(arguments.trial_folder).resolve() if is_trial else VERSION_FOLDER
    if not is_trial:
        check_registry_has_no_conflicting_version()

    head_commit = git_head_commit()
    stage_3_manifest = read_json(STAGE_3_MANIFEST_PATH)
    method = read_stage_3_method_record(stage_3_manifest)
    changed_code_files = method_code_files_changed_since_stage_3(method)
    if changed_code_files:
        raise RuntimeError(
            "Modeled WSE Derivation Method code changed since Stage 3 ran; the frozen fingerprint would not describe "
            f"this output. Rerun Stage 3 (bump the method version if the output should change): {changed_code_files}"
        )
    stage_1_sha256 = sha256_of_file(CROSS_SECTIONS_PATH)
    if stage_3_manifest["inputs"].get(repository_relative_path(CROSS_SECTIONS_PATH)) != stage_1_sha256:
        raise RuntimeError("Stage 1 cross-sections.json differs from the one Stage 3 read (sha256 mismatch).")
    method_code_paths = [REPOSITORY_ROOT / relative_path for relative_path in method["codeSha256ByFile"]]
    method_commit, method_date_basis = git_first_commit_with_method_code(method["codeSha256ByFile"])
    catalog = read_json(CATALOG_PATH)
    crosswalk = read_json(NHDPLUSV2_REACH_CROSSWALK_PATH)
    if crosswalk["segmentNetworkVersion"] != SEGMENT_NETWORK_VERSION:
        raise ValueError("Crosswalk segmentNetworkVersion does not match")
    crosswalk_by_id = {segment["segmentId"]: segment for segment in crosswalk["segments"]}
    anchor_points = anchor_points_by_segment_id(read_json(CROSS_SECTIONS_PATH))

    with staged_version_folder(PRODUCT, METHOD_ID, VERSION_LABEL, final_folder=final_folder) as staging:
        log(f"Building {PRODUCT} {VERSION_LABEL} in {staging}")

        network = export_creek_segment_network(staging / CREEK_SEGMENT_NETWORK_FILE_NAME)
        network_segments = network["segments"]
        if set(crosswalk_by_id) != {segment["segmentId"] for segment in network_segments}:
            raise ValueError("Crosswalk Creek Segments do not match the network")
        if set(anchor_points) != set(crosswalk_by_id):
            raise ValueError("Stage 1 Creek Segments do not match the network")
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
        for copy_name, source_path in SOURCE_MANIFEST_COPIES.items():
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
        # Junction depth and bed sharing is checked on the monthly series (cheap); the validator checks every value.
        monthly_flowlines_for_junction_check: list[DepthFlowlineSeries] = []
        try:
            for index, tnc_comid in enumerate(tnc_comids, start=1):
                hourly = load_national_water_model_hourly(tnc_comid, PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
                check_flowline_segments_match_network(hourly, network_segment_ids_by_comid[tnc_comid], "NWM hourly")
                hourly_range = (int(hourly.timestamps_ms[0]), int(hourly.timestamps_ms[-1]))
                if nwm_range_ms not in (None, hourly_range):
                    raise ValueError(f"{tnc_comid}: NWM hourly time range differs from other flowlines")
                nwm_range_ms = hourly_range
                static_values.add_flowline(hourly, NATIONAL_WATER_MODEL_HOURLY_DATASET_ID)
                nwm_intervals.add_flowline(hourly, hourly_range[1] + HOUR_MS)
                raw_hourly_writers.add_flowline(hourly)
                nwm_segment_count += len(hourly.segments)
                del hourly

                monthly = load_california_natural_flows_monthly(tnc_comid)
                check_flowline_segments_match_network(monthly, network_segment_ids_by_comid[tnc_comid], "CNF monthly")
                monthly_range = (int(monthly.timestamps_ms[0]), int(monthly.timestamps_ms[-1]))
                if cnf_range_ms not in (None, monthly_range):
                    raise ValueError(f"{tnc_comid}: CNF monthly time range differs from other flowlines")
                cnf_range_ms = monthly_range
                static_values.add_flowline(monthly, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID)
                cnf_intervals.add_flowline(monthly, add_one_month_ms(monthly_range[1]))
                cnf_values.add_flowline(monthly)
                cnf_segment_count += len(monthly.segments)
                monthly_flowlines_for_junction_check.append(monthly)
                if index % 10 == 0 or index == len(tnc_comids):
                    log(f"  read {index}/{len(tnc_comids)} TNC flowlines ({nwm_segment_count} Creek Segments)")
        finally:
            raw_hourly_writers.close()

        for label, count in [("NWM hourly", nwm_segment_count), ("CNF monthly", cnf_segment_count)]:
            if count != len(network_segments):
                raise ValueError(f"{label} has {count} Creek Segments, expected {len(network_segments)}")

        bed_cross_check = anchor_bed_cross_check(
            {segment_id: anchor_points[segment_id] for segment_id in static_values.by_segment_id}, static_values
        )
        log(
            f"Stage 1 section {ANCHOR_SECTION_INDEX} bed vs Time Series anchorBedElevationM: "
            f"{bed_cross_check['segments_beyond_tolerance']} of {bed_cross_check['segments_compared']} segments differ by more than "
            f"{bed_cross_check['tolerance_m']} m (largest difference {bed_cross_check['maximum_difference_m']:.6f} m)"
        )
        junction_statistics = shared_junction_statistics(monthly_flowlines_for_junction_check, network_segment_by_id)
        del monthly_flowlines_for_junction_check
        log(
            f"Shared junctions: {junction_statistics['shared_by_two_segments']} shared by two segments, "
            f"{junction_statistics['same_bed']} with the same bed, {junction_statistics['same_depth_where_both_present']} "
            f"with the same depth wherever both are present"
        )

        code = code_fingerprint(method_code_paths)
        version_record = {
            "product": PRODUCT,
            "method_id": METHOD_ID,
            "method_number": METHOD_NUMBER,
            "version_number": VERSION_NUMBER,
            "version_label": VERSION_LABEL,
            "status": STATUS,
            "change_type": method["changeType"],
            "change_note": CHANGE_NOTE,
            "method_date_utc": method_commit["date_utc"],
            "generated_at_utc": stage_3_manifest["completedAt"],
            "frozen_from_commit": head_commit,
            "code_fingerprint": code["sha256"],
            "segment_network_version": SEGMENT_NETWORK_VERSION,
            "extent_id": EXTENT_ID,
            "dataset_ids": [NATIONAL_WATER_MODEL_HOURLY_DATASET_ID, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID],
            "water_years": water_years_text(*nwm_range_ms, *cnf_range_ms),
            "derivation_summary": DERIVATION_SUMMARY,
            "derivation_json": derivation_json_text(catalog, method),
            "arcgis_table_names": ARCGIS_LAYER_AND_TABLE_NAMES,
        }

        upload_folder = staging / ARCGIS_UPLOAD_FOLDER_NAME
        upload_folder.mkdir()
        row_counts: dict[str, int] = {}
        with tempfile.TemporaryDirectory(prefix="modeled-wse-m2-gdb-") as temporary_folder:
            gdb_path = Path(temporary_folder) / UPLOAD_GDB_FOLDER_NAME
            log(f"Writing {VERSIONS_TABLE_NAME}")
            row_counts[VERSIONS_TABLE_NAME] = write_table(gdb_path, VERSIONS_TABLE_NAME, versions_table_columns(version_record))
            log(f"Writing {CREEK_SEGMENTS_LAYER_NAME}")
            segment_columns, segment_geometry = m2_creek_segment_columns_and_geometry(
                network_segments, crosswalk_by_id, anchor_points, static_values
            )
            row_counts[CREEK_SEGMENTS_LAYER_NAME] = write_table(
                gdb_path, CREEK_SEGMENTS_LAYER_NAME, segment_columns, segment_geometry, "LineString"
            )
            for name, rows in [
                (NWM_HOURLY_HELD_INTERVALS_TABLE_NAME, nwm_intervals),
                (CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME, cnf_intervals),
                (CNF_MONTHLY_VALUES_TABLE_NAME, cnf_values),
            ]:
                log(f"Writing {name}")
                row_counts[name] = write_table(gdb_path, name, rows.columns())
                log(f"  {row_counts[name]:,} rows")
            log("Zipping the file geodatabase")
            zip_folder(gdb_path, upload_folder / UPLOAD_GDB_ZIP_NAME)

        files = [
            file_entry(staging, path)
            for path in sorted(staging.rglob("*"))
            if path.is_file() and path.name != VERSION_JSON_NAME
        ]
        version_json = {
            **{key: value for key, value in version_record.items() if key != "derivation_json"},
            "derivation": json.loads(version_record["derivation_json"]),
            "frozen_at_utc": utc_now_iso(),
            "arcgis_prefix": ARCGIS_PREFIX,
            "arcgis_service": {"title": SERVICE_TITLE, "name": SERVICE_NAME},
            "method_change_note": method["changeNote"],
            "method_commit": method_commit,
            "method_date_basis": method_date_basis,
            "method_sha256": method["methodSha256"],
            "method_parameters": method["parameters"],
            "method_code_sha256_by_file": method["codeSha256ByFile"],
            "code_fingerprint_detail": {
                "basis": "the Stage 3 manifest's codeSha256ByFile, checked equal to the working tree at freeze",
                "commit": head_commit,
                "line_format": "sorted '<repository-relative path>:<sha256>' lines joined by newline",
                "files": code["files"],
                "working_tree_differs_from_head": git_uncommitted_paths(method_code_paths),
            },
            "schema": {
                "creek_segments_added_columns": ANCHOR_AND_JUNCTION_BED_FIELDS,
                "anchor_point": ANCHOR_POINT_NOTE,
                "held_wse_interval": HELD_WSE_INTERVAL_NOTE,
                "junction_wse": JUNCTION_WSE_NOTE,
                "anchor_section_index": ANCHOR_SECTION_INDEX,
                "anchor_crs_transform": "EPSG:32610 (thalwegUtm, meters) → EPSG:4326 with pyproj, always_xy",
            },
            "stage_1_anchor_bed_cross_check": bed_cross_check,
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
                **{
                    repository_relative_path(source_path): sha256_of_file(source_path)
                    for source_path in SOURCE_MANIFEST_COPIES.values()
                },
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
                    "METHOD.md step 6: both Creek Segments at a shared vertex carry the same junction depth and the same "
                    "junction bed. Counts are from the California Natural Flows monthly series; the bed is static."
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
        upload_zip = final_folder / ARCGIS_UPLOAD_FOLDER_NAME / UPLOAD_GDB_ZIP_NAME
        registry_record = {
            **{key: value for key, value in version_record.items() if key != "derivation_json"},
            "version_folder": repository_relative_path(final_folder),
            "arcgis_upload_sha256": sha256_of_file(upload_zip),
            "arcgis": {
                "service_item_id": None,
                "service_url": None,
                "file_geodatabase_item_id": None,
                "layer_ids": {name: None for name in ARCGIS_LAYER_AND_TABLE_NAMES},
                "raw_hourly_csv_item_ids": {f"WY{year}": None for year in PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS},
                "published_at_utc": None,
            },
        }
        update_registry_version(
            PRODUCT,
            registry_record,
            product_fields={
                "title": SERVICE_TITLE,
                "arcgis_service_name": SERVICE_NAME,
                "description": "Modeled water-surface elevation per Creek Segment, as Held WSE Intervals.",
            },
        )
        log("Registry updated: data/data-product-version-registry.json")
    log(f"Done in {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
