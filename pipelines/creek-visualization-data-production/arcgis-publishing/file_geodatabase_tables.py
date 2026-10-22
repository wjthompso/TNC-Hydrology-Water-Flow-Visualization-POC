"""Write and read Esri file geodatabase tables with pyogrio's OpenFileGDB driver (UCS-285).

Columns are pyarrow arrays, so field types are explicit: text with a width,
int16 (SmallInteger), int32 (Integer), float64 (Double), and UTC timestamps
(Date fields holding real datetimes, never strings). Do not use ogr2ogr here.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyogrio
from pyogrio.raw import read_arrow, write_arrow

GDAL_WIDTH_METADATA_KEY = "GDAL:OGR:width"
UTC_MILLISECOND_TIMESTAMP = pa.timestamp("ms", tz="UTC")


def text_column(name: str, values, width: int) -> tuple[pa.Field, pa.Array]:
    array = pa.array(values, type=pa.string())
    longest = max((len(value) for value in array.to_pylist() if value is not None), default=0)
    if longest > width:
        raise ValueError(f"Text field {name} needs {longest} characters but its width is {width}")
    return pa.field(name, pa.string(), metadata={GDAL_WIDTH_METADATA_KEY: str(width)}), array


def short_integer_column(name: str, values) -> tuple[pa.Field, pa.Array]:
    return pa.field(name, pa.int16()), pa.array(values, type=pa.int16())


def integer_column(name: str, values) -> tuple[pa.Field, pa.Array]:
    return pa.field(name, pa.int32()), pa.array(values, type=pa.int32())


def double_column(name: str, values) -> tuple[pa.Field, pa.Array]:
    """NaN in a numpy array becomes a null field value."""
    if isinstance(values, np.ndarray):
        array = pa.array(values, type=pa.float64(), from_pandas=True)
    else:
        array = pa.array(values, type=pa.float64())
    return pa.field(name, pa.float64()), array


def utc_date_column(name: str, epoch_ms_values) -> tuple[pa.Field, pa.Array]:
    """Epoch milliseconds (or None) → a UTC Date field."""
    if isinstance(epoch_ms_values, np.ndarray):
        array = pa.array(epoch_ms_values.astype("datetime64[ms]"), type=UTC_MILLISECOND_TIMESTAMP)
    else:
        array = pa.array(epoch_ms_values, type=pa.int64()).cast(UTC_MILLISECOND_TIMESTAMP)
    return pa.field(name, UTC_MILLISECOND_TIMESTAMP), array


def write_table(
    gdb_path: Path,
    layer_name: str,
    columns: list[tuple[pa.Field, pa.Array]],
    geometry_wkb: list[bytes] | None = None,
    geometry_type: str | None = None,
) -> int:
    """Write one table (or, with geometry_wkb, one EPSG:4326 feature class) into gdb_path."""
    fields = [field for field, _ in columns]
    arrays = [array for _, array in columns]
    geometry_name = None
    if geometry_wkb is not None:
        geometry_name = "geometry"
        fields.append(pa.field(geometry_name, pa.binary(), metadata={"ARROW:extension:name": "geoarrow.wkb"}))
        arrays.append(pa.array(geometry_wkb, type=pa.binary()))
    table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
    write_arrow(
        table,
        str(gdb_path),
        layer=layer_name,
        driver="OpenFileGDB",
        geometry_name=geometry_name,
        geometry_type=geometry_type,
        crs="EPSG:4326" if geometry_wkb is not None else None,
    )
    return table.num_rows


def read_table(gdb_path: Path, layer_name: str, max_features: int | None = None) -> pa.Table:
    _, table = read_arrow(str(gdb_path), layer=layer_name, max_features=max_features)
    return table


def layer_names(gdb_path: Path) -> list[str]:
    return [str(name) for name, _ in pyogrio.list_layers(str(gdb_path))]


def layer_info(gdb_path: Path, layer_name: str) -> dict:
    return pyogrio.read_info(str(gdb_path), layer=layer_name)


def zip_folder(folder: Path, zip_path: Path) -> None:
    """Zip a .gdb folder so the archive root holds the folder itself (what ArcGIS expects)."""
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file_path in sorted(folder.rglob("*")):
            if file_path.is_file():
                archive.write(file_path, arcname=f"{folder.name}/{file_path.relative_to(folder).as_posix()}")


def unzip_gdb(zip_path: Path, destination: Path) -> Path:
    """Extract a zipped .gdb and return the .gdb folder path."""
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(destination)
        top_level_names = {name.split("/", 1)[0] for name in archive.namelist()}
    gdb_folders = [name for name in top_level_names if name.endswith(".gdb")]
    if len(gdb_folders) != 1:
        raise ValueError(f"Expected one .gdb folder in {zip_path}, found {sorted(top_level_names)}")
    return destination / gdb_folders[0]
