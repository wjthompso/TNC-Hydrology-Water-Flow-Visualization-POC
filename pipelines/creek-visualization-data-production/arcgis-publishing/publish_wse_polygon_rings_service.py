"""Publish the frozen exact-ring table of a channel-ribbon WSE polygons version as its own private hosted service.

The table comes from freeze_wse_polygon_rings.py (data/data-product-versions/wse-polygons/<method id>/<label>-rings/). It is
published next to the version's own service, never into it, under the version's service name plus `_rings`:

    creek_water_visualization_wse_polygons_m3_v2_rings

With --publish it signs in, checks the service name is free, uploads the file geodatabase item into the portal folder
"Creek Water Visualization", publishes it (Query only), sets plain-language item text, adds attribute indexes, checks the row
count, and adds the ids to the polygon version's registry entry as `arcgis.exact_rings_service` (a new field; nothing that is
already set changes). Sharing stays owner-only; share_data_product_version_services.py makes it public. Nothing is deleted;
a failed run prints the ids it created.

    npm run data-products:publish-wse-polygon-rings -- --version m3-v2            # dry run
    npm run data-products:publish-wse-polygon-rings -- --version m3-v2 --publish
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_version_identity import WSE_POLYGONS, DataProductVersionIdentity  # noqa: E402
from data_product_versions import REPOSITORY_ROOT, update_registry_version, utc_now_iso, version_folder_path  # noqa: E402
from freeze_wse_polygon_rings import registry_polygon_version, rings_label, rings_upload_zip_name  # noqa: E402
from publish_data_product_version_service import EXPECTED_CAPABILITIES, upload_and_publish  # noqa: E402
from publish_data_products_to_arcgis import (  # noqa: E402
    ACCESS_INFORMATION,
    COMMON_TAGS,
    LICENSE_INFORMATION,
    PORTAL_FOLDER_NAME,
    all_layers_and_tables,
    attribute_index_name,
    get_or_create_portal_folder,
    load_portal_credentials,
)

INDEX_FIELDS = ["segment_id", "tnc_comid", "bucket_index"]


@dataclass(frozen=True)
class RingsServiceIdentity:
    """The one name upload_and_publish reads from a version identity."""

    service_name: str


def item_text(polygon_entry: dict, rings: dict) -> dict:
    label = polygon_entry["version_label"]
    title = f"{polygon_entry['arcgis']['service_title']} — exact ribbon outlines"
    snippet = (
        f"The water outlines of WSE polygons {label} exactly as computed, one row per Creek Segment and water depth, as text, "
        "for the Creek Water Visualization browser. Experimental, private."
    )
    description = "".join(
        [
            f"<p><b>{title}</b>. A table that goes with the hosted feature layer {polygon_entry['arcgis']['service_url']}.</p>",
            f"<p><b>Why it exists:</b> {rings['purpose']}</p>",
            "<p><b>Columns:</b> "
            + "; ".join(f"<code>{name}</code>: {meaning}" for name, meaning in rings["schema"].items())
            + ".</p>",
            f"<p><b>Provenance:</b> frozen {rings['frozen_at_utc']} from commit {rings['frozen_from_commit']}, from the same Stage 4 "
            f"files as {label} (SHA-256 checked); every ring equals the frozen file geodatabase geometry "
            f"({json.dumps(rings['source_checks']['rings_equal_frozen_polygon_layer'])}; reversed rings are the file geodatabase "
            "writer's, this table keeps the Stage 4 order).</p>",
            "<p><b>Versioning:</b> append-only; earlier versions are never overwritten or deleted.</p>",
        ]
    )
    return {"title": title, "snippet": snippet, "description": description}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True, help="Channel-ribbon WSE polygons version label, for example m3-v2.")
    parser.add_argument("--publish", action="store_true", help="Write to the portal. Without it, print the plan only.")
    arguments = parser.parse_args()

    polygon_entry = registry_polygon_version(arguments.version)
    if polygon_entry["arcgis"].get("exact_rings_service"):
        raise SystemExit(f"wse-polygons {arguments.version} rings are already published ({polygon_entry['arcgis']['exact_rings_service']['service_item_id']}).")
    identity = DataProductVersionIdentity(WSE_POLYGONS, polygon_entry["method_id"], arguments.version)
    rings_folder = version_folder_path(WSE_POLYGONS, identity.method_id, rings_label(arguments.version))
    rings = json.loads((rings_folder / "rings.json").read_text(encoding="utf-8"))
    upload_zip = rings_folder / "arcgis-upload" / rings_upload_zip_name(identity)
    text = item_text(polygon_entry, rings)
    tags = COMMON_TAGS + ["ucs-298", WSE_POLYGONS, arguments.version, "exact-rings", "experimental"]
    service_name = rings["arcgis_service_name"]

    print(f"Plan: publish the exact rings of wse-polygons {arguments.version} as their own service")
    print(f"  portal folder: {PORTAL_FOLDER_NAME} (private, owner only)")
    print(f"  service name: {service_name}")
    print(f"  title: {text['title']}")
    print(f"  snippet: {text['snippet']}")
    print(f"  upload: {upload_zip.relative_to(REPOSITORY_ROOT)} ({upload_zip.stat().st_size / 1048576:.1f} MB), {rings['counts']['rows']:,} rows")
    if not arguments.publish:
        print("Dry run only. Add --publish to write to the portal.")
        return

    from arcgis.features import FeatureLayerCollection
    from arcgis.gis import GIS

    started = time.time()
    portal_url, username, password = load_portal_credentials()
    gis = GIS(portal_url, username, password)
    print(f"Signed in as {gis.users.me.username}.")
    if not gis.content.is_service_name_available(service_name, "featureService"):
        raise SystemExit(f"Service name {service_name} is already taken on the portal. Nothing was changed.")
    folder = get_or_create_portal_folder(gis, PORTAL_FOLDER_NAME)
    created_item_ids: list[str] = []
    try:
        geodatabase_item, service_item = upload_and_publish(
            folder, upload_zip, RingsServiceIdentity(service_name), text["title"], tags, text["description"], created_item_ids
        )
        service_item.update(
            item_properties={**text, "tags": tags, "accessInformation": ACCESS_INFORMATION, "licenseInfo": LICENSE_INFORMATION}
        )
        (table,) = all_layers_and_tables(service_item)
        table.manager.add_to_definition(
            {
                "indexes": [
                    {"name": attribute_index_name(table.properties.name, field), "fields": field, "isAscending": True, "isUnique": False, "description": field}
                    for field in INDEX_FIELDS
                ]
            }
        )
        row_count = table.query(where="1=1", return_count_only=True)
        capabilities = FeatureLayerCollection.fromitem(service_item).properties.capabilities
        print(f"  {table.properties.name} (id {table.properties.id}): {row_count:,} rows; capabilities {capabilities}; sharing {service_item.access}")
        record = {
            "service_item_id": service_item.id,
            "service_url": service_item.url,
            "service_name": service_name,
            "service_title": text["title"],
            "file_geodatabase_item_id": geodatabase_item.id,
            "table_name": table.properties.name,
            "table_id": table.properties.id,
            "row_count": row_count,
            "rings_folder": rings_folder.relative_to(REPOSITORY_ROOT).as_posix(),
            "published_at_utc": utc_now_iso(),
            "portal_folder": PORTAL_FOLDER_NAME,
            "sharing": f"{service_item.access} (owner only); not shared",
        }
        update_registry_version(
            WSE_POLYGONS, {"version_label": arguments.version, "arcgis": {"exact_rings_service": record}}, allow_update_of_null_arcgis_fields=True
        )
        print("Registry updated: data/data-product-version-registry.json (arcgis.exact_rings_service)")
        if row_count != rings["counts"]["rows"] or capabilities != EXPECTED_CAPABILITIES or service_item.access != "private":
            raise RuntimeError(f"Published with {row_count} rows, capabilities {capabilities}, sharing {service_item.access}; expected {rings['counts']['rows']}, Query, private.")
        print(f"Done in {time.time() - started:.0f} s.")
    except Exception:
        print(f"FAILED. Items created in this run were left in place for inspection (never deleted): {created_item_ids}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
