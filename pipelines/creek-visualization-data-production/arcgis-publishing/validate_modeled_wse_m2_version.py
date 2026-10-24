"""Validate a frozen modeled WSE m2-v1 version by reading it back.

Reads the file geodatabase from arcgis-upload/modeled-wse-m2-v1.gdb.zip (unzipped to a temporary
folder), never the in-memory freeze, and compares it with the Stage 1 and Stage 3 source files.
Expected counts come from the frozen output (version.json) and the Stage 3 manifest, not constants.

- every National Water Model hourly WY2021–WY2023 `values`, `junctionDepthUpstreamM`, and
  `junctionDepthDownstreamM` array, rebuilt from Held WSE Intervals, matches exactly (float64
  equality, nulls as nulls, at most 3 decimals). An interval changes when ANY of the three changes,
  so neighbouring intervals never hold three equal values;
- the same for every California Natural Flows monthly array, from Held WSE Intervals and from the
  cnf_monthly_values table; the raw hourly CSV zips match the same arrays;
- junction WSE is not stored; junction bed + junction depth, rounded to 3 decimals, rebuilds every
  Stage 3 `junctionWseUpstreamM` / `junctionWseDownstreamM` value;
- Creek Segments layer: static columns anchor_longitude / anchor_latitude (Stage 1 section index 2
  thalwegUtm → EPSG:4326), anchor_bed_elevation_m, junction_bed_upstream_m, junction_bed_downstream_m
  equal their sources; Stage 1 section 2 bed equals the Time Series anchor bed within 0.001 m;
- field types: dates are Date fields (datetimes, not strings), text widths, EPSG:4326.

Prints a spot check (default 27714697-043/044/045 at 2023-02-01T00:00Z) of the rebuilt values.
Exits nonzero on any failure.

    npm run data-products:validate-modeled-wse-m2
    npm run data-products:validate-modeled-wse-m2 -- --version-folder=/tmp/modeled-wse-m2-trial
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.csv as pyarrow_csv
import shapely

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_versions import sha256_of_file  # noqa: E402
from file_geodatabase_tables import GDAL_WIDTH_METADATA_KEY, layer_info, layer_names, read_table, unzip_gdb  # noqa: E402
from held_wse_intervals import expand_held_interval_columns  # noqa: E402
from modeled_wse_m2_source_series import (  # noqa: E402
    DepthFlowlineSeries,
    load_california_natural_flows_monthly,
    load_national_water_model_hourly,
)
from modeled_wse_m2_version_layout import (  # noqa: E402
    ANCHOR_AND_JUNCTION_BED_FIELDS,
    ARCGIS_LAYER_AND_TABLE_NAMES,
    ARCGIS_UPLOAD_FOLDER_NAME,
    CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME,
    CNF_MONTHLY_VALUES_TABLE_NAME,
    CREEK_SEGMENT_NETWORK_FILE_NAME,
    CREEK_SEGMENTS_LAYER_NAME,
    CROSS_SECTIONS_PATH,
    HELD_INTERVAL_FIELDS,
    HOUR_MS,
    MAXIMUM_STAGE_1_VS_TIME_SERIES_BED_DIFFERENCE_M,
    NWM_HOURLY_HELD_INTERVALS_TABLE_NAME,
    PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS,
    RAW_HOURLY_VALUES_FOLDER_NAME,
    STAGE_3_MANIFEST_PATH,
    UPLOAD_GDB_ZIP_NAME,
    VERSION_FOLDER,
    VERSION_JSON_NAME,
    VERSIONS_TABLE_NAME,
    add_one_month_ms,
    anchor_points_by_segment_id,
    junction_id,
    junction_wse_from_bed_and_depth,
    raw_hourly_csv_name,
    raw_hourly_csv_zip_name,
    read_json,
    upstream_and_downstream_vertex_index,
)
from validate_modeled_wse_version import ArrayComparison, ValidationReport, log, numpy_of  # noqa: E402

DATE_FIELDS = {
    VERSIONS_TABLE_NAME: ["method_date_utc", "generated_at_utc", "published_at_utc"],
    NWM_HOURLY_HELD_INTERVALS_TABLE_NAME: ["valid_from_utc", "valid_until_utc"],
    CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME: ["valid_from_utc", "valid_until_utc"],
    CNF_MONTHLY_VALUES_TABLE_NAME: ["month_start_utc"],
}
EXPECTED_TEXT_WIDTHS = {
    (VERSIONS_TABLE_NAME, "derivation_json"): 32000,
    (CREEK_SEGMENTS_LAYER_NAME, "segment_id"): 16,
    (NWM_HOURLY_HELD_INTERVALS_TABLE_NAME, "segment_id"): 16,
    (CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME, "segment_id"): 16,
    (CNF_MONTHLY_VALUES_TABLE_NAME, "segment_id"): 16,
}
ANCHOR_COORDINATE_TOLERANCE_DEGREES = 1e-9
ANCHOR_MAXIMUM_DISTANCE_FROM_SEGMENT_DEGREES = 0.0005  # about 50 m; Stage 1 searches the thalweg within 30 m
DEFAULT_SPOT_CHECK_SEGMENT_IDS = ["27714697-043", "27714697-044", "27714697-045"]
DEFAULT_SPOT_CHECK_TIMESTAMP_MS = 1675209600000  # 2023-02-01T00:00:00Z

# Source name → table column, for the three time-varying values.
TIME_VARYING_SOURCE_TO_COLUMN = {
    "values": "wse_m",
    "junctionDepthUpstreamM": "junction_depth_upstream_m",
    "junctionDepthDownstreamM": "junction_depth_downstream_m",
}


def time_varying_arrays(segment) -> dict[str, np.ndarray]:
    return {
        "values": segment.values,
        "junctionDepthUpstreamM": segment.junction_depth_upstream_m,
        "junctionDepthDownstreamM": segment.junction_depth_downstream_m,
    }


# ---------------------------------------------------------------------------
# Reading the file geodatabase back
# ---------------------------------------------------------------------------


def split_sorted_rows_by_name(order: np.ndarray, codes: np.ndarray, dictionary: list[str]) -> dict[str, np.ndarray]:
    """{name: row indices in `order`} for rows already sorted so each name's rows are adjacent."""
    sorted_codes = codes[order]
    boundaries = np.flatnonzero(np.diff(sorted_codes)) + 1
    starts = np.concatenate([[0], boundaries])
    ends = np.concatenate([boundaries, [len(order)]])
    return {dictionary[sorted_codes[start]]: order[start:end] for start, end in zip(starts, ends)}


