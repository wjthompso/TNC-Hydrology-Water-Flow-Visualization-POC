"""Load the Stage 3 m2 Time Series of one TNC flowline as numpy arrays.

Shared by the m2 freeze and validate scripts so both read the source JSON the same way. The m2
file shape is m1's plus per-segment scalars and two depth arrays (see
modeled-wse-derivation-methods/m2-multi-section-manning-depth/multi-section-time-series-file.ts).
National Water Model hourly water years are merged into one continuous series.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from modeled_wse_m2_version_layout import (
    HOUR_MS,
    NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
    CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID,
    SEGMENT_NETWORK_VERSION,
    california_natural_flows_monthly_path,
    national_water_model_hourly_path,
    read_json,
)
from modeled_wse_version_layout import json_values_to_float_array

ARRAY_KEYS = [
    "values",
    "junctionDepthUpstreamM",
    "junctionDepthDownstreamM",
    "junctionWseUpstreamM",
    "junctionWseDownstreamM",
]
SCALAR_KEYS = ["anchorBedElevationM", "junctionBedUpstreamM", "junctionBedDownstreamM"]


@dataclass
class DepthSegmentSeries:
    segment_id: str
    values: np.ndarray  # anchor WSE, m NAVD88
    junction_depth_upstream_m: np.ndarray
    junction_depth_downstream_m: np.ndarray
    junction_wse_upstream_m: np.ndarray
    junction_wse_downstream_m: np.ndarray
    anchor_bed_elevation_m: float
    junction_bed_upstream_m: float
    junction_bed_downstream_m: float


@dataclass
class DepthFlowlineSeries:
    tnc_comid: str
    timestamps_ms: np.ndarray
    segments: list[DepthSegmentSeries]
    # Water year → (first index, end index) into timestamps_ms; hourly only.
    water_year_slices: dict[int, tuple[int, int]]


def _segment_series_from_json(segment: dict) -> DepthSegmentSeries:
    missing = [key for key in [*ARRAY_KEYS, *SCALAR_KEYS] if key not in segment]
    if missing:
        raise ValueError(f"{segment['segmentId']} is not an m2 Time Series segment; missing {missing}")
    for key in SCALAR_KEYS:
        if not isinstance(segment[key], (int, float)):
            raise ValueError(f"{segment['segmentId']} {key} is {segment[key]!r}, expected a number")
    return DepthSegmentSeries(
        segment_id=segment["segmentId"],
        values=json_values_to_float_array(segment["values"]),
        junction_depth_upstream_m=json_values_to_float_array(segment["junctionDepthUpstreamM"]),
        junction_depth_downstream_m=json_values_to_float_array(segment["junctionDepthDownstreamM"]),
        junction_wse_upstream_m=json_values_to_float_array(segment["junctionWseUpstreamM"]),
        junction_wse_downstream_m=json_values_to_float_array(segment["junctionWseDownstreamM"]),
        anchor_bed_elevation_m=float(segment["anchorBedElevationM"]),
        junction_bed_upstream_m=float(segment["junctionBedUpstreamM"]),
        junction_bed_downstream_m=float(segment["junctionBedDownstreamM"]),
    )


def _check_file_header(file_json: dict, expected_dataset_id: str, path) -> None:
    if file_json["segmentNetworkVersion"] != SEGMENT_NETWORK_VERSION:
        raise ValueError(f"{path}: segmentNetworkVersion {file_json['segmentNetworkVersion']} != {SEGMENT_NETWORK_VERSION}")
    if file_json["datasetId"] != expected_dataset_id:
        raise ValueError(f"{path}: datasetId {file_json['datasetId']} != {expected_dataset_id}")
    step_count = len(file_json["timestampsUtcMs"])
    for segment in file_json["segments"]:
        for key in ARRAY_KEYS:
            if len(segment[key]) != step_count:
                raise ValueError(f"{path}: {segment['segmentId']} {key} has {len(segment[key])} values, expected {step_count}")


def _check_scalars_equal(first: DepthSegmentSeries, later: DepthSegmentSeries, path) -> None:
    for name in ("anchor_bed_elevation_m", "junction_bed_upstream_m", "junction_bed_downstream_m"):
        if getattr(first, name) != getattr(later, name):
            raise ValueError(f"{path}: {first.segment_id} {name} differs between water years")


def load_national_water_model_hourly(tnc_comid: str, water_years: list[int]) -> DepthFlowlineSeries:
    """Merge WY files into one hourly series; checks hourly continuity, segment order, and static scalars."""
    timestamp_parts: list[np.ndarray] = []
    segment_parts: dict[str, list[DepthSegmentSeries]] = {}
    segment_order: list[str] | None = None
    water_year_slices: dict[int, tuple[int, int]] = {}
    step_offset = 0
    for water_year in water_years:
        path = national_water_model_hourly_path(tnc_comid, water_year)
        file_json = read_json(path)
        _check_file_header(file_json, NATIONAL_WATER_MODEL_HOURLY_DATASET_ID, path)
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
            series = _segment_series_from_json(segment)
            parts = segment_parts.setdefault(series.segment_id, [])
            if parts:
                _check_scalars_equal(parts[0], series, path)
            parts.append(series)
        timestamp_parts.append(timestamps_ms)
        water_year_slices[water_year] = (step_offset, step_offset + len(timestamps_ms))
        step_offset += len(timestamps_ms)
    segments = []
    for segment_id in segment_order or []:
        parts = segment_parts[segment_id]
        segments.append(
            DepthSegmentSeries(
                segment_id=segment_id,
                values=np.concatenate([part.values for part in parts]),
                junction_depth_upstream_m=np.concatenate([part.junction_depth_upstream_m for part in parts]),
                junction_depth_downstream_m=np.concatenate([part.junction_depth_downstream_m for part in parts]),
                junction_wse_upstream_m=np.concatenate([part.junction_wse_upstream_m for part in parts]),
                junction_wse_downstream_m=np.concatenate([part.junction_wse_downstream_m for part in parts]),
                anchor_bed_elevation_m=parts[0].anchor_bed_elevation_m,
                junction_bed_upstream_m=parts[0].junction_bed_upstream_m,
                junction_bed_downstream_m=parts[0].junction_bed_downstream_m,
            )
        )
    return DepthFlowlineSeries(tnc_comid, np.concatenate(timestamp_parts), segments, water_year_slices)


def load_california_natural_flows_monthly(tnc_comid: str) -> DepthFlowlineSeries:
    path = california_natural_flows_monthly_path(tnc_comid)
    file_json = read_json(path)
    _check_file_header(file_json, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID, path)
    timestamps_ms = np.array(file_json["timestampsUtcMs"], dtype=np.int64)
    segments = [_segment_series_from_json(segment) for segment in file_json["segments"]]
    return DepthFlowlineSeries(tnc_comid, timestamps_ms, segments, {})
