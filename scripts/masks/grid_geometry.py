"""Project geographic policy geometry onto configured spherical Lambert cells."""
import math

from pyproj import CRS, Transformer
from shapely import prepare, segmentize
from shapely.geometry import box
from shapely.ops import transform


class ProjectedFootprints:
    def __init__(self, grid, bounds):
        if grid['kind'] != 'lambert-conformal' or grid['wrapLongitude']:
            raise ValueError('Expected a non-wrapping Lambert grid')
        if not all(math.isfinite(grid[key]) and grid[key] != 0 for key in ('dxM', 'dyM')):
            raise ValueError('Projected grid spacing must be finite and nonzero')
        self.grid, self.bounds = grid, bounds
        sphere = CRS.from_proj4(f"+proj=longlat +R={grid['earthRadiusM']} +no_defs")
        projected = CRS.from_proj4(
            f"+proj=lcc +R={grid['earthRadiusM']} +lon_0={grid['centralMeridianDeg']} "
            f"+lat_0={grid['latitudeOfOriginDeg']} +lat_1={grid['standardParallel1Deg']} "
            f"+lat_2={grid['standardParallel2Deg']} +units=m +no_defs")
        self.forward = Transformer.from_crs(sphere, projected, always_xy=True)
        self.inverse = Transformer.from_crs(projected, sphere, always_xy=True)
        self.step_m = min(abs(grid['dxM']), abs(grid['dyM']))
        self.step_deg = math.degrees(self.step_m / grid['earthRadiusM'])
        self.region = self.project(box(*bounds)).intersection(self.rectangle(0, grid['width'] - 1, 0, grid['height'] - 1))
        prepare(self.region)

    def project(self, geometry):
        clipped = geometry.intersection(box(*self.bounds))
        return transform(self.forward.transform, segmentize(clipped, self.step_deg)) if not clipped.is_empty else clipped

    def rectangle(self, x0, x1, y0, y1):
        grid = self.grid
        xs = [grid['x0M'] + (x0 - .5) * grid['dxM'], grid['x0M'] + (x1 + .5) * grid['dxM']]
        ys = [grid['y0M'] + (y0 - .5) * grid['dyM'], grid['y0M'] + (y1 + .5) * grid['dyM']]
        return box(min(xs), min(ys), max(xs), max(ys))

    def footprints(self, x0, x1, y0, y1):
        clipped = self.rectangle(x0, x1, y0, y1).intersection(self.region)
        return [] if clipped.is_empty else [clipped]

    def geographic(self, geometry):
        return transform(self.inverse.transform, segmentize(geometry, self.step_m))

    def nearest(self, lat, lon):
        x, y = self.forward.transform(lon, lat)
        grid = self.grid
        return (x - grid['x0M']) / grid['dxM'], (y - grid['y0M']) / grid['dyM']
