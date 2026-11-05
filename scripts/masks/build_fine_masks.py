#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import struct
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_masks
from tile_pyramid import build_tiles, max_native_zoom

BLOCK_SIZE = 16
MASK_BYTES = 32


def fine_grid(native, k):
    if not isinstance(k, int) or not 1 <= k <= 64 or native['kind'] != 'regular-latlon':
        raise ValueError('Expected a regular grid and positive subdivision')
    if native['dx'] <= 0 or native['dy'] >= 0:
        raise ValueError('Grid must run west to east and north to south')
    if native['wrapLongitude'] and (native['lon0'] != -180 or not math.isclose(native['width'] * native['dx'], 360)):
        raise ValueError('Wrapping grid must start at -180 and span 360 degrees')
    width = native['width'] * k if native['wrapLongitude'] else (native['width'] - 1) * k + 1
    height = (native['height'] - 1) * k + 1
    if width < 1 or height < 1 or width * height >= 0xffffffff:
        raise ValueError('Fine grid exceeds the index space')
    return {**native, 'width': width, 'height': height, 'dx': native['dx'] / k, 'dy': native['dy'] / k}


def canonical_grid_json(grid):
    keys = ['kind', 'width', 'height', 'earthRadiusM', 'lon0', 'lat0', 'dx', 'dy', 'wrapLongitude']
    ordered = {key: grid[key] for key in keys}
    return subprocess.run(['node', '-e', "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8'))))"],
                          input=json.dumps(ordered), text=True, capture_output=True, check=True).stdout


def footprint(grid, bounds, x0, x1, y0, y1):
    west, south, east, north = bounds
    dx, dy = grid['dx'], grid['dy']
    low_y = max(south, grid['lat0'] + y1 * dy - abs(dy) / 2)
    high_y = min(north, grid['lat0'] + y0 * dy + abs(dy) / 2)
    if low_y >= high_y:
        return []
    low_x = grid['lon0'] + x0 * dx - dx / 2
    high_x = grid['lon0'] + x1 * dx + dx / 2
    shifts = (-360, 0, 360) if grid['wrapLongitude'] else (0,)
    result = []
    for shift in shifts:
        lo, hi = max(west, low_x + shift), min(east, high_x + shift)
        if lo < hi:
            result.append(build_masks.box(lo, low_y, hi, high_y))
    return result


def sparse_from_blocks(width, height, wrap, grid_hash, blocks):
    ids = sorted(blocks)
    active = 0
    directory = bytearray(8 * len(ids))
    for i, bid in enumerate(ids):
        struct.pack_into('<II', directory, i * 8, bid, active)
        out, halo = blocks[bid]
        active += sum((a | b).bit_count() for a, b in zip(out, halo))
    header = struct.pack('<7I', 0x31564353, 1, width, height, int(wrap), len(ids), active) + bytes.fromhex(grid_hash)
    return header + directory + b''.join(blocks[i][0] for i in ids) + b''.join(blocks[i][1] for i in ids)


