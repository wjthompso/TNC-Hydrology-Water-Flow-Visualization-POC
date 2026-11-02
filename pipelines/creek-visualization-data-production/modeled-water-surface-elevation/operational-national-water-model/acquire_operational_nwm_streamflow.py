# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["numpy", "h5py", "fsspec", "aiohttp", "requests"]
# ///
"""Reads hourly streamflow of a few reaches from NOAA's operational National Water Model (NWM)
Analysis and Assimilation run, without downloading whole files.

Each hourly file (~13 MB, netCDF4/HDF5, 2.8 million reaches) is read with HTTP range requests
through fsspec + h5py, touching only `feature_id` and `streamflow` (~2.4 MB per file). The wanted
reaches are looked up in every file's own `feature_id` array; the column order is never assumed.

The cache is one small JSON file per UTC day (`<cache-dir>/YYYYMMDD.json`) holding the raw scaled
integers, so an interrupted run resumes and a rerun downloads nothing it already has. A day is
written only when all of its hours were attempted. Hours that fail after several attempts are
cached as `failed` and retried on the next run; HTTP 404 hours are cached as `not-found` and
retried only while they are recent (a file that is not yet published may appear later).

Called by `stage-00-acquire-operational-national-water-model.ts`; run with `uv run`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

BUCKET_URL = "https://storage.googleapis.com/national-water-model"
CACHE_SCHEMA = 1
MAXIMUM_ATTEMPTS = 4
BACKOFF_SECONDS = 2.0
# A file missing this recently may simply not be published yet, so a rerun asks again.
RETRY_NOT_FOUND_WITHIN_DAYS = 3
EXPECTED_SCALE_FACTOR = 0.01


def hour_url(day: datetime, hour: int) -> str:
    stamp = day.strftime("%Y%m%d")
    return f"{BUCKET_URL}/nwm.{stamp}/analysis_assim/nwm.t{hour:02d}z.analysis_assim.channel_rt.tm00.conus.nc"


def as_text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def read_one_hour(fs, day: datetime, hour: int, comids: list[int]) -> dict:
    """Reads one hourly file once. Raises on any transport or format problem."""
    import h5py
    import numpy as np

    url = hour_url(day, hour)
    with fs.open(url, block_size=1 << 20, cache_type="readahead") as handle:
        with h5py.File(handle, "r") as file:
            attributes = {key: as_text(file.attrs[key]) for key in ("NWM_version_number", "code_version", "model_configuration", "model_output_valid_time") if key in file.attrs}
            expected_valid_time = (day + timedelta(hours=hour)).strftime("%Y-%m-%d_%H:%M:%S")
            if attributes.get("model_output_valid_time") != expected_valid_time:
                raise ValueError(f"file valid time {attributes.get('model_output_valid_time')} is not the requested {expected_valid_time}")
            feature_ids = file["feature_id"][:]
            streamflow = file["streamflow"]
            fill_value = int(streamflow.attrs["_FillValue"][0])
            scale_factor = float(streamflow.attrs["scale_factor"][0])
            add_offset = float(streamflow.attrs["add_offset"][0]) if "add_offset" in streamflow.attrs else 0.0
            unit = as_text(streamflow.attrs.get("units", ""))
            valid_range = [int(value) for value in streamflow.attrs["valid_range"]] if "valid_range" in streamflow.attrs else None
            if abs(scale_factor - EXPECTED_SCALE_FACTOR) > 1e-9 or add_offset != 0.0 or unit.replace(" ", "") != "m3s-1":
                raise ValueError(f"unexpected streamflow encoding: scale_factor={scale_factor}, add_offset={add_offset}, units={unit!r}")
            raw = streamflow[:]
            if raw.shape != feature_ids.shape:
                raise ValueError(f"streamflow shape {raw.shape} differs from feature_id shape {feature_ids.shape}")
            # Column indices are computed per file: the order of feature_id is verified, not assumed.
            positions = np.flatnonzero(np.isin(feature_ids, np.asarray(comids, dtype=feature_ids.dtype)))
            found: dict[int, int] = {}
            for position in positions:
                comid = int(feature_ids[position])
                if comid in found:
                    raise ValueError(f"feature_id {comid} appears more than once")
                found[comid] = int(raw[position])
            values: dict[str, int | None] = {}
            outside_valid_range = 0
            for comid in comids:
                if comid not in found or found[comid] == fill_value:
                    values[str(comid)] = None
                elif valid_range is not None and not (valid_range[0] <= found[comid] <= valid_range[1]):
                    values[str(comid)] = None
                    outside_valid_range += 1
                else:
                    values[str(comid)] = found[comid]
        cache = getattr(handle, "cache", None)
        transferred = int(getattr(cache, "total_requested_bytes", 0) or 0)
        requests_made = int(getattr(cache, "miss_count", 0) or 0) + 1  # +1 for the size lookup
    return {
        "status": "ok",
        "validTimeUtc": attributes.get("model_output_valid_time"),
        "nwmVersion": attributes.get("NWM_version_number"),
        "codeVersion": attributes.get("code_version"),
        "modelConfiguration": attributes.get("model_configuration"),
        "scaleFactor": scale_factor,
        "unit": unit,
        "streamflow": values,
        "absentFeatureIds": [comid for comid in comids if comid not in found],
        "valuesOutsideValidRange": outside_valid_range,
        "bytesTransferred": transferred,
        "requests": requests_made,
    }


def read_hour_with_retries(fs, day: datetime, hour: int, comids: list[int]) -> dict:
    last_error = ""
    for attempt in range(1, MAXIMUM_ATTEMPTS + 1):
        try:
            return read_one_hour(fs, day, hour, comids)
        except FileNotFoundError as error:
            return {"status": "not-found", "error": f"HTTP 404 {error}", "bytesTransferred": 0, "requests": 1}
        except Exception as error:  # noqa: BLE001 - any transport or HDF5 problem is retried the same way
            last_error = f"{type(error).__name__}: {error}"
            if attempt < MAXIMUM_ATTEMPTS:
                time.sleep(BACKOFF_SECONDS * attempt)
    return {"status": "failed", "error": last_error, "bytesTransferred": 0, "requests": MAXIMUM_ATTEMPTS}


def fetch_day(day_iso: str, hours: list[int], comids: list[int]) -> tuple[str, dict[int, dict]]:
    """Worker: reads the listed hours of one UTC day, one after another, through one HTTP client."""
    import fsspec

    day = datetime.fromisoformat(day_iso)
    fs = fsspec.filesystem("http")
    return day_iso, {hour: read_hour_with_retries(fs, day, hour, comids) for hour in hours}


def day_cache_path(cache_dir: Path, day: datetime) -> Path:
    return cache_dir / f"{day.strftime('%Y%m%d')}.json"


def load_day(cache_dir: Path, day: datetime) -> dict:
    path = day_cache_path(cache_dir, day)
    if path.exists():
        try:
            loaded = json.loads(path.read_text())
            if loaded.get("schema") == CACHE_SCHEMA:
                return loaded
        except json.JSONDecodeError:
            pass
    return {"schema": CACHE_SCHEMA, "date": day.strftime("%Y%m%d"), "hours": {}}


def save_day(cache_dir: Path, day: datetime, content: dict) -> None:
    path = day_cache_path(cache_dir, day)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(content, separators=(",", ":")))
    os.replace(temporary, path)


def needs_fetch(entry: dict | None, hour_start: datetime, comids: list[int], now: datetime) -> bool:
    if entry is None:
        return True
    if entry.get("status") == "ok":
        return not set(str(comid) for comid in comids).issubset(entry.get("streamflow", {}).keys())
    if entry.get("status") == "not-found":
        return now - hour_start < timedelta(days=RETRY_NOT_FOUND_WITHIN_DAYS)
    return True  # failed: always try again


def parse_utc(text: str) -> datetime:
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start", required=True, help="First valid hour, UTC ISO 8601, for example 2025-09-01T00:00:00Z")
    parser.add_argument("--end", required=True, help="Last valid hour, inclusive")
    parser.add_argument("--comids", required=True, help="Comma-separated NHDPlusV2 COMIDs (NWM feature_id values)")
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--report-out", required=True, help="Where to write this run's counts as JSON")
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()

    start, end = parse_utc(args.start), parse_utc(args.end)
    for label, value in (("start", start), ("end", end)):
        if value.minute or value.second or value.microsecond:
            parser.error(f"--{label} must be on the hour")
    if end < start:
        parser.error("--end is before --start")
    comids = sorted({int(item) for item in args.comids.split(",") if item.strip()})
    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)

    days: list[datetime] = []
    cursor = start.replace(hour=0)
    while cursor <= end:
        days.append(cursor)
        cursor += timedelta(days=1)

    def hours_of(day: datetime) -> list[int]:
        return [hour for hour in range(24) if start <= day + timedelta(hours=hour) <= end]

    loaded: dict[str, dict] = {}
    pending: dict[str, list[int]] = {}
    hours_in_range = 0
    for day in days:
        content = load_day(cache_dir, day)
        loaded[day.isoformat()] = content
        wanted = hours_of(day)
        hours_in_range += len(wanted)
        todo = [hour for hour in wanted if needs_fetch(content["hours"].get(f"{hour:02d}"), day + timedelta(hours=hour), comids, now)]
        if todo:
            pending[day.isoformat()] = todo
    hours_to_fetch = sum(len(hours) for hours in pending.values())
    print(f"{hours_in_range} hours in range, {hours_in_range - hours_to_fetch} already cached, {hours_to_fetch} to fetch in {len(pending)} day(s) with {args.workers} workers.", flush=True)

    started = time.time()
    bytes_transferred = 0
    requests_made = 0
    hours_fetched = 0
    days_done = 0
    if pending:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(fetch_day, day_iso, hours, comids) for day_iso, hours in pending.items()]
            for future in as_completed(futures):
                day_iso, results = future.result()
                content = loaded[day_iso]
                for hour, result in results.items():
                    content["hours"][f"{hour:02d}"] = result
                    bytes_transferred += int(result.get("bytesTransferred", 0))
                    requests_made += int(result.get("requests", 0))
                    hours_fetched += 1
                save_day(cache_dir, datetime.fromisoformat(day_iso), content)
                days_done += 1
                if days_done % 5 == 0 or days_done == len(pending):
                    elapsed = time.time() - started
                    print(f"  {days_done}/{len(pending)} days, {hours_fetched} hours, {bytes_transferred / 1e6:.0f} MB transferred, {elapsed:.0f} s", flush=True)

    status_counts = {"ok": 0, "not-found": 0, "failed": 0, "absent": 0}
    for day in days:
        content = loaded[day.isoformat()]
        for hour in hours_of(day):
            entry = content["hours"].get(f"{hour:02d}")
            status_counts[entry["status"] if entry else "absent"] += 1
    report = {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "hoursInRange": hours_in_range,
        "hoursFromCache": hours_in_range - hours_to_fetch,
        "hoursRequested": hours_fetched,
        "hoursOk": status_counts["ok"],
        "hoursNotFound": status_counts["not-found"],
        "hoursFailed": status_counts["failed"],
        "hoursAbsent": status_counts["absent"],
        "bytesTransferred": bytes_transferred,
        "httpRequests": requests_made,
        "workers": args.workers,
        "downloadSeconds": round(time.time() - started, 1),
    }
    Path(args.report_out).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
