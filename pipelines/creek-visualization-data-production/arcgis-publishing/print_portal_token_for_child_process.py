"""Print a short-lived ArcGIS portal token to stdout, for a parent process to capture in memory.

Used by scripts/verify-hosted-modeled-data-equivalence.ts, which spawns this script, reads the
token from the pipe, and passes it to the hosted adapters. The token is never printed by the
parent, logged, or written to disk. Do not run this script in an interactive terminal unless
you intend to see a live token.

Credentials come from a dotenv file (keys ARCGIS_URL, ARCGIS_USERNAME, ARCGIS_PASSWORD):
ARCGIS_DOTENV_PATH when set, else ../../Data-Pipeline/.env relative to the repository root.

    conda run --no-capture-output -p <Data-Pipeline>/conda-env python print_portal_token_for_child_process.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DOTENV_PATH = REPOSITORY_ROOT.parent.parent / "Data-Pipeline" / ".env"


def main() -> int:
    load_dotenv(os.environ.get("ARCGIS_DOTENV_PATH", str(DEFAULT_DOTENV_PATH)))
    missing = [key for key in ("ARCGIS_URL", "ARCGIS_USERNAME", "ARCGIS_PASSWORD") if not os.environ.get(key)]
    if missing:
        print(f"Missing credential keys in the dotenv file: {', '.join(missing)}", file=sys.stderr)
        return 1

    # Imported after the credential check: arcgis is slow to import.
    from arcgis.gis import GIS

    gis = GIS(os.environ["ARCGIS_URL"], os.environ["ARCGIS_USERNAME"], os.environ["ARCGIS_PASSWORD"])
    token = gis._con.token
    if not token:
        print("Signed in, but the portal returned no token.", file=sys.stderr)
        return 1
    sys.stdout.write(token)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
