"""Validate a frozen modeled WSE m1-v1 version by reading it back (UCS-285).

Reads the file geodatabase from arcgis-upload/modeled-wse-m1-v1.gdb.zip (unzipped to a
temporary folder), never the in-memory freeze, and compares it with the Stage 3 source JSON:

- every National Water Model hourly WY2021–WY2023 `values`, `junctionWseUpstreamM`, and
  `junctionWseDownstreamM` array, rebuilt from Held WSE Intervals, matches exactly
  (float64 equality, nulls as nulls, at most 3 decimals);
- the same for every California Natural Flows monthly array, from Held WSE Intervals and
  from the cnf_monthly_values table;
- the raw hourly CSV zips match the same arrays;
- junction identity: one stored series per junction, used by both Creek Segments;
- 3,338 Creek Segments in the network, segments layer, every table, and every CSV;
- field types: dates are Date fields (datetimes, not strings), text widths, EPSG:4326.

Exits nonzero on any failure.

    npm run data-products:validate-modeled-wse
    npm run data-products:validate-modeled-wse -- --version-folder=/tmp/modeled-wse-trial/m1-v1
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pyarrow_compute
import pyarrow.csv as pyarrow_csv
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_versions import sha256_of_file  # noqa: E402
from file_geodatabase_tables import GDAL_WIDTH_METADATA_KEY, layer_info, layer_names, read_table, unzip_gdb  # noqa: E402
from held_wse_intervals import expand_held_intervals  # noqa: E402
from modeled_wse_source_series import (  # noqa: E402
    FlowlineSeries,
    load_california_natural_flows_monthly,
    load_national_water_model_hourly,
)
from modeled_wse_version_layout import (  # noqa: E402
    ARCGIS_LAYER_AND_TABLE_NAMES,
    ARCGIS_UPLOAD_FOLDER_NAME,
    CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME,
    CNF_MONTHLY_VALUES_TABLE_NAME,
    CREEK_SEGMENT_NETWORK_FILE_NAME,
    CREEK_SEGMENTS_LAYER_NAME,
    EXPECTED_SEGMENT_COUNT,
    HOUR_MS,
    NWM_HOURLY_HELD_INTERVALS_TABLE_NAME,
    PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS,
    RAW_HOURLY_VALUES_FOLDER_NAME,
    UPLOAD_GDB_ZIP_NAME,
    VERSION_FOLDER,
    VERSION_JSON_NAME,
    VERSIONS_TABLE_NAME,
    add_one_month_ms,
    junction_id,
    raw_hourly_csv_name,
    raw_hourly_csv_zip_name,
    read_json,
    segment_junction_wse_from_junction_series,
    upstream_and_downstream_vertex_index,
)

DATE_FIELDS = {
    VERSIONS_TABLE_NAME: ["method_date_utc", "generated_at_utc", "published_at_utc"],
    NWM_HOURLY_HELD_INTERVALS_TABLE_NAME: ["valid_from_utc", "valid_until_utc"],
    CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME: ["valid_from_utc", "valid_until_utc"],
    CNF_MONTHLY_VALUES_TABLE_NAME: ["month_start_utc"],
}
EXPECTED_TEXT_WIDTHS = {
    (VERSIONS_TABLE_NAME, "derivation_json"): 32000,
    (CREEK_SEGMENTS_LAYER_NAME, "segment_id"): 16,
    (NWM_HOURLY_HELD_INTERVALS_TABLE_NAME, "location_id"): 16,
    (CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME, "location_id"): 16,
    (CNF_MONTHLY_VALUES_TABLE_NAME, "segment_id"): 16,
}
HELD_INTERVAL_FIELDS = ["location_kind", "location_id", "tnc_comid", "valid_from_utc", "valid_until_utc", "wse_m", "step_count"]


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


class ValidationReport:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.checks: list[str] = []

    def check(self, passed: bool, description: str) -> None:
        (self.checks if passed else self.failures).append(description)
        if not passed:
            log(f"FAIL: {description}")


class ArrayComparison:
    """Counts exact mismatches between rebuilt and source arrays (nulls must match nulls)."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.arrays = 0
        self.values = 0
        self.nulls = 0
        self.mismatched_values = 0
        self.mismatched_arrays = 0
        self.more_than_three_decimals = 0
        self.first_mismatches: list[str] = []

    def compare(self, description: str, rebuilt: np.ndarray, source: np.ndarray) -> None:
        self.arrays += 1
        self.values += len(source)
        source_null = np.isnan(source)
        self.nulls += int(source_null.sum())
        present = ~source_null
        self.more_than_three_decimals += int(np.sum(np.round(source[present], 3) != source[present]))
        if len(rebuilt) != len(source):
            self.mismatched_arrays += 1
            self.mismatched_values += len(source)
            self.first_mismatches.append(f"{description}: length {len(rebuilt)} != {len(source)}")
            return
        mismatched = ~((rebuilt == source) | (np.isnan(rebuilt) & source_null))
        count = int(mismatched.sum())
        if count:
            self.mismatched_arrays += 1
            self.mismatched_values += count
            if len(self.first_mismatches) < 5:
                index = int(np.flatnonzero(mismatched)[0])
                self.first_mismatches.append(f"{description}[{index}]: {rebuilt[index]} != {source[index]}")

    def summary(self) -> str:
        return (
            f"{self.label}: {self.arrays:,} arrays, {self.values:,} values ({self.nulls:,} null), "
            f"{self.mismatched_values} mismatched values in {self.mismatched_arrays} arrays"
        )

    def report_into(self, report: ValidationReport) -> None:
        report.check(self.mismatched_values == 0, self.summary() + "".join(f"; {m}" for m in self.first_mismatches))
        report.check(self.more_than_three_decimals == 0, f"{self.label}: {self.more_than_three_decimals} source values with more than 3 decimals")


