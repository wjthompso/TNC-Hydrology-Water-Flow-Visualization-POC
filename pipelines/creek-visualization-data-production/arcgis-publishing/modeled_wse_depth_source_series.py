"""Load the Stage 3 Time Series of one TNC flowline for any depth-style Modeled WSE Derivation Method.

m2 through m5 store, per Creek Segment, the anchor WSE (`values`), the water depth at both junctions,
and three static beds (anchor, upstream junction, downstream junction). m2 also stores the junction WSE
arrays; m3, m4, and m5 do not (junction WSE = junction bed + junction depth is the browser's rule there
too, but nothing to compare it with is saved). This reader takes the Stage 3 version folder as an
argument, unlike modeled_wse_m2_source_series.py, which is fixed to m2 v1 and stays untouched.

The returned objects have the attribute names the m2 accumulators and validators read, so those
classes are reused as they are.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from modeled_wse_version_layout import (
    CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID,
    HOUR_MS,
    NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
    SEGMENT_NETWORK_VERSION,
    json_values_to_float_array,
    read_json,
)

REQUIRED_ARRAY_KEYS = ["values", "junctionDepthUpstreamM", "junctionDepthDownstreamM"]
OPTIONAL_JUNCTION_WSE_KEYS = ["junctionWseUpstreamM", "junctionWseDownstreamM"]
SCALAR_KEYS = ["anchorBedElevationM", "junctionBedUpstreamM", "junctionBedDownstreamM"]


@dataclass
class DepthSegmentSeries:
    segment_id: str
    values: np.ndarray  # anchor WSE, m NAVD88
    junction_depth_upstream_m: np.ndarray
    junction_depth_downstream_m: np.ndarray
    junction_wse_upstream_m: np.ndarray | None  # m2 only
    junction_wse_downstream_m: np.ndarray | None
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


class DepthTimeSeriesFolder:
    """The `time-series/` folder of one Stage 3 version, for example 03-time-series/m4-…/v1/time-series."""

    def __init__(self, time_series_folder: Path) -> None:
        self.folder = time_series_folder

    def national_water_model_hourly_path(self, tnc_comid: str, water_year: int) -> Path:
        return self.folder / NATIONAL_WATER_MODEL_HOURLY_DATASET_ID / "water-surface-elevation" / tnc_comid / f"WY{water_year}.json"

    def california_natural_flows_monthly_path(self, tnc_comid: str) -> Path:
        return self.folder / CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID / "water-surface-elevation" / f"{tnc_comid}.json"

    def load_national_water_model_hourly(self, tnc_comid: str, water_years: list[int]) -> DepthFlowlineSeries:
        """Merge WY files into one hourly series; checks hourly continuity, segment order, and static scalars."""
        timestamp_parts: list[np.ndarray] = []
        segment_parts: dict[str, list[DepthSegmentSeries]] = {}
        segment_order: list[str] | None = None
        water_year_slices: dict[int, tuple[int, int]] = {}
        step_offset = 0
        for water_year in water_years:
            path = self.national_water_model_hourly_path(tnc_comid, water_year)
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
        segments = [_concatenated(segment_parts[segment_id]) for segment_id in segment_order or []]
        return DepthFlowlineSeries(tnc_comid, np.concatenate(timestamp_parts), segments, water_year_slices)

    def load_california_natural_flows_monthly(self, tnc_comid: str) -> DepthFlowlineSeries:
        path = self.california_natural_flows_monthly_path(tnc_comid)
        file_json = read_json(path)
        _check_file_header(file_json, CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID, path)
        timestamps_ms = np.array(file_json["timestampsUtcMs"], dtype=np.int64)
        segments = [_segment_series_from_json(segment) for segment in file_json["segments"]]
        return DepthFlowlineSeries(tnc_comid, timestamps_ms, segments, {})


def _optional_array(segment: dict, key: str) -> np.ndarray | None:
    return json_values_to_float_array(segment[key]) if key in segment else None


def _segment_series_from_json(segment: dict) -> DepthSegmentSeries:
    missing = [key for key in [*REQUIRED_ARRAY_KEYS, *SCALAR_KEYS] if key not in segment]
    if missing:
        raise ValueError(f"{segment['segmentId']} is not a depth-style Time Series segment; missing {missing}")
    for key in SCALAR_KEYS:
        if not isinstance(segment[key], (int, float)):
            raise ValueError(f"{segment['segmentId']} {key} is {segment[key]!r}, expected a number")
    return DepthSegmentSeries(
        segment_id=segment["segmentId"],
        values=json_values_to_float_array(segment["values"]),
        junction_depth_upstream_m=json_values_to_float_array(segment["junctionDepthUpstreamM"]),
        junction_depth_downstream_m=json_values_to_float_array(segment["junctionDepthDownstreamM"]),
        junction_wse_upstream_m=_optional_array(segment, "junctionWseUpstreamM"),
        junction_wse_downstream_m=_optional_array(segment, "junctionWseDownstreamM"),
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
        for key in [*REQUIRED_ARRAY_KEYS, *OPTIONAL_JUNCTION_WSE_KEYS]:
            if key in segment and len(segment[key]) != step_count:
                raise ValueError(f"{path}: {segment['segmentId']} {key} has {len(segment[key])} values, expected {step_count}")


def _check_scalars_equal(first: DepthSegmentSeries, later: DepthSegmentSeries, path) -> None:
    for name in ("anchor_bed_elevation_m", "junction_bed_upstream_m", "junction_bed_downstream_m"):
        if getattr(first, name) != getattr(later, name):
            raise ValueError(f"{path}: {first.segment_id} {name} differs between water years")


def _concatenated(parts: list[DepthSegmentSeries]) -> DepthSegmentSeries:
    def joined(name: str) -> np.ndarray | None:
        arrays = [getattr(part, name) for part in parts]
        return None if arrays[0] is None else np.concatenate(arrays)

    return DepthSegmentSeries(
        segment_id=parts[0].segment_id,
        values=joined("values"),
        junction_depth_upstream_m=joined("junction_depth_upstream_m"),
        junction_depth_downstream_m=joined("junction_depth_downstream_m"),
        junction_wse_upstream_m=joined("junction_wse_upstream_m"),
        junction_wse_downstream_m=joined("junction_wse_downstream_m"),
        anchor_bed_elevation_m=parts[0].anchor_bed_elevation_m,
        junction_bed_upstream_m=parts[0].junction_bed_upstream_m,
        junction_bed_downstream_m=parts[0].junction_bed_downstream_m,
    )
