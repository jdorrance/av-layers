"""Build the bounded XYZ pyramid from immutable output-cell footprints."""
from __future__ import annotations

import bisect
import functools
import math
from pathlib import Path
import subprocess


@functools.cache
def max_native_zoom():
    root = Path(__file__).resolve().parents[2]
    value = subprocess.run(
        ['node', '--import', 'tsx', '--input-type=module', '-e',
         "import { MAX_NATIVE_ZOOM } from './packages/contracts/src/format.ts'; process.stdout.write(String(MAX_NATIVE_ZOOM));"],
        cwd=root, text=True, capture_output=True, check=True)
    return int(value.stdout)


def _footprints(grid, bounds, x0, x1, y0, y1):
    west, south, east, north = bounds
    low_y = max(south, grid['lat0'] + y1 * grid['dy'] - abs(grid['dy']) / 2)
    high_y = min(north, grid['lat0'] + y0 * grid['dy'] + abs(grid['dy']) / 2)
    if low_y >= high_y:
        return
    low_x = grid['lon0'] + x0 * grid['dx'] - grid['dx'] / 2
    high_x = grid['lon0'] + x1 * grid['dx'] + grid['dx'] / 2
    for shift in ((-360, 0, 360) if grid['wrapLongitude'] else (0,)):
        lo, hi = max(west, low_x + shift), min(east, high_x + shift)
        if lo < hi:
            yield lo, low_y, hi, high_y


def build_tiles(output, grid, bounds, max_zoom):
    if type(max_zoom) is not int or not 0 <= max_zoom <= max_native_zoom():
        raise ValueError('Invalid maximum native zoom')
    n = 1 << max_zoom
    finest = bytearray(n * n)
    columns = (grid['width'] + 15) // 16
    x_boundaries = [-180 + x * 360 / n for x in range(n + 1)]
    y_boundaries = [-math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n)))) for y in range(n + 1)]

    def indices(boundaries, lo, hi):
        return max(0, bisect.bisect_left(boundaries, lo) - 1), min(n - 1, bisect.bisect_right(boundaries, hi) - 1)

    for bid, mask in output.items():
        bx, by = bid % columns, bid // columns
        bw, bh = min(16, grid['width'] - bx * 16), min(16, grid['height'] - by * 16)
        row = 0
        while row < bh:
            bits = int.from_bytes(mask[row * 2:row * 2 + 2], 'little')
            end = row + 1
            while end < bh and int.from_bytes(mask[end * 2:end * 2 + 2], 'little') == bits:
                end += 1
            col = 0
            while col < bw:
                if not bits & (1 << col):
                    col += 1
                    continue
                stop = col + 1
                while stop < bw and bits & (1 << stop):
                    stop += 1
                for west, south, east, north in _footprints(grid, bounds, bx * 16 + col, bx * 16 + stop - 1, by * 16 + row, by * 16 + end - 1):
                    if -north > y_boundaries[-1] or -south < y_boundaries[0]:
                        continue
                    x0, x1 = indices(x_boundaries, west, east)
                    y0, y1 = indices(y_boundaries, -north, -south)
                    for y in range(y0, y1 + 1):
                        finest[y * n + x0:y * n + x1 + 1] = b'\1' * (x1 - x0 + 1)
                col = stop
            row = end
    levels = [None] * (max_zoom + 1)
    levels[max_zoom] = finest
    for zoom in range(max_zoom - 1, -1, -1):
        side = 1 << zoom
        child = levels[zoom + 1]
        levels[zoom] = bytearray(any(child[(2 * y + dy) * (side * 2) + 2 * x + dx] for dy in (0, 1) for dx in (0, 1))
                                 for y in range(side) for x in range(side))
    bits = bytearray().join(levels)
    packed = bytearray((len(bits) + 7) // 8)
    for index, value in enumerate(bits):
        if value:
            packed[index >> 3] |= 1 << (index & 7)
    return bytes(packed)
