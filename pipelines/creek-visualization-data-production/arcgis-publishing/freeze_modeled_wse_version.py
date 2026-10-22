"""Freeze modeled WSE m1-v1 into an append-only data-product version folder (UCS-285).

Local only: reads the Stage 0–3 pipeline working output and writes

    data/data-product-versions/modeled-wse/m1-drainage-area-ratio-manning-rating-curve/m1-v1/
      version.json
      source-manifests/                 copies of Stage 1, 2, 3 manifests and the Stage 5 catalog
      creek-segment-network.json        from export-creek-segment-network.ts (canonical TS segmentation)
      arcgis-upload/modeled-wse-m1-v1.gdb.zip
      raw-hourly-values/national-water-model-hourly-WY2021.csv.zip (… WY2022, WY2023)

and adds the version to data/data-product-version-registry.json (ArcGIS fields null).
The file geodatabase holds the five layers and tables of the "Creek Water Visualization —
Modeled WSE" service. Refuses to run if the version folder or a different registry
record already exists.

    npm run data-products:freeze-modeled-wse
    npm run data-products:freeze-modeled-wse -- --trial-folder=/tmp/modeled-wse-trial --only-tnc-comids=27714637
"""

from __future__ import annotations

import argparse
import io
import json
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.csv as pyarrow_csv
from shapely import LineString, to_wkb

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_versions import (  # noqa: E402
    REPOSITORY_ROOT,
    code_fingerprint,
    git_commit,
    git_head_commit,
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
    short_integer_column,
    text_column,
    utc_date_column,
    write_table,
    zip_folder,
)
from held_wse_intervals import held_intervals_of_series  # noqa: E402
from modeled_wse_junctions import JunctionIdentityCounts, junction_series_of_flowline  # noqa: E402
from modeled_wse_source_series import (  # noqa: E402
    FlowlineSeries,
    load_california_natural_flows_monthly,
    load_national_water_model_hourly,
)
from modeled_wse_version_layout import (  # noqa: E402
    ARCGIS_LAYER_AND_TABLE_NAMES,
    ARCGIS_PREFIX,
    ARCGIS_UPLOAD_FOLDER_NAME,
    CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID,
    CATALOG_PATH,
    CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME,
    CNF_MONTHLY_VALUES_TABLE_NAME,
    CREEK_SEGMENT_NETWORK_FILE_NAME,
    CREEK_SEGMENTS_LAYER_NAME,
    EXPECTED_SEGMENT_COUNT,
    EXPORT_CREEK_SEGMENT_NETWORK_SCRIPT,
    EXTENT_ID,
    HOUR_MS,
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
    junction_id,
    raw_hourly_csv_name,
    raw_hourly_csv_zip_name,
    read_json,
    upstream_and_downstream_vertex_index,
)

METHOD_COMMIT = "54618bbb"
OUTPUT_NEUTRAL_LATER_COMMITS = {"5265e7cf": "flowline snapshot path", "c0e955e5": "comment only"}
CHANGE_TYPE = "new method"
STATUS = "active"  # same value the wse-polygons registry entry uses; retiring sets "superseded"
MODELED_WSE_CODE_FOLDER = REPOSITORY_ROOT / "pipelines" / "creek-visualization-data-production" / "modeled-water-surface-elevation"
STAGE_0_TO_3_CODE_FILES = [
    MODELED_WSE_CODE_FOLDER / file_name
    for file_name in [
        "stage-00-acquire.ts",
        "stage-01-cross-sections.ts",
        "stage-02-rating-curves.ts",
        "stage-03-time-series.ts",
        "rating-curve-inversion.ts",
        "drainage-area-ratio.ts",
        "discharge-records.ts",
        "cross-section-geometry.ts",
        "pipeline-configuration.ts",
        "creek-segment-network.ts",
        "national-water-model-zarr.ts",
        "nhdplusv2-reach-crosswalk.ts",
        "water-years.ts",
    ]
] + [
    MODELED_WSE_CODE_FOLDER.parent / "tnc-flowline-segmentation.ts",
    MODELED_WSE_CODE_FOLDER.parent / "creek-segment-adjacency.ts",
]