# ---------------------------------------------------------------------------
# Reading the file geodatabase back
# ---------------------------------------------------------------------------


def numpy_of(table: pa.Table, name: str) -> np.ndarray:
    column = table.column(name).combine_chunks()
    if pa.types.is_timestamp(column.type):
        column = column.cast(pa.int64())
        if column.null_count:
            raise ValueError(f"{name} has {column.null_count} null dates")
        return column.to_numpy()
    if pa.types.is_floating(column.type):
        return column.to_numpy(zero_copy_only=False)
    return column.to_numpy(zero_copy_only=False)


class HeldIntervalsByLocation:
    """Held WSE Interval rows grouped by location_id, each group sorted by valid_from_utc."""

    def __init__(self, table: pa.Table) -> None:
        location = table.column("location_id").combine_chunks().dictionary_encode()
        codes = location.indices.to_numpy()
        names = location.dictionary.to_pylist()
        kinds = numpy_of(table, "location_kind")
        self.tnc_comid = numpy_of(table, "tnc_comid")
        self.valid_from_ms = numpy_of(table, "valid_from_utc")
        self.valid_until_ms = numpy_of(table, "valid_until_utc")
        self.wse_m = numpy_of(table, "wse_m").astype(np.float64)
        self.step_count = numpy_of(table, "step_count").astype(np.int64)
        order = np.lexsort((self.valid_from_ms, codes))
        sorted_codes = codes[order]
        boundaries = np.flatnonzero(np.diff(sorted_codes)) + 1
        starts = np.concatenate([[0], boundaries])
        ends = np.concatenate([boundaries, [len(order)]])
        self.rows_by_location: dict[str, np.ndarray] = {}
        self.kind_by_location: dict[str, str] = {}
        self.inconsistent_kind_or_comid = 0
        for start, end in zip(starts, ends):
            rows = order[start:end]
            name = names[sorted_codes[start]]
            self.rows_by_location[name] = rows
            location_kinds = set(kinds[rows])
            if len(location_kinds) != 1 or len(set(self.tnc_comid[rows])) != 1:
                self.inconsistent_kind_or_comid += 1
            self.kind_by_location[name] = next(iter(location_kinds))
        self.row_count = table.num_rows

    def location_ids_of_kind(self, kind: str) -> set[str]:
        return {name for name, location_kind in self.kind_by_location.items() if location_kind == kind}

    def rebuild(self, location: str, timestamps_ms: np.ndarray, end_ms: int, problems: list[str]) -> np.ndarray:
        rows = self.rows_by_location.get(location)
        if rows is None:
            problems.append(f"{location}: no Held WSE Intervals")
            return np.full(len(timestamps_ms), np.inf)
        valid_from = self.valid_from_ms[rows]
        valid_until = self.valid_until_ms[rows]
        if not np.array_equal(valid_until[:-1], valid_from[1:]):
            problems.append(f"{location}: intervals are not contiguous")
        if valid_until[-1] != end_ms:
            problems.append(f"{location}: last valid_until_utc {valid_until[-1]} != {end_ms}")
        values = self.wse_m[rows]
        same_as_next = (values[1:] == values[:-1]) | (np.isnan(values[1:]) & np.isnan(values[:-1]))
        if np.any(same_as_next):
            problems.append(f"{location}: {int(same_as_next.sum())} neighbouring intervals hold the same value")
        try:
            return expand_held_intervals(valid_from, values, self.step_count[rows], timestamps_ms)
        except ValueError as error:
            problems.append(f"{location}: {error}")
            return np.full(len(timestamps_ms), np.inf)


