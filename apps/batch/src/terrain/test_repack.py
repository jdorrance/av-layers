"""Synthetic integration checks; run with the same pinned dependencies as repack.py."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin

from repack import repack


class RepackTest(unittest.TestCase):
    def test_preserves_native_samples_overviews_mask_and_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = [Path(directory) / name for name in ("source.tif", "target.tif")]
            values = np.arange(1200 * 1200, dtype=np.float32).reshape(1200, 1200) / 7 - 100
            values[0, 0], values[2, 8], values[3, 9] = 0, -32767, np.nan
            transform = from_origin(44 - 1 / 2400, 41 + 1 / 2400, 1 / 1200, 1 / 1200)
            with rasterio.open(source, "w", driver="GTiff", width=1200, height=1200, count=1,
                               dtype="float32", crs="EPSG:4326", transform=transform,
                               nodata=-32767, tiled=True, blockxsize=256, blockysize=256) as dataset:
                dataset.write(values, 1)
                dataset.update_tags(AREA_OR_POINT="Point", fixture="native sample preservation")
                dataset.build_overviews([2, 4], Resampling.average)
            result = repack(source, target)
            self.assertEqual(result["geometry"]["lon0"], 44)
            self.assertEqual(result["geometry"]["lat0"], 41)
            self.assertEqual(result["nodata"], -32767)
            with rasterio.open(target) as packed:
                self.assertEqual(packed.block_shapes, [(512, 512)])
                self.assertEqual(packed.overviews(1), [2, 4])
                self.assertEqual(packed.tags()["AREA_OR_POINT"], "Point")
                np.testing.assert_array_equal(values.view(np.uint32), packed.read(1).view(np.uint32))

    def test_preserves_longitude_spacing_at_high_latitude(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = [Path(directory) / name for name in ("source.tif", "target.tif")]
            transform = from_origin(-180 - 1 / 480, 86 + 1 / 2400, 1 / 240, 1 / 1200)
            with rasterio.open(source, "w", driver="GTiff", width=240, height=1200, count=1,
                               dtype="float32", crs="EPSG:4326", transform=transform) as dataset:
                dataset.write(np.zeros((1200, 240), dtype=np.float32), 1)
                dataset.update_tags(AREA_OR_POINT="Point")
            result = repack(source, target)
            self.assertEqual(result["geometry"]["lon0"], -180)
            self.assertEqual(result["geometry"]["dx"], 1 / 240)
            self.assertEqual(result["geometry"]["dy"], -1 / 1200)

    def test_rejects_projected_or_non_float_input(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = [Path(directory) / name for name in ("source.tif", "target.tif")]
            with rasterio.open(source, "w", driver="GTiff", width=2, height=2, count=1,
                               dtype="uint16", crs="EPSG:3857", transform=from_origin(0, 1, 1, 1)) as dataset:
                dataset.write(np.zeros((2, 2), dtype=np.uint16), 1)
            with self.assertRaisesRegex(ValueError, "GLO-90 Float32"):
                repack(source, target)
            self.assertFalse(target.exists())

    def test_rejects_unrepresented_mask_instead_of_publishing_valid_elevation(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = [Path(directory) / name for name in ("source.tif", "target.tif")]
            with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True):
                with rasterio.open(source, "w", driver="GTiff", width=1200, height=1200, count=1,
                                   dtype="float32", crs="EPSG:4326",
                                   transform=from_origin(44, 41, 1 / 1200, 1 / 1200)) as dataset:
                    dataset.write(np.ones((1200, 1200), dtype=np.float32), 1)
                    mask = np.full((1200, 1200), 255, dtype=np.uint8)
                    mask[10, 10] = 0
                    dataset.write_mask(mask)
            with self.assertRaisesRegex(ValueError, "validity mask"):
                repack(source, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
