#!/usr/bin/env python3
import hashlib
import json
import math
import os
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_fine_masks as fine_masks
import build_masks
from tile_pyramid import build_tiles, max_native_zoom
from shapely.geometry import box
from shapely.ops import unary_union


def tile_lat(y, n):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))


def reference(grid, bounds, admitted, excluded, zoom):
    width, height = grid['width'], grid['height']
    west, south, east, north = bounds
    output = set()
    footprints = {}
    for row in range(height):
        for col in range(width):
            lon = grid['lon0'] + col * grid['dx']
            lat = grid['lat0'] + row * grid['dy']
            bottom, top = max(south, lat - abs(grid['dy']) / 2), min(north, lat + abs(grid['dy']) / 2)
            parts = []
            for shift in ((-360, 0, 360) if grid['wrapLongitude'] else (0,)):
                left, right = max(west, lon + shift - abs(grid['dx']) / 2), min(east, lon + shift + abs(grid['dx']) / 2)
                if left < right and bottom < top:
                    parts.append(box(left, bottom, right, top))
            if any(admitted.intersects(part) for part in parts) and not any(excluded.intersects(part) for part in parts):
                output.add((col, row))
                footprints[(col, row)] = parts
    halo = set()
    for col, row in output:
        for yy in range(row - 1, row + 2):
            for xx in range(col - 1, col + 2):
                if grid['wrapLongitude']:
                    xx %= width
                if 0 <= xx < width and 0 <= yy < height and (xx, yy) not in output:
                    halo.add((xx, yy))
    tile_bits = bytearray(sum(4 ** z for z in range(zoom + 1)))
    all_parts = [part for parts in footprints.values() for part in parts]
    offset = 0
    for z in range(zoom + 1):
        n = 2 ** z
        for y in range(n):
            for x in range(n):
                tile = box(-180 + x * 360 / n, tile_lat(y + 1, n),
                           -180 + (x + 1) * 360 / n, tile_lat(y, n))
                tile_bits[offset + y * n + x] = any(part.intersects(tile) for part in all_parts)
        offset += n * n
    return output, halo, build_masks.pack_bits(tile_bits)


