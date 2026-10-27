"""Validate a frozen depth-style modeled WSE version (freeze_modeled_wse_depth_version.py) by reading it back.

Reads the file geodatabase from arcgis-upload/ (unzipped to a temporary folder) and the raw hourly CSV
zips, never the in-memory freeze, and compares them with the Stage 3 (and anchor-source) files named in
version.json. Expected counts come from version.json and the Stage 3 manifest, not constants.

- every National Water Model hourly WY2021–WY2023 `values`, `junctionDepthUpstreamM`, and
  `junctionDepthDownstreamM` array, rebuilt from Held WSE Intervals, matches exactly (nulls as nulls);
  neighbouring intervals never hold three equal values;
- the same for every California Natural Flows monthly array, from Held WSE Intervals and from the
  cnf_monthly_values table; the raw hourly CSV zips match the same arrays;
- where Stage 3 stores junction WSE (m2), junction bed + junction depth, rounded to 3 decimals, rebuilds it;
- Creek Segments layer: network columns, anchor point equal to its source (Stage 1 section or channel
  ribbon), beds equal to the Time Series scalars, channel-ribbon station columns, null_values_note, and a
  Creek Segment whose values are all null is null in every table;
- field types: dates are Date fields, text widths, EPSG:4326.

Exits nonzero on any failure.

    npm run data-products:validate-modeled-wse-version -- --method m4-flowline-profile-variable-power-depth --version m4-v1
    npm run data-products:validate-modeled-wse-version -- --version-folder=<trial folder>
"""

from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import shapely

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_version_identity import MODELED_WSE, DataProductVersionIdentity  # noqa: E402
from data_product_versions import REPOSITORY_ROOT, sha256_of_file  # noqa: E402
from file_geodatabase_tables import GDAL_WIDTH_METADATA_KEY, layer_info, layer_names, read_table, unzip_gdb  # noqa: E402
from freeze_modeled_wse_depth_version import (  # noqa: E402
    CHANNEL_RIBBON,
    CHANNEL_RIBBON_FIELDS,
    added_creek_segment_fields,
    anchor_point_source,
    read_stage_3_method_record,
)
from modeled_wse_depth_source_series import DepthFlowlineSeries, DepthTimeSeriesFolder  # noqa: E402
from modeled_wse_m2_version_layout import HELD_INTERVAL_FIELDS, junction_wse_from_bed_and_depth  # noqa: E402
from modeled_wse_version_layout import (  # noqa: E402
    ARCGIS_UPLOAD_FOLDER_NAME,
    CREEK_SEGMENT_NETWORK_FILE_NAME,
    HOUR_MS,
    PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS,
    RAW_HOURLY_VALUES_FOLDER_NAME,
    VERSION_JSON_NAME,
    add_one_month_ms,
    junction_id,
    raw_hourly_csv_zip_name,
    read_json,
    upstream_and_downstream_vertex_index,
)
from validate_modeled_wse_m2_version import (  # noqa: E402
    HeldIntervalsBySegment,
    MonthlyValuesBySegment,
    RawHourlyCsv,
    check_versions_table,
    depth_null_pattern_mismatches,
    time_varying_arrays,
)
from validate_modeled_wse_version import ArrayComparison, ValidationReport, log  # noqa: E402

ANCHOR_COORDINATE_TOLERANCE_DEGREES = 1e-9
ANCHOR_MAXIMUM_DISTANCE_FROM_SEGMENT_DEGREES = 0.0005  # about 50 m; the anchor search reaches 30 m from the flowline
SPOT_CHECK_SEGMENT_IDS = ["27714697-043", "27714697-044", "27714697-045"]
SPOT_CHECK_TIMESTAMP_MS = 1675209600000  # 2023-02-01T00:00:00Z


