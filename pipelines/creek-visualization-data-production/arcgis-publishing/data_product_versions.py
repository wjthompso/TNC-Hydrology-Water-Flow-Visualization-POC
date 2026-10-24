"""Shared helpers for freezing and registering data-product versions (UCS-285).

A data-product version is a frozen, append-only copy of pipeline output that is
(or will be) published to ArcGIS. Layout (see data/README.md):

    data/data-product-versions/<product>/<method-id>/<version-label>/
    data/data-product-version-registry.json

Public API (kept small on purpose; other freeze scripts import it):

    REPOSITORY_ROOT, DATA_FOLDER, PIPELINE_WORKING_OUTPUT_FOLDER,
    DATA_PRODUCT_VERSIONS_FOLDER, DATA_PRODUCT_VERSION_REGISTRY_PATH

    version_folder_path(product, method_id, version_label) -> Path
    create_version_folder(product, method_id, version_label) -> Path
        Creates the folder; raises VersionFolderAlreadyExistsError if it exists.
    staged_version_folder(product, method_id, version_label, final_folder=None)   (context manager)
        Yields a hidden sibling staging folder; on success renames it to the final
        version folder (refusing if that appeared meanwhile); on error deletes the
        staging folder, so a failed freeze never leaves a half-written version.
    sha256_of_file(path) -> str
    sha256_of_bytes(data) -> str
    code_fingerprint(paths, commit=None) -> {"sha256": str, "files": [{"path", "sha256"}]}
        sha256 over sorted "repo-relative-path:sha256" lines ("\n"-joined). With a
        commit, file bytes come from that commit (git show <commit>:<path>), not the
        working tree.
    git_uncommitted_paths(paths) -> [repo-relative paths with working-tree changes]
    git_head_commit() -> str
    git_commit(commit) -> {"commit": full sha, "date_utc": str}
    git_last_commit(paths, before_iso=None) -> {"commit": str, "date_utc": str} | None
    git_last_commit_date(paths, before_iso=None) -> str | None   (ISO 8601 UTC "...Z")
    utc_iso_from_epoch_ms(ms) -> str
    read_registry() -> dict
    write_registry(registry) -> None
    update_registry_version(product, version_record, product_fields=None) -> dict
        Adds a version to a product entry (merging by version_label). Refuses to
        replace an existing version unless allow_update_of_null_arcgis_fields=True
        and only null ArcGIS fields would change.
    write_json(path, value) -> None
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Iterable, Iterator

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DATA_FOLDER = REPOSITORY_ROOT / "data"
PIPELINE_WORKING_OUTPUT_FOLDER = DATA_FOLDER / "pipeline-working-output"
DATA_PRODUCT_VERSIONS_FOLDER = DATA_FOLDER / "data-product-versions"
DATA_PRODUCT_VERSION_REGISTRY_PATH = DATA_FOLDER / "data-product-version-registry.json"

REGISTRY_SCHEMA_VERSION = 1


class VersionFolderAlreadyExistsError(RuntimeError):
    """Raised when a version folder already exists (versions are append-only)."""


class RegistryVersionConflictError(RuntimeError):
    """Raised when a registry write would overwrite an existing version record."""


# ---------------------------------------------------------------------------
# Version folders
# ---------------------------------------------------------------------------


def version_folder_path(product: str, method_id: str, version_label: str) -> Path:
    return DATA_PRODUCT_VERSIONS_FOLDER / product / method_id / version_label


def create_version_folder(product: str, method_id: str, version_label: str) -> Path:
    """Create an empty version folder. Refuses if it already exists (append-only)."""
    folder = version_folder_path(product, method_id, version_label)
    if folder.exists():
        raise VersionFolderAlreadyExistsError(
            f"Version folder already exists and versions are append-only: {folder}. "
            "Freeze a new version label instead of overwriting this one."
        )
    folder.parent.mkdir(parents=True, exist_ok=True)
    folder.mkdir(parents=False, exist_ok=False)
    return folder


@contextlib.contextmanager
def staged_version_folder(
    product: str, method_id: str, version_label: str, final_folder: Path | None = None
) -> Iterator[Path]:
    """Build a version in a staging folder, then move it into place in one rename.

    Refuses up front if the final folder exists. On any exception the staging folder
    is deleted and the final folder is never created. final_folder overrides the
    standard location (used for scratch trial runs outside data/).
    """
    final_folder = Path(final_folder) if final_folder else version_folder_path(product, method_id, version_label)
    if final_folder.exists():
        raise VersionFolderAlreadyExistsError(
            f"Version folder already exists and versions are append-only: {final_folder}. "
            "Freeze a new version label instead of overwriting this one."
        )
    final_folder.parent.mkdir(parents=True, exist_ok=True)
    staging_folder = final_folder.parent / f".{version_label}.staging-{os.getpid()}"
    if staging_folder.exists():
        shutil.rmtree(staging_folder)
    staging_folder.mkdir()
    try:
        yield staging_folder
        if final_folder.exists():
            raise VersionFolderAlreadyExistsError(f"Version folder appeared while building: {final_folder}")
        staging_folder.rename(final_folder)
    except BaseException:
        shutil.rmtree(staging_folder, ignore_errors=True)
        raise


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------


def sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def repository_relative_path(path: Path) -> str:
    return Path(path).resolve().relative_to(REPOSITORY_ROOT).as_posix()


def code_fingerprint(paths: Iterable[Path], commit: str | None = None) -> dict:
    """sha256 over sorted 'repo-relative-path:sha256' lines of the given files.

    With commit, hashes each file as stored in that commit; otherwise the working tree.
    """
    files = []
    for path in paths:
        relative_path = repository_relative_path(path)
        if commit is None:
            file_sha256 = sha256_of_file(path)
        else:
            file_sha256 = sha256_of_bytes(_run_git_bytes(["show", f"{commit}:{relative_path}"]))
        files.append({"path": relative_path, "sha256": file_sha256})
    files.sort(key=lambda file: file["path"])
    lines = [f"{file['path']}:{file['sha256']}" for file in files]
    return {"sha256": sha256_of_bytes("\n".join(lines).encode("utf-8")), "files": files}


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------


def _run_git(arguments: list[str]) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def _run_git_bytes(arguments: list[str]) -> bytes:
    completed = subprocess.run(["git", *arguments], cwd=REPOSITORY_ROOT, check=True, capture_output=True)
    return completed.stdout


def git_uncommitted_paths(paths: Iterable[Path | str]) -> list[str]:
    """Repo-relative paths among `paths` whose working tree differs from HEAD (or untracked)."""
    # Not _run_git: its strip() would eat the leading status column of the first line.
    output = _run_git_bytes(["status", "--porcelain", "--", *(str(path) for path in paths)]).decode("utf-8")
    return sorted(line[3:] for line in output.splitlines() if line.strip())


def git_head_commit() -> str:
    return _run_git(["rev-parse", "HEAD"])


def git_commit(commit: str) -> dict:
    """Full sha and committer date of one commit: {"commit": str, "date_utc": "...Z"}."""
    output = _run_git(["log", "-1", "--format=%H %cI", commit])
    full_commit, date = output.split(" ", 1)
    return {"commit": full_commit, "date_utc": _git_iso_to_utc_z(date)}


def _git_iso_to_utc_z(git_iso_date: str) -> str:
    parsed = dt.datetime.fromisoformat(git_iso_date)
    return parsed.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_last_commit(paths: Iterable[Path | str], before_iso: str | None = None) -> dict | None:
    """Latest commit (on HEAD's history) touching any path, optionally at or before a time.

    Returns {"commit": full sha, "date_utc": committer date "YYYY-MM-DDTHH:MM:SSZ"} or None.
    """
    arguments = ["log", "-1", "--format=%H %cI"]
    if before_iso:
        arguments.append(f"--before={before_iso}")
    arguments.append("--")
    arguments.extend(str(path) for path in paths)
    output = _run_git(arguments)
    if not output:
        return None
    commit, date = output.split(" ", 1)
    return {"commit": commit, "date_utc": _git_iso_to_utc_z(date)}


def git_first_commit_with_method_code(code_sha256_by_file: dict[str, str]) -> tuple[dict, str]:
    """The earliest commit holding exactly the method code a stage recorded, and a sentence saying so.

    `code_sha256_by_file` maps repository-relative paths to the SHA-256 the stage manifest recorded.
    Walks the commits that touched those files from newest to oldest and stops at the first one whose
    copy of any file differs; the oldest commit before that point is returned. Unlike
    git_last_commit(before_iso=...), this still finds the right commit when the method was
    committed only after the stage ran (it was uncommitted work then), and it is not pulled back to an
    older commit that touched only a shared file.
    """
    log_output = _run_git(["log", "--format=%H", "--", *code_sha256_by_file])
    matching_commit = None
    for commit in log_output.splitlines():
        if not all(
            _file_sha256_at_commit(commit, path) == recorded_sha256 for path, recorded_sha256 in code_sha256_by_file.items()
        ):
            break
        matching_commit = commit
    if matching_commit is None:
        raise RuntimeError("No git commit holds exactly the method code files the stage recorded.")
    return git_commit(matching_commit), (
        "committer date of the earliest git commit whose copies of every method code file equal the SHA-256 the stage "
        "manifest recorded (the method code may have been committed after the stage ran)"
    )


def _file_sha256_at_commit(commit: str, relative_path: str) -> str | None:
    try:
        return sha256_of_bytes(_run_git_bytes(["show", f"{commit}:{relative_path}"]))
    except subprocess.CalledProcessError:
        return None  # the file did not exist in that commit


def git_last_commit_date(paths: Iterable[Path | str], before_iso: str | None = None) -> str | None:
    found = git_last_commit(paths, before_iso)
    return found["date_utc"] if found else None


# ---------------------------------------------------------------------------
# Time and JSON
# ---------------------------------------------------------------------------


def utc_iso_from_epoch_ms(epoch_ms: int) -> str:
    return dt.datetime.fromtimestamp(epoch_ms / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_now_iso() -> str:
    return dt.datetime.now(tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Registry (data/data-product-version-registry.json, tracked, no secrets)
# ---------------------------------------------------------------------------


def read_registry() -> dict:
    if not DATA_PRODUCT_VERSION_REGISTRY_PATH.exists():
        return {"registrySchemaVersion": REGISTRY_SCHEMA_VERSION, "products": {}}
    return json.loads(DATA_PRODUCT_VERSION_REGISTRY_PATH.read_text(encoding="utf-8"))


def write_registry(registry: dict) -> None:
    write_json(DATA_PRODUCT_VERSION_REGISTRY_PATH, registry)


def _only_null_fields_change(existing: dict, incoming: dict) -> bool:
    for key, new_value in incoming.items():
        old_value = existing.get(key)
        if old_value == new_value:
            continue
        if old_value is None:
            continue
        if isinstance(old_value, dict) and isinstance(new_value, dict):
            if not _only_null_fields_change(old_value, new_value):
                return False
            continue
        return False
    return True


def _merge_filling_nulls(existing: dict, incoming: dict) -> dict:
    merged = dict(existing)
    for key, new_value in incoming.items():
        old_value = merged.get(key)
        if isinstance(old_value, dict) and isinstance(new_value, dict):
            merged[key] = _merge_filling_nulls(old_value, new_value)
        elif old_value is None:
            merged[key] = new_value
    return merged


def update_registry_version(
    product: str,
    version_record: dict,
    product_fields: dict | None = None,
    allow_update_of_null_arcgis_fields: bool = False,
) -> dict:
    """Add one version record to a product entry and write the registry.

    version_record must contain "version_label". If that label already exists the
    call raises RegistryVersionConflictError, unless allow_update_of_null_arcgis_fields
    is True and every changed field was previously null (used after publishing to fill
    ArcGIS item/layer ids). product_fields (e.g. title, description) are set only
    where missing. Returns the written registry.
    """
    version_label = version_record["version_label"]
    registry = read_registry()
    registry.setdefault("registrySchemaVersion", REGISTRY_SCHEMA_VERSION)
    products = registry.setdefault("products", {})
    product_entry = products.setdefault(product, {"product": product, "versions": []})
    for key, value in (product_fields or {}).items():
        product_entry.setdefault(key, value)
    versions = product_entry.setdefault("versions", [])

    for index, existing in enumerate(versions):
        if existing.get("version_label") != version_label:
            continue
        if existing == version_record:
            write_registry(registry)
            return registry
        if allow_update_of_null_arcgis_fields and _only_null_fields_change(existing, version_record):
            versions[index] = _merge_filling_nulls(existing, version_record)
            write_registry(registry)
            return registry
        raise RegistryVersionConflictError(
            f"Registry already has {product} {version_label} with different values; "
            "versions are append-only. Freeze a new version label instead."
        )

    versions.append(version_record)
    write_registry(registry)
    return registry