def add_halo(output, width, height, wrap):
    columns = (width + 15) // 16
    rows = (height + 15) // 16
    candidates = set()
    for bid in output:
        bx, by = bid % columns, bid // columns
        for yy in range(max(0, by - 1), min(rows, by + 2)):
            for xx in range(bx - 1, bx + 2):
                if wrap:
                    xx %= columns
                if 0 <= xx < columns:
                    candidates.add(yy * columns + xx)
    def row_bits(bx, y):
        if y < 0 or y >= height or bx < 0 or bx >= columns:
            return 0
        bits = output.get((y // 16) * columns + bx)
        return int.from_bytes(bits[(y % 16) * 2:(y % 16) * 2 + 2], 'little') if bits else 0
    blocks = {}
    for bid in candidates:
        bx, by = bid % columns, bid // columns
        bw, bh = min(16, width - bx * 16), min(16, height - by * 16)
        out = output.get(bid, bytearray(MASK_BYTES))
        halo = bytearray(MASK_BYTES)
        for r in range(bh):
            y = by * 16 + r
            expanded = 0
            for yy in (y - 1, y, y + 1):
                bits = row_bits(bx, yy)
                expanded |= bits | bits << 1 | bits >> 1
                left = bx - 1 if bx else columns - 1 if wrap else -1
                right = bx + 1 if bx + 1 < columns else 0 if wrap else -1
                left_width = min(16, width - left * 16) if left >= 0 else 0
                if left_width and row_bits(left, yy) & (1 << (left_width - 1)):
                    expanded |= 1
                if right >= 0 and row_bits(right, yy) & 1:
                    expanded |= 1 << (bw - 1)
            own = int.from_bytes(out[r * 2:r * 2 + 2], 'little')
            halo[r * 2:r * 2 + 2] = ((expanded & ((1 << bw) - 1)) & ~own).to_bytes(2, 'little')
        if any(out) or any(halo):
            blocks[bid] = (out, halo)
    return blocks


def build_hierarchy(settings, k, source):
    coverage = settings['coverage']
    fine = fine_grid(settings['grid'], k)
    width, height, wrap = fine['width'], fine['height'], fine['wrapLongitude']
    bounds = (coverage['west'], coverage['south'], coverage['east'], coverage['north'])
    if not (-180 <= bounds[0] < bounds[2] <= 180 and -90 <= bounds[1] < bounds[3] <= 90):
        raise ValueError('Expected non-crossing coverage bounds')
    if not isinstance(coverage['maxNativeZoom'], int) or not 0 <= coverage['maxNativeZoom'] <= max_native_zoom():
        raise ValueError('Invalid maximum native zoom')
    grid_hash = hashlib.sha256(canonical_grid_json(fine).encode()).hexdigest()
    with build_masks.tempfile.TemporaryDirectory(prefix='fine-mask-') as tmp:
        _, shp = build_masks.materialize_source(source, Path(tmp))
        admitted, excluded, iso_exceptions, continent_exclusions = build_masks.load_features(
            shp, tuple(coverage['excludedA3']), tuple(coverage.get('excludedContinents', ())))
        build_masks.prepare(excluded)
        lat_min, lat_max = bounds[1], bounds[3]
        lat_steps = int(math.ceil((lat_max - lat_min) / build_masks.TILE_DEG)) + 1
        lon_start = math.floor(bounds[0] / build_masks.TILE_DEG) * build_masks.TILE_DEG + build_masks.TILE_HALF_DEG
        lon_steps = int(math.ceil((bounds[2] - bounds[0]) / build_masks.TILE_DEG)) + 1
        lon_centers = [-175 + 10 * i for i in range(36)] if wrap else [lon_start + build_masks.TILE_DEG * i for i in range(lon_steps)]
        geoms = []
        for lat_center in (lat_min + build_masks.TILE_DEG * i for i in range(lat_steps)):
            if lat_center + build_masks.TILE_HALF_DEG <= lat_min or lat_center - build_masks.TILE_HALF_DEG >= lat_max:
                continue
            for lon_center in lon_centers:
                if lon_center + build_masks.TILE_HALF_DEG <= bounds[0] or lon_center - build_masks.TILE_HALF_DEG >= bounds[2]:
                    continue
                geom = build_masks.build_tile_geometry(admitted, lon_center, lat_center, lat_min, lat_max,
                                                       coverage['seaBufferMeters'], bounds[0], bounds[2], wrap)
                if geom is not None and not geom.is_empty:
                    build_masks.prepare(geom)
                    geoms.append(geom)
        tree = build_masks.STRtree(geoms)
        columns = (width + 15) // 16
        output = {}
        for by in range((height + 15) // 16):
            for bx in range(columns):
                x, y = bx * 16, by * 16
                bw, bh = min(16, width - x), min(16, height - y)
                parts = footprint(fine, bounds, x, x + bw - 1, y, y + bh - 1)
                matches = set(int(i) for part in parts for i in tree.query(part, predicate='intersects'))
                if not matches:
                    continue
                union = geoms[next(iter(matches))] if len(matches) == 1 else build_masks.unary_union([geoms[i] for i in matches])
                build_masks.prepare(union)
                full = bool(footprint(fine, bounds, x, x, y, y)) and bool(footprint(fine, bounds, x + bw - 1, x + bw - 1, y + bh - 1, y + bh - 1))
                full = full and all(union.covers(part) for part in parts) and (excluded.is_empty or all(not excluded.intersects(part) for part in parts))
                mask = bytearray(MASK_BYTES)
                for r in range(bh):
                    bits = (1 << bw) - 1 if full else 0
                    if not full:
                        for c in range(bw):
                            cells = footprint(fine, bounds, x + c, x + c, y + r, y + r)
                            if any(union.intersects(cell) for cell in cells) and (excluded.is_empty or all(not excluded.intersects(cell) for cell in cells)):
                                bits |= 1 << c
                    mask[r * 2:r * 2 + 2] = bits.to_bytes(2, 'little')
                if any(mask):
                    output[by * columns + bx] = mask
        blocks = add_halo(output, width, height, wrap)
        if not output:
            raise ValueError('Coverage has no output cells')
        if 60 + len(blocks) * 72 > 256 * 1024 * 1024:
            raise ValueError('Sparse coverage exceeds byte limit')
        sparse = sparse_from_blocks(width, height, wrap, grid_hash, blocks)
        tiles = build_tiles(output, fine, bounds, coverage['maxNativeZoom'])
        return {'fine': fine, 'gridHash': grid_hash, 'sparseBytes': sparse, 'tilesBytes': tiles,
                'activeCells': sum(sum((a | b).bit_count() for a, b in zip(out, halo)) for out, halo in blocks.values()),
                'blockCount': len(blocks), 'source': {'dataset': build_masks.SOURCE_DATASET, 'release': build_masks.SOURCE_RELEASE,
                'url': build_masks.SOURCE_URL, 'sha256': build_masks.SOURCE_SHA256, 'archiveBytes': build_masks.SOURCE_ARCHIVE_BYTES,
                'license': build_masks.SOURCE_LICENSE, 'excludedA3': coverage['excludedA3'],
                'excludedContinents': coverage.get('excludedContinents', []), 'isoExceptions': iso_exceptions,
                'continentExclusions': continent_exclusions}}


def descriptor(settings, k, result):
    coverage = settings['coverage']
    return {'version': 2, 'id': coverage['id'], 'grid': result['fine'], 'gridHash': result['gridHash'],
            'bounds': [coverage['west'], coverage['south'], coverage['east'], coverage['north']],
            'policy': coverage['description'] + ' Fine ' + str(k) + 'x subdivision.', 'maxZoom': coverage['maxNativeZoom'],
            'supportHaloCells': 1, 'sampleLayout': {'format': 'cell-major-block-shards-v1', 'blockSize': 16},
            'files': {name: {'bytes': len(result[key]), 'sha256': hashlib.sha256(result[key]).hexdigest()}
                      for name, key in [('sparse', 'sparseBytes'), ('tiles', 'tilesBytes')]}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path('packages/contracts/config/models.json'))
    parser.add_argument('--model')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--k', type=int)
    args = parser.parse_args()
    if build_masks.geos_version_string != '3.13.1' or build_masks.proj_version_str != '9.5.1':
        raise SystemExit('Mask generation requires GEOS 3.13.1 and PROJ 9.5.1')
    settings = build_masks.model_settings(args.config, args.model)
    k = args.k if args.k is not None else settings.get('terrainSubdivisionFactor')
    settings['coverage']['maxNativeZoom'] = max_native_zoom()
    output = args.output or Path('packages/contracts') / settings['coverageDir'] / 'fine'
    result = build_hierarchy(settings, k, args.source)
    output.mkdir(parents=True, exist_ok=True)
    for name, key in [('sparse.bin', 'sparseBytes'), ('tiles.bin', 'tilesBytes')]:
        build_masks.write_atomic(output / name, result[key])
    build_masks.write_atomic(output / 'manifest.json', json.dumps(descriptor(settings, k, result), separators=(',', ':')).encode())
    receipt = {'source': result['source'], 'grid': result['fine'], 'gridHash': result['gridHash'], 'k': k,
               'seaBufferMeters': settings['coverage']['seaBufferMeters'], 'files': descriptor(settings, k, result)['files'],
               'generator': {'path': 'scripts/masks/build_fine_masks.py', 'sha256': build_masks.sha256_file(Path(__file__)),
                             'policySha256': build_masks.sha256_file(Path(build_masks.__file__)), 'python': platform.python_version(),
                             'geos': build_masks.geos_version_string, 'proj': build_masks.proj_version_str,
                             'packages': {name: version(name) for name in ('shapely', 'pyproj', 'pyshp')},
                             'arguments': sys.argv[1:]}}
    build_masks.write_atomic(output / 'source.json', json.dumps(receipt, indent=2).encode())
    print(json.dumps({'output': str(output), 'gridHash': result['gridHash'], 'activeCells': result['activeCells'],
                      'blockCount': result['blockCount'], 'files': descriptor(settings, k, result)['files']}, indent=2))


if __name__ == '__main__':
    main()
