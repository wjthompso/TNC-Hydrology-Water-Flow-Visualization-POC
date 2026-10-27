"""Names of one Data-Product Version, derived from its product, method, and version label (UCS-298 workaround).

The m1 and m2 scripts write their names as constants. The generic freeze, validate, and publish scripts
(`*_depth_version.py`, `publish_data_product_version_service.py`) derive them here instead, so a new
version needs no code edit:

    label m3-v2           → ArcGIS prefix modeled_wse_m3_v2 / wse_polygons_m3_v2
                          → service creek_water_visualization_modeled_wse_m3_v2 (one hosted service per version,
                            because no code path adds a version to an existing service)
                          → upload modeled-wse-m3-v2.gdb.zip
                          → folder data/data-product-versions/<product>/<method id>/m3-v2/

PLAIN_TEXT_BY_VERSION holds the plain-language title words and one-sentence summary a person scanning the
portal reads. It is the only per-version text kept in code; a version without an entry falls back to the
method label recorded by the stage.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from data_product_versions import version_folder_path

MODELED_WSE = "modeled-wse"
WSE_POLYGONS = "wse-polygons"
PRODUCTS = (MODELED_WSE, WSE_POLYGONS)

ARCGIS_PRODUCT_PREFIX = {MODELED_WSE: "modeled_wse", WSE_POLYGONS: "wse_polygons"}
VERSIONS_TABLE_NAME = {MODELED_WSE: "modeled_wse_versions", WSE_POLYGONS: "wse_polygon_versions"}
SERVICE_NAME_PREFIX = "creek_water_visualization"
SERVICE_TITLE_BASE = {
    MODELED_WSE: "Dangermond Preserve — Inferred Creek Water Surface Elevations",
    WSE_POLYGONS: "Dangermond Preserve — Creek Water Outlines",
}
VERSION_LABEL_PATTERN = re.compile(r"^m(\d+)-v(\d+)$")

# (product, version label) → (title words, one-sentence summary). Plain language, no method ids.
PLAIN_TEXT_BY_VERSION = {
    (MODELED_WSE, "m2-v1"): (
        "multi-section Manning depth",
        "Water depth from Manning's equation at the first, middle, and last cross-section of each Creek Segment, "
        "so the water surface can run parallel to the creek bed.",
    ),
    (MODELED_WSE, "m3-v1"): (
        "channel profile, smoothed bed, Manning roughness",
        "Water depth from Manning's equation on one cross-section cut across a smoothed creek channel, over a "
        "smoothed creek bed that always runs downhill.",
    ),
    (MODELED_WSE, "m3-v2"): (
        "channel profile, raw lidar bed, Manning roughness",
        "Like m3-v1, but the creek bed is the raw 1 m lidar at the creek's lowest point (no smoothing) and the water "
        "surface is pool-filled, so pools behind steps stand level.",
    ),
    (MODELED_WSE, "m4-v1"): (
        "Ferguson & Recking steep-creek roughness",
        "m3-v2's channel and bed with a flow resistance that rises with slope on steep creeks, from the Ferguson & "
        "Recking (2025) variable-power law, so steep water runs slower and deeper.",
    ),
    (MODELED_WSE, "m5-v1"): (
        "Jarrett steep-creek roughness",
        "m3-v2's channel and bed with a flow resistance that rises with slope on steep creeks, from Jarrett's (1984) "
        "field-fitted equation, which needs no grain size.",
    ),
    (WSE_POLYGONS, "m2-v1"): (
        "height above nearest drainage fill, for m2-v1",
        "Water outlines that flood the 1 m lidar up to each water depth above the local creek bed; drawn with "
        "modeled WSE m2-v1.",
    ),
    (WSE_POLYGONS, "m3-v1"): (
        "channel ribbon, for m3-v1",
        "One continuous ribbon of water along the creek channel, with its edges at 19 water depths; drawn with "
        "modeled WSE m3-v1.",
    ),
    (WSE_POLYGONS, "m3-v2"): (
        "channel ribbon on the raw lidar bed, for m3-v2, m4-v1 and m5-v1",
        "One continuous ribbon of water along the creek channel on the raw 1 m lidar bed, with its edges at 19 water "
        "depths; drawn with modeled WSE m3-v2, or m4-v1 or m5-v1, which share its channel.",
    ),
}


@dataclass(frozen=True)
class DataProductVersionIdentity:
    product: str
    method_id: str  # registry method id, for example m3-flowline-profile-manning-depth or m3-flowline-channel-ribbon
    version_label: str

    def __post_init__(self) -> None:
        if self.product not in PRODUCTS:
            raise ValueError(f"Unknown product {self.product}; expected one of {PRODUCTS}")
        if not VERSION_LABEL_PATTERN.match(self.version_label):
            raise ValueError(f"Version label {self.version_label} is not m<method number>-v<version number>")
        if not self.method_id.startswith(f"m{self.method_number}-"):
            raise ValueError(f"Method id {self.method_id} does not start with the label's method number m{self.method_number}-")

    @property
    def method_number(self) -> int:
        return int(VERSION_LABEL_PATTERN.match(self.version_label).group(1))

    @property
    def version_number(self) -> int:
        return int(VERSION_LABEL_PATTERN.match(self.version_label).group(2))

    @property
    def arcgis_prefix(self) -> str:
        return f"{ARCGIS_PRODUCT_PREFIX[self.product]}_{self.version_label.replace('-', '_')}"

    @property
    def versions_table_name(self) -> str:
        return VERSIONS_TABLE_NAME[self.product]

    @property
    def service_name(self) -> str:
        return f"{SERVICE_NAME_PREFIX}_{self.arcgis_prefix}"

    @property
    def upload_zip_name(self) -> str:
        return f"{self.product}-{self.version_label}.gdb.zip"

    @property
    def upload_gdb_folder_name(self) -> str:
        # Underscores only, because ArcGIS names a file geodatabase like a table.
        return f"{self.arcgis_prefix}.gdb"

    @property
    def version_folder(self) -> Path:
        return version_folder_path(self.product, self.method_id, self.version_label)

    def service_title(self, method_label: str) -> str:
        title_words = PLAIN_TEXT_BY_VERSION.get((self.product, self.version_label), (method_label, ""))[0]
        return f"{SERVICE_TITLE_BASE[self.product]} ({self.version_label}, {title_words})"

    def service_snippet(self, method_label: str) -> str:
        summary = PLAIN_TEXT_BY_VERSION.get((self.product, self.version_label), ("", method_label))[1]
        return f"{summary} Experimental, private."
