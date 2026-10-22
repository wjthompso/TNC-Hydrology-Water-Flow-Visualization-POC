"""Load the Stage 3 modeled WSE Time Series of one TNC flowline as numpy arrays (UCS-285).

Shared by the freeze and validate scripts so both read the source JSON the same way.
National Water Model hourly water years are merged into one continuous series.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from modeled_wse_version_layout import (
    HOUR_MS,
    SEGMENT_NETWORK_VERSION,
    california_natural_flows_monthly_path,
    json_values_to_float_array,
    national_water_model_hourly_path,
    read_json,
)


@dataclass
class SegmentSeries:
    segment_id: str
    values: np.ndarray
    junction_wse_upstream_m: np.ndarray
    junction_wse_downstream_m: np.ndarray


@dataclass
class FlowlineSeries:
    tnc_comid: str
    timestamps_ms: np.ndarray
    segments: list[SegmentSeries]
    # Water year → (first index, end index) into timestamps_ms; hourly only.
    water_year_slices: dict[int, tuple[int, int]]


def _segment_series_from_json(segment: dict) -> SegmentSeries:
    return SegmentSeries(
        segment_id=segment["segmentId"],
        values=json_values_to_float_array(segment["values"]),
        junction_wse_upstream_m=json_values_to_float_array(segment["junctionWseUpstreamM"]),
        junction_wse_downstream_m=json_values_to_float_array(segment["junctionWseDownstreamM"]),
    )


def _check_file_header(file_json: dict, expected_dataset_id: str, path) -> None:
    if file_json["segmentNetworkVersion"] != SEGMENT_NETWORK_VERSION:
        raise ValueError(f"{path}: segmentNetworkVersion {file_json['segmentNetworkVersion']} != {SEGMENT_NETWORK_VERSION}")
    if file_json["datasetId"] != expected_dataset_id:
        raise ValueError(f"{path}: datasetId {file_json['datasetId']} != {expected_dataset_id}")
    step_count = len(file_json["timestampsUtcMs"])
    for segment in file_json["segments"]:
        for key in ("values", "junctionWseUpstreamM", "junctionWseDownstreamM"):
            if len(segment[key]) != step_count:
                raise ValueError(f"{path}: {segment['segmentId']} {key} has {len(segment[key])} values, expected {step_count}")


def load_national_water_model_hourly(tnc_comid: str, water_years: list[int]) -> FlowlineSeries:
    """Merge WY files into one hourly series; checks hourly continuity and identical segment order."""
    timestamp_parts: list[np.ndarray] = []
    segment_parts: dict[str, list[SegmentSeries]] = {}
    segment_order: list[str] | None = None
    water_year_slices: dict[int, tuple[int, int]] = {}
    step_offset = 0
    for water_year in water_years:
        path = national_water_model_hourly_path(tnc_comid, water_year)
        file_json = read_json(path)
        _check_file_header(file_json, "national-water-model-hourly", path)
        timestamps_ms = np.array(file_json["timestampsUtcMs"], dtype=np.int64)
        if np.any(np.diff(timestamps_ms) != HOUR_MS):
            raise ValueError(f"{path}: timestamps are not continuous hourly steps")
        if timestamp_parts and timestamps_ms[0] != timestamp_parts[-1][-1] + HOUR_MS:
            raise ValueError(f"{path}: WY{water_year} does not start one hour after the previous water year ends")
        order = [segment["segmentId"] for segment in file_json["segments"]]
        if segment_order is None:
            segment_order = order
        elif order != segment_order:
            raise ValueError(f"{path}: segment order differs from the first water year")
        for segment in file_json["segments"]:
            segment_parts.setdefault(segment["segmentId"], []).append(_segment_series_from_json(segment))
        timestamp_parts.append(timestamps_ms)
        water_year_slices[water_year] = (step_offset, step_offset + len(timestamps_ms))
        step_offset += len(timestamps_ms)
    segments = [
        SegmentSeries(
            segment_id=segment_id,
            values=np.concatenate([part.values for part in segment_parts[segment_id]]),
            junction_wse_upstream_m=np.concatenate([part.junction_wse_upstream_m for part in segment_parts[segment_id]]),
            junction_wse_downstream_m=np.concatenate([part.junction_wse_downstream_m for part in segment_parts[segment_id]]),
        )
        for segment_id in segment_order or []
    ]
    return FlowlineSeries(tnc_comid, np.concatenate(timestamp_parts), segments, water_year_slices)


def load_california_natural_flows_monthly(tnc_comid: str) -> FlowlineSeries:
    path = california_natural_flows_monthly_path(tnc_comid)
    file_json = read_json(path)
    _check_file_header(file_json, "california-natural-flows-monthly", path)
    timestamps_ms = np.array(file_json["timestampsUtcMs"], dtype=np.int64)
    segments = [_segment_series_from_json(segment) for segment in file_json["segments"]]
    return FlowlineSeries(tnc_comid, timestamps_ms, segments, {})