# Text field widths (characters)
SEGMENT_ID_WIDTH = 16
TNC_COMID_WIDTH = 12
LOCATION_ID_WIDTH = 16
LOCATION_KIND_WIDTH = 8
SHORT_TEXT_WIDTH = 64
MEDIUM_TEXT_WIDTH = 256
LONG_TEXT_WIDTH = 2000
DERIVATION_JSON_WIDTH = 32000


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


def export_creek_segment_network(output_path: Path) -> dict:
    subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
            str(EXPORT_CREEK_SEGMENT_NETWORK_SCRIPT),
            f"--extent={EXTENT_ID}",
            f"--output={output_path}",
        ],
        cwd=REPOSITORY_ROOT,
        check=True,
    )
    network = read_json(output_path)
    if network["segmentNetworkVersion"] != SEGMENT_NETWORK_VERSION or network["extentId"] != EXTENT_ID:
        raise ValueError(f"Unexpected network {network['extentId']} {network['segmentNetworkVersion']}")
    if len(network["segments"]) != EXPECTED_SEGMENT_COUNT:
        raise ValueError(f"Network has {len(network['segments'])} Creek Segments, expected {EXPECTED_SEGMENT_COUNT}")
    for segment in network["segments"]:
        if len(segment["pathWgs84"]) != 2:
            raise ValueError(f"{segment['segmentId']} path has {len(segment['pathWgs84'])} vertices, expected 2")
    return network


def tnc_comids_in_network_order(network_segments: list[dict]) -> list[str]:
    return sorted({segment["tncComid"] for segment in network_segments})


def check_flowline_segments_match_network(flowline: FlowlineSeries, network_segment_ids: list[str], label: str) -> None:
    file_segment_ids = [segment.segment_id for segment in flowline.segments]
    if sorted(file_segment_ids) != sorted(network_segment_ids):
        raise ValueError(f"{label} {flowline.tnc_comid}: segments do not match the Creek Segment network")


# ---------------------------------------------------------------------------
# Accumulators
# ---------------------------------------------------------------------------


class HeldWseIntervalRows:
    def __init__(self) -> None:
        self.location_kind: list[np.ndarray] = []
        self.location_id: list[np.ndarray] = []
        self.tnc_comid: list[np.ndarray] = []
        self.valid_from_ms: list[np.ndarray] = []
        self.valid_until_ms: list[np.ndarray] = []
        self.wse_m: list[np.ndarray] = []
        self.step_count: list[np.ndarray] = []
        self.location_counts = {"segment": 0, "junction": 0}

    def add_series(self, kind: str, location: str, tnc_comid: str, intervals: dict[str, np.ndarray]) -> None:
        row_count = len(intervals["valid_from_ms"])
        self.location_kind.append(np.full(row_count, kind, dtype=object))
        self.location_id.append(np.full(row_count, location, dtype=object))
        self.tnc_comid.append(np.full(row_count, tnc_comid, dtype=object))
        self.valid_from_ms.append(intervals["valid_from_ms"])
        self.valid_until_ms.append(intervals["valid_until_ms"])
        self.wse_m.append(intervals["wse_m"])
        self.step_count.append(intervals["step_count"])
        self.location_counts[kind] += 1

    def add_flowline(
        self, flowline: FlowlineSeries, junction_series: dict[str, np.ndarray], end_timestamp_ms: int
    ) -> None:
        for segment in flowline.segments:
            intervals = held_intervals_of_series(segment.values, flowline.timestamps_ms, end_timestamp_ms)
            self.add_series("segment", segment.segment_id, flowline.tnc_comid, intervals)
        for identifier, series in junction_series.items():
            intervals = held_intervals_of_series(series, flowline.timestamps_ms, end_timestamp_ms)
            self.add_series("junction", identifier, flowline.tnc_comid, intervals)

    def columns(self) -> list:
        def joined(parts: list[np.ndarray]) -> np.ndarray:
            return np.concatenate(parts) if parts else np.array([])

        return [
            text_column("location_kind", joined(self.location_kind), LOCATION_KIND_WIDTH),
            text_column("location_id", joined(self.location_id), LOCATION_ID_WIDTH),
            text_column("tnc_comid", joined(self.tnc_comid), TNC_COMID_WIDTH),
            utc_date_column("valid_from_utc", joined(self.valid_from_ms).astype(np.int64)),
            utc_date_column("valid_until_utc", joined(self.valid_until_ms).astype(np.int64)),
            double_column("wse_m", joined(self.wse_m).astype(np.float64)),
            integer_column("step_count", joined(self.step_count).astype(np.int32)),
        ]