class HeldIntervalsBySegment:
    """Held WSE Interval rows grouped by segment_id, each group sorted by valid_from_utc."""

    def __init__(self, table: pa.Table) -> None:
        segment = table.column("segment_id").combine_chunks().dictionary_encode()
        codes = segment.indices.to_numpy()
        names = segment.dictionary.to_pylist()
        self.tnc_comid = numpy_of(table, "tnc_comid")
        self.valid_from_ms = numpy_of(table, "valid_from_utc")
        self.valid_until_ms = numpy_of(table, "valid_until_utc")
        self.columns = {name: numpy_of(table, name).astype(np.float64) for name in TIME_VARYING_SOURCE_TO_COLUMN.values()}
        self.step_count = numpy_of(table, "step_count").astype(np.int64)
        order = np.lexsort((self.valid_from_ms, codes))
        self.rows_by_segment = split_sorted_rows_by_name(order, codes, names)
        self.inconsistent_comid = sum(
            1 for rows in self.rows_by_segment.values() if len(set(self.tnc_comid[rows])) != 1
        )
        self.row_count = table.num_rows

    def rebuild(self, segment_id: str, timestamps_ms: np.ndarray, end_ms: int, problems: list[str]) -> dict[str, np.ndarray]:
        """The three time-varying arrays of one segment, or infinities (guaranteed mismatches) after a problem is noted."""
        failure = {source: np.full(len(timestamps_ms), np.inf) for source in TIME_VARYING_SOURCE_TO_COLUMN}
        rows = self.rows_by_segment.get(segment_id)
        if rows is None:
            problems.append(f"{segment_id}: no Held WSE Intervals")
            return failure
        valid_from = self.valid_from_ms[rows]
        valid_until = self.valid_until_ms[rows]
        if not np.array_equal(valid_until[:-1], valid_from[1:]):
            problems.append(f"{segment_id}: intervals are not contiguous")
        if valid_until[-1] != end_ms:
            problems.append(f"{segment_id}: last valid_until_utc {valid_until[-1]} != {end_ms}")
        columns = {column: self.columns[column][rows] for column in TIME_VARYING_SOURCE_TO_COLUMN.values()}
        same_as_next = np.ones(len(rows) - 1, dtype=bool)
        for values in columns.values():
            same_as_next &= (values[1:] == values[:-1]) | (np.isnan(values[1:]) & np.isnan(values[:-1]))
        if np.any(same_as_next):
            problems.append(f"{segment_id}: {int(same_as_next.sum())} neighbouring intervals hold the same three values")
        try:
            rebuilt = expand_held_interval_columns(valid_from, self.step_count[rows], columns, timestamps_ms)
        except ValueError as error:
            problems.append(f"{segment_id}: {error}")
            return failure
        return {source: rebuilt[column] for source, column in TIME_VARYING_SOURCE_TO_COLUMN.items()}


