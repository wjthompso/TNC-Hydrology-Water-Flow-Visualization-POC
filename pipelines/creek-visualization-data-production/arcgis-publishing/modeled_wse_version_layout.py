"""Names, paths, and shared rules for the modeled WSE m1-v1 data-product version (UCS-285).

Used by freeze_modeled_wse_version.py (writes the version) and
validate_modeled_wse_version.py (reads it back), so both agree on every name and rule.
"""

from __future__ import annotations

import calendar
import datetime as dt
import json
from pathlib import Path

import numpy as np

from data_product_versions import PIPELINE_WORKING_OUTPUT_FOLDER, REPOSITORY_ROOT, version_folder_path

PRODUCT = "modeled-wse"
METHOD_ID = "m1-drainage-area-ratio-manning-rating-curve"
METHOD_NUMBER = 1
VERSION_NUMBER = 1
VERSION_LABEL = "m1-v1"
ARCGIS_PREFIX = "modeled_wse_m1_v1"
EXTENT_ID = "dangermond-preserve"
SEGMENT_NETWORK_VERSION = "dangermond-preserve-v1"
EXPECTED_SEGMENT_COUNT = 3338

SERVICE_TITLE = "Creek Water Visualization — Modeled WSE"
SERVICE_NAME = "creek_water_visualization_modeled_wse"

VERSIONS_TABLE_NAME = "modeled_wse_versions"
CREEK_SEGMENTS_LAYER_NAME = f"{ARCGIS_PREFIX}_creek_segments"
NWM_HOURLY_HELD_INTERVALS_TABLE_NAME = f"{ARCGIS_PREFIX}_nwm_hourly_held_intervals"
CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME = f"{ARCGIS_PREFIX}_cnf_monthly_held_intervals"
CNF_MONTHLY_VALUES_TABLE_NAME = f"{ARCGIS_PREFIX}_cnf_monthly_values"
ARCGIS_LAYER_AND_TABLE_NAMES = [
    VERSIONS_TABLE_NAME,
    CREEK_SEGMENTS_LAYER_NAME,
    NWM_HOURLY_HELD_INTERVALS_TABLE_NAME,
    CNF_MONTHLY_HELD_INTERVALS_TABLE_NAME,
    CNF_MONTHLY_VALUES_TABLE_NAME,
]

NATIONAL_WATER_MODEL_HOURLY_DATASET_ID = "national-water-model-hourly"
CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID = "california-natural-flows-monthly"
PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS = [2021, 2022, 2023]
HOUR_MS = 3_600_000

# Version folder contents
VERSION_FOLDER = version_folder_path(PRODUCT, METHOD_ID, VERSION_LABEL)
VERSION_JSON_NAME = "version.json"
SOURCE_MANIFESTS_FOLDER_NAME = "source-manifests"
CREEK_SEGMENT_NETWORK_FILE_NAME = "creek-segment-network.json"
ARCGIS_UPLOAD_FOLDER_NAME = "arcgis-upload"
UPLOAD_GDB_ZIP_NAME = "modeled-wse-m1-v1.gdb.zip"
# Folder name inside the zip. Underscores only, because ArcGIS names a file geodatabase like a table.
UPLOAD_GDB_FOLDER_NAME = f"{ARCGIS_PREFIX}.gdb"
RAW_HOURLY_VALUES_FOLDER_NAME = "raw-hourly-values"


def raw_hourly_csv_name(water_year: int) -> str:
    return f"national-water-model-hourly-WY{water_year}.csv"


def raw_hourly_csv_zip_name(water_year: int) -> str:
    return f"{raw_hourly_csv_name(water_year)}.zip"