class MonthlyValuesBySegment:
    def __init__(self, table: pa.Table) -> None:
        segment = table.column("segment_id").combine_chunks().dictionary_encode()
        codes = segment.indices.to_numpy()
        names = segment.dictionary.to_pylist()
        self.month_start_ms = numpy_of(table, "month_start_utc")
        self.columns = {
            "values": numpy_of(table, "wse_m").astype(np.float64),
            "junctionWseUpstreamM": numpy_of(table, "junction_wse_upstream_m").astype(np.float64),
            "junctionWseDownstreamM": numpy_of(table, "junction_wse_downstream_m").astype(np.float64),
        }
        order = np.lexsort((self.month_start_ms, codes))
        sorted_codes = codes[order]
        boundaries = np.flatnonzero(np.diff(sorted_codes)) + 1
        starts = np.concatenate([[0], boundaries])
        ends = np.concatenate([boundaries, [len(order)]])
        self.rows_by_segment = {names[sorted_codes[s]]: order[s:e] for s, e in zip(starts, ends)}


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
                            "junction_wse_upstream_m": pa.float64(),
                            "junction_wse_downstream_m": pa.float64(),
                        }
                    ),
                )
        segment = table.column("segment_id").combine_chunks()
        codes = segment.indices.to_numpy()
        names = segment.dictionary.to_pylist()
        self.time_utc = table.column("time_utc")
        self.columns = {
            "values": table.column("wse_m").to_numpy(),
            "junctionWseUpstreamM": table.column("junction_wse_upstream_m").to_numpy(),
            "junctionWseDownstreamM": table.column("junction_wse_downstream_m").to_numpy(),
        }
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
        report.check(dtypes["wse_m"] == "float64" and dtypes["step_count"] == "int32", f"{table_name} wse_m Double, step_count Integer")
    segments_info = layer_info(gdb_path, CREEK_SEGMENTS_LAYER_NAME)
    report.check(segments_info["crs"] == "EPSG:4326", f"{CREEK_SEGMENTS_LAYER_NAME} CRS {segments_info['crs']}")
    report.check("LineString" in str(segments_info["geometry_type"]), f"{CREEK_SEGMENTS_LAYER_NAME} geometry {segments_info['geometry_type']}")
    dtypes = dict(zip(segments_info["fields"], segments_info["dtypes"]))
    report.check(dtypes.get("drainage_area_ratio_transfer") == "int16", "drainage_area_ratio_transfer is SmallInteger")
    for (table_name, field), width in EXPECTED_TEXT_WIDTHS.items():
        schema_field = read_table(gdb_path, table_name, max_features=1).schema.field(field)
        stored_width = (schema_field.metadata or {}).get(GDAL_WIDTH_METADATA_KEY.encode(), b"").decode()
        report.check(stored_width == str(width), f"{table_name}.{field} text width {stored_width} == {width}")