class MonthlyValuesBySegment:
    def __init__(self, table: pa.Table) -> None:
        segment = table.column("segment_id").combine_chunks().dictionary_encode()
        codes = segment.indices.to_numpy()
        names = segment.dictionary.to_pylist()
        self.month_start_ms = numpy_of(table, "month_start_utc")
        self.columns = {source: numpy_of(table, column).astype(np.float64) for source, column in TIME_VARYING_SOURCE_TO_COLUMN.items()}
        order = np.lexsort((self.month_start_ms, codes))
        self.rows_by_segment = split_sorted_rows_by_name(order, codes, names)


class RawHourlyCsv:
    """One water year's CSV, grouped by segment in file order (written segment by segment)."""

    def __init__(self, zip_path: Path, water_year: int) -> None:
        with zipfile.ZipFile(zip_path) as archive:
            with archive.open(raw_hourly_csv_name(water_year)) as stream:
                table = pyarrow_csv.read_csv(
                    stream,
                    convert_options=pyarrow_csv.ConvertOptions(
                        column_types={
                            "segment_id": pa.dictionary(pa.int32(), pa.string()),
                            "tnc_comid": pa.string(),
                            "time_utc": pa.string(),
                            "wse_m": pa.float64(),
                            "junction_depth_upstream_m": pa.float64(),
                            "junction_depth_downstream_m": pa.float64(),
                        }
                    ),
                )
        segment = table.column("segment_id").combine_chunks()
        codes = segment.indices.to_numpy()
        names = segment.dictionary.to_pylist()
        self.time_utc = table.column("time_utc")
        self.columns = {source: table.column(column).to_numpy() for source, column in TIME_VARYING_SOURCE_TO_COLUMN.items()}
        boundaries = np.flatnonzero(np.diff(codes)) + 1
        starts = np.concatenate([[0], boundaries])
        ends = np.concatenate([boundaries, [len(codes)]])
        self.slice_by_segment: dict[str, tuple[int, int]] = {}
        self.segment_split_into_blocks = 0
        for start, end in zip(starts, ends):
            name = names[codes[start]]
            if name in self.slice_by_segment:
                self.segment_split_into_blocks += 1
            self.slice_by_segment[name] = (int(start), int(end))
        self.row_count = table.num_rows

    def times_of(self, segment_id: str) -> list[str]:
        start, end = self.slice_by_segment[segment_id]
        return self.time_utc.slice(start, end - start).to_pylist()


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def check_field_types(gdb_path: Path, report: ValidationReport) -> None:
    names = layer_names(gdb_path)
    report.check(sorted(names) == sorted(ARCGIS_LAYER_AND_TABLE_NAMES), f"layers and tables: {sorted(names)}")
    for table_name, date_fields in DATE_FIELDS.items():
        info = layer_info(gdb_path, table_name)
        dtypes = dict(zip(info["fields"], info["dtypes"]))
        for field in date_fields:
            report.check(str(dtypes.get(field, "")).startswith("datetime64"), f"{table_name}.{field} is a Date field ({dtypes.get(field)})")
    for table_name in [NWM_HOURLY_HELD_INTERVALS_TABLE_NAME, CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME]:
        info = layer_info(gdb_path, table_name)
        report.check(list(info["fields"]) == HELD_INTERVAL_FIELDS, f"{table_name} fields {list(info['fields'])}")
        dtypes = dict(zip(info["fields"], info["dtypes"]))
        report.check(
            all(dtypes[name] == "float64" for name in TIME_VARYING_SOURCE_TO_COLUMN.values()) and dtypes["step_count"] == "int32",
            f"{table_name} wse_m and both junction depths are Double, step_count Integer",
        )
    segments_info = layer_info(gdb_path, CREEK_SEGMENTS_LAYER_NAME)
    report.check(segments_info["crs"] == "EPSG:4326", f"{CREEK_SEGMENTS_LAYER_NAME} CRS {segments_info['crs']}")
    report.check("LineString" in str(segments_info["geometry_type"]), f"{CREEK_SEGMENTS_LAYER_NAME} geometry {segments_info['geometry_type']}")
    dtypes = dict(zip(segments_info["fields"], segments_info["dtypes"]))
    report.check(dtypes.get("drainage_area_ratio_transfer") == "int16", "drainage_area_ratio_transfer is SmallInteger")
    report.check(
        all(dtypes.get(name) == "float64" for name in ANCHOR_AND_JUNCTION_BED_FIELDS),
        f"{CREEK_SEGMENTS_LAYER_NAME} anchor and junction bed columns are Double ({[dtypes.get(n) for n in ANCHOR_AND_JUNCTION_BED_FIELDS]})",
    )
    report.check(
        list(segments_info["fields"][-len(ANCHOR_AND_JUNCTION_BED_FIELDS) :]) == ANCHOR_AND_JUNCTION_BED_FIELDS,
        f"{CREEK_SEGMENTS_LAYER_NAME} ends with {ANCHOR_AND_JUNCTION_BED_FIELDS}",
    )
    for (table_name, field), width in EXPECTED_TEXT_WIDTHS.items():
        schema_field = read_table(gdb_path, table_name, max_features=1).schema.field(field)
        stored_width = (schema_field.metadata or {}).get(GDAL_WIDTH_METADATA_KEY.encode(), b"").decode()
        report.check(stored_width == str(width), f"{table_name}.{field} text width {stored_width} == {width}")