# Pipeline working output (sources)
EXTENT_WORKING_OUTPUT_FOLDER = PIPELINE_WORKING_OUTPUT_FOLDER / EXTENT_ID
# Stage 3 writes each Modeled WSE Derivation Method version to 03-time-series/<method-id>/v<version>/ (UCS-296).
STAGE_3_VERSION_FOLDER = EXTENT_WORKING_OUTPUT_FOLDER / "03-time-series" / METHOD_ID / f"v{VERSION_NUMBER}"
TIME_SERIES_FOLDER = STAGE_3_VERSION_FOLDER / "time-series"
STAGE_3_MANIFEST_PATH = STAGE_3_VERSION_FOLDER / "manifest.json"
MODELED_WSE_METHOD_CODE_FOLDER = (
    REPOSITORY_ROOT
    / "pipelines/creek-visualization-data-production/modeled-water-surface-elevation/modeled-wse-derivation-methods"
    / METHOD_ID
)
CATALOG_PATH = EXTENT_WORKING_OUTPUT_FOLDER / "05-catalog" / "catalog.json"
SOURCE_MANIFEST_COPIES = {
    "01-cross-sections-manifest.json": EXTENT_WORKING_OUTPUT_FOLDER / "01-cross-sections" / "manifest.json",
    "02-rating-curves-manifest.json": EXTENT_WORKING_OUTPUT_FOLDER / "02-rating-curves" / "manifest.json",
    "03-time-series-manifest.json": STAGE_3_MANIFEST_PATH,
    "05-catalog-catalog.json": CATALOG_PATH,
}
NHDPLUSV2_REACH_CROSSWALK_PATH = (
    REPOSITORY_ROOT / "data" / "source-inputs" / "reviewed-assignments" / "nhdplusv2-reach-crosswalk-dangermond-preserve.json"
)
EXPORT_CREEK_SEGMENT_NETWORK_SCRIPT = (
    REPOSITORY_ROOT / "pipelines" / "creek-visualization-data-production" / "arcgis-publishing" / "export-creek-segment-network.ts"
)


def national_water_model_hourly_path(tnc_comid: str, water_year: int) -> Path:
    return (
        TIME_SERIES_FOLDER / NATIONAL_WATER_MODEL_HOURLY_DATASET_ID / "water-surface-elevation" / tnc_comid / f"WY{water_year}.json"
    )


def california_natural_flows_monthly_path(tnc_comid: str) -> Path:
    return TIME_SERIES_FOLDER / CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID / "water-surface-elevation" / f"{tnc_comid}.json"


# ---------------------------------------------------------------------------
# Shared rules
# ---------------------------------------------------------------------------


def junction_id(tnc_comid: str, vertex_index: int) -> str:
    """A segment junction is one TNC flowline vertex, e.g. 27714637-v026."""
    return f"{tnc_comid}-v{vertex_index:03d}"


def upstream_and_downstream_vertex_index(segment: dict) -> tuple[int, int]:
    """Upstream vertex is vertexIndexStart when flowDirection is +1, else vertexIndexEnd."""
    if segment["flowDirection"] == 1:
        return segment["vertexIndexStart"], segment["vertexIndexEnd"]
    return segment["vertexIndexEnd"], segment["vertexIndexStart"]


def json_values_to_float_array(values: list) -> np.ndarray:
    """JSON numbers (3 decimals) and nulls → float64 with NaN for null."""
    return np.array([np.nan if value is None else value for value in values], dtype=np.float64)


def segment_junction_wse_from_junction_series(segment_values: np.ndarray, junction_series: np.ndarray) -> np.ndarray:
    """Stage 3 rule: a segment's junction WSE is null where its own value is null, else the shared junction value."""
    return np.where(np.isnan(segment_values), np.nan, junction_series)


def add_one_month_ms(epoch_ms: int) -> int:
    moment = dt.datetime.fromtimestamp(epoch_ms / 1000, tz=dt.timezone.utc)
    year, month = (moment.year + 1, 1) if moment.month == 12 else (moment.year, moment.month + 1)
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return int(moment.replace(year=year, month=month, day=day).timestamp() * 1000)


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))