class TableNames:
    def __init__(self, version_json: dict) -> None:
        prefix = version_json["arcgis_prefix"]
        self.versions = version_json["arcgis_table_names"][0]
        self.creek_segments = f"{prefix}_creek_segments"
        self.nwm_intervals = f"{prefix}_nwm_hourly_held_intervals"
        self.cnf_intervals = f"{prefix}_cnf_monthly_held_intervals"
        self.cnf_values = f"{prefix}_cnf_monthly_values"
        self.all = version_json["arcgis_table_names"]


def check_field_types(gdb_path: Path, tables: TableNames, added_fields: list[str], report: ValidationReport) -> None:
    names = layer_names(gdb_path)
    report.check(sorted(names) == sorted(tables.all), f"layers and tables: {sorted(names)}")
    date_fields = {
        tables.versions: ["method_date_utc", "generated_at_utc", "published_at_utc"],
        tables.nwm_intervals: ["valid_from_utc", "valid_until_utc"],
        tables.cnf_intervals: ["valid_from_utc", "valid_until_utc"],
        tables.cnf_values: ["month_start_utc"],
    }
    for table_name, fields in date_fields.items():
        dtypes = dict(zip(*[layer_info(gdb_path, table_name)[key] for key in ("fields", "dtypes")]))
        for field in fields:
            report.check(str(dtypes.get(field, "")).startswith("datetime64"), f"{table_name}.{field} is a Date field ({dtypes.get(field)})")
    for table_name in (tables.nwm_intervals, tables.cnf_intervals):
        info = layer_info(gdb_path, table_name)
        report.check(list(info["fields"]) == HELD_INTERVAL_FIELDS, f"{table_name} fields {list(info['fields'])}")
    segments_info = layer_info(gdb_path, tables.creek_segments)
    report.check(segments_info["crs"] == "EPSG:4326", f"{tables.creek_segments} CRS {segments_info['crs']}")
    report.check("LineString" in str(segments_info["geometry_type"]), f"{tables.creek_segments} geometry {segments_info['geometry_type']}")
    report.check(
        list(segments_info["fields"][-len(added_fields) :]) == added_fields, f"{tables.creek_segments} ends with {added_fields}"
    )
    dtypes = dict(zip(segments_info["fields"], segments_info["dtypes"]))
    report.check(
        all(dtypes.get(name) == "float64" for name in added_fields[:5]),
        f"{tables.creek_segments} anchor point and bed columns are Double",
    )
    for table_name, field, width in [
        (tables.versions, "derivation_json", 32000),
        (tables.creek_segments, "segment_id", 16),
        (tables.nwm_intervals, "segment_id", 16),
        (tables.cnf_intervals, "segment_id", 16),
        (tables.cnf_values, "segment_id", 16),
    ]:
        schema_field = read_table(gdb_path, table_name, max_features=1).schema.field(field)
        stored_width = (schema_field.metadata or {}).get(GDAL_WIDTH_METADATA_KEY.encode(), b"").decode()
        report.check(stored_width == str(width), f"{table_name}.{field} text width {stored_width} == {width}")