def check_versions_table(gdb_path: Path, version_json: dict, report: ValidationReport) -> None:
    table = read_table(gdb_path, VERSIONS_TABLE_NAME)
    report.check(table.num_rows == 1, f"{VERSIONS_TABLE_NAME} has {table.num_rows} row")
    row = table.to_pylist()[0]
    for key in [
        "product", "method_id", "version_label", "status", "change_type", "change_note",
        "frozen_from_commit", "code_fingerprint", "segment_network_version",
    ]:  # fmt: skip
        report.check(row[key] == version_json[key], f"{VERSIONS_TABLE_NAME}.{key} matches version.json")
    report.check(
        json.loads(row["derivation_json"]) == version_json["derivation"],
        f"{VERSIONS_TABLE_NAME}.derivation_json matches version.json ({len(row['derivation_json']):,} characters)",
    )
    method_date = row["method_date_utc"]
    report.check(
        method_date is not None and method_date.strftime("%Y-%m-%dT%H:%M:%SZ") == version_json["method_date_utc"],
        f"method_date_utc {method_date}",
    )


def check_creek_segments(
    gdb_path: Path,
    network: dict,
    version_json: dict,
    expected_segment_count: int,
    source_static_beds: dict[str, tuple[float, float, float]],
    report: ValidationReport,
) -> dict[str, dict]:
    table = read_table(gdb_path, CREEK_SEGMENTS_LAYER_NAME)
    geometry_column = next(name for name in table.column_names if name in ("SHAPE", "geometry", "wkb_geometry"))
    rows = table.drop_columns([geometry_column]).to_pylist()
    report.check(len(rows) == expected_segment_count, f"{CREEK_SEGMENTS_LAYER_NAME}: {len(rows):,} Creek Segments (expected {expected_segment_count:,})")
    network_by_id = {segment["segmentId"]: segment for segment in network["segments"]}
    mismatches = 0
    for row in rows:
        segment = network_by_id.get(row["segment_id"])
        if segment is None:
            mismatches += 1
            continue
        upstream_vertex, downstream_vertex = upstream_and_downstream_vertex_index(segment)
        expected = {
            "tnc_comid": segment["tncComid"],
            "vertex_index_start": segment["vertexIndexStart"],
            "vertex_index_end": segment["vertexIndexEnd"],
            "flow_direction": segment["flowDirection"],
            "upstream_segment_id": segment["upstreamSegmentId"],
            "downstream_segment_id": segment["downstreamSegmentId"],
            "upstream_junction_id": junction_id(segment["tncComid"], upstream_vertex),
            "downstream_junction_id": junction_id(segment["tncComid"], downstream_vertex),
        }
        if any(row[key] != value for key, value in expected.items()):
            mismatches += 1
    report.check(mismatches == 0, f"{CREEK_SEGMENTS_LAYER_NAME}: {mismatches} rows differ from the network export")
    geometries = shapely.from_wkb(table.column(geometry_column).to_pylist())
    report.check(bool(np.all(shapely.get_num_coordinates(geometries) == 2)), f"{CREEK_SEGMENTS_LAYER_NAME}: every geometry has 2 vertices")

    # Static anchor point and junction beds
    anchor_points = anchor_points_by_segment_id(read_json(CROSS_SECTIONS_PATH))
    anchor_mismatches: list[str] = []
    bed_mismatches: list[str] = []
    stage_1_bed_differences: list[float] = []
    too_far_from_segment: list[str] = []
    for row, geometry in zip(rows, geometries):
        segment_id = row["segment_id"]
        expected_point = anchor_points[segment_id]
        if (
            abs(row["anchor_longitude"] - expected_point["anchor_longitude"]) > ANCHOR_COORDINATE_TOLERANCE_DEGREES
            or abs(row["anchor_latitude"] - expected_point["anchor_latitude"]) > ANCHOR_COORDINATE_TOLERANCE_DEGREES
        ):
            anchor_mismatches.append(segment_id)
        if shapely.distance(shapely.Point(row["anchor_longitude"], row["anchor_latitude"]), geometry) > ANCHOR_MAXIMUM_DISTANCE_FROM_SEGMENT_DEGREES:
            too_far_from_segment.append(segment_id)
        source_beds = source_static_beds.get(segment_id)
        stored_beds = (row["anchor_bed_elevation_m"], row["junction_bed_upstream_m"], row["junction_bed_downstream_m"])
        if source_beds is None or tuple(stored_beds) != source_beds:
            bed_mismatches.append(segment_id)
        elif segment_id in anchor_points:
            stage_1_bed_differences.append(abs(expected_point["stage_1_anchor_bed_elevation_m"] - source_beds[0]))
    report.check(not anchor_mismatches, f"anchor_longitude / anchor_latitude equal Stage 1 section index 2 thalwegUtm transformed to EPSG:4326 ({len(anchor_mismatches)} differ)")
    report.check(not too_far_from_segment, f"every anchor point lies within {ANCHOR_MAXIMUM_DISTANCE_FROM_SEGMENT_DEGREES}° of its Creek Segment ({len(too_far_from_segment)} do not: {too_far_from_segment[:5]})")
    report.check(not bed_mismatches, f"anchor and junction bed columns equal the Time Series scalars ({len(bed_mismatches)} differ: {bed_mismatches[:5]})")
    beyond_tolerance = sum(difference > MAXIMUM_STAGE_1_VS_TIME_SERIES_BED_DIFFERENCE_M for difference in stage_1_bed_differences)
    recorded = version_json["stage_1_anchor_bed_cross_check"]
    report.check(
        beyond_tolerance == recorded["segments_beyond_tolerance"],
        f"Stage 1 section 2 bed vs Time Series anchor bed: {beyond_tolerance} of {len(stage_1_bed_differences):,} segments beyond "
        f"{MAXIMUM_STAGE_1_VS_TIME_SERIES_BED_DIFFERENCE_M} m (largest {max(stage_1_bed_differences, default=0):.6f} m); version.json recorded {recorded['segments_beyond_tolerance']}",
    )
    return {row["segment_id"]: row for row in rows}