def check_versions_table(gdb_path: Path, version_json: dict, report: ValidationReport) -> None:
    table = read_table(gdb_path, VERSIONS_TABLE_NAME)
    report.check(table.num_rows == 1, f"{VERSIONS_TABLE_NAME} has {table.num_rows} row")
    row = table.to_pylist()[0]
    for key in ["product", "method_id", "version_label", "status", "change_type", "frozen_from_commit", "code_fingerprint", "segment_network_version"]:
        report.check(row[key] == version_json[key], f"{VERSIONS_TABLE_NAME}.{key} matches version.json")
    report.check(json.loads(row["derivation_json"]) == version_json["derivation"], f"{VERSIONS_TABLE_NAME}.derivation_json matches version.json ({len(row['derivation_json']):,} characters)")
    method_date = row["method_date_utc"]
    report.check(method_date is not None and method_date.strftime("%Y-%m-%dT%H:%M:%SZ") == version_json["method_date_utc"], f"method_date_utc {method_date}")


def check_creek_segments(gdb_path: Path, network: dict, report: ValidationReport, expected_segment_count: int) -> dict[str, dict]:
    table = read_table(gdb_path, CREEK_SEGMENTS_LAYER_NAME)
    rows = table.drop_columns([name for name in table.column_names if name in ("SHAPE", "geometry", "wkb_geometry")]).to_pylist()
    report.check(len(rows) == expected_segment_count, f"{CREEK_SEGMENTS_LAYER_NAME}: {len(rows):,} Creek Segments")
    report.check(len(network["segments"]) == EXPECTED_SEGMENT_COUNT, f"{CREEK_SEGMENT_NETWORK_FILE_NAME}: {len(network['segments']):,} Creek Segments")
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
    geometry_column = next(name for name in table.column_names if name in ("SHAPE", "geometry", "wkb_geometry"))
    import shapely

    geometries = shapely.from_wkb(table.column(geometry_column).to_pylist())
    vertex_counts = shapely.get_num_coordinates(geometries)
    report.check(bool(np.all(vertex_counts == 2)), f"{CREEK_SEGMENTS_LAYER_NAME}: every geometry has 2 vertices")
    return {row["segment_id"]: row for row in rows}


