"""Losslessly retile one GLO-90 source; emit checked sample-centre metadata."""

import argparse
import json
import math
import sys

import numpy as np
import rasterio
from rasterio.shutil import copy


def equal_samples(left, right):
    if left.shape != right.shape or left.transform != right.transform:
        raise ValueError("Repacking changed raster geometry")
    if not np.array_equal(left.read(1).view(np.uint32), right.read(1).view(np.uint32)):
        raise ValueError("Repacking changed native elevation bits")
    if not np.array_equal(left.read_masks(1), right.read_masks(1)):
        raise ValueError("Repacking changed elevation validity")


def repack(source, destination):
    with rasterio.Env(GDAL_CACHEMAX=32 * 1024 * 1024, GDAL_NUM_THREADS="1"):
        with rasterio.open(source) as original:
            transform = original.transform
            if (original.count != 1 or original.dtypes != ("float32",)
                    or original.crs != rasterio.crs.CRS.from_epsg(4326)
                    or original.width not in (1200, 800, 600, 400, 240, 120) or original.height != 1200
                    or transform.b != 0 or transform.d != 0
                    or transform.a <= 0 or transform.e >= 0
                    or not math.isclose(transform.a * original.width, 1, abs_tol=1e-10)
                    or not math.isclose(transform.e * original.height, -1, abs_tol=1e-10)):
                raise ValueError("Expected one north-up geographic GLO-90 Float32 band")
            if original.nodata is not None and math.isinf(original.nodata):
                raise ValueError("Unsupported infinite nodata")
            values = original.read(1)
            unexplained_mask = (original.read_masks(1) == 0) & np.isfinite(values)
            if original.nodata is not None:
                unexplained_mask &= values != original.nodata
            if np.any(unexplained_mask):
                raise ValueError("Source validity mask requires support beyond scalar nodata")
            copy(original, destination, driver="COG", strict=True, BLOCKSIZE=512,
                 COMPRESS="DEFLATE", LEVEL=6, PREDICTOR=3, NUM_THREADS=1,
                 OVERVIEWS="FORCE_USE_EXISTING", BIGTIFF="IF_NEEDED")
            with rasterio.open(destination) as packed:
                equal_samples(original, packed)
                same_nodata = (original.nodata == packed.nodata or
                               (original.nodata is not None and packed.nodata is not None
                                and math.isnan(original.nodata) and math.isnan(packed.nodata)))
                if (packed.crs != original.crs or packed.dtypes != original.dtypes
                        or not same_nodata or packed.tags() != original.tags()
                        or packed.block_shapes != [(512, 512)]
                        or packed.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG"
                        or packed.overviews(1) != original.overviews(1)):
                    raise ValueError("Repacking changed source metadata or overview layout")
            for level in range(len(original.overviews(1))):
                with rasterio.open(source, OVERVIEW_LEVEL=level) as old:
                    with rasterio.open(destination, OVERVIEW_LEVEL=level) as new:
                        equal_samples(old, new)
            lon, lat = original.xy(0, 0)
            return {
                "runtime": {"rasterio": rasterio.__version__, "numpy": np.__version__,
                            "python": f"{sys.version_info.major}.{sys.version_info.minor}",
                            "gdal": rasterio.__gdal_version__},
                "geometry": {"width": original.width, "height": original.height,
                             "lon0": lon, "lat0": lat, "dx": transform.a, "dy": transform.e},
                "nodata": original.nodata if original.nodata is not None and math.isfinite(original.nodata) else None,
            }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args()
    print(json.dumps(repack(args.source, args.destination), allow_nan=False, separators=(",", ":")))