def compare_flowline(
    flowline: DepthFlowlineSeries,
    intervals: HeldIntervalsBySegment,
    end_ms: int,
    segment_rows: dict[str, dict],
    comparison: ArrayComparison,
    junction_wse_comparison: ArrayComparison,
    problems: list[str],
) -> None:
    """Rebuild each segment's three time-varying arrays, then its junction WSE, from the stored intervals."""
    for segment in flowline.segments:
        row = segment_rows[segment.segment_id]
        rebuilt = intervals.rebuild(segment.segment_id, flowline.timestamps_ms, end_ms, problems)
        for source_name, source in time_varying_arrays(segment).items():
            comparison.compare(f"{segment.segment_id}.{source_name}", rebuilt[source_name], source)
        for bed_field, depth_name, source in [
            ("junction_bed_upstream_m", "junctionDepthUpstreamM", segment.junction_wse_upstream_m),
            ("junction_bed_downstream_m", "junctionDepthDownstreamM", segment.junction_wse_downstream_m),
        ]:
            junction_wse_comparison.compare(
                f"{segment.segment_id}.{depth_name}→junctionWse",
                junction_wse_from_bed_and_depth(row[bed_field], rebuilt[depth_name]),
                source,
            )


def depth_null_pattern_mismatches(flowline: DepthFlowlineSeries) -> int:
    """Segments whose junction depths are null at different steps than the value (the Held WSE Interval null-run rule assumes none)."""
    return sum(
        not (
            np.array_equal(np.isnan(segment.values), np.isnan(segment.junction_depth_upstream_m))
            and np.array_equal(np.isnan(segment.values), np.isnan(segment.junction_depth_downstream_m))
        )
        for segment in flowline.segments
    )


