#!/usr/bin/env python3
"""Build coverage bitsets from pinned Natural Earth 1:50m admin-0.

uv run --python 3.12 --with shapely==2.1.2 --with pyproj==3.7.2 \
  --with pyshp==2.3.1 python scripts/masks/build_masks.py --source ne_50m_admin_0_countries.zip
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import shlex
import sys
import tempfile
import urllib.request
import zipfile
from importlib.metadata import PackageNotFoundError, version as distribution_version
from pathlib import Path
from tile_pyramid import build_tiles as build_cell_tiles, max_native_zoom

try:
    import shapefile  # type: ignore
except ImportError:
    shapefile = None

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

TILE_DEG = 10.0
TILE_HALF_DEG = TILE_DEG / 2.0
TILE_LON_PAD = 4.0
TILE_LAT_PAD = 2.0
BUFFER_QUAD_SEGS = 16


def model_settings(path: Path, model: str | None = None):
    config = json.loads(path.read_text())
    model = config['defaultModel'] if model is None else model
    try:
        return next(item for item in config['models'] if item['modelId'] == model)
    except StopIteration:
        raise SystemExit(f'Unknown model: {model}') from None


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


def iter_shapefile_records(shp_path: Path):
    if shapefile is not None:
        reader = shapefile.Reader(str(shp_path))
        for sr in reader.iterShapeRecords():
            yield sr.record.as_dict(), shape(sr.shape.__geo_interface__)
        return
    import geopandas as gpd  # type: ignore

    gdf = gpd.read_file(shp_path)
    cols = [c for c in gdf.columns if c != "geometry"]
    for _, row in gdf.iterrows():
        rec = {c: row[c] for c in cols}
        yield rec, row.geometry


def load_features(
    shp_path: Path,
    excluded_a3: tuple[str, ...],
    excluded_continents: tuple[str, ...],
):
    admitted = []
    excluded = []
    iso_exceptions = []
    continent_exclusions = []
    for rec, raw_geom in iter_shapefile_records(shp_path):
        adm0 = rec.get("ADM0_A3")
        iso3 = rec.get("ISO_A3")
        iso3_eh = rec.get("ISO_A3_EH")
        continent = rec.get("CONTINENT")
        excluded_by_continent = continent in excluded_continents and adm0 not in excluded_a3
        if excluded_by_continent:
            continent_exclusions.append(
                {
                    "admin": rec.get("ADMIN"),
                    "adm0_a3": adm0,
                    "continent": continent,
                }
            )
        if (iso3 == "-99" or iso3_eh != iso3) and adm0 not in excluded_a3:
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
        geom = fill_holes(raw_geom)
        for part in polygon_parts(geom):
            if adm0 in excluded_a3 or excluded_by_continent:
                excluded.append(part)
            else:
                admitted.append(part)
    iso_exceptions.sort(key=lambda r: (r["adm0_a3"] or "", r["admin"] or ""))
    continent_exclusions.sort(key=lambda r: (r["adm0_a3"] or "", r["admin"] or ""))
    return admitted, unary_union(excluded), iso_exceptions, continent_exclusions


def local_aeqd(lat0: float) -> tuple[Transformer, Transformer]:
    crs = CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat0:.12f} +lon_0=0 +datum=WGS84 "
        "+units=m +no_defs +over"
    )
    forward = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    inverse = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    return forward, inverse


def build_tile_geometry(
    parts,
    lon_center: float,
    lat_center: float,
    lat_min: float,
    lat_max: float,
    sea_buffer_meters: float,
    lon_min: float = -180.0,
    lon_max: float = 180.0,
    wrap_longitude: bool = True,
):
    core = box(
        max(lon_min, lon_center - TILE_HALF_DEG),
        max(lat_min, lat_center - TILE_HALF_DEG),
        min(lon_max, lon_center + TILE_HALF_DEG),
        min(lat_max, lat_center + TILE_HALF_DEG),
    )
    if core.is_empty or core.area <= 0:
        return None
    expanded = box(
        lon_center - TILE_HALF_DEG - TILE_LON_PAD,
        max(-90.0, lat_center - TILE_HALF_DEG - TILE_LAT_PAD),
        lon_center + TILE_HALF_DEG + TILE_LON_PAD,
        min(90.0, lat_center + TILE_HALF_DEG + TILE_LAT_PAD),
    )
    shifts = (-360.0, 0.0, 360.0) if wrap_longitude else (0.0,)
    pieces = []
    for part in parts:
        for shift in shifts:
            moved = affinity.translate(part, xoff=shift) if shift else part
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
    buffered = project.buffer(sea_buffer_meters, quad_segs=BUFFER_QUAD_SEGS)
    if buffered.is_empty:
        return None
    unprojected = transform(inv.transform, buffered)
    absolute = affinity.translate(unprojected, xoff=lon_center)
    clipped = absolute.intersection(core)
    if clipped.is_empty:
        return None

    normalized = []
    for shift in shifts:
        moved = affinity.translate(clipped, xoff=shift) if shift else clipped
        piece = moved.intersection(box(lon_min, -90.0, lon_max, 90.0))
        if not piece.is_empty:
            normalized.extend(polygon_parts(piece))
    if not normalized:
        return None
    return unary_union(normalized)


def dateline_shift_selfchecks(lat_min: float, lat_max: float, sea_buffer_meters: float):
    cases = [
        ("east_179_9_into_west_tile", 179.90, -175.0, -179.80),
        ("west_neg179_9_into_east_tile", -179.95, 175.0, 179.80),
    ]
    results = []
    for name, source_lon, tile_lon, probe_lon in cases:
        strip = box(source_lon, -0.05, source_lon + 0.05, 0.05)
        geom = build_tile_geometry(
            [strip], tile_lon, 0.0, min(-1.0, lat_min), max(1.0, lat_max), sea_buffer_meters
        )
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


def pack_bits(bits: bytearray) -> bytes:
    out = bytearray((len(bits) + 7) // 8)
    for idx, value in enumerate(bits):
        if value:
            out[idx >> 3] |= 1 << (idx & 7)
    return bytes(out)


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def regeneration_command(args: argparse.Namespace) -> str:
    command = [
        "uv", "run", "--python", "3.12",
        "--with", "shapely==2.1.2", "--with", "pyproj==3.7.2", "--with", "pyshp==2.3.1",
        "python", "scripts/masks/build_masks.py",
        "--config", str(args.config), "--model", args.model, "--output", str(args.output),
    ]
    if args.source is not None:
        command.extend(["--source", str(args.source)])
    if args.allow_local_libs:
        command.append("--allow-local-libs")
    return shlex.join(command)


def write_projected_masks(settings, args):
    """Serialize the shared sparse rasterizer's native (k=1) view as dense coverage."""
    import struct
    from build_fine_masks import build_hierarchy
    from grid_geometry import ProjectedFootprints

    coverage, grid = settings['coverage'], settings['grid']
    if coverage['interpolationHaloCells'] != 1:
        raise ValueError('Projected coverage requires one interpolation halo cell')
    result = build_hierarchy(settings, 1, args.source)
    sparse = result['sparseBytes']
    count = struct.unpack_from('<I', sparse, 20)[0]
    width, height = grid['width'], grid['height']
    columns = (width + 15) // 16
    dense = [bytearray((width * height + 7) // 8) for _ in range(2)]
    for i in range(count):
        bid = struct.unpack_from('<I', sparse, 60 + i * 8)[0]
        for layer in range(2):
            start = 60 + count * 8 + layer * count * 32 + i * 32
            bits = int.from_bytes(sparse[start:start + 32], 'little')
            while bits:
                bit = bits & -bits
                local = bit.bit_length() - 1
                col, row = bid % columns * 16 + local % 16, bid // columns * 16 + local // 16
                index = row * width + col
                dense[layer][index >> 3] |= 1 << (index & 7)
                bits ^= bit
    output, halo = map(bytes, dense)
    bounds = tuple(coverage[key] for key in ('west', 'south', 'east', 'north'))
    geometry = ProjectedFootprints(grid, bounds)
    tests = []
    for name, lat, lon, expected in coverage['probes']:
        x, y = geometry.nearest(lat, lon)
        inside = bounds[0] <= lon <= bounds[2] and bounds[1] <= lat <= bounds[3] and -.5 <= x < width - .5 and -.5 <= y < height - .5
        index = math.floor(y + .5) * width + math.floor(x + .5) if inside else 0
        observed = bool(inside and output[index >> 3] & (1 << (index & 7)))
        tests.append({'name': name, 'lat': lat, 'lon': lon, 'expectedOutput': expected, 'observedOutput': observed, 'withinFootprint': inside})
    if any(test['expectedOutput'] != test['observedOutput'] for test in tests):
        raise SystemExit('Projected coverage test failures: ' + ', '.join(test['name'] for test in tests if test['expectedOutput'] != test['observedOutput']))
    payloads = {'output': output, 'halo': halo, 'tiles': result['tilesBytes']}
    descriptor = {'version': 1, 'id': coverage['id'], 'grid': grid, 'bounds': list(bounds), 'policy': coverage['description'],
                  'maxZoom': coverage['maxNativeZoom'], 'supportHaloCells': 1,
                  'sampleLayout': {'format': 'cell-major-blocks-v1', 'blockSize': 16},
                  'files': {name: {'bytes': len(data), 'sha256': sha256_bytes(data)} for name, data in payloads.items()}}
    tile_counts, offset = {}, 0
    for zoom in range(coverage['maxNativeZoom'] + 1):
        tile_counts[str(zoom)] = sum(bool(payloads['tiles'][index >> 3] & (1 << (index & 7))) for index in range(offset, offset + 4**zoom))
        offset += 4**zoom
    receipt = {'source': result['source'], 'grid': grid,
               'output': {**descriptor['files']['output'], 'counts': {'activeCells': sum(byte.bit_count() for byte in output)}},
               'halo': {**descriptor['files']['halo'], 'counts': {'haloOnlyCells': sum(byte.bit_count() for byte in halo)}},
               'tiles': {**descriptor['files']['tiles'], 'countsByZoom': tile_counts}, 'tests': {'cases': tests},
               'regeneration': {'command': regeneration_command(args), 'toolingSha256': sha256_file(Path(__file__)),
                                'rasterizerSha256': sha256_file(Path(__file__).with_name('build_fine_masks.py')),
                                'geometrySha256': sha256_file(Path(__file__).with_name('grid_geometry.py')),
                                'tilesSha256': sha256_file(Path(__file__).with_name('tile_pyramid.py')),
                                'GEOS': geos_version_string, 'PROJ': proj_version_str}}
    args.output.mkdir(parents=True, exist_ok=True)
    for name, data in payloads.items():
        write_atomic(args.output / f'{name}.bin', data)
    write_atomic(args.output / 'manifest.json', json.dumps(descriptor, separators=(',', ':')).encode())
    write_atomic(args.output / 'source.json', json.dumps(receipt, indent=2).encode())
    print(json.dumps({'output': str(args.output), 'activeCells': receipt['output']['counts']['activeCells'],
                      'haloOnlyCells': receipt['halo']['counts']['haloOnlyCells'], 'tileCounts': tile_counts,
                      'files': descriptor['files']}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("packages/contracts/config/models.json"),
    )
    parser.add_argument("--model")
    parser.add_argument("--source", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--allow-local-libs", action="store_true")
    args = parser.parse_args()

    settings = model_settings(args.config.resolve(), args.model)
    args.model = settings["modelId"]
    grid = settings["grid"]
    coverage = settings["coverage"]
    if not any(case[3] for case in coverage["probes"]):
        raise SystemExit("Coverage requires a positive regression probe")
    coverage["maxNativeZoom"] = max_native_zoom()
    if args.output is None:
        args.output = Path("packages/contracts") / settings["coverageDir"]
    if not args.allow_local_libs and (
        geos_version_string != "3.13.1" or proj_version_str != "9.5.1"
    ):
        raise SystemExit("Mask regeneration requires GEOS 3.13.1 and PROJ 9.5.1 (or --allow-local-libs)")
    if grid['kind'] == 'lambert-conformal':
        write_projected_masks(settings, args)
        return
    if grid["kind"] != "regular-latlon":
        raise SystemExit("This generator requires a regular-latlon grid")
    if grid["dx"] <= 0 or grid["dy"] >= 0 or not math.isclose(grid["dx"], -grid["dy"]):
        raise SystemExit("This generator requires square cells ordered west-to-east and north-to-south")
    if grid["wrapLongitude"] and (
        grid["lon0"] != -180 or not math.isclose(grid["width"] * grid["dx"], 360)
    ):
        raise SystemExit("This generator requires wrapping grids to start at -180 and cover 360 degrees")
    if coverage["maxNativeZoom"] < 2:
        raise SystemExit("Coverage regression probes require zoom 2")

    policy_id = coverage["id"]
    lon_min_bound, lon_max_bound = coverage["west"], coverage["east"]
    lat_min, lat_max = coverage["south"], coverage["north"]
    sea_buffer_meters = coverage["seaBufferMeters"]
    excluded_a3 = tuple(coverage["excludedA3"])
    excluded_continents = tuple(coverage.get("excludedContinents", ()))
    halo_cells = coverage["interpolationHaloCells"]
    lon0, lat0 = grid["lon0"], grid["lat0"]
    width, height = grid["width"], grid["height"]
    dx, dy = grid["dx"], grid["dy"]
    wrap_longitude = bool(grid["wrapLongitude"])
    cell_half = abs(dx) / 2
    cell_count = width * height
    cell_bytes = (cell_count + 7) // 8
    tile_zooms = tuple(range(coverage["maxNativeZoom"] + 1))
    tile_offsets: dict[str, int] = {}
    running = 0
    for z in tile_zooms:
        tile_offsets[str(z)] = running
        running += 4**z
    tile_total_bits = running

    row_min = max(0, int(round((lat0 - lat_max) / -dy)))
    row_max = min(height - 1, int(round((lat0 - lat_min) / -dy)))

    def cell_lon_intervals(col: int):
        center = lon0 + col * dx
        if wrap_longitude and col == 0:
            return (
                (center - cell_half, center + cell_half),
                (180.0 - cell_half, 180.0 + cell_half),
            )
        return ((center - cell_half, center + cell_half),)

    def build_cell_boxes(rows, cols, lon_center, lat_center, clip_to_core: bool):
        tiles = []
        for row in rows:
            lat_center_cell = lat0 + row * dy
            y0 = max(lat_min, lat_center_cell - cell_half)
            y1 = min(lat_max, lat_center_cell + cell_half)
            if clip_to_core:
                y0 = max(y0, lat_center - TILE_HALF_DEG)
                y1 = min(y1, lat_center + TILE_HALF_DEG)
            if y1 <= y0:
                continue
            for col in cols:
                for x0, x1 in cell_lon_intervals(col):
                    a = max(lon_min_bound, x0)
                    b = min(lon_max_bound, x1)
                    if clip_to_core:
                        a = max(a, lon_center - TILE_HALF_DEG)
                        b = min(b, lon_center + TILE_HALF_DEG)
                    if b <= a:
                        continue
                    tiles.append((row, col, box(a, y0, b, y1)))
        return tiles

    def rasterize_admitted(tile_geoms) -> bytearray:
        active = bytearray(cell_count)
        for entry in tile_geoms:
            if entry is None:
                continue
            lon_center, lat_center, geom = entry
            if geom.is_empty:
                continue
            prepare(geom)
            lo = lon_center - TILE_HALF_DEG
            hi = lon_center + TILE_HALF_DEG
            col_min = max(0, math.ceil((lo - cell_half - lon0) / dx - 1e-9))
            col_max = min(width - 1, math.floor((hi + cell_half - lon0) / dx + 1e-9))
            cols = list(range(col_min, col_max + 1))
            if wrap_longitude and hi >= 180.0 - cell_half and 0 not in cols:
                cols.append(0)
            r_min = max(
                row_min,
                math.ceil((lat0 - (lat_center + TILE_HALF_DEG + cell_half)) / -dy - 1e-9),
            )
            r_max = min(
                row_max,
                math.floor((lat0 - (lat_center - TILE_HALF_DEG - cell_half)) / -dy + 1e-9),
            )
            rows = list(range(r_min, r_max + 1))
            candidates = build_cell_boxes(rows, cols, lon_center, lat_center, True)
            if not candidates:
                continue
            boxes = [item[2] for item in candidates]
            hits = intersects(geom, boxes)
            for (row, col, _), hit in zip(candidates, hits):
                if hit:
                    active[row * width + col] = 1
        return active

    def apply_exclusions(active: bytearray, excluded_geom) -> int:
        if excluded_geom.is_empty:
            return 0
        prepare(excluded_geom)
        indices = [i for i, v in enumerate(active) if v]
        boxes = []
        owners = []
        for idx in indices:
            row, col = divmod(idx, width)
            lat = lat0 + row * dy
            y0 = max(lat_min, lat - cell_half)
            y1 = min(lat_max, lat + cell_half)
            for x0, x1 in cell_lon_intervals(col):
                a = max(lon_min_bound, x0)
                b = min(lon_max_bound, x1)
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
        halo = bytearray(cell_count)
        for idx, is_active in enumerate(active):
            if not is_active:
                continue
            row, col = divmod(idx, width)
            for dr in range(-halo_cells, halo_cells + 1):
                rr = row + dr
                if rr < 0 or rr >= height:
                    continue
                for dc in range(-halo_cells, halo_cells + 1):
                    if dr == 0 and dc == 0:
                        continue
                    if wrap_longitude:
                        cc = (col + dc) % width
                    else:
                        cc = col + dc
                        if cc < 0 or cc >= width:
                            continue
                    k = rr * width + cc
                    if not active[k]:
                        halo[k] = 1
        return halo

    def build_tiles(active: bytearray):
        blocks = {}
        columns = (width + 15) // 16
        for idx, is_active in enumerate(active):
            if not is_active:
                continue
            row, col = divmod(idx, width)
            bid = (row // 16) * columns + col // 16
            mask = blocks.setdefault(bid, bytearray(32))
            local = (row % 16) * 16 + col % 16
            mask[local >> 3] |= 1 << (local & 7)
        bits = build_cell_tiles(blocks, grid, (lon_min_bound, lat_min, lon_max_bound, lat_max), tile_zooms[-1])
        counts = {}
        active_tiles = []
        for z in tile_zooms:
            n = 2**z
            offset = tile_offsets[str(z)]
            covered = lambda index: bits[index >> 3] & (1 << (index & 7))
            counts[str(z)] = sum(bool(covered(offset + index)) for index in range(n * n))
            if z == 5:
                active_tiles = [f"{z}/{x}/{y}" for x in range(n) for y in range(n) if covered(offset + y * n + x)]
        return bits, counts, active_tiles

    def nearest_cell(lat: float, lon: float) -> tuple[int, int, float, float]:
        row = int(math.floor((lat0 - lat) / -dy + 0.5))
        if wrap_longitude:
            col = int(math.floor((lon - lon0) / dx + 0.5)) % width
        else:
            col = max(0, min(width - 1, int(math.floor((lon - lon0) / dx + 0.5))))
        row = max(0, min(height - 1, row))
        return row, col, lat0 + row * dy, lon0 + col * dx

    def run_tests(output_bits: bytes, halo_bits: bytes, tile_bits: bytes):
        cases = coverage["probes"]
        results = []
        for name, lat, lon, expected in cases:
            row, col, cell_lat, cell_lon = nearest_cell(lat, lon)
            idx = row * width + col
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
                    "withinLatitudeBand": lat_min <= lat <= lat_max,
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

        _, lat, lon, _ = next(case for case in cases if case[3])
        z2x = max(0, min(3, int((lon + 180) / 360 * 4)))
        z2y = max(0, min(3, int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 4)))
        tile_index = tile_offsets["2"] + z2y * 4 + z2x
        tile_observed = bool(tile_bits[tile_index >> 3] & (1 << (tile_index & 7)))
        return results, tile_observed, f"2/{z2x}/{z2y}"

    args.output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="soaring-mask-") as tmp:
        archive, shp_path = materialize_source(args.source, Path(tmp))
        admitted, excluded_geom, iso_exceptions, continent_exclusions = load_features(
            shp_path, excluded_a3, excluded_continents
        )
        dateline_checks = dateline_shift_selfchecks(lat_min, lat_max, sea_buffer_meters)

        tile_geoms = []
        lat_steps = int(math.ceil((lat_max - lat_min) / TILE_DEG)) + 1
        lat_centers = [lat_min + TILE_DEG * i for i in range(lat_steps)]
        if wrap_longitude:
            lon_centers = [-175.0 + 10.0 * i for i in range(36)]
        else:
            lon_start = math.floor(lon_min_bound / TILE_DEG) * TILE_DEG + TILE_HALF_DEG
            lon_steps = int(math.ceil((lon_max_bound - lon_min_bound) / TILE_DEG)) + 1
            lon_centers = [lon_start + TILE_DEG * i for i in range(lon_steps)]
        for lat_center in lat_centers:
            for lon_center in lon_centers:
                geom = build_tile_geometry(
                    admitted,
                    lon_center,
                    lat_center,
                    lat_min,
                    lat_max,
                    sea_buffer_meters,
                    lon_min_bound,
                    lon_max_bound,
                    wrap_longitude,
                )
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

        python_packages = {}
        for pkg in ("shapely", "pyproj", "pyshp", "geopandas", "pyogrio"):
            try:
                python_packages[pkg] = distribution_version(pkg)
            except PackageNotFoundError:
                pass

        manifest = {
            "schemaVersion": 1,
            "id": policy_id,
            "kind": "coverage-mask",
            "maxZoom": tile_zooms[-1],
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
                    "excludeValues": list(excluded_a3),
                    "excludeContinents": list(excluded_continents),
                    "isoFallback": "ISO_A3_EH",
                    "isoExceptionRows": iso_exceptions,
                    "continentExclusionRows": continent_exclusions,
                },
            },
            "policy": {
                "id": policy_id,
                "latMin": lat_min,
                "latMax": lat_max,
                "seaBufferMeters": sea_buffer_meters,
                "bufferMethod": (
                    "10-degree tiles; source clipped to tile plus 4deg lon/2deg lat; "
                    "per-tile WGS84 azimuthal-equidistant local metric projection; "
                    "50 km planar buffer with 16 quad segments; inverse-projected and "
                    "clipped to the 10-degree core."
                ),
                "excludedPrecedence": (
                    "An output cell is cleared if its nearest-cell footprint "
                    "intersects the filled raw ADM0 footprint of RUS, CHN, ATA, GRL "
                    "or any country whose CONTINENT attribute is Africa, "
                    "even when that removes a buffer strip outside the excluded polygon."
                ),
                "inlandLakes": (
                    "Interior rings of admitted country polygons are filled before "
                    "buffering, so inland lakes and enclosed water remain included."
                ),
                "cellFootprint": (
                    f"Regular-grid nearest-cell rectangle: longitude center +/-{cell_half}deg, "
                    f"latitude center +/-{cell_half}deg, clipped to bounds "
                    f"[{lon_min_bound}, {lat_min}, {lon_max_bound}, {lat_max}]."
                ),
                "tileRule": (
                    f"A z0-{tile_zooms[-1]} XYZ bit is set iff the tile's exact EPSG:4326 "
                    "Web-Mercator lon/lat bounding box intersects at least one active "
                    "cell footprint; tile centers are not tested."
                ),
                "outputDomain": (
                    "union of admitted nearest-cell footprints clipped to the coverage bounds"
                ),
            },
            "grid": {
                "name": settings["source"]["configurationId"],
                "lon0": lon0,
                "lat0": lat0,
                "width": width,
                "height": height,
                "dx": dx,
                "dy": dy,
                "lonPeriodic": wrap_longitude,
                "rowMajor": "north-to-south",
                "columns": "west-to-east",
                "bitOrder": (
                    "lsb0: index = row*width + col; byte = index >> 3; "
                    "bit = index & 7; bit value = 1 << bit."
                ),
                "cellCount": cell_count,
                "bitsetBytes": cell_bytes,
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
                    "totalCells": cell_count,
                    "activeCellsBeforeExclusion": admitted_count,
                    "clearedByExcludedFootprint": cleared,
                    "activeCells": active_count,
                    "inactiveCells": cell_count - active_count,
                },
                "sha256": output_sha,
            },
            "halo": {
                "file": "halo.bin",
                "encoding": "bitpacked-lsb0",
                "bytes": len(halo_bytes),
                "definition": (
                    "Input-only one-cell Chebyshev ring (8-neighbour) around "
                    "output-active cells, excluding output-active cells."
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
                "zooms": list(tile_zooms),
                "offsets": tile_offsets,
                "tileCounts": {str(z): 4**z for z in tile_zooms},
                "totalBits": tile_total_bits,
                "bytes": len(tile_bytes),
                "countsByZoom": tile_counts,
                "activeZ5Tiles": active_z5_tiles,
                "sha256": tile_sha,
            },
            "approximation": {
                "cellDiagonalDegrees": round(math.hypot(dx, abs(dy)), 6),
                "cellDiagonalMetersAtEquator": round(
                    math.hypot(dx * 111_320.0, abs(dy) * 110_574.0), 1
                ),
                "statement": (
                    "Natural Earth 1:50m geometry is generalized; the 50 km buffer is "
                    "source-geometry seaward buffering, not an exact pixel coastline."
                ),
            },
            "tinyIslandInspection": {
                "requiredTestIslandsCovered": [
                    "Azores/Sao Miguel",
                    "Canaries/Tenerife",
                    "Aleutians/Unalaska",
                    "New Zealand",
                ] if policy_id == "soaring-land-v1" else [],
                "knownNaturalEarth50mOmission": (
                    "Lord Howe Island is absent from this Natural Earth 1:50m admin-0 "
                    "release and is not a required v1 test case."
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
                "pythonPackages": python_packages,
                "command": regeneration_command(args),
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
        write_atomic(args.output / "source.json", manifest_bytes)
        descriptor = {
            "version": 1,
            "id": policy_id,
            "grid": grid,
            "bounds": [lon_min_bound, lat_min, lon_max_bound, lat_max],
            "policy": coverage["description"],
            "maxZoom": tile_zooms[-1],
            "supportHaloCells": halo_cells,
            "sampleLayout": {"format": "cell-major-blocks-v1", "blockSize": 16},
            "files": {
                "output": {"bytes": len(output_bytes), "sha256": output_sha},
                "halo": {"bytes": len(halo_bytes), "sha256": halo_sha},
                "tiles": {"bytes": len(tile_bytes), "sha256": tile_sha},
            },
        }
        write_atomic(
            args.output / "manifest.json",
            json.dumps(descriptor, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        )

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
