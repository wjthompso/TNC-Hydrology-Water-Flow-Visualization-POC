"""Segment-junction WSE series for Held WSE Intervals (UCS-285).

A segment junction is one TNC flowline vertex. Stage 3 writes the junction WSE on
both Creek Segments that share a vertex (junctionWseUpstreamM / junctionWseDownstreamM),
so the publisher stores each junction's series once.

Identity rule: wherever both segments have a junction value at a time step, they
must be identical. Stage 3 writes null junction WSE where a segment's own value is
null, so at the 6 vertices next to a Drainage-Area Ratio Transfer segment with no
discharge, one side is null for the whole series. The stored junction series takes
the non-null side; each segment's own junction array is rebuilt exactly as
"null where the segment's value is null, else the junction series"
(segment_junction_wse_from_junction_series), and that rebuild is asserted here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from modeled_wse_source_series import FlowlineSeries
from modeled_wse_version_layout import (
    junction_id,
    segment_junction_wse_from_junction_series,
    upstream_and_downstream_vertex_index,
)


class JunctionIdentityError(AssertionError):
    """Two Creek Segments disagree about the WSE at their shared vertex."""


def _same_with_nulls(left: np.ndarray, right: np.ndarray) -> bool:
    return bool(np.all((left == right) | (np.isnan(left) & np.isnan(right))))


@dataclass
class JunctionIdentityCounts:
    junctions: int = 0
    shared_by_two_segments: int = 0
    identical_series: int = 0
    identical_where_both_present: int = 0
    resolved_junction_ids: list[str] = field(default_factory=list)

    def add(self, other: "JunctionIdentityCounts") -> None:
        self.junctions += other.junctions
        self.shared_by_two_segments += other.shared_by_two_segments
        self.identical_series += other.identical_series
        self.identical_where_both_present += other.identical_where_both_present
        self.resolved_junction_ids.extend(other.resolved_junction_ids)


def junction_series_of_flowline(
    flowline: FlowlineSeries, network_segment_by_id: dict[str, dict]
) -> tuple[dict[str, np.ndarray], JunctionIdentityCounts]:
    """{junction id: series} sorted by vertex, plus identity counts. Raises JunctionIdentityError."""
    contributions_by_vertex: dict[int, list[tuple[str, np.ndarray, np.ndarray]]] = {}
    for segment in flowline.segments:
        network_segment = network_segment_by_id[segment.segment_id]
        upstream_vertex, downstream_vertex = upstream_and_downstream_vertex_index(network_segment)
        contributions_by_vertex.setdefault(upstream_vertex, []).append(
            (segment.segment_id, segment.values, segment.junction_wse_upstream_m)
        )
        contributions_by_vertex.setdefault(downstream_vertex, []).append(
            (segment.segment_id, segment.values, segment.junction_wse_downstream_m)
        )

    counts = JunctionIdentityCounts()
    series_by_junction_id: dict[str, np.ndarray] = {}
    for vertex_index in sorted(contributions_by_vertex):
        contributions = contributions_by_vertex[vertex_index]
        identifier = junction_id(flowline.tnc_comid, vertex_index)
        if len(contributions) > 2:
            raise JunctionIdentityError(f"{identifier}: {len(contributions)} segments share one vertex")
        combined = np.full(len(flowline.timestamps_ms), np.nan)
        for segment_id, _, junction_values in contributions:
            both_present = ~np.isnan(combined) & ~np.isnan(junction_values)
            disagreements = np.flatnonzero(both_present & (combined != junction_values))
            if len(disagreements):
                raise JunctionIdentityError(
                    f"{identifier}: {segment_id} disagrees at {len(disagreements)} time steps, "
                    f"first index {disagreements[0]}"
                )
            combined = np.where(np.isnan(combined), junction_values, combined)
        for segment_id, segment_values, junction_values in contributions:
            rebuilt = segment_junction_wse_from_junction_series(segment_values, combined)
            if not _same_with_nulls(rebuilt, junction_values):
                raise JunctionIdentityError(f"{identifier}: {segment_id} junction WSE cannot be rebuilt from the stored series")
        counts.junctions += 1
        if len(contributions) == 2:
            counts.shared_by_two_segments += 1
            if _same_with_nulls(contributions[0][2], contributions[1][2]):
                counts.identical_series += 1
            else:
                counts.identical_where_both_present += 1
                counts.resolved_junction_ids.append(identifier)
        series_by_junction_id[identifier] = combined
    return series_by_junction_id, counts