def unpack(data):
    magic, version, width, height, wrap, count, active = struct.unpack_from('<7I', data)
    assert magic == 0x31564353 and version == 1
    out, halo = set(), set()
    columns = (width + 15) // 16
    offset = 60 + count * 8
    running = 0
    for i in range(count):
        bid, start = struct.unpack_from('<II', data, 60 + 8 * i)
        assert start == running
        for local in range(256):
            col, row = bid % columns * 16 + local % 16, bid // columns * 16 + local // 16
            for result, pos in ((out, offset), (halo, offset + count * 32)):
                if data[pos + i * 32 + local // 8] & (1 << (local % 8)):
                    assert col < width and row < height
                    result.add((col, row))
                    running += 1
    assert running == active
    return out, halo


def check_typescript(settings, k, result):
    with tempfile.TemporaryDirectory() as tmp:
        descriptor = json.dumps(fine_masks.descriptor(settings, k, result), separators=(',', ':')).encode()
        digest = hashlib.sha256(descriptor).hexdigest()
        directory = Path(tmp) / 'coverage' / digest
        directory.mkdir(parents=True)
        (directory / 'manifest.json').write_bytes(descriptor)
        (directory / 'sparse.bin').write_bytes(result['sparseBytes'])
        (directory / 'tiles.bin').write_bytes(result['tilesBytes'])
        subprocess.run(['node', '--import', 'tsx', 'scripts/masks/check_fine_masks.ts', tmp, digest], check=True)


class FineMasksTest(unittest.TestCase):
    def test_tile_pyramid_bounds_come_from_wire_contract(self):
        for zoom in (-1, max_native_zoom() + 1, 1.5, True):
            with self.assertRaises(ValueError):
                build_tiles({}, {}, (), zoom)

    def run_case(self, grid, bounds, admitted, excluded, k=1, zoom=3):
        settings = {'modelId': 'test', 'coverageDir': 'coverage/test', 'grid': grid,
                    'coverage': {'id': 'test', 'description': 'test', 'west': bounds[0], 'south': bounds[1],
                                 'east': bounds[2], 'north': bounds[3], 'maxNativeZoom': zoom,
                                 'seaBufferMeters': 0, 'excludedA3': [], 'excludedContinents': []}}
        admitted_union = unary_union(admitted)
        excluded = unary_union(excluded)
        def tile(parts, lon, lat, lat_min, lat_max, buffer, lon_min, lon_max, wrap):
            core = box(max(lon_min, lon - 5), max(lat_min, lat - 5), min(lon_max, lon + 5), min(lat_max, lat + 5))
            geom = admitted_union.intersection(core)
            return geom if not geom.is_empty else None
        with patch.object(build_masks, 'materialize_source', return_value=(Path('fixture.zip'), Path('fixture.shp'))), \
             patch.object(build_masks, 'load_features', return_value=(admitted, excluded, [], [])), \
             patch.object(build_masks, 'build_tile_geometry', side_effect=tile):
            result = fine_masks.build_hierarchy(settings, k, None)
        expected_out, expected_halo, expected_tiles = reference(result['fine'], bounds, admitted_union, excluded, 3)
        actual_out, actual_halo = unpack(result['sparseBytes'])
        self.assertEqual(actual_out, expected_out)
        self.assertEqual(actual_halo, expected_halo)
        if zoom == 3:
            self.assertEqual(result['tilesBytes'], expected_tiles)
        else:
            prefix = bytearray(result['tilesBytes'][:len(expected_tiles)])
            prefix[-1] &= (1 << (sum(4 ** z for z in range(4)) % 8)) - 1
            self.assertEqual(prefix, expected_tiles)
            self.assertTrue(any(result['tilesBytes'][len(expected_tiles):]))
        self.assertTrue(actual_out)
        check_typescript(settings, k, result)
        return actual_out, actual_halo

    def test_regional_boundaries_and_islands(self):
        grid = {'kind': 'regular-latlon', 'width': 41, 'height': 35, 'earthRadiusM': 6371229,
                'lon0': -10, 'lat0': 10, 'dx': 0.5, 'dy': -0.25, 'wrapLongitude': False}
        out, halo = self.run_case(grid, (-8, 2, 8, 9), [box(-2.35, 5, -2.3, 5.1), box(1, 3, 4, 7)],
                                  [box(2, 4, 2.5, 5)])
        self.assertIn((15, 20), out)
        self.assertIn((16, 20), halo)
        self.assertTrue(any(x >= 16 for x, y in halo))

    def test_wrap_seam_exclusions_and_poles(self):
        grid = {'kind': 'regular-latlon', 'width': 36, 'height': 19, 'earthRadiusM': 6371229,
                'lon0': -180, 'lat0': 90, 'dx': 10, 'dy': -10, 'wrapLongitude': True}
        out, halo = self.run_case(grid, (-180, -90, 180, 90),
                                  [box(179, -2, 180, 2), box(-179, 87, -178, 90), box(5, -90, 7, -88)],
                                  [box(-180, -1, -179.5, 1)])
        self.assertNotIn((0, 9), out)
        self.assertIn((0, 0), out)
        self.assertIn((35, 0), halo)

    def test_signed_step_validation(self):
        grid = {'kind': 'regular-latlon', 'width': 2, 'height': 2, 'earthRadiusM': 6371229,
                'lon0': 0, 'lat0': 0, 'dx': -1, 'dy': 1, 'wrapLongitude': False}
        with self.assertRaises(ValueError):
            fine_masks.fine_grid(grid, 1)
        grid['dx'] = 1
        with self.assertRaises(ValueError):
            fine_masks.fine_grid(grid, 1)

    def test_subdivision_and_tile_boundaries(self):
        grid = {'kind': 'regular-latlon', 'width': 21, 'height': 21, 'earthRadiusM': 6371229,
                'lon0': -10, 'lat0': 10, 'dx': 1, 'dy': -1, 'wrapLongitude': False}
        self.run_case(grid, (-10, -10, 10, 10), [box(-0.1, -0.1, 0.1, 0.1)], [], k=2)

    def test_zoom_ten_preserves_cells_and_prior_tiles(self):
        grid = {'kind': 'regular-latlon', 'width': 3, 'height': 3, 'earthRadiusM': 6371229,
                'lon0': 0, 'lat0': 1, 'dx': 0.5, 'dy': -0.5, 'wrapLongitude': False}
        self.run_case(grid, (0, 0, 1, 1), [box(0.1, 0.1, 0.9, 0.9)], [], zoom=10)

    @unittest.skipUnless(os.environ.get('FINE_MASK_REAL_SOURCE'), 'set FINE_MASK_REAL_SOURCE for pinned source smoke')
    def test_pinned_source_smoke(self):
        settings = json.loads(Path('packages/contracts/config/gfs.json').read_text())
        settings['grid'] = {'kind': 'regular-latlon', 'width': 33, 'height': 33, 'earthRadiusM': 6371229,
                            'lon0': -8, 'lat0': 40, 'dx': 0.25, 'dy': -0.25, 'wrapLongitude': False}
        settings['coverage'].update({'west': -8, 'south': 32, 'east': 0, 'north': 40, 'maxNativeZoom': 3})
        bounds = (-8, 32, 0, 40)
        with tempfile.TemporaryDirectory() as tmp:
            archive, shp = build_masks.materialize_source(None, Path(tmp))
            admitted, excluded, _, _ = build_masks.load_features(shp, tuple(settings['coverage']['excludedA3']), ('Africa',))
            result = fine_masks.build_hierarchy(settings, 1, archive)
            tiles = []
            for lat in (32, 42):
                for lon in (-5, 5):
                    geom = build_masks.build_tile_geometry(admitted, lon, lat, 32, 40, 50000, -8, 0, False)
                    if geom is not None:
                        tiles.append(geom)
            out, halo, tile_bits = reference(result['fine'], bounds, unary_union(tiles), excluded, 3)
            self.assertEqual(unpack(result['sparseBytes']), (out, halo))
            self.assertEqual(result['tilesBytes'], tile_bits)
            self.assertGreater(len(out), 0)
            self.assertEqual(result['source']['sha256'], build_masks.SOURCE_SHA256)
            check_typescript(settings, 1, result)


if __name__ == '__main__':
    unittest.main()
