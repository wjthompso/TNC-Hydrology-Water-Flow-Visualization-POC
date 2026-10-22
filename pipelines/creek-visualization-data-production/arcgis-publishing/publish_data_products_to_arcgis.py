"""Publish a frozen data-product version to ArcGIS Enterprise as a private hosted feature layer.

Reads a version folder written by the freeze scripts
(data/data-product-versions/<product>/<method-id>/<version>/), uploads its zipped file
geodatabase to the portal folder "Creek Water Visualization", publishes it, adds attribute
indexes and time settings, and records the ArcGIS ids in the versions table and in
data/data-product-version-registry.json.

Safety rules:
- Dry run by default. Nothing reaches the portal without --publish.
- Never deletes any portal item, including items created by this script. A failed run
  prints the ids it created so a person can inspect them.
- Refuses to publish a version the registry already records as published, and refuses a
  service name that is already taken.
- Items stay private (owner only).

Credentials come from ARCGIS_URL, ARCGIS_USERNAME and ARCGIS_PASSWORD in the dotenv file
at ARCGIS_DOTENV_PATH (default: <repository>/../../Data-Pipeline/.env). Values are never printed.

Usage (from the repository root):
  npm run data-products:publish-arcgis -- --product wse-polygons --version m1-v1
  npm run data-products:publish-arcgis -- --product wse-polygons --version m1-v1 --publish
  npm run data-products:publish-arcgis -- --product modeled-wse --version m1-v1 --upload-raw-csv --publish
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

import pyogrio

from data_product_versions import REPOSITORY_ROOT, read_registry, utc_now_iso, write_json

PORTAL_FOLDER_NAME = "Creek Water Visualization"
REGISTRY_PATH = REPOSITORY_ROOT / "data" / "data-product-version-registry.json"
COMMON_TAGS = ["ucs-285", "creek-water-visualization", "dangermond-preserve"]
ACCESS_INFORMATION = (
    "NOAA National Water Model v3.0 retrospective; California Natural Flows Database; "
    "USGS 3D Elevation Program (3DEP) 1 m terrain; TNC (The Nature Conservancy) flowlines; "
    "EPA NHDPlusV2. Derived by the UCSB Spatial Center."
)
LICENSE_INFORMATION = (
    "Research and visualization use. Modeled values are not validated at every creek; see the description."
)

# Attribute indexes added after publishing, by kind of layer or table.
INDEX_FIELDS_BY_TABLE_KIND = {
    "held_intervals": ["location_id", "location_kind", "tnc_comid", "valid_from_utc", "valid_until_utc"],
    "monthly_values": ["segment_id", "tnc_comid", "month_start_utc"],
    "creek_segments": ["segment_id", "tnc_comid"],
    "polygons": ["segment_id", "tnc_comid", "bucket_index"],
}

PRODUCTS = {
    "modeled-wse": {"method_id": "m1-drainage-area-ratio-manning-rating-curve", "versions_table": "modeled_wse_versions"},
    "wse-polygons": {"method_id": "m1-junction-sloped-terrain-fill", "versions_table": "wse_polygon_versions"},
}


def table_kind(table_name: str) -> str | None:
    if table_name.endswith("_held_intervals"):
        return "held_intervals"
    if table_name.endswith("_monthly_values"):
        return "monthly_values"
    if table_name.endswith("_creek_segments"):
        return "creek_segments"
    if table_name.startswith("wse_polygons_m"):
        return "polygons"
    return None


def describe_file_geodatabase(zip_path: Path) -> list[dict]:
    """Layer and table names, geometry types, and row counts, read locally from the zip."""
    with tempfile.TemporaryDirectory() as temporary_folder:
        zipfile.ZipFile(zip_path).extractall(temporary_folder)
        geodatabase = next(Path(temporary_folder).glob("*.gdb"))
        contents = []
        for name, geometry_type in pyogrio.list_layers(geodatabase):
            info = pyogrio.read_info(geodatabase, layer=name)
            contents.append({"name": str(name), "geometry_type": geometry_type, "rows": int(info["features"])})
        return contents


def build_item_description(product: str, version: dict, title: str) -> str:
    paragraphs = [
        f"<b>{title}</b>, data-product version <b>{version['version_label']}</b> (method <code>{version['method_id']}</code>).",
        f"<b>What it is:</b> {version.get('derivation_summary', '')}",
        f"<b>Change type:</b> {version.get('change_type')}. <b>Note:</b> {version.get('change_note')}",
        (
            f"<b>Provenance:</b> method date {version.get('method_date_utc')}; generated {version.get('generated_at_utc')}; "
            f"frozen {version.get('frozen_at_utc')} from commit <code>{version.get('frozen_from_commit')}</code>; "
            f"segment network {version.get('segment_network_version')}."
        ),
    ]
    if product == "wse-polygons":
        built_from = version.get("built_from_modeled_wse_version", {})
        paragraphs.append(
            f"<b>Built from:</b> modeled WSE {built_from.get('version_label')} (<code>{built_from.get('method_id')}</code>). "
            f"WSE Polygon Generation Method fingerprint <code>{version.get('method_sha256')}</code>."
        )
        paragraphs.append(
            "One polygon per Creek Segment elevation bucket (min_wse_m inclusive, max_wse_m exclusive); "
            "the browser picks the bucket holding the modeled WSE at the selected time."
        )
    else:
        paragraphs.append(
            "<b>Held WSE Interval tables</b> store one row per constant stretch of water-surface elevation "
            "(valid_from_utc inclusive, valid_until_utc exclusive), so every hourly or monthly value can be rebuilt exactly. "
            "Raw hourly values are separate zipped CSV items in the same folder."
        )
    paragraphs.append(
        "<b>Versioning:</b> append-only. Layer and table names carry their version (for example <code>_m1_v1</code>). "
        "A new method number means a new approach; a new version number means an implementation fix or parameter change. "
        "Earlier versions are never overwritten or deleted; the versions table lists every version and its status. Times are UTC."
    )
    paragraphs.append("Published from the creek-water-visualization repository (UCS-285).")
    return "".join(f"<p>{paragraph}</p>" for paragraph in paragraphs)


def load_portal_credentials() -> tuple[str, str, str]:
    from dotenv import load_dotenv

    default_dotenv_path = REPOSITORY_ROOT.parent.parent / "Data-Pipeline" / ".env"
    dotenv_path = Path(os.environ.get("ARCGIS_DOTENV_PATH", default_dotenv_path))
    if not dotenv_path.exists():
        raise SystemExit(f"Credential file not found at {dotenv_path}. Set ARCGIS_DOTENV_PATH.")
    load_dotenv(dotenv_path)
    missing = [key for key in ("ARCGIS_URL", "ARCGIS_USERNAME", "ARCGIS_PASSWORD") if not os.environ.get(key)]
    if missing:
        raise SystemExit(f"Missing credential variables: {', '.join(missing)}.")
    return os.environ["ARCGIS_URL"], os.environ["ARCGIS_USERNAME"], os.environ["ARCGIS_PASSWORD"]


def get_or_create_portal_folder(gis, folder_name: str):
    folder = gis.content.folders.get(folder_name)
    if folder is None:
        folder = gis.content.folders.create(folder_name)
        print(f"  created portal folder: {folder_name}")
    else:
        print(f"  using portal folder: {folder_name}")
    return folder


def attribute_index_name(table_name: str, field_name: str) -> str:
    """Index names must be unique across the whole hosted data store, so they carry a short hash
    of the layer or table name. Kept under 30 characters for the underlying database."""
    import hashlib

    table_hash = hashlib.sha1(table_name.encode("utf-8")).hexdigest()[:6]
    return f"ix_{table_hash}_{field_name}"[:30]


def all_layers_and_tables(service_item) -> list:
    return list(service_item.layers) + list(service_item.tables)


def add_indexes_and_time(service_item) -> list[str]:
    notes = []
    for layer in all_layers_and_tables(service_item):
        name = layer.properties.name
        kind = table_kind(name)
        if kind is None:
            continue
        existing_fields = {field["name"].lower() for field in layer.properties.fields}
        indexed_fields = {index["fields"].lower() for index in layer.properties.get("indexes", [])}
        indexes = [
            {
                "name": attribute_index_name(name, field_name),
                "fields": field_name,
                "isAscending": True,
                "isUnique": False,
                "description": field_name,
            }
            for field_name in INDEX_FIELDS_BY_TABLE_KIND[kind]
            if field_name.lower() in existing_fields and field_name.lower() not in indexed_fields
        ]
        if not indexes:
            notes.append(f"{name}: attribute indexes already present")
            continue
        try:
            layer.manager.add_to_definition({"indexes": indexes})
            notes.append(f"{name}: {len(indexes)} attribute indexes added")
        except Exception as error:  # noqa: BLE001 - reported, not fatal
            notes.append(f"{name}: attribute indexes not added ({type(error).__name__}: {error})")
        if kind == "held_intervals":
            time_info = {
                "startTimeField": "valid_from_utc",
                "endTimeField": "valid_until_utc",
                "timeReference": {"timeZone": "UTC"},
            }
            try:
                layer.manager.update_definition({"timeInfo": time_info})
                notes.append(f"{name}: time enabled (valid_from_utc to valid_until_utc)")
            except Exception as error:  # noqa: BLE001
                notes.append(f"{name}: time not enabled ({type(error).__name__}: {error})")
    return notes


def upload_raw_csv_item(folder, csv_zip: Path, title: str, version_label: str, tags: list[str], description: str):
    water_year = csv_zip.name.removesuffix(".csv.zip").split("-")[-1]
    properties = {
        "title": f"{title} {version_label} raw hourly values {water_year}",
        "tags": tags + ["raw-hourly-values", water_year],
        "snippet": f"Every hourly modeled WSE value for every Creek Segment, {water_year} (zipped CSV). Not a layer.",
        "description": description,
        "accessInformation": ACCESS_INFORMATION,
    }
    last_error = None
    for item_type in ("CSV Collection", "Code Attachment"):
        try:
            item = folder.add({**properties, "type": item_type}, file=str(csv_zip)).result()
            return water_year, item
        except Exception as error:  # noqa: BLE001 - try the next accepted item type
            last_error = error
            print(f"  item type '{item_type}' rejected ({type(error).__name__}); trying the next type")
    raise RuntimeError(f"Could not upload {csv_zip.name}: {last_error}")


def epoch_milliseconds_from_utc_iso(utc_iso: str) -> int:
    from datetime import datetime

    return int(datetime.fromisoformat(utc_iso.replace("Z", "+00:00")).timestamp() * 1000)


def update_versions_table_row(service_item, versions_table_name: str, version_label: str, updates: dict) -> bool:
    """Fill ArcGIS ids and the publish time on one versions-table row.

    The service is read-only ("Query"), so this briefly allows updates, edits the one row,
    and restores "Query" even if the edit fails.
    """
    from arcgis.features import FeatureLayerCollection

    service_manager = FeatureLayerCollection.fromitem(service_item).manager
    versions_table = next(table for table in service_item.tables if table.properties.name == versions_table_name)
    object_id_field = versions_table.properties.objectIdField
    row = versions_table.query(where=f"version_label = '{version_label}'", out_fields=object_id_field).features[0]
    field_types = {field["name"]: field["type"] for field in versions_table.properties.fields}
    attributes = {object_id_field: row.attributes[object_id_field]}
    for key, value in updates.items():
        if key not in field_types or value is None:
            continue
        attributes[key] = epoch_milliseconds_from_utc_iso(value) if field_types[key] == "esriFieldTypeDate" else value

    service_manager.update_definition({"capabilities": "Query,Update"})
    try:
        result = versions_table.edit_features(updates=[{"attributes": attributes}])
    finally:
        service_manager.update_definition({"capabilities": "Query"})
    update_result = result["updateResults"][0]
    if not update_result.get("success"):
        print(f"  versions table update error: {update_result.get('error')}")
    return bool(update_result.get("success"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--product", required=True, choices=sorted(PRODUCTS))
    parser.add_argument("--version", required=True, help="Version label, for example m1-v1.")
    parser.add_argument("--publish", action="store_true", help="Write to the portal. Without it, print the plan only.")
    parser.add_argument(
        "--upload-raw-csv",
        action="store_true",
        help="modeled-wse only: also upload the raw hourly CSV zips as unpublished items.",
    )
    arguments = parser.parse_args()

    product_settings = PRODUCTS[arguments.product]
    version_folder = (
        REPOSITORY_ROOT / "data" / "data-product-versions" / arguments.product / product_settings["method_id"] / arguments.version
    )
    version_path = version_folder / "version.json"
    if not version_path.exists():
        raise SystemExit(f"No frozen version at {version_folder}. Run the freeze script first.")
    version = json.loads(version_path.read_text(encoding="utf-8"))

    registry = read_registry()
    registry_entry = registry["products"][arguments.product]
    registry_version = next(item for item in registry_entry["versions"] if item["version_label"] == arguments.version)
    if registry_version["arcgis"].get("service_item_id"):
        raise SystemExit(
            f"{arguments.product} {arguments.version} is already published ({registry_version['arcgis']['service_item_id']}). "
            "Versions are append-only."
        )

    upload_zip = next((version_folder / "arcgis-upload").glob("*.gdb.zip"))
    raw_csv_zips = sorted((version_folder / "raw-hourly-values").glob("*.csv.zip")) if arguments.upload_raw_csv else []
    service_name = registry_entry["arcgis_service_name"]
    title = registry_entry["title"]
    tags = COMMON_TAGS + [arguments.product, arguments.version]
    description = build_item_description(arguments.product, version, title)
    snippet = f"{title} ({arguments.version}). Private until the Creek Water Visualization experience is released."

    print(f"Plan: publish {arguments.product} {arguments.version}")
    print(f"  portal folder: {PORTAL_FOLDER_NAME} (private, owner only)")
    print(f"  service: {service_name}  title: {title}")
    print(f"  upload: {upload_zip.relative_to(REPOSITORY_ROOT)} ({upload_zip.stat().st_size / 1048576:.1f} MB)")
    for entry in describe_file_geodatabase(upload_zip):
        print(f"    {entry['name']}: {entry['geometry_type'] or 'table'}, {entry['rows']:,} rows")
    for csv_zip in raw_csv_zips:
        print(f"  raw CSV item: {csv_zip.name} ({csv_zip.stat().st_size / 1048576:.1f} MB)")
    if not arguments.publish:
        print("Dry run only. Add --publish to write to the portal.")
        return

    from arcgis.gis import GIS

    portal_url, username, password = load_portal_credentials()
    gis = GIS(portal_url, username, password)
    print(f"Signed in as {gis.users.me.username}.")
    if not gis.content.is_service_name_available(service_name, "featureService"):
        raise SystemExit(f"Service name {service_name} is already taken on the portal. Nothing was changed.")

    folder = get_or_create_portal_folder(gis, PORTAL_FOLDER_NAME)
    created_item_ids: list[str] = []
    try:
        print("Uploading file geodatabase…")
        geodatabase_item = folder.add(
            {
                "title": f"{title} {arguments.version} (file geodatabase)",
                "type": "File Geodatabase",
                "tags": tags + ["source-upload"],
                "snippet": f"Source upload for {title} {arguments.version}.",
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
                "name": service_name,
                "targetSR": {"wkid": 4326},
                "maxRecordCount": 10000,
                "hasStaticData": True,
                "capabilities": "Query",
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
        print(f"  sharing: {service_item.access}")

        for note in add_indexes_and_time(service_item):
            print(f"  {note}")

        layer_ids = {layer.properties.name: layer.properties.id for layer in all_layers_and_tables(service_item)}
        row_counts = {
            layer.properties.name: layer.query(where="1=1", return_count_only=True)
            for layer in all_layers_and_tables(service_item)
        }
        for name, count in row_counts.items():
            print(f"  {name} (id {layer_ids[name]}): {count:,} rows")

        raw_csv_item_ids: dict[str, str] = {}
        for csv_zip in raw_csv_zips:
            print(f"Uploading raw hourly values {csv_zip.name}…")
            csv_description = description + f"<p>Hosted feature layer: {service_item.url}</p>"
            water_year, csv_item = upload_raw_csv_item(folder, csv_zip, title, arguments.version, tags, csv_description)
            created_item_ids.append(csv_item.id)
            raw_csv_item_ids[water_year] = csv_item.id
            print(f"  {water_year}: {csv_item.id} ({csv_item.type})")

        published_at_utc = utc_now_iso()
        row_updated = update_versions_table_row(
            service_item,
            product_settings["versions_table"],
            arguments.version,
            {
                "published_at_utc": published_at_utc,
                "arcgis_table_names": json.dumps(layer_ids, sort_keys=True),
                "raw_hourly_csv_item_ids": json.dumps(raw_csv_item_ids, sort_keys=True) if raw_csv_item_ids else None,
            },
        )
        print(f"  versions table row updated: {row_updated}")

        arcgis_record = dict(registry_version["arcgis"])
        arcgis_record.update(
            {
                "service_item_id": service_item.id,
                "service_url": service_item.url,
                "file_geodatabase_item_id": geodatabase_item.id,
                "published_at_utc": published_at_utc,
                "portal_folder": PORTAL_FOLDER_NAME,
                "row_counts": row_counts,
                "layer_ids": layer_ids,
            }
        )
        if raw_csv_item_ids:
            arcgis_record["raw_hourly_csv_item_ids"] = raw_csv_item_ids

        latest_registry = read_registry()
        latest_entry = latest_registry["products"][arguments.product]
        for item in latest_entry["versions"]:
            if item["version_label"] == arguments.version:
                item["arcgis"] = arcgis_record
        latest_entry["service_item_id"] = service_item.id
        latest_entry["service_url"] = service_item.url
        write_json(REGISTRY_PATH, latest_registry)
        print(f"Registry updated: {REGISTRY_PATH.relative_to(REPOSITORY_ROOT)}")
        print("Done.")
    except Exception:
        print(
            f"FAILED. Items created in this run were left in place for inspection (never deleted): {created_item_ids}",
            file=sys.stderr,
        )
        raise


if __name__ == "__main__":
    main()