def compare_flowline(
    flowline: FlowlineSeries,
    intervals: HeldIntervalsByLocation,
    end_ms: int,
    segment_rows: dict[str, dict],
    comparison: ArrayComparison,
    problems: list[str],
    junction_ids_used: set[str],
) -> None:
    """Rebuild each segment's values and both junction arrays from the stored intervals."""
    junction_cache: dict[str, np.ndarray] = {}
    for segment in flowline.segments:
        row = segment_rows[segment.segment_id]
        rebuilt_values = intervals.rebuild(segment.segment_id, flowline.timestamps_ms, end_ms, problems)
        comparison.compare(f"{segment.segment_id}.values", rebuilt_values, segment.values)
        for junction_field, source in [
            ("upstream_junction_id", segment.junction_wse_upstream_m),
            ("downstream_junction_id", segment.junction_wse_downstream_m),
        ]:
            identifier = row[junction_field]
            junction_ids_used.add(identifier)
            if identifier not in junction_cache:
                junction_cache[identifier] = intervals.rebuild(identifier, flowline.timestamps_ms, end_ms, problems)
            rebuilt_junction = segment_junction_wse_from_junction_series(segment.values, junction_cache[identifier])
            comparison.compare(f"{segment.segment_id}.{junction_field}", rebuilt_junction, source)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version-folder", default=str(VERSION_FOLDER))
    arguments = parser.parse_args()
    version_folder = Path(arguments.version_folder).resolve()
    started = time.time()
    report = ValidationReport()
    version_json = read_json(version_folder / VERSION_JSON_NAME)
    expected_segment_count = version_json["counts"]["creek_segments"] if version_json.get("trial") else EXPECTED_SEGMENT_COUNT

    for entry in version_json["files"]:
        path = version_folder / entry["path"]
        report.check(path.exists() and sha256_of_file(path) == entry["sha256"], f"sha256 of {entry['path']}")

    network = read_json(version_folder / CREEK_SEGMENT_NETWORK_FILE_NAME)
    with tempfile.TemporaryDirectory(prefix="validate-modeled-wse-") as temporary_folder:
        log("Unzipping the file geodatabase")
        gdb_path = unzip_gdb(version_folder / ARCGIS_UPLOAD_FOLDER_NAME / UPLOAD_GDB_ZIP_NAME, Path(temporary_folder))
        check_field_types(gdb_path, report)
        check_versions_table(gdb_path, version_json, report)
        segment_rows = check_creek_segments(gdb_path, network, report, expected_segment_count)
        tnc_comids = sorted({row["tnc_comid"] for row in segment_rows.values()})

        row_counts = {}
        log(f"Reading {NWM_HOURLY_HELD_INTERVALS_TABLE_NAME}")
        nwm_intervals = HeldIntervalsByLocation(read_table(gdb_path, NWM_HOURLY_HELD_INTERVALS_TABLE_NAME))
        log(f"Reading {CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME}")
        cnf_intervals = HeldIntervalsByLocation(read_table(gdb_path, CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME))
        log(f"Reading {CNF_MONTHLY_VALUES_TABLE_NAME}")
        cnf_values_table = read_table(gdb_path, CNF_MONTHLY_VALUES_TABLE_NAME)
        cnf_values = MonthlyValuesBySegment(cnf_values_table)
        for name in ARCGIS_LAYER_AND_TABLE_NAMES:
            row_counts[name] = layer_info(gdb_path, name)["features"]
        del cnf_values_table

        for label, intervals in [("NWM hourly", nwm_intervals), ("CNF monthly", cnf_intervals)]:
            segment_ids = intervals.location_ids_of_kind("segment")
            report.check(len(segment_ids) == expected_segment_count and segment_ids == set(segment_rows), f"{label} Held WSE Intervals: {len(segment_ids):,} Creek Segments")
            report.check(intervals.inconsistent_kind_or_comid == 0, f"{label}: {intervals.inconsistent_kind_or_comid} locations with mixed location_kind or tnc_comid")
        report.check(len(cnf_values.rows_by_segment) == expected_segment_count, f"{CNF_MONTHLY_VALUES_TABLE_NAME}: {len(cnf_values.rows_by_segment):,} Creek Segments")

        nwm_comparison = ArrayComparison("NWM hourly WY2021–WY2023 from Held WSE Intervals")
        cnf_comparison = ArrayComparison("CNF monthly from Held WSE Intervals")
        cnf_values_comparison = ArrayComparison(f"CNF monthly from {CNF_MONTHLY_VALUES_TABLE_NAME}")
        csv_comparisons = {year: ArrayComparison(f"raw hourly CSV WY{year}") for year in PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS}
        problems: list[str] = []
        nwm_junctions_used: set[str] = set()
        cnf_junctions_used: set[str] = set()
        hourly_by_comid_for_csv: dict[str, FlowlineSeries] = {}

        for index, tnc_comid in enumerate(tnc_comids, start=1):
            hourly = load_national_water_model_hourly(tnc_comid, PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
            compare_flowline(hourly, nwm_intervals, int(hourly.timestamps_ms[-1]) + HOUR_MS, segment_rows, nwm_comparison, problems, nwm_junctions_used)
            hourly_by_comid_for_csv[tnc_comid] = hourly
            monthly = load_california_natural_flows_monthly(tnc_comid)
            compare_flowline(monthly, cnf_intervals, add_one_month_ms(int(monthly.timestamps_ms[-1])), segment_rows, cnf_comparison, problems, cnf_junctions_used)
            for segment in monthly.segments:
                rows = cnf_values.rows_by_segment.get(segment.segment_id)
                if rows is None or not np.array_equal(cnf_values.month_start_ms[rows], monthly.timestamps_ms):
                    problems.append(f"{CNF_MONTHLY_VALUES_TABLE_NAME} {segment.segment_id}: month_start_utc differs")
                    continue
                for key, source in [
                    ("values", segment.values),
                    ("junctionWseUpstreamM", segment.junction_wse_upstream_m),
                    ("junctionWseDownstreamM", segment.junction_wse_downstream_m),
                ]:
                    cnf_values_comparison.compare(f"{segment.segment_id}.{key}", cnf_values.columns[key][rows], source)
            if index % 20 == 0 or index == len(tnc_comids):
                log(f"  compared {index}/{len(tnc_comids)} TNC flowlines")

        for label, intervals, used in [("NWM hourly", nwm_intervals, nwm_junctions_used), ("CNF monthly", cnf_intervals, cnf_junctions_used)]:
            stored = intervals.location_ids_of_kind("junction")
            report.check(stored == used, f"{label}: {len(stored):,} stored junction series, {len(used):,} referenced by Creek Segments, {len(stored ^ used)} differ")
        del nwm_intervals, cnf_intervals, cnf_values

        csv_row_counts = {}
        for water_year in PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS:
            log(f"Reading raw hourly CSV WY{water_year}")
            csv = RawHourlyCsv(version_folder / RAW_HOURLY_VALUES_FOLDER_NAME / raw_hourly_csv_zip_name(water_year), water_year)
            csv_row_counts[f"WY{water_year}"] = csv.row_count
            report.check(len(csv.slice_by_segment) == expected_segment_count and csv.segment_split_into_blocks == 0, f"raw hourly CSV WY{water_year}: {len(csv.slice_by_segment):,} Creek Segments")
            for tnc_comid, hourly in hourly_by_comid_for_csv.items():
                start, end = hourly.water_year_slices[water_year]
                first_segment = hourly.segments[0].segment_id
                expected_times = [
                    f"{text}Z" for text in np.datetime_as_string(hourly.timestamps_ms[start:end].astype("datetime64[ms]"), unit="s")
                ]
                if csv.times_of(first_segment) != expected_times:
                    problems.append(f"raw hourly CSV WY{water_year} {first_segment}: time_utc differs")
                for segment in hourly.segments:
                    csv_start, csv_end = csv.slice_by_segment.get(segment.segment_id, (0, 0))
                    for key, source in [
                        ("values", segment.values),
                        ("junctionWseUpstreamM", segment.junction_wse_upstream_m),
                        ("junctionWseDownstreamM", segment.junction_wse_downstream_m),
                    ]:
                        csv_comparisons[water_year].compare(f"{segment.segment_id}.{key}", csv.columns[key][csv_start:csv_end], source[start:end])
            del csv

        for comparison in [nwm_comparison, cnf_comparison, cnf_values_comparison, *csv_comparisons.values()]:
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
    for comparison in [nwm_comparison, cnf_comparison, cnf_values_comparison, *csv_comparisons.values()]:
        print(f"  {comparison.summary()}")
    junction_identity = version_json["junction_identity"]
    for dataset_id in ["national-water-model-hourly", "california-natural-flows-monthly"]:
        counts = junction_identity[dataset_id]
        print(
            f"  junction identity {dataset_id}: {counts['junctions']:,} junctions, {counts['shared_by_two_segments']:,} shared, "
            f"{counts['identical_series']:,} identical, {counts['identical_where_both_present']} identical where both non-null"
        )
    print(f"Checks: {len(report.checks)} passed, {len(report.failures)} failed ({time.time() - started:.0f} s)")
    for failure in report.failures:
        print(f"  FAIL {failure}")
    sys.exit(1 if report.failures else 0)


if __name__ == "__main__":
    main()
