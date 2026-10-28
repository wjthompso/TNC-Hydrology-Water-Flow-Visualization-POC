"""Make the default modeled pairing's hosted services public (Everyone), with plain-language item text.

The browser's production build opens modeled WSE m5-v1 drawn on WSE polygons m3-v2 (the channel ribbon), whose rings it
reads from the supplementary exact-rings service. This script shares exactly those three service items with Everyone:

    modeled WSE   m5-v1   creek_water_visualization_modeled_wse_m5_v1
    WSE polygons  m3-v2   creek_water_visualization_wse_polygons_m3_v2
    WSE polygons  m3-v2   creek_water_visualization_wse_polygons_m3_v2_rings  (arcgis.exact_rings_service)

Their file geodatabase items, raw hourly CSV items, and every other version stay as they are (private). The m1-v1 items
are never touched. For each service it records the sharing before and after, replaces "Experimental, private." in the
snippet, puts a plain-language description (the style of item-metadata/) above the technical one, saves the public item
text as item-metadata/<product>-<label>[-rings]-service.json (fetched anonymously), and adds `public_sharing` to the
version's registry `arcgis` record (a new field; nothing already set changes). Nothing is deleted.

    npm run data-products:share-default-pairing-services                          # dry run: the plan and current sharing
    npm run data-products:share-default-pairing-services -- --publish --output <before-after.json>
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_product_version_identity import MODELED_WSE, WSE_POLYGONS  # noqa: E402
from data_product_versions import read_registry, update_registry_version, utc_now_iso, write_json  # noqa: E402
from publish_data_products_to_arcgis import ACCESS_INFORMATION, LICENSE_INFORMATION, load_portal_credentials  # noqa: E402

ITEM_METADATA_FOLDER = Path(__file__).resolve().parent / "item-metadata"
PORTAL_ITEM_URL = "https://dangermondpreserve-spatial.com/portal/sharing/rest/content/items/{item_id}?f=json"
PRIVATE_SNIPPET_ENDING = "Experimental, private."
PUBLIC_SNIPPET_ENDING = "Shown by default in the Creek Water Visualization."
PRIVATE_DESCRIPTION_SENTENCE = "Experimental: shared with its owner only until the team decides otherwise."
PUBLIC_DESCRIPTION_SENTENCE = "Shared publicly as the Creek Water Visualization's default modeled water; other versions stay private."
SAVED_FIELDS = ("id", "type", "title", "snippet", "description", "tags", "accessInformation", "licenseInfo", "access")

ACCURACY = (
    "<p><b>Accuracy and limits</b><br />These are estimates, not measurements. The stream flows are modeled without gauge "
    "correction and may be off by a factor of 2 to 5, so the timing of rises and falls is more reliable than the heights. "
    "The water depth assumes steady flow over a bare-earth lidar terrain that cannot see the underwater channel bed. Use "
    "them for research and visualization.</p>"
)

PLAIN_INTRO = {
    (MODELED_WSE, "m5-v1"): (
        "<p><b>What this is</b><br />Inferred <b>water surface elevation (WSE)</b> and water depth for every short stretch of "
        "creek (Creek Segment) in the Jack and Laura Dangermond Preserve, California, every hour from October 2020 to "
        "January 2023 and every month from 1950 to 2024, in meters above the North American Vertical Datum of 1988 (NAVD88). "
        "This is the version the Creek Water Visualization shows by default.</p>"
        "<p><b>How it was made</b><br />Modeled stream flow (NOAA National Water Model v3.0 retrospective, hourly; California "
        "Natural Flows, monthly) is shared out to each creek stretch by the land area draining into it. The creek bed is the "
        "1-meter USGS 3DEP lidar at the creek's lowest point, with no smoothing. At one cross-section per stretch, a "
        "flow-resistance law fitted to steep mountain streams (Jarrett, 1984) gives the water depth; on steep creeks the "
        "water runs slower and deeper than with a fixed Manning roughness. Pools behind steps are filled level.</p>"
    ),
    (WSE_POLYGONS, "m3-v2"): (
        "<p><b>What this is</b><br />Water outlines for the creeks of the Jack and Laura Dangermond Preserve, California: one "
        "continuous ribbon of water along each creek channel, with its edges drawn for 19 water depths from 1 centimeter to "
        "8 meters. Each outline vertex carries the creek-bed elevation (m NAVD88) as Z, so the water can sit at the right "
        "depth above the bed on a 3D map. Pair it with the inferred water surface elevations (m5-v1) to see where the water "
        "was at any hour. This is the version the Creek Water Visualization shows by default.</p>"
        "<p><b>How it was made</b><br />At stations about 2 meters apart along the creek's lowest path in the 1-meter USGS "
        "3DEP lidar, a cross-section is flooded to each depth and its two water edges are joined into a ribbon.</p>"
    ),
    (WSE_POLYGONS, "m3-v2-rings"): (
        "<p><b>What this is</b><br />The same water outlines as the companion WSE polygons layer (m3-v2), stored exactly as "
        "computed: one row per creek stretch and water depth, with the outline as text. When the layer was published, the "
        "map server split outlines that cross themselves (where a ribbon folds at a bend) into simple pieces. The Creek Water "
        "Visualization reads this table instead, so it can draw each ribbon in its original order along the creek.</p>"
    ),
}


def registry_entry(product: str, version_label: str) -> dict:
    (entry,) = [entry for entry in read_registry()["products"][product]["versions"] if entry["version_label"] == version_label]
    return entry


def services() -> list[dict]:
    """The three service items, each with the registry record it is described by."""
    modeled = registry_entry(MODELED_WSE, "m5-v1")
    polygons = registry_entry(WSE_POLYGONS, "m3-v2")
    rings = polygons["arcgis"].get("exact_rings_service")
    if not rings:
        raise SystemExit("WSE polygons m3-v2 has no arcgis.exact_rings_service yet; publish the rings first.")
    return [
        {"product": MODELED_WSE, "label": "m5-v1", "item_id": modeled["arcgis"]["service_item_id"], "url": modeled["arcgis"]["service_url"]},
        {"product": WSE_POLYGONS, "label": "m3-v2", "item_id": polygons["arcgis"]["service_item_id"], "url": polygons["arcgis"]["service_url"]},
        {"product": WSE_POLYGONS, "label": "m3-v2-rings", "item_id": rings["service_item_id"], "url": rings["service_url"]},
    ]


def public_text(service: dict, item) -> dict:
    snippet = item.snippet.replace(PRIVATE_SNIPPET_ENDING, PUBLIC_SNIPPET_ENDING)
    if PUBLIC_SNIPPET_ENDING not in snippet:
        snippet = f"{snippet} {PUBLIC_SNIPPET_ENDING}"
    technical = item.description.replace(PRIVATE_DESCRIPTION_SENTENCE, PUBLIC_DESCRIPTION_SENTENCE)
    description = (
        PLAIN_INTRO[(service["product"], service["label"])]
        + ACCURACY
        + f"<p><b>Service</b><br />{service['url']}</p>"
        + "<p><b>Technical details</b></p>"
        + technical
    )
    return {"snippet": snippet, "description": description, "accessInformation": ACCESS_INFORMATION, "licenseInfo": LICENSE_INFORMATION}


def anonymous_item_json(item_id: str) -> dict:
    with urllib.request.urlopen(PORTAL_ITEM_URL.format(item_id=item_id), timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--publish", action="store_true", help="Share and edit the items. Without it, print the plan only.")
    parser.add_argument("--output", type=Path, help="Write the before/after sharing record here (JSON).")
    arguments = parser.parse_args()

    from arcgis.gis import GIS

    portal_url, username, password = load_portal_credentials()
    gis = GIS(portal_url, username, password)
    print(f"Signed in as {gis.users.me.username}.")
    record = {"started_at_utc": utc_now_iso(), "services": []}
    for service in services():
        item = gis.content.get(service["item_id"])
        if item.owner != gis.users.me.username or item.type != "Feature Service" or item.url.rstrip("/") != service["url"].rstrip("/"):
            raise SystemExit(f"{service['item_id']} is not the signed-in user's feature service at {service['url']}. Nothing was changed.")
        entry = {**service, "title": item.title, "access_before": item.access}
        print(f"  {service['product']} {service['label']}: item {item.id}, {item.title!r}, sharing {item.access}")
        if arguments.publish:
            text = public_text(service, item)
            item.update(item_properties=text)
            item.sharing.sharing_level = "EVERYONE"
            refreshed = gis.content.get(service["item_id"])
            entry["access_after"] = refreshed.access
            entry["shared_at_utc"] = utc_now_iso()
            time.sleep(1)
            public_item = anonymous_item_json(service["item_id"])
            entry["anonymous_item_access"] = public_item.get("access")
            write_json(
                ITEM_METADATA_FOLDER / f"{service['product']}-{service['label']}-service.json",
                {field: public_item.get(field) for field in SAVED_FIELDS},
            )
            sharing = {"access": refreshed.access, "shared_at_utc": entry["shared_at_utc"], "access_before": entry["access_before"]}
            if service["label"].endswith("-rings"):
                arcgis_update = {"exact_rings_service": {"public_sharing": sharing}}
            else:
                arcgis_update = {"public_sharing": sharing}
            update_registry_version(
                service["product"],
                {"version_label": service["label"].removesuffix("-rings"), "arcgis": arcgis_update},
                allow_update_of_null_arcgis_fields=True,
            )
            print(f"    now {refreshed.access}; anonymous item read: {entry['anonymous_item_access']}")
        record["services"].append(entry)
    if arguments.output:
        write_json(arguments.output, record)
    if not arguments.publish:
        print("Dry run only. Add --publish to share these three items with Everyone.")


if __name__ == "__main__":
    main()
