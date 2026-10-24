"""Held WSE Intervals: a Time Series stored as consecutive constant-value rows (UCS-285).

One Held WSE Interval holds one location's water-surface elevation constant from
valid_from_utc until valid_until_utc (exclusive: the next change, or the last
timestamp plus one time step). Null runs are kept as intervals with wse_m null, so
every time step's value can be rebuilt exactly.
"""

from __future__ import annotations

import numpy as np


def held_interval_runs(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Start index and step count of each run of equal values (NaN equals NaN)."""
    if len(values) == 0:
        return np.array([], dtype=np.int64), np.array([], dtype=np.int64)
    is_null = np.isnan(values)
    same_as_previous = (values[1:] == values[:-1]) | (is_null[1:] & is_null[:-1])
    run_starts = np.concatenate([[0], np.flatnonzero(~same_as_previous) + 1])
    run_ends = np.concatenate([run_starts[1:], [len(values)]])
    return run_starts, run_ends - run_starts


def held_intervals_of_series(
    values: np.ndarray, timestamps_ms: np.ndarray, end_timestamp_ms: int
) -> dict[str, np.ndarray]:
    """valid_from_ms, valid_until_ms, wse_m, step_count arrays for one series.

    end_timestamp_ms is the exclusive end of the whole series (last timestamp + one step).
    """
    run_starts, step_counts = held_interval_runs(values)
    valid_from_ms = timestamps_ms[run_starts]
    next_starts = run_starts + step_counts
    valid_until_ms = np.where(
        next_starts < len(timestamps_ms),
        timestamps_ms[np.minimum(next_starts, len(timestamps_ms) - 1)],
        end_timestamp_ms,
    )
    return {
        "valid_from_ms": valid_from_ms.astype(np.int64),
        "valid_until_ms": valid_until_ms.astype(np.int64),
        "wse_m": values[run_starts],
        "step_count": step_counts.astype(np.int32),
    }


def expand_held_intervals(
    valid_from_ms: np.ndarray, wse_m: np.ndarray, step_count: np.ndarray, timestamps_ms: np.ndarray
) -> np.ndarray:
    """Rebuild one value per timestamp from a location's Held WSE Intervals (sorted by valid_from)."""
    order = np.argsort(valid_from_ms, kind="stable")
    rebuilt = np.repeat(wse_m[order], step_count[order])
    if len(rebuilt) != len(timestamps_ms):
        raise ValueError(f"Held WSE Intervals cover {len(rebuilt)} steps, expected {len(timestamps_ms)}")
    starts = np.concatenate([[0], np.cumsum(step_count[order])[:-1]])
    if len(starts) and not np.array_equal(timestamps_ms[starts], valid_from_ms[order]):
        raise ValueError("Held WSE Interval valid_from_utc does not match the series timestamps")
    return rebuilt


# ---------------------------------------------------------------------------
# Several parallel series that change together (modeled WSE m2)
# ---------------------------------------------------------------------------
# m2 stores three time-varying numbers per Creek Segment: the anchor WSE and the water depth at each
# junction. One Held WSE Interval ends when ANY of them changes, so every row holds all three.


def held_interval_runs_of_columns(columns: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """Start index and step count of each run in which every column is unchanged (NaN equals NaN)."""
    step_total = len(columns[0])
    if step_total == 0:
        return np.array([], dtype=np.int64), np.array([], dtype=np.int64)
    same_as_previous = np.ones(step_total - 1, dtype=bool)
    for values in columns:
        is_null = np.isnan(values)
        same_as_previous &= (values[1:] == values[:-1]) | (is_null[1:] & is_null[:-1])
    run_starts = np.concatenate([[0], np.flatnonzero(~same_as_previous) + 1])
    run_ends = np.concatenate([run_starts[1:], [step_total]])
    return run_starts, run_ends - run_starts


def held_intervals_of_columns(
    columns_by_name: dict[str, np.ndarray], timestamps_ms: np.ndarray, end_timestamp_ms: int
) -> dict[str, np.ndarray]:
    """valid_from_ms, valid_until_ms, step_count, and each column's constant value, one entry per interval.

    end_timestamp_ms is the exclusive end of the whole series (last timestamp + one step).
    """
    run_starts, step_counts = held_interval_runs_of_columns(list(columns_by_name.values()))
    next_starts = run_starts + step_counts
    valid_until_ms = np.where(
        next_starts < len(timestamps_ms),
        timestamps_ms[np.minimum(next_starts, len(timestamps_ms) - 1)],
        end_timestamp_ms,
    )
    return {
        "valid_from_ms": timestamps_ms[run_starts].astype(np.int64),
        "valid_until_ms": valid_until_ms.astype(np.int64),
        "step_count": step_counts.astype(np.int32),
        **{name: values[run_starts] for name, values in columns_by_name.items()},
    }


def expand_held_interval_columns(
    valid_from_ms: np.ndarray,
    step_count: np.ndarray,
    columns_by_name: dict[str, np.ndarray],
    timestamps_ms: np.ndarray,
) -> dict[str, np.ndarray]:
    """Rebuild every column at every timestamp from one location's Held WSE Intervals (rows in any order)."""
    order = np.argsort(valid_from_ms, kind="stable")
    sorted_step_count = step_count[order]
    if int(sorted_step_count.sum()) != len(timestamps_ms):
        raise ValueError(f"Held WSE Intervals cover {int(sorted_step_count.sum())} steps, expected {len(timestamps_ms)}")
    starts = np.concatenate([[0], np.cumsum(sorted_step_count)[:-1]])
    if len(starts) and not np.array_equal(timestamps_ms[starts], valid_from_ms[order]):
        raise ValueError("Held WSE Interval valid_from_utc does not match the series timestamps")
    return {name: np.repeat(values[order], sorted_step_count) for name, values in columns_by_name.items()}
