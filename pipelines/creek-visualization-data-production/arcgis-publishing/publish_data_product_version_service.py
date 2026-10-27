"""Publish one frozen Data-Product Version to ArcGIS Enterprise as its OWN private hosted feature layer.

publish_data_products_to_arcgis.py publishes into the product's one service name and so refuses any version
after m1-v1 (UCS-298: no code path adds a version to an existing service). This script gives every version
its own service instead, named by data_product_version_identity.py:

    creek_water_visualization_modeled_wse_m4_v1, creek_water_visualization_wse_polygons_m3_v2, …

It reads the version from the registry (folder, method) and its frozen folder (zipped file geodatabase,
raw hourly CSV zips, version.json), then, with --publish:

  1. signs in and checks the service name is free;
  2. uploads the file geodatabase item into the portal folder "Creek Water Visualization" and publishes it
     (maxRecordCount 10000, Query only);
  3. sets a plain-language title, snippet (one-sentence summary, "Experimental, private."), the method's
     derivation text as description, tags, credits, and terms of use;
  4. adds attribute indexes, and time settings on the Held WSE Interval tables;
  5. with --upload-raw-csv (modeled WSE), uploads the raw hourly CSV zips as items;
  6. fills the versions-table row (briefly allowing Update, then restoring Query) and the version's null
     ArcGIS fields in data/data-product-version-registry.json.

Safety rules: dry run without --publish; refuses a version the registry records as published and a taken
service name; never deletes or overwrites a portal item (a failed run prints the ids it created); leaves
every item at the owner-only sharing the portal gives it; never touches the product-level registry fields
of the live m1-v1 services. Credentials come from ARCGIS_DOTENV_PATH and are never printed.

    npm run data-products:publish-arcgis-version -- --product wse-polygons --version m2-v1
    npm run data-products:publish-arcgis-version -- --product modeled-wse --version m4-v1 --upload-raw-csv --publish
"""

from __future__ import annotations

import argparse
import html
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_version_identity import MODELED_WSE, PRODUCTS, WSE_POLYGONS, DataProductVersionIdentity  # noqa: E402
from data_product_versions import REPOSITORY_ROOT, read_registry, update_registry_version, utc_now_iso  # noqa: E402
from publish_data_products_to_arcgis import (  # noqa: E402
    ACCESS_INFORMATION,
    COMMON_TAGS,
    LICENSE_INFORMATION,
    PORTAL_FOLDER_NAME,
    all_layers_and_tables,
    attribute_index_name,
    describe_file_geodatabase,
    get_or_create_portal_folder,
    load_portal_credentials,
    table_kind,
    update_versions_table_row,
)

# Attribute indexes by kind of layer or table (publish_data_products_to_arcgis.table_kind). The depth-style
# Held WSE Interval tables are per Creek Segment, so they index segment_id where m1's index location_id.
INDEX_FIELDS_BY_TABLE_KIND = {
    "held_intervals": ["segment_id", "tnc_comid", "valid_from_utc", "valid_until_utc"],
    "monthly_values": ["segment_id", "tnc_comid", "month_start_utc"],
    "creek_segments": ["segment_id", "tnc_comid"],
    "polygons": ["segment_id", "tnc_comid", "bucket_index"],
}
EXPECTED_CAPABILITIES = "Query"


def registry_version(product: str, version_label: str) -> dict:
    versions = read_registry()["products"][product]["versions"]
    matches = [version for version in versions if version["version_label"] == version_label]
    if len(matches) != 1:
        raise SystemExit(f"Registry has {len(matches)} {product} entries labelled {version_label}; freeze it first.")
    return matches[0]


def method_label(product: str, version_json: dict) -> str:
    if product == WSE_POLYGONS:
        return version_json["pipeline_method_label"]
    return version_json.get("method_label") or version_json["derivation"]["method"]["label"]


def paragraph(label: str, text: str) -> str:
    return f"<p><b>{html.escape(label)}:</b> {html.escape(str(text))}</p>"