class MonthlyValueRows:
    def __init__(self) -> None:
        self.segment_id: list[np.ndarray] = []
        self.tnc_comid: list[np.ndarray] = []
        self.month_start_ms: list[np.ndarray] = []
        self.wse_m: list[np.ndarray] = []
        self.junction_wse_upstream_m: list[np.ndarray] = []
        self.junction_wse_downstream_m: list[np.ndarray] = []

    def add_flowline(self, flowline: FlowlineSeries) -> None:
        step_count = len(flowline.timestamps_ms)
        for segment in flowline.segments:
            self.segment_id.append(np.full(step_count, segment.segment_id, dtype=object))
            self.tnc_comid.append(np.full(step_count, flowline.tnc_comid, dtype=object))
            self.month_start_ms.append(flowline.timestamps_ms)
            self.wse_m.append(segment.values)
            self.junction_wse_upstream_m.append(segment.junction_wse_upstream_m)
            self.junction_wse_downstream_m.append(segment.junction_wse_downstream_m)

    def columns(self) -> list:
        return [
            text_column("segment_id", np.concatenate(self.segment_id), SEGMENT_ID_WIDTH),
            text_column("tnc_comid", np.concatenate(self.tnc_comid), TNC_COMID_WIDTH),
            utc_date_column("month_start_utc", np.concatenate(self.month_start_ms)),
            double_column("wse_m", np.concatenate(self.wse_m)),
            double_column("junction_wse_upstream_m", np.concatenate(self.junction_wse_upstream_m)),
            double_column("junction_wse_downstream_m", np.concatenate(self.junction_wse_downstream_m)),
        ]