def check_creek_segments(
    gdb_path: Path,
    tables: TableNames,
    network: dict,
    version_json: dict,
    anchor_source: dict,
    source_static_beds: dict[str, tuple[float, float, float]],
    report: ValidationReport,
) -> dict[str, dict]:
    table = read_table(gdb_path, tables.creek_segments)
    geometry_column = next(name for name in table.column_names if name in ("SHAPE", "geometry", "wkb_geometry"))
    rows = table.drop_columns([geometry_column]).to_pylist()
    expected_count = version_json["counts"]["creek_segments"]
    report.check(len(rows) == expected_count, f"{tables.creek_segments}: {len(rows):,} Creek Segments (expected {expected_count:,})")
    network_by_id = {segment["segmentId"]: segment for segment in network["segments"]}
    network_mismatches = 0
    for row in rows:
        segment = network_by_id.get(row["segment_id"])
        if segment is None:
            network_mismatches += 1
            continue
        upstream_vertex, downstream_vertex = upstream_and_downstream_vertex_index(segment)
        expected = {
            "tnc_comid": segment["tncComid"],
            "flow_direction": segment["flowDirection"],
            "upstream_segment_id": segment["upstreamSegmentId"],
            "downstream_segment_id": segment["downstreamSegmentId"],
            "upstream_junction_id": junction_id(segment["tncComid"], upstream_vertex),
            "downstream_junction_id": junction_id(segment["tncComid"], downstream_vertex),
        }
        if any(row[key] != value for key, value in expected.items()):
            network_mismatches += 1
    report.check(network_mismatches == 0, f"{tables.creek_segments}: {network_mismatches} rows differ from the network export")
    geometries = shapely.from_wkb(table.column(geometry_column).to_pylist())

    points = anchor_source["points"]
    point_mismatches, too_far, bed_mismatches, ribbon_mismatches = [], [], [], []
    for row, geometry in zip(rows, geometries):
        segment_id = row["segment_id"]
        point = points.get(segment_id)
        if point is None:
            if row["anchor_longitude"] is not None or row["anchor_latitude"] is not None:
                point_mismatches.append(segment_id)
        else:
            if (
                row["anchor_longitude"] is None
                or abs(row["anchor_longitude"] - point["anchor_longitude"]) > ANCHOR_COORDINATE_TOLERANCE_DEGREES
                or abs(row["anchor_latitude"] - point["anchor_latitude"]) > ANCHOR_COORDINATE_TOLERANCE_DEGREES
            ):
                point_mismatches.append(segment_id)
            elif shapely.distance(shapely.Point(row["anchor_longitude"], row["anchor_latitude"]), geometry) > ANCHOR_MAXIMUM_DISTANCE_FROM_SEGMENT_DEGREES:
                too_far.append(segment_id)
            if anchor_source["kind"] == CHANNEL_RIBBON and any(row[name] != point[name] for name in CHANNEL_RIBBON_FIELDS):
                ribbon_mismatches.append(segment_id)
        stored_beds = (row["anchor_bed_elevation_m"], row["junction_bed_upstream_m"], row["junction_bed_downstream_m"])
        if tuple(stored_beds) != source_static_beds.get(segment_id):
            bed_mismatches.append(segment_id)
    report.check(not point_mismatches, f"anchor_longitude / anchor_latitude equal the {anchor_source['kind']} source ({len(point_mismatches)} differ: {point_mismatches[:5]})")
    report.check(not too_far, f"every anchor point lies within {ANCHOR_MAXIMUM_DISTANCE_FROM_SEGMENT_DEGREES}° of its Creek Segment ({len(too_far)} do not: {too_far[:5]})")
    report.check(not bed_mismatches, f"anchor and junction bed columns equal the Time Series scalars ({len(bed_mismatches)} differ: {bed_mismatches[:5]})")
    if anchor_source["kind"] == CHANNEL_RIBBON:
        report.check(not ribbon_mismatches, f"{CHANNEL_RIBBON_FIELDS} equal channelRibbon ({len(ribbon_mismatches)} differ: {ribbon_mismatches[:5]})")
    without_point = sum(row["anchor_longitude"] is None for row in rows)
    report.check(
        without_point == len(version_json["anchor_bed_cross_check"]["segments_without_anchor_point"]),
        f"{without_point} Creek Segments without an anchor point, as version.json records",
    )
    return {row["segment_id"]: row for row in rows}


def compare_flowline(
    flowline: DepthFlowlineSeries,
    intervals: HeldIntervalsBySegment,
    end_ms: int,
    segment_rows: dict[str, dict],
    comparison: ArrayComparison,
    junction_wse_comparison: ArrayComparison,
    all_null_problems: list[str],
    problems: list[str],
) -> None:
    """Rebuild each segment's three time-varying arrays (and, where Stage 3 stores it, its junction WSE) from the intervals."""
    for segment in flowline.segments:
        row = segment_rows[segment.segment_id]
        rebuilt = intervals.rebuild(segment.segment_id, flowline.timestamps_ms, end_ms, problems)
        for source_name, source in time_varying_arrays(segment).items():
            comparison.compare(f"{segment.segment_id}.{source_name}", rebuilt[source_name], source)
        if np.all(np.isnan(segment.values)) and not all(np.all(np.isnan(values)) for values in rebuilt.values()):
            all_null_problems.append(segment.segment_id)
        if segment.junction_wse_upstream_m is None:
            continue
        for bed_field, depth_name, source in [
            ("junction_bed_upstream_m", "junctionDepthUpstreamM", segment.junction_wse_upstream_m),
            ("junction_bed_downstream_m", "junctionDepthDownstreamM", segment.junction_wse_downstream_m),
        ]:
            junction_wse_comparison.compare(
                f"{segment.segment_id}.{depth_name}→junctionWse", junction_wse_from_bed_and_depth(row[bed_field], rebuilt[depth_name]), source
            )