def print_spot_check(
    segment_ids: list[str], timestamp_ms: int, nwm_intervals: HeldIntervalsBySegment, flowlines_by_comid: dict[str, DepthFlowlineSeries],
    report: ValidationReport,
) -> None:
    print("Spot check (rebuilt from Held WSE Intervals, compared with the Stage 3 source at the same time):")
    for segment_id in segment_ids:
        flowline = flowlines_by_comid.get(segment_id.split("-")[0])
        segment = next((s for s in flowline.segments if s.segment_id == segment_id), None) if flowline else None
        if segment is None:
            print(f"  {segment_id}: not in this version")
            continue
        index = int(np.flatnonzero(flowline.timestamps_ms == timestamp_ms)[0])
        problems: list[str] = []
        rebuilt = nwm_intervals.rebuild(segment_id, flowline.timestamps_ms, int(flowline.timestamps_ms[-1]) + HOUR_MS, problems)
        source = time_varying_arrays(segment)
        identical = all(
            rebuilt[name][index] == source[name][index] or (np.isnan(rebuilt[name][index]) and np.isnan(source[name][index])) for name in source
        )
        report.check(identical and not problems, f"spot check {segment_id} at {timestamp_ms}: rebuilt equals source")
        print(
            f"  {segment_id} @ {timestamp_ms}: wse {rebuilt['values'][index]}  depth up {rebuilt['junctionDepthUpstreamM'][index]}  "
            f"depth down {rebuilt['junctionDepthDownstreamM'][index]}  anchor bed {segment.anchor_bed_elevation_m}  "
            f"→ anchor depth {rebuilt['values'][index] - segment.anchor_bed_elevation_m:.3f}  (source equal: {identical})"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version-folder", default=str(VERSION_FOLDER))
    parser.add_argument("--spot-check-segments", default=",".join(DEFAULT_SPOT_CHECK_SEGMENT_IDS))
    parser.add_argument("--spot-check-timestamp-ms", type=int, default=DEFAULT_SPOT_CHECK_TIMESTAMP_MS)
    arguments = parser.parse_args()
    version_folder = Path(arguments.version_folder).resolve()
    started = time.time()
    report = ValidationReport()
    version_json = read_json(version_folder / VERSION_JSON_NAME)
    expected_segment_count = version_json["counts"]["creek_segments"]

    for entry in version_json["files"]:
        path = version_folder / entry["path"]
        report.check(path.exists() and sha256_of_file(path) == entry["sha256"], f"sha256 of {entry['path']}")

    network = read_json(version_folder / CREEK_SEGMENT_NETWORK_FILE_NAME)
    if not version_json.get("trial"):
        stage_3_segment_count = read_json(STAGE_3_MANIFEST_PATH)["counts"]["creekSegments"]
        report.check(
            len(network["segments"]) == expected_segment_count == stage_3_segment_count,
            f"Creek Segments: network {len(network['segments']):,}, version.json {expected_segment_count:,}, Stage 3 manifest {stage_3_segment_count:,}",
        )

    with tempfile.TemporaryDirectory(prefix="validate-modeled-wse-m2-") as temporary_folder:
        log("Unzipping the file geodatabase")
        gdb_path = unzip_gdb(version_folder / ARCGIS_UPLOAD_FOLDER_NAME / UPLOAD_GDB_ZIP_NAME, Path(temporary_folder))
        check_field_types(gdb_path, report)
        check_versions_table(gdb_path, version_json, report)

        log("Reading the Stage 3 static bed scalars of every Creek Segment")
        # A trial version holds only some flowlines; the frozen version holds all of them.
        tnc_comids = sorted({segment_id.split("-")[0] for segment_id in read_segment_ids(gdb_path)})
        source_static_beds: dict[str, tuple[float, float, float]] = {}
        monthly_by_comid: dict[str, DepthFlowlineSeries] = {}
        for tnc_comid in tnc_comids:
            monthly = load_california_natural_flows_monthly(tnc_comid)
            monthly_by_comid[tnc_comid] = monthly
            for segment in monthly.segments:
                source_static_beds[segment.segment_id] = (
                    segment.anchor_bed_elevation_m,
                    segment.junction_bed_upstream_m,
                    segment.junction_bed_downstream_m,
                )
        segment_rows = check_creek_segments(gdb_path, network, version_json, expected_segment_count, source_static_beds, report)

        row_counts = {}
        log(f"Reading {NWM_HOURLY_HELD_INTERVALS_TABLE_NAME}")
        nwm_intervals = HeldIntervalsBySegment(read_table(gdb_path, NWM_HOURLY_HELD_INTERVALS_TABLE_NAME))
        log(f"Reading {CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME}")
        cnf_intervals = HeldIntervalsBySegment(read_table(gdb_path, CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME))
        log(f"Reading {CNF_MONTHLY_VALUES_TABLE_NAME}")
        cnf_values_table = read_table(gdb_path, CNF_MONTHLY_VALUES_TABLE_NAME)
        cnf_values = MonthlyValuesBySegment(cnf_values_table)
        for name in ARCGIS_LAYER_AND_TABLE_NAMES:
            row_counts[name] = layer_info(gdb_path, name)["features"]
        del cnf_values_table

        for label, intervals in [("NWM hourly", nwm_intervals), ("CNF monthly", cnf_intervals)]:
            report.check(
                len(intervals.rows_by_segment) == expected_segment_count and set(intervals.rows_by_segment) == set(segment_rows),
                f"{label} Held WSE Intervals: {len(intervals.rows_by_segment):,} Creek Segments",
            )
            report.check(intervals.inconsistent_comid == 0, f"{label}: {intervals.inconsistent_comid} segments with mixed tnc_comid")
        report.check(len(cnf_values.rows_by_segment) == expected_segment_count, f"{CNF_MONTHLY_VALUES_TABLE_NAME}: {len(cnf_values.rows_by_segment):,} Creek Segments")

        nwm_comparison = ArrayComparison("NWM hourly WY2021–WY2023 from Held WSE Intervals (wse, junction depths)")
        cnf_comparison = ArrayComparison("CNF monthly from Held WSE Intervals (wse, junction depths)")
        cnf_values_comparison = ArrayComparison(f"CNF monthly from {CNF_MONTHLY_VALUES_TABLE_NAME}")
        nwm_junction_wse = ArrayComparison("NWM hourly junction WSE rebuilt as junction bed + depth")
        cnf_junction_wse = ArrayComparison("CNF monthly junction WSE rebuilt as junction bed + depth")
        csv_comparisons = {year: ArrayComparison(f"raw hourly CSV WY{year}") for year in PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS}
        problems: list[str] = []
        null_pattern_mismatched_segments = 0
        hourly_by_comid: dict[str, DepthFlowlineSeries] = {}

        for index, tnc_comid in enumerate(tnc_comids, start=1):
            hourly = load_national_water_model_hourly(tnc_comid, PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
            compare_flowline(hourly, nwm_intervals, int(hourly.timestamps_ms[-1]) + HOUR_MS, segment_rows, nwm_comparison, nwm_junction_wse, problems)
            null_pattern_mismatched_segments += depth_null_pattern_mismatches(hourly)
            hourly_by_comid[tnc_comid] = hourly
            monthly = monthly_by_comid[tnc_comid]
            compare_flowline(monthly, cnf_intervals, add_one_month_ms(int(monthly.timestamps_ms[-1])), segment_rows, cnf_comparison, cnf_junction_wse, problems)
            null_pattern_mismatched_segments += depth_null_pattern_mismatches(monthly)
            for segment in monthly.segments:
                rows = cnf_values.rows_by_segment.get(segment.segment_id)
                if rows is None or not np.array_equal(cnf_values.month_start_ms[rows], monthly.timestamps_ms):
                    problems.append(f"{CNF_MONTHLY_VALUES_TABLE_NAME} {segment.segment_id}: month_start_utc differs")
                    continue
                for source_name, source in time_varying_arrays(segment).items():
                    cnf_values_comparison.compare(f"{segment.segment_id}.{source_name}", cnf_values.columns[source_name][rows], source)
            if index % 20 == 0 or index == len(tnc_comids):
                log(f"  compared {index}/{len(tnc_comids)} TNC flowlines")
        report.check(null_pattern_mismatched_segments == 0, f"{null_pattern_mismatched_segments} Time Series segments with junction depths null at different steps than the value")

        print_spot_check(arguments.spot_check_segments.split(","), arguments.spot_check_timestamp_ms, nwm_intervals, hourly_by_comid, report)
        del nwm_intervals, cnf_intervals, cnf_values

        csv_row_counts = {}
        for water_year in PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS:
            log(f"Reading raw hourly CSV WY{water_year}")
            csv = RawHourlyCsv(version_folder / RAW_HOURLY_VALUES_FOLDER_NAME / raw_hourly_csv_zip_name(water_year), water_year)
            csv_row_counts[f"WY{water_year}"] = csv.row_count
            report.check(
                len(csv.slice_by_segment) == expected_segment_count and csv.segment_split_into_blocks == 0,
                f"raw hourly CSV WY{water_year}: {len(csv.slice_by_segment):,} Creek Segments",
            )
            for tnc_comid, hourly in hourly_by_comid.items():
                start, end = hourly.water_year_slices[water_year]
                first_segment = hourly.segments[0].segment_id
                expected_times = [
                    f"{text}Z" for text in np.datetime_as_string(hourly.timestamps_ms[start:end].astype("datetime64[ms]"), unit="s")
                ]
                if csv.times_of(first_segment) != expected_times:
                    problems.append(f"raw hourly CSV WY{water_year} {first_segment}: time_utc differs")
                for segment in hourly.segments:
                    csv_start, csv_end = csv.slice_by_segment.get(segment.segment_id, (0, 0))
                    for source_name, source in time_varying_arrays(segment).items():
                        csv_comparisons[water_year].compare(
                            f"{segment.segment_id}.{source_name}", csv.columns[source_name][csv_start:csv_end], source[start:end]
                        )
            del csv

        all_comparisons = [nwm_comparison, cnf_comparison, cnf_values_comparison, nwm_junction_wse, cnf_junction_wse, *csv_comparisons.values()]
        for comparison in all_comparisons:
            comparison.report_into(report)
        report.check(not problems, f"{len(problems)} Held WSE Interval structure problems" + "".join(f"; {p}" for p in problems[:5]))

    print()
    print(f"Modeled WSE {version_json['version_label']} validation ({version_folder})")
    print("Row counts (read back from the file geodatabase):")
    for name, count in row_counts.items():
        print(f"  {name:<52} {count:>12,}")
    for name, count in csv_row_counts.items():
        print(f"  raw hourly CSV {name:<37} {count:>12,}")
    print("File sizes:")
    for entry in version_json["files"]:
        if entry["bytes"] > 1_000_000 or entry["path"].endswith(".zip"):
            print(f"  {entry['path']:<70} {entry['bytes'] / 1_000_000:>9.1f} MB")
    print("Round trips:")
    for comparison in all_comparisons:
        print(f"  {comparison.summary()}")
    cross_check = version_json["stage_1_anchor_bed_cross_check"]
    print(
        f"Stage 1 section 2 bed vs Time Series anchor bed: {cross_check['segments_beyond_tolerance']} of "
        f"{cross_check['segments_compared']:,} segments beyond {cross_check['tolerance_m']} m (largest {cross_check['maximum_difference_m']} m)"
    )
    sharing = version_json["junction_sharing"]
    print(
        f"Junction sharing (CNF monthly): {sharing['shared_by_two_segments']:,} shared vertices, {sharing['same_bed']:,} same bed, "
        f"{sharing['same_depth_where_both_present']:,} same depth where both present, {sharing['same_null_pattern']:,} same null pattern"
    )
    print(f"Checks: {len(report.checks)} passed, {len(report.failures)} failed ({time.time() - started:.0f} s)")
    for failure in report.failures:
        print(f"  FAIL {failure}")
    sys.exit(1 if report.failures else 0)


def read_segment_ids(gdb_path: Path) -> list[str]:
    return read_table(gdb_path, CREEK_SEGMENTS_LAYER_NAME).column("segment_id").to_pylist()


if __name__ == "__main__":
    main()
