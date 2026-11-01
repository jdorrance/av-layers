#!/usr/bin/env python3
"""Build the soaring-land-v1 coverage bitsets from pinned Natural Earth 1:50m admin-0.

Regenerate with:
  uv run --python 3.14.7 --with shapely==2.1.2 --with pyproj==3.7.2 \
    --with pyshp==2.3.1 python scripts/masks/build_masks.py \
    --source ne_50m_admin_0_countries.zip \
    --output packages/contracts/coverage
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import sys
import tempfile
import urllib.request
import zipfile
from importlib.metadata import version as distribution_version
from pathlib import Path

import shapefile
from pyproj import CRS, Transformer, proj_version_str
from shapely import affinity, geos_version_string, intersects, make_valid, prepare, unary_union
from shapely.geometry import MultiPolygon, Point, Polygon, box, shape
from shapely.ops import transform
from shapely.strtree import STRtree

SOURCE_URL = (
    "https://naturalearth.s3.amazonaws.com/50m_cultural/"
    "ne_50m_admin_0_countries.zip"
)
SOURCE_SHA256 = "5fed433373581fa648920435f937d95f2d3c0200e067409c6478dcdf1b853139"
SOURCE_RELEASE = "5.1.1"
SOURCE_DATASET = "Natural Earth 1:50m Admin 0 Countries"
SOURCE_LICENSE = "public-domain"
SOURCE_ARCHIVE_BYTES = 799734

if geos_version_string != "3.13.1" or proj_version_str != "9.5.1":
    raise SystemExit("Mask regeneration requires GEOS 3.13.1 and PROJ 9.5.1")

POLICY_ID = "soaring-land-v1"
LAT_MIN = -55.0
LAT_MAX = 65.0
SEA_BUFFER_METERS = 50_000.0
EXCLUDED_A3 = ("RUS", "ATA", "GRL")

LON0 = -180.0
LAT0 = 90.0
WIDTH = 1440
HEIGHT = 721
DX = 0.25
DY = -0.25
CELL_HALF = 0.125
CELL_COUNT = WIDTH * HEIGHT
CELL_BYTES = (CELL_COUNT + 7) // 8

TILE_ZOOMS = (0, 1, 2, 3, 4, 5, 6, 7)
TILE_OFFSETS = {}
_running = 0
for _z in TILE_ZOOMS:
    TILE_OFFSETS[str(_z)] = _running
    _running += 4**_z
TILE_TOTAL_BITS = _running
TILE_BYTES = (TILE_TOTAL_BITS + 7) // 8

ROW_MIN = int(round((LAT0 - LAT_MAX) / -DY))
ROW_MAX = int(round((LAT0 - LAT_MIN) / -DY))

TILE_DEG = 10.0
TILE_HALF_DEG = TILE_DEG / 2.0
TILE_LON_PAD = 4.0
TILE_LAT_PAD = 2.0
BUFFER_QUAD_SEGS = 16


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download_source(dest: Path) -> None:
    with urllib.request.urlopen(SOURCE_URL) as response:
        dest.write_bytes(response.read())


def materialize_source(source: Path | None, workdir: Path) -> tuple[Path, Path]:
    archive = source
    if archive is None:
        archive = workdir / "ne_50m_admin_0_countries.zip"
        download_source(archive)
    actual = sha256_file(archive)
    if actual != SOURCE_SHA256:
        raise SystemExit(
            f"source checksum mismatch: expected {SOURCE_SHA256}, got {actual}"
        )
    if zipfile.is_zipfile(archive):
        extract_dir = workdir / "ne"
        extract_dir.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(extract_dir)
        return archive, extract_dir / "ne_50m_admin_0_countries.shp"
    return archive, archive


def fill_holes(geom):
    geom = make_valid(geom)
    if geom.is_empty:
        return geom
    parts = []
    raw = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
    for part in raw:
        if isinstance(part, Polygon):
            if part.area > 0:
                parts.append(Polygon(part.exterior))
        elif isinstance(part, MultiPolygon):
            for p in part.geoms:
                if p.area > 0:
                    parts.append(Polygon(p.exterior))
    if not parts:
        return Polygon()
    return unary_union(parts)


def polygon_parts(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return [p for p in geom.geoms if not p.is_empty]
    if hasattr(geom, "geoms"):
        out = []
        for g in geom.geoms:
            out.extend(polygon_parts(g))
        return out
    return []


def load_features(shp_path: Path):
    reader = shapefile.Reader(str(shp_path))
    admitted = []
    excluded = []
    iso_exceptions = []
    for sr in reader.iterShapeRecords():
        rec = sr.record.as_dict()
        adm0 = rec.get("ADM0_A3")
        iso3 = rec.get("ISO_A3")
        iso3_eh = rec.get("ISO_A3_EH")
        if (iso3 == "-99" or iso3_eh != iso3) and adm0 not in EXCLUDED_A3:
            iso_exceptions.append(
                {
                    "admin": rec.get("ADMIN"),
                    "adm0_a3": adm0,
                    "iso_a3": iso3,
                    "iso_a3_eh": iso3_eh,
                    "iso_a2": rec.get("ISO_A2"),
                    "iso_a2_eh": rec.get("ISO_A2_EH"),
                }
            )
        geom = fill_holes(shape(sr.shape.__geo_interface__))
        for part in polygon_parts(geom):
            if adm0 in EXCLUDED_A3:
                excluded.append(part)
            else:
                admitted.append(part)
    iso_exceptions.sort(key=lambda r: (r["adm0_a3"] or "", r["admin"] or ""))
    return admitted, unary_union(excluded), iso_exceptions


def local_aeqd(lat0: float) -> tuple[Transformer, Transformer]:
    crs = CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat0:.12f} +lon_0=0 +datum=WGS84 "
        "+units=m +no_defs +over"
    )
    forward = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    inverse = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    return forward, inverse


def build_tile_geometry(parts, lon_center: float, lat_center: float):
    core = box(
        lon_center - TILE_HALF_DEG,
        max(LAT_MIN, lat_center - TILE_HALF_DEG),
        lon_center + TILE_HALF_DEG,
        min(LAT_MAX, lat_center + TILE_HALF_DEG),
    )
    if core.is_empty or core.area <= 0:
        return None
    expanded = box(
        lon_center - TILE_HALF_DEG - TILE_LON_PAD,
        max(-90.0, lat_center - TILE_HALF_DEG - TILE_LAT_PAD),
        lon_center + TILE_HALF_DEG + TILE_LON_PAD,
        min(90.0, lat_center + TILE_HALF_DEG + TILE_LAT_PAD),
    )
    pieces = []
    for part in parts:
        for shift in (-360.0, 0.0, 360.0):
            moved = affinity.translate(part, xoff=shift)
            if not moved.intersects(expanded):
                continue
            clipped = moved.intersection(expanded)
            pieces.extend(polygon_parts(clipped))
    if not pieces:
        return None

    merged = unary_union(pieces)
    fwd, inv = local_aeqd(lat_center)
    local = transform(lambda x, y, z=None: (x - lon_center, y), merged)
    project = transform(fwd.transform, local)
    buffered = project.buffer(SEA_BUFFER_METERS, quad_segs=BUFFER_QUAD_SEGS)
    if buffered.is_empty:
        return None
    unprojected = transform(inv.transform, buffered)
    absolute = affinity.translate(unprojected, xoff=lon_center)
    clipped = absolute.intersection(core)
    if clipped.is_empty:
        return None

    normalized = []
    for shift in (-360.0, 0.0, 360.0):
        moved = affinity.translate(clipped, xoff=shift)
        piece = moved.intersection(box(-180.0, -90.0, 180.0, 90.0))
        if not piece.is_empty:
            normalized.extend(polygon_parts(piece))
    if not normalized:
        return None
    return unary_union(normalized)


def dateline_shift_selfchecks():
    cases = [
        ("east_179_9_into_west_tile", 179.90, -175.0, -179.80),
        ("west_neg179_9_into_east_tile", -179.95, 175.0, 179.80),
    ]
    results = []
    for name, source_lon, tile_lon, probe_lon in cases:
        strip = box(source_lon, -0.05, source_lon + 0.05, 0.05)
        geom = build_tile_geometry([strip], tile_lon, 0.0)
        observed = bool(geom is not None and geom.contains(Point(probe_lon, 0.0)))
        results.append(
            {
                "name": name,
                "sourceLonRange": [source_lon, source_lon + 0.05],
                "tileCoreLon": [tile_lon - TILE_HALF_DEG, tile_lon + TILE_HALF_DEG],
                "probeLon": probe_lon,
                "expected": True,
                "observed": observed,
            }
        )
        if not observed:
            raise SystemExit(f"dateline shift selfcheck failed: {name}")
    return results


def cell_lon_intervals(col: int):
    center = LON0 + col * DX
    if col == 0:
        return (
            (center - CELL_HALF, center + CELL_HALF),
            (180.0 - CELL_HALF, 180.0 + CELL_HALF),
        )
    return ((center - CELL_HALF, center + CELL_HALF),)


def build_cell_boxes(rows, cols, lon_center, lat_center, clip_to_core: bool):
    tiles = []
    for row in rows:
        lat_center_cell = LAT0 + row * DY
        y0 = max(LAT_MIN, lat_center_cell - CELL_HALF)
        y1 = min(LAT_MAX, lat_center_cell + CELL_HALF)
        if clip_to_core:
            y0 = max(y0, lat_center - TILE_HALF_DEG)
            y1 = min(y1, lat_center + TILE_HALF_DEG)
        if y1 <= y0:
            continue
        for col in cols:
            for x0, x1 in cell_lon_intervals(col):
                a = max(-180.0, x0)
                b = min(180.0, x1)
                if clip_to_core:
                    a = max(a, lon_center - TILE_HALF_DEG)
                    b = min(b, lon_center + TILE_HALF_DEG)
                if b <= a:
                    continue
                tiles.append((row, col, box(a, y0, b, y1)))
    return tiles


def rasterize_admitted(tile_geoms) -> bytearray:
    active = bytearray(CELL_COUNT)
    for entry in tile_geoms:
        if entry is None:
            continue
        lon_center, lat_center, geom = entry
        if geom.is_empty:
            continue
        prepare(geom)
        lo = lon_center - TILE_HALF_DEG
        hi = lon_center + TILE_HALF_DEG
        col_min = max(0, math.ceil((lo - CELL_HALF - LON0) / DX - 1e-9))
        col_max = min(WIDTH - 1, math.floor((hi + CELL_HALF - LON0) / DX + 1e-9))
        cols = list(range(col_min, col_max + 1))
        if hi >= 180.0 - CELL_HALF and 0 not in cols:
            cols.append(0)
        row_min = max(
            ROW_MIN,
            math.ceil((LAT0 - (lat_center + TILE_HALF_DEG + CELL_HALF)) / -DY - 1e-9),
        )
        row_max = min(
            ROW_MAX,
            math.floor((LAT0 - (lat_center - TILE_HALF_DEG - CELL_HALF)) / -DY + 1e-9),
        )
        rows = list(range(row_min, row_max + 1))
        candidates = build_cell_boxes(rows, cols, lon_center, lat_center, True)
        if not candidates:
            continue
        boxes = [item[2] for item in candidates]
        hits = intersects(geom, boxes)
        for (row, col, _), hit in zip(candidates, hits):
            if hit:
                active[row * WIDTH + col] = 1
    return active


def apply_exclusions(active: bytearray, excluded_geom) -> int:
    if excluded_geom.is_empty:
        return 0
    prepare(excluded_geom)
    indices = [i for i, v in enumerate(active) if v]
    boxes = []
    owners = []
    for idx in indices:
        row, col = divmod(idx, WIDTH)
        lat = LAT0 + row * DY
        y0 = max(LAT_MIN, lat - CELL_HALF)
        y1 = min(LAT_MAX, lat + CELL_HALF)
        for x0, x1 in cell_lon_intervals(col):
            a = max(-180.0, x0)
            b = min(180.0, x1)
            if b <= a:
                continue
            boxes.append(box(a, y0, b, y1))
            owners.append(idx)
    if not boxes:
        return 0
    hits = intersects(excluded_geom, boxes)
    cleared = set()
    for idx, hit in zip(owners, hits):
        if hit and active[idx]:
            active[idx] = 0
            cleared.add(idx)
    return len(cleared)


def build_halo(active: bytearray) -> bytearray:
    halo = bytearray(CELL_COUNT)
    for idx, is_active in enumerate(active):
        if not is_active:
            continue
        row, col = divmod(idx, WIDTH)
        for dr in (-1, 0, 1):
            rr = row + dr
            if rr < 0 or rr >= HEIGHT:
                continue
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                cc = (col + dc) % WIDTH
                k = rr * WIDTH + cc
                if not active[k]:
                    halo[k] = 1
    return halo


def pack_bits(bits: bytearray) -> bytes:
    out = bytearray((len(bits) + 7) // 8)
    for idx, value in enumerate(bits):
        if value:
            out[idx >> 3] |= 1 << (idx & 7)
    return bytes(out)


def tile_lat(y: int, n: int) -> float:
    return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))


def build_tiles(active: bytearray):
    boxes = []
    for idx, is_active in enumerate(active):
        if not is_active:
            continue
        row, col = divmod(idx, WIDTH)
        lat = LAT0 + row * DY
        y0 = max(LAT_MIN, lat - CELL_HALF)
        y1 = min(LAT_MAX, lat + CELL_HALF)
        for x0, x1 in cell_lon_intervals(col):
            a = max(-180.0, x0)
            b = min(180.0, x1)
            if b > a:
                boxes.append(box(a, y0, b, y1))
    tree = STRtree(boxes)
    bits = bytearray(TILE_TOTAL_BITS)
    counts = {}
    active_tiles = []
    for z in TILE_ZOOMS:
        n = 2**z
        offset = TILE_OFFSETS[str(z)]
        count = 0
        for x in range(n):
            lon_min = -180.0 + x * 360.0 / n
            lon_max = -180.0 + (x + 1) * 360.0 / n
            for y in range(n):
                lat_max = tile_lat(y, n)
                lat_min = tile_lat(y + 1, n)
                probe = box(lon_min, lat_min, lon_max, lat_max)
                if len(tree.query(probe)) > 0:
                    bits[offset + y * n + x] = 1
                    count += 1
                    if z == 5:
                        active_tiles.append(f"{z}/{x}/{y}")
        counts[str(z)] = count
    return pack_bits(bits), counts, active_tiles


def nearest_cell(lat: float, lon: float) -> tuple[int, int, float, float]:
    row = int(math.floor((LAT0 - lat) / -DY + 0.5))
    col = int(math.floor((lon - LON0) / DX + 0.5)) % WIDTH
    row = max(0, min(HEIGHT - 1, row))
    return row, col, LAT0 + row * DY, LON0 + col * DX


def run_tests(output_bits: bytes, halo_bits: bytes, tile_bits: bytes):
    cases = [
        ("torrey_pines", 32.9200, -117.2400, True),
        ("karioitahi_offshore_4km", -37.2900, 174.6400, True),
        ("big_sur_coast", 36.2700, -121.8100, True),
        ("azores_sao_miguel", 37.7410, -25.6750, True),
        ("canaries_tenerife", 28.2910, -16.6290, True),
        ("armenia_yerevan", 40.1790, 44.4990, True),
        ("new_zealand_wellington", -41.2865, 174.7762, True),
        ("aleutians_unalaska", 53.8750, -166.5360, True),
        ("dateline_east_attu", 52.9000, 173.2000, True),
        ("dateline_west_taveuni", -16.8500, -179.9700, True),
        ("exclude_russia_moscow", 55.7558, 37.6173, False),
        ("exclude_greenland_nuuk", 64.1814, -51.6941, False),
        ("exclude_antarctica", -77.8500, 166.6700, False),
        ("outside_band_north", 66.0000, 20.0000, False),
        ("outside_band_south", -56.0000, 10.0000, False),
        ("open_ocean_atlantic", 30.0000, -40.0000, False),
    ]
    results = []
    for name, lat, lon, expected in cases:
        row, col, cell_lat, cell_lon = nearest_cell(lat, lon)
        idx = row * WIDTH + col
        observed = bool(output_bits[idx >> 3] & (1 << (idx & 7)))
        observed_halo = bool(halo_bits[idx >> 3] & (1 << (idx & 7)))
        results.append(
            {
                "name": name,
                "lat": lat,
                "lon": lon,
                "expectedOutput": expected,
                "observedOutput": observed,
                "observedHalo": observed_halo,
                "withinLatitudeBand": LAT_MIN <= lat <= LAT_MAX,
                "nearestCell": {
                    "row": row,
                    "col": col,
                    "centerLat": round(cell_lat, 6),
                    "centerLon": round(cell_lon, 6),
                },
            }
        )
    failures = [
        r["name"] for r in results if r["expectedOutput"] != r["observedOutput"]
    ]
    if failures:
        raise SystemExit(f"coverage test failures: {', '.join(failures)}")

    z2x = 2
    z2y = 1
    tile_index = TILE_OFFSETS["2"] + z2y * 4 + z2x
    tile_observed = bool(tile_bits[tile_index >> 3] & (1 << (tile_index & 7)))
    return results, tile_observed, "2/2/1"


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=None)
    parser.add_argument(
        "--output", type=Path, default=Path("packages/contracts/coverage")
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="soaring-mask-") as tmp:
        archive, shp_path = materialize_source(args.source, Path(tmp))
        admitted, excluded_geom, iso_exceptions = load_features(shp_path)
        dateline_checks = dateline_shift_selfchecks()

        tile_geoms = []
        lat_centers = [
            -55.0 + 10.0 * i for i in range(13)
        ]
        lon_centers = [-175.0 + 10.0 * i for i in range(36)]
        for lat_center in lat_centers:
            for lon_center in lon_centers:
                geom = build_tile_geometry(admitted, lon_center, lat_center)
                if geom is not None:
                    tile_geoms.append((lon_center, lat_center, geom))

        active = rasterize_admitted(tile_geoms)
        admitted_count = sum(active)
        cleared = apply_exclusions(active, excluded_geom)
        active_count = sum(active)
        halo = build_halo(active)
        halo_count = sum(halo)

        output_bytes = pack_bits(active)
        halo_bytes = pack_bits(halo)
        tile_bytes, tile_counts, active_z5_tiles = build_tiles(active)

        tests, tile_test_observed, tile_test_name = run_tests(
            output_bytes, halo_bytes, tile_bytes
        )

        output_sha = sha256_bytes(output_bytes)
        halo_sha = sha256_bytes(halo_bytes)
        tile_sha = sha256_bytes(tile_bytes)

        script_path = Path(__file__).resolve()
        script_sha = sha256_file(script_path)

        manifest = {
            "schemaVersion": 1,
            "id": POLICY_ID,
            "kind": "coverage-mask",
            "maxZoom": TILE_ZOOMS[-1],
            "crs": "EPSG:4326",
            "source": {
                "dataset": SOURCE_DATASET,
                "release": SOURCE_RELEASE,
                "url": SOURCE_URL,
                "sha256": SOURCE_SHA256,
                "archiveBytes": SOURCE_ARCHIVE_BYTES,
                "license": SOURCE_LICENSE,
                "attributes": {
                    "excludeField": "ADM0_A3",
                    "excludeValues": list(EXCLUDED_A3),
                    "isoFallback": "ISO_A3_EH",
                    "isoExceptionRows": iso_exceptions,
                },
            },
            "policy": {
                "id": POLICY_ID,
                "latMin": LAT_MIN,
                "latMax": LAT_MAX,
                "seaBufferMeters": SEA_BUFFER_METERS,
                "bufferMethod": (
                    "10-degree tiles; source clipped to tile plus 4deg lon/2deg lat; "
                    "per-tile WGS84 azimuthal-equidistant local metric projection; "
                    "50 km planar buffer with 16 quad segments; inverse-projected and "
                    "clipped to the 10-degree core; antimeridian shifted and split at "
                    "+/-180. No global LAEA or degree buffer."
                ),
                "excludedPrecedence": (
                    "An output cell is cleared if its nearest-cell footprint "
                    "intersects the filled raw ADM0 footprint of RUS, ATA or GRL, "
                    "even when that removes a buffer strip outside the excluded polygon."
                ),
                "inlandLakes": (
                    "Interior rings of admitted country polygons are filled before "
                    "buffering, so inland lakes and enclosed water remain included."
                ),
                "cellFootprint": (
                    "GFS regular-grid nearest-cell rectangle: longitude center +/-0.125deg "
                    "(periodic at +/-180), latitude center +/-0.125deg, clipped to "
                    "-55..65. A cell is output-active when this rectangle intersects the "
                    "admitted buffered geometry and does not intersect an excluded footprint."
                ),
                "tileRule": (
                    "A z0-7 XYZ bit is set iff the tile's exact EPSG:4326 "
                    "Web-Mercator lon/lat bounding box intersects at least one active "
                    "cell footprint; tile centers are not tested."
                ),
                "outputDomain": (
                    "union of admitted nearest-cell footprints clipped to the latitude band"
                ),
            },
            "grid": {
                "name": "gfs-0p25-global",
                "lon0": LON0,
                "lat0": LAT0,
                "width": WIDTH,
                "height": HEIGHT,
                "dx": DX,
                "dy": DY,
                "lonPeriodic": True,
                "rowMajor": "north-to-south",
                "columns": "west-to-east",
                "bitOrder": (
                    "lsb0: index = row*width + col; byte = index >> 3; "
                    "bit = index & 7; bit value = 1 << bit. Row 0 is 90N, "
                    "row 720 is 90S, column 0 is 180W."
                ),
                "cellCount": CELL_COUNT,
                "bitsetBytes": CELL_BYTES,
            },
            "files": {
                "output": "output.bin",
                "halo": "halo.bin",
                "tiles": "tiles.bin",
            },
            "output": {
                "file": "output.bin",
                "encoding": "bitpacked-lsb0",
                "bytes": len(output_bytes),
                "counts": {
                    "totalCells": CELL_COUNT,
                    "activeCellsBeforeExclusion": admitted_count,
                    "clearedByExcludedFootprint": cleared,
                    "activeCells": active_count,
                    "inactiveCells": CELL_COUNT - active_count,
                },
                "sha256": output_sha,
            },
            "halo": {
                "file": "halo.bin",
                "encoding": "bitpacked-lsb0",
                "bytes": len(halo_bytes),
                "definition": (
                    "Input-only one-cell Chebyshev ring (8-neighbour, longitude "
                    "wrapped, latitude clamped) around output-active cells, excluding "
                    "output-active cells. It may cross the latitude band. Halo bits "
                    "never make a cell output-active and are not query coverage."
                ),
                "counts": {
                    "haloOnlyCells": halo_count,
                    "activePlusHaloCells": active_count + halo_count,
                    "haloOverheadRatio": round(halo_count / active_count, 6),
                },
                "sha256": halo_sha,
            },
            "tiles": {
                "file": "tiles.bin",
                "encoding": "bitpacked-lsb0",
                "zooms": list(TILE_ZOOMS),
                "offsets": TILE_OFFSETS,
                "tileCounts": {str(z): 4**z for z in TILE_ZOOMS},
                "totalBits": TILE_TOTAL_BITS,
                "bytes": len(tile_bytes),
                "countsByZoom": tile_counts,
                "activeZ5Tiles": active_z5_tiles,
                "sha256": tile_sha,
            },
            "approximation": {
                "cellDiagonalDegrees": round(math.hypot(DX, abs(DY)), 6),
                "cellDiagonalMetersAtEquator": round(
                    math.hypot(DX * 111_320.0, abs(DY) * 110_574.0), 1
                ),
                "statement": (
                    "Natural Earth 1:50m geometry is generalized; the 50 km buffer is "
                    "source-geometry seaward buffering, not an exact pixel coastline. "
                    "Tile-local azimuthal-equidistant projection has sub-0.5% metric "
                    "distortion across a 10-degree tile (about 250 m at 50 km at the "
                    "tile edge), reported as an approximation rather than a geodesic "
                    "buffer guarantee. Conservative 0.25-degree cell-footprint "
                    "intersection can overreach the coastal band or underfill an "
                    "excluded border by about one cell diagonal (0.3536 deg, about "
                    "39 km at the equator and 17 km at 65N)."
                ),
            },
            "tinyIslandInspection": {
                "requiredTestIslandsCovered": [
                    "Azores/Sao Miguel",
                    "Canaries/Tenerife",
                    "Aleutians/Unalaska",
                    "New Zealand",
                ],
                "knownNaturalEarth50mOmission": (
                    "Lord Howe Island is absent from this Natural Earth 1:50m admin-0 "
                    "release and is not a required v1 test case; no runtime exception "
                    "or invented geometry is used. Required v1 test islands are present "
                    "or within the admitted 50 km buffer."
                ),
                "versionedGeometryCorrection": None,
            },
            "tests": {
                "cases": tests,
                "datelineShiftSelfChecks": dateline_checks,
                "xyzTileProbe": {
                    "tile": tile_test_name,
                    "expected": True,
                    "observed": tile_test_observed,
                },
            },
            "regional": {},
            "regeneration": {
                "tooling": "scripts/masks/build_masks.py",
                "toolingSha256": script_sha,
                "python": platform.python_version(),
                "pythonVersion": sys.version.split()[0],
                "pythonImplementation": platform.python_implementation(),
                "platform": platform.platform(),
                "machine": platform.machine(),
                "nativeLibraries": {
                    "GEOS": geos_version_string,
                    "PROJ": proj_version_str,
                },
                "pythonPackages": {
                    name: distribution_version(name)
                    for name in ("shapely", "pyproj", "pyshp")
                },
                "command": (
                    "uv run --python 3.14.7 --with shapely==2.1.2 "
                    "--with pyproj==3.7.2 --with pyshp==2.3.1 "
                    "python scripts/masks/build_masks.py "
                    "--source ne_50m_admin_0_countries.zip "
                    "--output packages/contracts/coverage"
                ),
                "scheduledBuildGIS": False,
            },
        }

        if not tile_test_observed:
            raise SystemExit("xyz tile probe failed")

        write_atomic(args.output / "output.bin", output_bytes)
        write_atomic(args.output / "halo.bin", halo_bytes)
        write_atomic(args.output / "tiles.bin", tile_bytes)
        manifest_bytes = (
            json.dumps(manifest, indent=2, ensure_ascii=True) + "\n"
        ).encode("utf-8")
        write_atomic(args.output / "manifest.json", manifest_bytes)

    print(
        json.dumps(
            {
                "output": str(args.output / "output.bin"),
                "activeCells": active_count,
                "haloOnlyCells": halo_count,
                "tileCounts": tile_counts,
                "outputSha256": output_sha,
                "haloSha256": halo_sha,
                "tileSha256": tile_sha,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
