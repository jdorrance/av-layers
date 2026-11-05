import type { ElevationGrid, SolarSite, TerrainBounds, TerrainSources } from '@av/contracts';
import { domainOf, expandBounds, metresPerDegree, xToLon } from './grid.ts';
import { MAX_ZOOM } from './constants.ts';

export const fixtureSources: TerrainSources = {
  surface: { id: 'fixture-native-dem', name: 'Fixture DEM', resolutionM: 90, licence: 'test', url: 'https://example.test/dem' },
  horizon: { id: 'fixture-native-dem', name: 'Fixture DEM', resolutionM: 90, licence: 'test', url: 'https://example.test/dem' }
};
function grid(bounds: TerrainBounds, step: number, elevation: (latitude: number, longitude: number) => number): ElevationGrid {
  const width = Math.ceil((bounds.east - bounds.west) / step), height = Math.ceil((bounds.north - bounds.south) / step);
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    values[row * width + column] = elevation(bounds.north - (row + 0.5) * step, bounds.west + (column + 0.5) * step);
  }
  return { values, width, height, west: bounds.west, north: bounds.north, dLon: step, dLat: step };
}
export function solarFixture(name: 'flat' | 'plane' | 'ridge' | 'missing' | 'seam') {
  const longitude = name === 'seam' ? xToLon(638 * 4096, MAX_ZOOM) : 44;
  const site: SolarSite = { slug: name, latitude: 40, longitude };
  const area = { name, south: site.latitude - 0.0001, west: site.longitude - 0.0001, north: site.latitude + 0.0001, east: site.longitude + 0.0001 };
  const domain = domainOf(site, { area }), scale = metresPerDegree(site.latitude);
  const elevation = (latitude: number, longitude: number) => {
    const x = (longitude - site.longitude) * scale.lon, y = (latitude - site.latitude) * scale.lat;
    if (name === 'missing' && Math.abs(x) < 200 && Math.abs(y) < 200) return NaN;
    if (name === 'ridge') return 300 + 900 * Math.exp(-(((x - 900) / 170) ** 2) - (y / 600) ** 2);
    return name === 'flat' ? 1000 : 1000 + x * 0.2 + y * 0.1;
  };
  return { site, area, maxDistanceKm: 2, sources: fixtureSources,
    fine: grid(expandBounds(domain.bounds, 250), 1 / 8000, elevation),
    coarse: grid(expandBounds(domain.bounds, 2100), 1 / 1200, elevation) };
}
