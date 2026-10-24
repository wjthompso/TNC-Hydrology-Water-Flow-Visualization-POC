"""Names, paths, and shared rules for the modeled WSE m2-v1 data-product version.

m2 is the Modeled WSE Derivation Method `m2-multi-section-manning-depth`. Its Time Series
segments carry an anchor WSE (`values`, at Stage 1 section index 2) plus water DEPTHS at the two
junctions, so the frozen version differs from m1-v1 (modeled_wse_version_layout.py) in three ways:

- Creek Segments layer: adds the static anchor point (longitude, latitude, bed elevation) and the
  two junction bed elevations per segment.
- Held WSE Interval tables: one row per stretch of time in which the anchor WSE and both junction
  depths stay constant, for Creek Segments only (m2 has no shared junction series).
- Junction WSE is not stored. It is junction bed + junction depth, rounded to 3 decimals, and the
  validator proves that rebuild against the Stage 3 junction WSE arrays.

Used by freeze_modeled_wse_m2_version.py (writes the version) and
validate_modeled_wse_m2_version.py (reads it back). Everything not m2-specific is imported from
modeled_wse_version_layout.py, so the m1 modules stay untouched.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from pyproj import Transformer

from data_product_versions import version_folder_path
from modeled_wse_version_layout import (  # noqa: F401  (re-exported for the m2 scripts)
    ARCGIS_UPLOAD_FOLDER_NAME,
    CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID,
    CREEK_SEGMENT_NETWORK_FILE_NAME,
    EXTENT_ID,
    EXTENT_WORKING_OUTPUT_FOLDER,
    HOUR_MS,
    NATIONAL_WATER_MODEL_HOURLY_DATASET_ID,
    NHDPLUSV2_REACH_CROSSWALK_PATH,
    PUBLISHED_NATIONAL_WATER_MODEL_WATER_YEARS,
    RAW_HOURLY_VALUES_FOLDER_NAME,
    SEGMENT_NETWORK_VERSION,
    SERVICE_NAME,
    SERVICE_TITLE,
    SOURCE_MANIFESTS_FOLDER_NAME,
    VERSION_JSON_NAME,
    VERSIONS_TABLE_NAME,
    add_one_month_ms,
    junction_id,
    raw_hourly_csv_name,
    raw_hourly_csv_zip_name,
    read_json,
    upstream_and_downstream_vertex_index,
)

PRODUCT = "modeled-wse"
METHOD_ID = "m2-multi-section-manning-depth"
METHOD_NUMBER = 2
VERSION_NUMBER = 1
VERSION_LABEL = "m2-v1"
ARCGIS_PREFIX = "modeled_wse_m2_v1"

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

UPLOAD_GDB_ZIP_NAME = "modeled-wse-m2-v1.gdb.zip"
# Folder name inside the zip. Underscores only, because ArcGIS names a file geodatabase like a table.
UPLOAD_GDB_FOLDER_NAME = f"{ARCGIS_PREFIX}.gdb"
VERSION_FOLDER = version_folder_path(PRODUCT, METHOD_ID, VERSION_LABEL)

# ---------------------------------------------------------------------------
# Pipeline working output (sources)
# ---------------------------------------------------------------------------

STAGE_3_VERSION_FOLDER = EXTENT_WORKING_OUTPUT_FOLDER / "03-time-series" / METHOD_ID / f"v{VERSION_NUMBER}"
TIME_SERIES_FOLDER = STAGE_3_VERSION_FOLDER / "time-series"
STAGE_3_MANIFEST_PATH = STAGE_3_VERSION_FOLDER / "manifest.json"
CROSS_SECTIONS_PATH = EXTENT_WORKING_OUTPUT_FOLDER / "01-cross-sections" / "cross-sections.json"
STAGE_1_MANIFEST_PATH = EXTENT_WORKING_OUTPUT_FOLDER / "01-cross-sections" / "manifest.json"
CATALOG_PATH = EXTENT_WORKING_OUTPUT_FOLDER / "05-catalog" / "catalog.json"  # dataset facts only; see below
# The Stage 5 catalog and the Stage 2 manifest are not copied on purpose: the catalog on disk describes
# the current default modeled WSE version (m1), so the freeze reads only its method-independent
# dataset facts (and records its hash), and m2 does not use Stage 2 rating curves.
SOURCE_MANIFEST_COPIES = {
    "01-cross-sections-manifest.json": STAGE_1_MANIFEST_PATH,
    "03-time-series-manifest.json": STAGE_3_MANIFEST_PATH,
}


def national_water_model_hourly_path(tnc_comid: str, water_year: int) -> Path:
    return (
        TIME_SERIES_FOLDER / NATIONAL_WATER_MODEL_HOURLY_DATASET_ID / "water-surface-elevation" / tnc_comid / f"WY{water_year}.json"
    )


def california_natural_flows_monthly_path(tnc_comid: str) -> Path:
    return TIME_SERIES_FOLDER / CALIFORNIA_NATURAL_FLOWS_MONTHLY_DATASET_ID / "water-surface-elevation" / f"{tnc_comid}.json"


# ---------------------------------------------------------------------------
# Column names
# ---------------------------------------------------------------------------

# Held WSE Interval tables: one row per stretch of time in which wse_m and both junction depths are
# constant. A null run (value null) is one interval with all three null.
HELD_INTERVAL_FIELDS = [
    "segment_id",
    "tnc_comid",
    "valid_from_utc",
    "valid_until_utc",
    "wse_m",
    "junction_depth_upstream_m",
    "junction_depth_downstream_m",
    "step_count",
]
# Time-varying m2 values, as named in the Time Series files and in the tables.
TIME_VARYING_COLUMNS_BY_SOURCE_NAME = {
    "values": "wse_m",
    "junctionDepthUpstreamM": "junction_depth_upstream_m",
    "junctionDepthDownstreamM": "junction_depth_downstream_m",
}
# Static per-segment columns added to the Creek Segments layer.
ANCHOR_AND_JUNCTION_BED_FIELDS = [
    "anchor_longitude",
    "anchor_latitude",
    "anchor_bed_elevation_m",
    "junction_bed_upstream_m",
    "junction_bed_downstream_m",
]
MAXIMUM_STAGE_1_VS_TIME_SERIES_BED_DIFFERENCE_M = 0.001
ANCHOR_SECTION_INDEX = 2
STAGE_1_SECTION_CRS = "EPSG:32610"  # UTM zone 10N, meters, the CRS of thalwegUtm


# ---------------------------------------------------------------------------
# Shared rules
# ---------------------------------------------------------------------------


def round_to_three_decimals(values: np.ndarray) -> np.ndarray:
    """Stage 3 stores values and junction WSE with 3 decimals; NaN stays NaN."""
    return np.round(values, 3)


def junction_wse_from_bed_and_depth(junction_bed_m: float, junction_depth_m: np.ndarray) -> np.ndarray:
    """m2 rule: junction WSE = junction bed + junction depth, rounded to 3 decimals; null where depth is null."""
    return round_to_three_decimals(junction_bed_m + junction_depth_m)


def anchor_points_by_segment_id(cross_sections: dict, anchor_section_index: int = ANCHOR_SECTION_INDEX) -> dict[str, dict]:
    """Each Creek Segment's anchor point from Stage 1: thalwegUtm of section `anchor_section_index`.

    Returns {segment id: {"anchor_longitude", "anchor_latitude" (WGS84, EPSG:4326),
    "stage_1_anchor_bed_elevation_m"}}. The anchor point is not stored in the Time Series.
    pyproj's EPSG:32610 → EPSG:4326 transform is the same projection as the repository's proj4 helper
    `utm10nToWgs84` (utm-geometry.ts); the two agree to 3e-14 degrees on all 3,338 anchors (checked against a Node run of the helper).
    """
    segments = cross_sections["segments"]
    sections = [segment["sections"][anchor_section_index] for segment in segments]
    transformer = Transformer.from_crs(STAGE_1_SECTION_CRS, "EPSG:4326", always_xy=True)
    longitudes, latitudes = transformer.transform(
        [section["thalwegUtm"]["x"] for section in sections], [section["thalwegUtm"]["y"] for section in sections]
    )
    return {
        segment["segmentId"]: {
            "anchor_longitude": float(longitude),
            "anchor_latitude": float(latitude),
            "stage_1_anchor_bed_elevation_m": section["bedElevationM"],
        }
        for segment, section, longitude, latitude in zip(segments, sections, longitudes, latitudes)
    }