class RawHourlyCsvZipWriters:
    """One zipped CSV per water year, streamed flowline by flowline."""

    SCHEMA = pa.schema(
        [
            ("segment_id", pa.string()),
            ("tnc_comid", pa.string()),
            ("time_utc", pa.string()),
            ("wse_m", pa.float64()),
            ("junction_wse_upstream_m", pa.float64()),
            ("junction_wse_downstream_m", pa.float64()),
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

    def add_flowline(self, flowline: FlowlineSeries) -> None:
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
                        np.concatenate([s.junction_wse_upstream_m[start:end] for s in flowline.segments]), from_pandas=True
                    ),
                    pa.array(
                        np.concatenate([s.junction_wse_downstream_m[start:end] for s in flowline.segments]), from_pandas=True
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
# Tables
# ---------------------------------------------------------------------------


def creek_segment_columns_and_geometry(network_segments: list[dict], crosswalk_by_id: dict[str, dict]) -> tuple[list, list]:
    rows = []
    geometry_wkb = []
    for segment in network_segments:
        crosswalk = crosswalk_by_id[segment["segmentId"]]
        upstream_vertex, downstream_vertex = upstream_and_downstream_vertex_index(segment)
        rows.append(
            {
                "segment_id": segment["segmentId"],
                "tnc_comid": segment["tncComid"],
                "vertex_index_start": segment["vertexIndexStart"],
                "vertex_index_end": segment["vertexIndexEnd"],
                "length_m": segment["lengthM"],
                "flow_direction": segment["flowDirection"],
                "upstream_segment_id": segment["upstreamSegmentId"],
                "downstream_segment_id": segment["downstreamSegmentId"],
                "upstream_junction_id": junction_id(segment["tncComid"], upstream_vertex),
                "downstream_junction_id": junction_id(segment["tncComid"], downstream_vertex),
                "nhdplusv2_comid": crosswalk["nhdplusV2Comid"],
                "segment_drainage_area_km2": crosswalk.get("segmentDrainageAreaKm2"),
                "reach_drainage_area_km2": crosswalk.get("reachDrainageAreaKm2"),
                "drainage_area_ratio": crosswalk.get("drainageAreaRatio"),
                "drainage_area_ratio_transfer": 1 if crosswalk.get("drainageAreaRatioTransfer") else 0,
                "transfer_distance_m": crosswalk.get("transferDistanceM"),
            }
        )
        geometry_wkb.append(to_wkb(LineString(segment["pathWgs84"])))

    def values(name: str) -> list:
        return [row[name] for row in rows]

    columns = [
        text_column("segment_id", values("segment_id"), SEGMENT_ID_WIDTH),
        text_column("tnc_comid", values("tnc_comid"), TNC_COMID_WIDTH),
        integer_column("vertex_index_start", values("vertex_index_start")),
        integer_column("vertex_index_end", values("vertex_index_end")),
        double_column("length_m", values("length_m")),
        short_integer_column("flow_direction", values("flow_direction")),
        text_column("upstream_segment_id", values("upstream_segment_id"), SEGMENT_ID_WIDTH),
        text_column("downstream_segment_id", values("downstream_segment_id"), SEGMENT_ID_WIDTH),
        text_column("upstream_junction_id", values("upstream_junction_id"), LOCATION_ID_WIDTH),
        text_column("downstream_junction_id", values("downstream_junction_id"), LOCATION_ID_WIDTH),
        integer_column("nhdplusv2_comid", values("nhdplusv2_comid")),
        double_column("segment_drainage_area_km2", [float_or_none(v) for v in values("segment_drainage_area_km2")]),
        double_column("reach_drainage_area_km2", [float_or_none(v) for v in values("reach_drainage_area_km2")]),
        double_column("drainage_area_ratio", [float_or_none(v) for v in values("drainage_area_ratio")]),
        short_integer_column("drainage_area_ratio_transfer", values("drainage_area_ratio_transfer")),
        double_column("transfer_distance_m", [float_or_none(v) for v in values("transfer_distance_m")]),
    ]
    return columns, geometry_wkb


def float_or_none(value) -> float | None:
    return None if value is None else float(value)


def versions_table_columns(version_record: dict) -> list:
    record = version_record
    return [
        text_column("product", [record["product"]], SHORT_TEXT_WIDTH),
        text_column("method_id", [record["method_id"]], SHORT_TEXT_WIDTH),
        short_integer_column("method_number", [record["method_number"]]),
        short_integer_column("version_number", [record["version_number"]]),
        text_column("version_label", [record["version_label"]], SHORT_TEXT_WIDTH),
        text_column("status", [record["status"]], SHORT_TEXT_WIDTH),
        text_column("change_type", [record["change_type"]], SHORT_TEXT_WIDTH),
        text_column("change_note", [record["change_note"]], LONG_TEXT_WIDTH),
        utc_date_column("method_date_utc", [iso_to_epoch_ms(record["method_date_utc"])]),
        utc_date_column("generated_at_utc", [iso_to_epoch_ms(record["generated_at_utc"])]),
        text_column("frozen_from_commit", [record["frozen_from_commit"]], SHORT_TEXT_WIDTH),
        text_column("code_fingerprint", [record["code_fingerprint"]], SHORT_TEXT_WIDTH),
        text_column("segment_network_version", [record["segment_network_version"]], SHORT_TEXT_WIDTH),
        text_column("extent_id", [record["extent_id"]], SHORT_TEXT_WIDTH),
        text_column("dataset_ids", [", ".join(record["dataset_ids"])], MEDIUM_TEXT_WIDTH),
        text_column("water_years", [record["water_years"]], MEDIUM_TEXT_WIDTH),
        text_column("derivation_summary", [record["derivation_summary"]], LONG_TEXT_WIDTH),
        text_column("derivation_json", [record["derivation_json"]], DERIVATION_JSON_WIDTH),
        text_column("arcgis_table_names", [", ".join(record["arcgis_table_names"])], LONG_TEXT_WIDTH),
        # Filled after publishing (edit_features), so null in the frozen upload.
        text_column("raw_hourly_csv_item_ids", [None], LONG_TEXT_WIDTH),
        utc_date_column("published_at_utc", [None]),
    ]


def iso_to_epoch_ms(iso_text: str) -> int:
    import datetime as dt

    return int(dt.datetime.fromisoformat(iso_text.replace("Z", "+00:00")).timestamp() * 1000)


# ---------------------------------------------------------------------------
# Version metadata
# ---------------------------------------------------------------------------


def derivation_json_text(catalog: dict) -> str:
    datasets = {dataset["datasetId"]: dataset for dataset in catalog["datasets"]}
    derivations = {series["datasetId"]: series["derivation"] for series in catalog["timeSeries"]}
    published = [NATIONAL_WATER_MODEL_HOURLY_DATASET_ID, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID]
    value = {
        "variable": next(v for v in catalog["variables"] if v["variableId"] == "water-surface-elevation"),
        "datasets": [
            {
                "datasetId": dataset_id,
                "publisherId": datasets[dataset_id]["publisherId"],
                "timeStep": datasets[dataset_id]["timeStep"],
                "accuracyNote": datasets[dataset_id]["accuracyNote"],
                "derivation": derivations[dataset_id],
            }
            for dataset_id in published
        ],
        "drainageAreaRatioTransfer": catalog["drainageAreaRatioTransfer"],
        "junctionWse": STAGE_3_JUNCTION_WSE_NOTE,
    }
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(text) > DERIVATION_JSON_WIDTH:
        raise ValueError(f"derivation_json is {len(text)} characters, more than {DERIVATION_JSON_WIDTH}")
    return text


STAGE_3_JUNCTION_WSE_NOTE = (
    "Segment-junction WSE (one series per TNC flowline vertex) is the higher of the two neighbouring Creek "
    "Segments' values; at a flowline end, or where the neighbour is null, the segment's own value."
)

DERIVATION_SUMMARY = (
    "Modeled water-surface elevation (m NAVD88) per Creek Segment. Discharge per NHDPlusV2 reach (NOAA National "
    "Water Model v3.0 retrospective, hourly, WY2021–WY2023; California Natural Flows, monthly, 1950–2024) is "
    "scaled to each Creek Segment by the USGS drainage-area ratio method (capped at 1; a segment on a creek with "
    "no NHDPlusV2 reach of its own uses Drainage-Area Ratio Transfer from the nearest reach, and gets no "
    "discharge beyond 1000 m), then converted to WSE with a divided-channel Manning's equation rating curve "
    "(n = 0.04 main channel, 0.07 floodplain) on USGS 3DEP 1 m cross-sections. Junction WSE at a shared vertex "
    "is the higher of the two neighbouring segments' values. Values are stored as Held WSE Intervals."
)


def change_note(head_commit: str) -> str:
    later = "; ".join(f"{commit} ({reason})" for commit, reason in OUTPUT_NEUTRAL_LATER_COMMITS.items())
    return (
        f"First version of method m1. Output generated by the method as of {METHOD_COMMIT}; frozen from "
        f"{head_commit[:8]}. Later commits {later} and the UCS-295 data-folder renames do not change output."
    )


def water_years_text(nwm_start_ms: int, nwm_last_ms: int, cnf_start_ms: int, cnf_last_ms: int) -> str:
    years = PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS
    return (
        f"{NATIONAL_WATER_MODEL_HOURLY_DATASET_ID}: WY{years[0]}–WY{years[-1]} hourly "
        f"{utc_iso_from_epoch_ms(nwm_start_ms)} to {utc_iso_from_epoch_ms(nwm_last_ms)}; "
        f"{CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID}: monthly "
        f"{utc_iso_from_epoch_ms(cnf_start_ms)[:7]} to {utc_iso_from_epoch_ms(cnf_last_ms)[:7]}"
    )


def file_entry(version_folder: Path, path: Path) -> dict:
    return {"path": path.relative_to(version_folder).as_posix(), "bytes": path.stat().st_size, "sha256": sha256_of_file(path)}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--trial-folder", help="Write a scratch version here instead of data/; registry is not touched.")
    parser.add_argument("--only-tnc-comids", help="Comma-separated TNC flowline COMIDs (trial runs only).")
    arguments = parser.parse_args()
    if arguments.only_tnc_comids and not arguments.trial_folder:
        parser.error("--only-tnc-comids needs --trial-folder; a real version always holds every Creek Segment.")
    return arguments


def check_registry_has_no_conflicting_version() -> None:
    product_entry = read_registry().get("products", {}).get(PRODUCT)
    for version in (product_entry or {}).get("versions", []):
        if version.get("version_label") == VERSION_LABEL:
            raise SystemExit(f"Registry already has {PRODUCT} {VERSION_LABEL}; versions are append-only.")


def main() -> None:
    arguments = parse_arguments()
    started = time.time()
    is_trial = bool(arguments.trial_folder)
    final_folder = Path(arguments.trial_folder).resolve() if is_trial else VERSION_FOLDER
    if not is_trial:
        check_registry_has_no_conflicting_version()

    head_commit = git_head_commit()
    method_commit = git_commit(METHOD_COMMIT)
    stage_3_manifest = read_json(STAGE_3_MANIFEST_PATH)
    catalog = read_json(CATALOG_PATH)
    crosswalk = read_json(NHDPLUSV2_REACH_CROSSWALK_PATH)
    if crosswalk["segmentNetworkVersion"] != SEGMENT_NETWORK_VERSION:
        raise ValueError("Crosswalk segmentNetworkVersion does not match")
    crosswalk_by_id = {segment["segmentId"]: segment for segment in crosswalk["segments"]}

    with staged_version_folder(PRODUCT, METHOD_ID, VERSION_LABEL, final_folder=final_folder) as staging:
        log(f"Building {PRODUCT} {VERSION_LABEL} in {staging}")

        network_path = staging / CREEK_SEGMENT_NETWORK_FILE_NAME
        network = export_creek_segment_network(network_path)
        network_segments = network["segments"]
        if set(crosswalk_by_id) != {segment["segmentId"] for segment in network_segments}:
            raise ValueError("Crosswalk Creek Segments do not match the network")
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

        nwm_intervals = HeldWseIntervalRows()
        cnf_intervals = HeldWseIntervalRows()
        cnf_values = MonthlyValueRows()
        nwm_junction_counts = JunctionIdentityCounts()
        cnf_junction_counts = JunctionIdentityCounts()
        raw_hourly_writers = RawHourlyCsvZipWriters(staging / RAW_HOURLY_VALUES_FOLDER_NAME, PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
        nwm_range_ms: tuple[int, int] | None = None
        cnf_range_ms: tuple[int, int] | None = None
        nwm_segment_count = 0
        cnf_segment_count = 0
        try:
            for index, tnc_comid in enumerate(tnc_comids, start=1):
                hourly = load_national_water_model_hourly(tnc_comid, PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
                check_flowline_segments_match_network(hourly, network_segment_ids_by_comid[tnc_comid], "NWM hourly")
                hourly_range = (int(hourly.timestamps_ms[0]), int(hourly.timestamps_ms[-1]))
                if nwm_range_ms not in (None, hourly_range):
                    raise ValueError(f"{tnc_comid}: NWM hourly time range differs from other flowlines")
                nwm_range_ms = hourly_range
                hourly_junctions, counts = junction_series_of_flowline(hourly, network_segment_by_id)
                nwm_junction_counts.add(counts)
                nwm_intervals.add_flowline(hourly, hourly_junctions, hourly_range[1] + HOUR_MS)
                raw_hourly_writers.add_flowline(hourly)
                nwm_segment_count += len(hourly.segments)
                del hourly, hourly_junctions

                monthly = load_california_natural_flows_monthly(tnc_comid)
                check_flowline_segments_match_network(monthly, network_segment_ids_by_comid[tnc_comid], "CNF monthly")
                monthly_range = (int(monthly.timestamps_ms[0]), int(monthly.timestamps_ms[-1]))
                if cnf_range_ms not in (None, monthly_range):
                    raise ValueError(f"{tnc_comid}: CNF monthly time range differs from other flowlines")
                cnf_range_ms = monthly_range
                monthly_junctions, counts = junction_series_of_flowline(monthly, network_segment_by_id)
                cnf_junction_counts.add(counts)
                cnf_intervals.add_flowline(monthly, monthly_junctions, add_one_month_ms(monthly_range[1]))
                cnf_values.add_flowline(monthly)
                cnf_segment_count += len(monthly.segments)
                del monthly, monthly_junctions
                if index % 10 == 0 or index == len(tnc_comids):
                    log(f"  read {index}/{len(tnc_comids)} TNC flowlines ({nwm_segment_count} Creek Segments)")
        finally:
            raw_hourly_writers.close()

        for label, count in [("NWM hourly", nwm_segment_count), ("CNF monthly", cnf_segment_count)]:
            if count != len(network_segments):
                raise ValueError(f"{label} has {count} Creek Segments, expected {len(network_segments)}")
        log(
            f"Junction identity: NWM {nwm_junction_counts.shared_by_two_segments} shared vertices "
            f"({nwm_junction_counts.identical_where_both_present} identical only where both present: "
            f"{', '.join(nwm_junction_counts.resolved_junction_ids)}); CNF {cnf_junction_counts.shared_by_two_segments} "
            f"({cnf_junction_counts.identical_where_both_present})"
        )

        code = code_fingerprint(STAGE_0_TO_3_CODE_FILES, commit=head_commit)
        version_record = {
            "product": PRODUCT,
            "method_id": METHOD_ID,
            "method_number": METHOD_NUMBER,
            "version_number": VERSION_NUMBER,
            "version_label": VERSION_LABEL,
            "status": STATUS,
            "change_type": CHANGE_TYPE,
            "change_note": change_note(head_commit),
            "method_date_utc": method_commit["date_utc"],
            "generated_at_utc": stage_3_manifest["completedAt"],
            "frozen_from_commit": head_commit,
            "code_fingerprint": code["sha256"],
            "segment_network_version": SEGMENT_NETWORK_VERSION,
            "extent_id": EXTENT_ID,
            "dataset_ids": [NATIONAL_WATER_MODEL_HOURLY_DATASET_ID, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID],
            "water_years": water_years_text(*nwm_range_ms, *cnf_range_ms),
            "derivation_summary": DERIVATION_SUMMARY,
            "derivation_json": derivation_json_text(catalog),
            "arcgis_table_names": ARCGIS_LAYER_AND_TABLE_NAMES,
        }

        upload_folder = staging / ARCGIS_UPLOAD_FOLDER_NAME
        upload_folder.mkdir()
        row_counts: dict[str, int] = {}
        with tempfile.TemporaryDirectory(prefix="modeled-wse-gdb-") as temporary_folder:
            gdb_path = Path(temporary_folder) / UPLOAD_GDB_FOLDER_NAME
            log(f"Writing {VERSIONS_TABLE_NAME}")
            row_counts[VERSIONS_TABLE_NAME] = write_table(gdb_path, VERSIONS_TABLE_NAME, versions_table_columns(version_record))
            log(f"Writing {CREEK_SEGMENTS_LAYER_NAME}")
            segment_columns, segment_geometry = creek_segment_columns_and_geometry(network_segments, crosswalk_by_id)
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
            "method_commit": method_commit,
            "code_fingerprint_detail": {
                "basis": "HEAD at freeze",
                "commit": head_commit,
                "line_format": "sorted '<repository-relative path>:<sha256>' lines joined by newline",
                "files": code["files"],
                "working_tree_differs_from_head": git_uncommitted_paths(STAGE_0_TO_3_CODE_FILES),
            },
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
                **{
                    repository_relative_path(source_path): sha256_of_file(source_path)
                    for source_path in SOURCE_MANIFEST_COPIES.values()
                },
            },
            "counts": {
                "creek_segments": len(network_segments),
                "tnc_flowlines": len(tnc_comids),
                "arcgis_rows": row_counts,
                "nwm_hourly_held_interval_locations": nwm_intervals.location_counts,
                "cnf_monthly_held_interval_locations": cnf_intervals.location_counts,
                "raw_hourly_csv_rows": {f"WY{year}": count for year, count in raw_hourly_writers.row_counts.items()},
            },
            "junction_identity": {
                "rule": (
                    "Both Creek Segments at a shared vertex carry identical junction WSE wherever both are non-null; "
                    "the junction series is stored once. Each segment's own junction array is null where its value "
                    "is null, else the junction series."
                ),
                NATIONAL_WATER_MODEL_HOURLY_DATASET_ID: vars(nwm_junction_counts),
                CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID: vars(cnf_junction_counts),
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