def build_item_description(product: str, version_json: dict, title: str) -> str:
    """The method's derivation text and what a downloader needs, as HTML for the item page."""
    label = version_json["version_label"]
    parts = [
        f"<p><b>{html.escape(title)}</b>. Data-Product Version <b>{label}</b> of <code>{version_json['method_id']}</code>. "
        "Experimental: shared with its owner only until the team decides otherwise.</p>",
        paragraph("How it is made", version_json["derivation_summary"]),
        paragraph("Change", f"{version_json['change_type']}: {version_json['change_note']}"),
    ]
    if product == MODELED_WSE:
        schema = version_json.get("schema", {})
        anchor_note = schema.get("anchor_point") or version_json.get("derivation", {}).get("anchorPoint")
        parts += [
            paragraph("WSE Anchor Point", f"{anchor_note} Anchor depth = wse_m − anchor_bed_elevation_m."),
            paragraph(
                "Held WSE Interval tables",
                "One row per Creek Segment and stretch of time in which wse_m (m NAVD88) and both junction water depths stay "
                "constant; valid_from_utc inclusive, valid_until_utc exclusive, so every hourly or monthly value can be "
                "rebuilt exactly. Junction WSE = the junction bed column of the Creek Segments layer + the junction depth.",
            ),
            paragraph(
                "Raw hourly values",
                "Every hourly value of every Creek Segment, one zipped CSV item per water year in the same portal folder "
                "(columns segment_id, tnc_comid, time_utc, wse_m, junction_depth_upstream_m, junction_depth_downstream_m).",
            ),
        ]
        if schema.get("null_values"):
            parts.append(paragraph("Null values", schema["null_values"]))
        channel = version_json.get("anchor_point_source", {}).get("channel_from_modeled_wse_version")
        if channel and channel["version_label"] != label:
            parts.append(paragraph("Channel", f"Solved on the channel of modeled WSE {channel['version_label']}; draw it with that version's channel-ribbon polygons."))
    else:
        built_from = version_json["built_from_modeled_wse_version"]
        parts += [
            paragraph("Built from", f"modeled WSE {built_from['version_label']} ({built_from['method_id']})"),
            paragraph("Bucket bounds", version_json["bucket_bounds"]["note"]),
            paragraph("Vertex Z", version_json["vertex_z"]["meaning"] if isinstance(version_json["vertex_z"], dict) else version_json["vertex_z"]),
            paragraph("Drawing", f"{version_json['browser_drawing']}: {version_json.get('browser_drawing_rule', '')}"),
            paragraph("Geometry", version_json["polygon_layer"]["geometry_assembly"]),
        ]
        if version_json.get("channel_ribbon_table"):
            parts.append(paragraph("Channel ribbons table", version_json["channel_ribbon_table"]))
    method_commit = version_json["method_commit"]  # a dict in modeled WSE versions, the bare commit in m2-v1 polygons
    parts += [
        paragraph(
            "Provenance",
            f"method code commit {method_commit['commit'] if isinstance(method_commit, dict) else method_commit}; "
            f"generated {version_json['generated_at_utc']}; frozen {version_json['frozen_at_utc']} from commit "
            f"{version_json['frozen_from_commit']}; code fingerprint {version_json['code_fingerprint']}.",
        ),
        paragraph("Layers and tables", ", ".join(version_json["arcgis_table_names"])),
        "<p><b>Versioning:</b> append-only. Every Data-Product Version has its own service; layer and table names carry "
        "the version label. Earlier versions are never overwritten or deleted. Times are UTC.</p>",
        "<p>Published from the creek-water-visualization repository (UCS-285, UCS-298).</p>",
    ]
    return "".join(parts)


def add_attribute_indexes_and_time(service_item) -> list[str]:
    notes = []
    for layer in all_layers_and_tables(service_item):
        name = layer.properties.name
        kind = table_kind(name)
        if kind is None:
            continue
        existing_fields = {field["name"].lower() for field in layer.properties.fields}
        indexed_fields = {index["fields"].lower() for index in layer.properties.get("indexes", [])}
        indexes = [
            {"name": attribute_index_name(name, field), "fields": field, "isAscending": True, "isUnique": False, "description": field}
            for field in INDEX_FIELDS_BY_TABLE_KIND[kind]
            if field.lower() in existing_fields and field.lower() not in indexed_fields
        ]
        if indexes:
            try:
                layer.manager.add_to_definition({"indexes": indexes})
                notes.append(f"{name}: {len(indexes)} attribute indexes added")
            except Exception as error:  # noqa: BLE001 - reported, not fatal
                notes.append(f"{name}: attribute indexes not added ({type(error).__name__}: {error})")
        if kind == "held_intervals":
            time_info = {"startTimeField": "valid_from_utc", "endTimeField": "valid_until_utc", "timeReference": {"timeZone": "UTC"}}
            try:
                layer.manager.update_definition({"timeInfo": time_info})
                notes.append(f"{name}: time enabled (valid_from_utc to valid_until_utc)")
            except Exception as error:  # noqa: BLE001
                notes.append(f"{name}: time not enabled ({type(error).__name__}: {error})")
    return notes