def default_version_folder(method_id: str, version_label: str) -> Path:
    return DataProductVersionIdentity(MODELED_WSE, method_id, version_label).version_folder


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--method", help="Stage 3 method id; with --version names the frozen folder.")
    parser.add_argument("--version", help="Version label, for example m4-v1.")
    parser.add_argument("--version-folder", help="A frozen or trial version folder (instead of --method and --version).")
    arguments = parser.parse_args()
    if arguments.version_folder:
        version_folder = Path(arguments.version_folder).resolve()
    elif arguments.method and arguments.version:
        version_folder = default_version_folder(arguments.method, arguments.version)
    else:
        parser.error("Give --method and --version, or --version-folder.")
    started = time.time()
    report = ValidationReport()
    version_json = read_json(version_folder / VERSION_JSON_NAME)
    identity = DataProductVersionIdentity(MODELED_WSE, version_json["method_id"], version_json["version_label"])
    tables = TableNames(version_json)
    stage_3_folder = REPOSITORY_ROOT / version_json["stage_3_folder"]
    stage_3_manifest = read_json(stage_3_folder / "manifest.json")
    method = read_stage_3_method_record(stage_3_manifest, identity)
    report.check(method["methodSha256"] == version_json["method_sha256"], "Stage 3 method fingerprint equals version.json")
    anchor_source = anchor_point_source(stage_3_manifest, method, identity)
    report.check(anchor_source["kind"] == version_json["anchor_point_source"]["kind"], f"anchor point source is {anchor_source['kind']}")
    added_fields = added_creek_segment_fields(anchor_source)
    time_series = DepthTimeSeriesFolder(stage_3_folder / "time-series")
    expected_segment_count = version_json["counts"]["creek_segments"]

    for entry in version_json["files"]:
        path = version_folder / entry["path"]
        report.check(path.exists() and sha256_of_file(path) == entry["sha256"], f"sha256 of {entry['path']}")
    network = read_json(version_folder / CREEK_SEGMENT_NETWORK_FILE_NAME)
    if not version_json.get("trial"):
        report.check(
            len(network["segments"]) == expected_segment_count == stage_3_manifest["counts"]["creekSegments"],
            f"Creek Segments: network {len(network['segments']):,}, version.json {expected_segment_count:,}, "
            f"Stage 3 manifest {stage_3_manifest['counts']['creekSegments']:,}",
        )

    with tempfile.TemporaryDirectory(prefix=f"validate-{MODELED_WSE}-{identity.version_label}-") as temporary_folder:
        log("Unzipping the file geodatabase")
        gdb_path = unzip_gdb(version_folder / ARCGIS_UPLOAD_FOLDER_NAME / identity.upload_zip_name, Path(temporary_folder))
        check_field_types(gdb_path, tables, added_fields, report)
        check_versions_table(gdb_path, version_json, report)

        segment_ids = read_table(gdb_path, tables.creek_segments).column("segment_id").to_pylist()
        tnc_comids = sorted({segment_id.split("-")[0] for segment_id in segment_ids})
        log(f"Reading the Stage 3 monthly series and static beds of {len(tnc_comids)} TNC flowlines")
        monthly_by_comid = {tnc_comid: time_series.load_california_natural_flows_monthly(tnc_comid) for tnc_comid in tnc_comids}
        source_static_beds = {
            segment.segment_id: (segment.anchor_bed_elevation_m, segment.junction_bed_upstream_m, segment.junction_bed_downstream_m)
            for monthly in monthly_by_comid.values()
            for segment in monthly.segments
        }
        segment_rows = check_creek_segments(gdb_path, tables, network, version_json, anchor_source, source_static_beds, report)
        notes_present = sum(row["null_values_note"] is not None for row in segment_rows.values())
        report.check(
            notes_present == version_json["null_values"]["segments_with_note"],
            f"{notes_present} Creek Segments carry a null_values_note (version.json: {version_json['null_values']['segments_with_note']})",
        )

        log(f"Reading {tables.nwm_intervals}, {tables.cnf_intervals}, {tables.cnf_values}")
        nwm_intervals = HeldIntervalsBySegment(read_table(gdb_path, tables.nwm_intervals))
        cnf_intervals = HeldIntervalsBySegment(read_table(gdb_path, tables.cnf_intervals))
        cnf_values = MonthlyValuesBySegment(read_table(gdb_path, tables.cnf_values))
        row_counts = {name: layer_info(gdb_path, name)["features"] for name in tables.all}
        report.check(row_counts == version_json["counts"]["arcgis_rows"], f"row counts equal version.json: {row_counts}")
        for label, intervals in [("NWM hourly", nwm_intervals), ("CNF monthly", cnf_intervals)]:
            report.check(
                len(intervals.rows_by_segment) == expected_segment_count and set(intervals.rows_by_segment) == set(segment_rows),
                f"{label} Held WSE Intervals: {len(intervals.rows_by_segment):,} Creek Segments",
            )
            report.check(intervals.inconsistent_comid == 0, f"{label}: {intervals.inconsistent_comid} segments with mixed tnc_comid")
        report.check(len(cnf_values.rows_by_segment) == expected_segment_count, f"{tables.cnf_values}: {len(cnf_values.rows_by_segment):,} Creek Segments")

        nwm_comparison = ArrayComparison("NWM hourly WY2021–WY2023 from Held WSE Intervals (wse, junction depths)")
        cnf_comparison = ArrayComparison("CNF monthly from Held WSE Intervals (wse, junction depths)")
        cnf_values_comparison = ArrayComparison(f"CNF monthly from {tables.cnf_values}")
        nwm_junction_wse = ArrayComparison("NWM hourly junction WSE rebuilt as junction bed + depth (m2 family only)")
        cnf_junction_wse = ArrayComparison("CNF monthly junction WSE rebuilt as junction bed + depth (m2 family only)")
        csv_comparisons = {year: ArrayComparison(f"raw hourly CSV WY{year}") for year in PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS}
        problems: list[str] = []
        all_null_problems: list[str] = []
        null_pattern_mismatched_segments = 0
        hourly_by_comid: dict[str, DepthFlowlineSeries] = {}
        for index, tnc_comid in enumerate(tnc_comids, start=1):
            hourly = time_series.load_national_water_model_hourly(tnc_comid, PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS)
            compare_flowline(
                hourly, nwm_intervals, int(hourly.timestamps_ms[-1]) + HOUR_MS, segment_rows, nwm_comparison, nwm_junction_wse,
                all_null_problems, problems,
            )  # fmt: skip
            null_pattern_mismatched_segments += depth_null_pattern_mismatches(hourly)
            hourly_by_comid[tnc_comid] = hourly
            monthly = monthly_by_comid[tnc_comid]
            compare_flowline(
                monthly, cnf_intervals, add_one_month_ms(int(monthly.timestamps_ms[-1])), segment_rows, cnf_comparison, cnf_junction_wse,
                all_null_problems, problems,
            )  # fmt: skip
            null_pattern_mismatched_segments += depth_null_pattern_mismatches(monthly)
            for segment in monthly.segments:
                rows = cnf_values.rows_by_segment.get(segment.segment_id)
                if rows is None or not np.array_equal(cnf_values.month_start_ms[rows], monthly.timestamps_ms):
                    problems.append(f"{tables.cnf_values} {segment.segment_id}: month_start_utc differs")
                    continue
                for source_name, source in time_varying_arrays(segment).items():
                    cnf_values_comparison.compare(f"{segment.segment_id}.{source_name}", cnf_values.columns[source_name][rows], source)
            if index % 20 == 0 or index == len(tnc_comids):
                log(f"  compared {index}/{len(tnc_comids)} TNC flowlines")
        report.check(null_pattern_mismatched_segments == 0, f"{null_pattern_mismatched_segments} Time Series segments with junction depths null at different steps than the value")
        report.check(not all_null_problems, f"Creek Segments whose source values are all null are null in every column ({len(all_null_problems)} are not)")

        print("Spot check (rebuilt from Held WSE Intervals at 2023-02-01T00:00Z, compared with the Stage 3 source):")
        for segment_id in SPOT_CHECK_SEGMENT_IDS:
            flowline = hourly_by_comid.get(segment_id.split("-")[0])
            segment = next((s for s in flowline.segments if s.segment_id == segment_id), None) if flowline else None
            if segment is None:
                continue
            step = int(np.flatnonzero(flowline.timestamps_ms == SPOT_CHECK_TIMESTAMP_MS)[0])
            rebuilt = nwm_intervals.rebuild(segment_id, flowline.timestamps_ms, int(flowline.timestamps_ms[-1]) + HOUR_MS, [])
            print(
                f"  {segment_id}: wse {rebuilt['values'][step]} (source {segment.values[step]}), anchor bed {segment.anchor_bed_elevation_m}, "
                f"depth up {rebuilt['junctionDepthUpstreamM'][step]}, depth down {rebuilt['junctionDepthDownstreamM'][step]}"
            )
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
            for hourly in hourly_by_comid.values():
                start, end = hourly.water_year_slices[water_year]
                expected_times = [f"{text}Z" for text in np.datetime_as_string(hourly.timestamps_ms[start:end].astype("datetime64[ms]"), unit="s")]
                if csv.times_of(hourly.segments[0].segment_id) != expected_times:
                    problems.append(f"raw hourly CSV WY{water_year} {hourly.segments[0].segment_id}: time_utc differs")
                for segment in hourly.segments:
                    csv_start, csv_end = csv.slice_by_segment.get(segment.segment_id, (0, 0))
                    for source_name, source in time_varying_arrays(segment).items():
                        csv_comparisons[water_year].compare(f"{segment.segment_id}.{source_name}", csv.columns[source_name][csv_start:csv_end], source[start:end])
            del csv
        report.check(csv_row_counts == version_json["counts"]["raw_hourly_csv_rows"], f"raw hourly CSV rows equal version.json: {csv_row_counts}")

        all_comparisons = [nwm_comparison, cnf_comparison, cnf_values_comparison, *csv_comparisons.values()]
        if method["parameters"].get("solvedSections"):
            all_comparisons += [nwm_junction_wse, cnf_junction_wse]
        for comparison in all_comparisons:
            comparison.report_into(report)
        report.check(not problems, f"{len(problems)} Held WSE Interval structure problems" + "".join(f"; {p}" for p in problems[:5]))

    print()
    print(f"Modeled WSE {identity.version_label} validation ({version_folder})")
    print("Row counts (read back from the file geodatabase):")
    for name, count in row_counts.items():
        print(f"  {name:<52} {count:>12,}")
    for name, count in csv_row_counts.items():
        print(f"  raw hourly CSV {name:<37} {count:>12,}")
    print("Round trips:")
    for comparison in all_comparisons:
        print(f"  {comparison.summary()}")
    print(f"Checks: {len(report.checks)} passed, {len(report.failures)} failed ({time.time() - started:.0f} s)")
    for failure in report.failures:
        print(f"  FAIL {failure}")
    sys.exit(1 if report.failures else 0)


if __name__ == "__main__":
    main()