def upload_raw_hourly_csv_item(folder, csv_zip: Path, title: str, tags: list[str], description: str):
    water_year = csv_zip.name.removesuffix(".csv.zip").split("-")[-1]
    properties = {
        "title": f"{title} — raw hourly values {water_year}",
        "tags": tags + ["raw-hourly-values", water_year],
        "snippet": f"Every hourly modeled WSE value of every Creek Segment in {water_year} (zipped CSV). Not a layer. Experimental, private.",
        "description": description,
        "accessInformation": ACCESS_INFORMATION,
        "licenseInfo": LICENSE_INFORMATION,
    }
    last_error = None
    for item_type in ("CSV Collection", "Code Attachment"):
        try:
            return water_year, folder.add({**properties, "type": item_type}, file=str(csv_zip)).result()
        except Exception as error:  # noqa: BLE001 - try the next accepted item type
            last_error = error
            print(f"  item type '{item_type}' rejected ({type(error).__name__}); trying the next type")
    raise RuntimeError(f"Could not upload {csv_zip.name}: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--product", required=True, choices=PRODUCTS)
    parser.add_argument("--version", required=True, help="Version label, for example m4-v1.")
    parser.add_argument("--publish", action="store_true", help="Write to the portal. Without it, print the plan only.")
    parser.add_argument("--upload-raw-csv", action="store_true", help="modeled-wse only: also upload the raw hourly CSV zips as items.")
    arguments = parser.parse_args()
    if arguments.upload_raw_csv and arguments.product != MODELED_WSE:
        parser.error("--upload-raw-csv applies to modeled-wse only.")

    entry = registry_version(arguments.product, arguments.version)
    if entry["arcgis"].get("service_item_id"):
        raise SystemExit(f"{arguments.product} {arguments.version} is already published ({entry['arcgis']['service_item_id']}). Versions are append-only.")
    identity = DataProductVersionIdentity(arguments.product, entry["method_id"], arguments.version)
    version_folder = REPOSITORY_ROOT / entry["version_folder"]
    if version_folder != identity.version_folder:
        raise SystemExit(f"Registry folder {entry['version_folder']} is not the expected {identity.version_folder}.")
    version_json = json.loads((version_folder / "version.json").read_text(encoding="utf-8"))
    upload_zip = version_folder / "arcgis-upload" / identity.upload_zip_name
    raw_csv_zips = sorted((version_folder / "raw-hourly-values").glob("*.csv.zip")) if arguments.upload_raw_csv else []
    label_text = method_label(arguments.product, version_json)
    title = identity.service_title(label_text)
    snippet = identity.service_snippet(label_text)
    tags = COMMON_TAGS + ["ucs-298", arguments.product, arguments.version, "experimental"]
    description = build_item_description(arguments.product, version_json, title)
    versions_table_name = identity.versions_table_name

    print(f"Plan: publish {arguments.product} {arguments.version} as its own service")
    print(f"  portal folder: {PORTAL_FOLDER_NAME} (private, owner only)")
    print(f"  service name: {identity.service_name}")
    print(f"  title: {title}")
    print(f"  snippet: {snippet}")
    print(f"  description: {len(description):,} characters")
    print(f"  upload: {upload_zip.relative_to(REPOSITORY_ROOT)} ({upload_zip.stat().st_size / 1048576:.1f} MB)")
    for content in describe_file_geodatabase(upload_zip):
        print(f"    {content['name']}: {content['geometry_type'] or 'table'}, {content['rows']:,} rows")
    for csv_zip in raw_csv_zips:
        print(f"  raw CSV item: {csv_zip.name} ({csv_zip.stat().st_size / 1048576:.1f} MB)")
    if not arguments.publish:
        print("Dry run only. Add --publish to write to the portal.")
        return

    from arcgis.features import FeatureLayerCollection
    from arcgis.gis import GIS

    started = time.time()
    portal_url, username, password = load_portal_credentials()
    gis = GIS(portal_url, username, password)
    print(f"Signed in as {gis.users.me.username}.")
    if not gis.content.is_service_name_available(identity.service_name, "featureService"):
        raise SystemExit(f"Service name {identity.service_name} is already taken on the portal. Nothing was changed.")

    folder = get_or_create_portal_folder(gis, PORTAL_FOLDER_NAME)
    created_item_ids: list[str] = []
    try:
        print("Uploading file geodatabase…")
        geodatabase_item = folder.add(
            {
                "title": f"{title} (file geodatabase)",
                "type": "File Geodatabase",
                "tags": tags + ["source-upload"],
                "snippet": f"Source upload for {title}. Experimental, private.",
                "description": description,
                "accessInformation": ACCESS_INFORMATION,
            },
            file=str(upload_zip),
        ).result()
        created_item_ids.append(geodatabase_item.id)
        print(f"  file geodatabase item: {geodatabase_item.id}")

        print("Publishing hosted feature layer (can take several minutes)…")
        service_item = geodatabase_item.publish(
            publish_parameters={
                "name": identity.service_name,
                "targetSR": {"wkid": 4326},
                "maxRecordCount": 10000,
                "hasStaticData": True,
                "capabilities": EXPECTED_CAPABILITIES,
            }
        )
        created_item_ids.append(service_item.id)
        print(f"  service item: {service_item.id}")
        print(f"  service URL: {service_item.url}")
        service_item.update(
            item_properties={
                "title": title,
                "snippet": snippet,
                "description": description,
                "tags": tags,
                "accessInformation": ACCESS_INFORMATION,
                "licenseInfo": LICENSE_INFORMATION,
            }
        )
        for note in add_attribute_indexes_and_time(service_item):
            print(f"  {note}")

        layer_ids = {layer.properties.name: layer.properties.id for layer in all_layers_and_tables(service_item)}
        row_counts = {layer.properties.name: layer.query(where="1=1", return_count_only=True) for layer in all_layers_and_tables(service_item)}
        for name, count in row_counts.items():
            print(f"  {name} (id {layer_ids[name]}): {count:,} rows")

        raw_csv_item_ids: dict[str, str] = {}
        for csv_zip in raw_csv_zips:
            print(f"Uploading raw hourly values {csv_zip.name}…")
            csv_description = description + f"<p>Hosted feature layer: {service_item.url}</p>"
            water_year, csv_item = upload_raw_hourly_csv_item(folder, csv_zip, title, tags, csv_description)
            created_item_ids.append(csv_item.id)
            raw_csv_item_ids[water_year] = csv_item.id
            print(f"  {water_year}: {csv_item.id} ({csv_item.type})")

        published_at_utc = utc_now_iso()
        row_updated = update_versions_table_row(
            service_item,
            versions_table_name,
            arguments.version,
            {
                "published_at_utc": published_at_utc,
                "arcgis_table_names": json.dumps(layer_ids, sort_keys=True),
                "raw_hourly_csv_item_ids": json.dumps(raw_csv_item_ids, sort_keys=True) if raw_csv_item_ids else None,
            },
        )
        print(f"  versions table row updated: {row_updated}")
        capabilities = FeatureLayerCollection.fromitem(service_item).properties.capabilities
        print(f"  capabilities: {capabilities}; sharing: {service_item.access}")

        arcgis_record = {
            "service_item_id": service_item.id,
            "service_url": service_item.url,
            "service_name": identity.service_name,
            "service_title": title,
            "file_geodatabase_item_id": geodatabase_item.id,
            "published_at_utc": published_at_utc,
            "portal_folder": PORTAL_FOLDER_NAME,
            "row_counts": row_counts,
            "layer_ids": layer_ids,
            "sharing": f"{service_item.access} (owner only); not shared",
            "versions_table_row_updated": row_updated,
        }
        if raw_csv_item_ids:
            arcgis_record["raw_hourly_csv_item_ids"] = raw_csv_item_ids
        if arguments.product == WSE_POLYGONS:
            arcgis_record["versions_table_layer_id"] = layer_ids.get(versions_table_name)
            arcgis_record["polygon_layer_id"] = layer_ids.get(identity.arcgis_prefix)
        # Fills only this version's null ArcGIS fields; the product-level fields (the live m1 services) stay as they are.
        update_registry_version(
            arguments.product, {"version_label": arguments.version, "arcgis": arcgis_record}, allow_update_of_null_arcgis_fields=True
        )
        print("Registry updated: data/data-product-version-registry.json")
        if capabilities != EXPECTED_CAPABILITIES or service_item.access != "private":
            raise RuntimeError(f"Service ended with capabilities {capabilities} and sharing {service_item.access}; expected Query and private.")
        print(f"Done in {time.time() - started:.0f} s.")
    except Exception:
        print(f"FAILED. Items created in this run were left in place for inspection (never deleted): {created_item_ids}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
