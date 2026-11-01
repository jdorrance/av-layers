import { describe, expect, it } from 'vitest';
import { clampOpacity, frameTileUrl, previewRasterLayer, previewRasterSource, windyTileOptions } from './client';

describe('tile template and options', () => {
  it('substitutes only the pinned frame into a server template', () => {
    const url = frameTileUrl('https://api.test/tiles/gfs/build/usable-lift-msl/{frame}/{z}/{x}/{y}.webp', 'f003');
    expect(url).toBe('https://api.test/tiles/gfs/build/usable-lift-msl/f003/{z}/{x}/{y}.webp');
    expect(() => frameTileUrl('https://api.test/{z}/{x}/{y}.webp', 'f003')).toThrow(RangeError);
  });

  it('builds a MapLibre 256px raster source limited to the native max zoom', () => {
    const source = previewRasterSource('https://api.test/{frame}/{z}/{x}/{y}.webp', 'f003', 5, 'Test attribution');
    expect(source).toMatchObject({ type: 'raster', tileSize: 256, minzoom: 0, maxzoom: 5 });
    expect(source.tiles).toEqual(['https://api.test/f003/{z}/{x}/{y}.webp']);
    expect(previewRasterLayer()).not.toHaveProperty('maxzoom');
  });

  it('applies default opacity exactly once on the raster layer', () => {
    const layer = previewRasterLayer();
    expect(layer.paint['raster-opacity']).toBe(0.5);
    expect(Object.keys(layer.paint).filter(key => key.includes('opacity'))).toEqual(['raster-opacity']);
  });

  it('pins supported LeafletGL tile options and disables retina requests', () => {
    const options = windyTileOptions(5, 0.5, 'Test attribution');
    expect(options).toMatchObject({
      tileSize: 256,
      detectRetina: false,
      minZoom: 0,
      maxZoom: 18,
      maxNativeZoom: 5,
      minNativeZoom: 0,
      opacity: 0.5
    });
  });

  it('clamps opacity and rejects invalid source zoom', () => {
    expect(clampOpacity(2)).toBe(1);
    expect(clampOpacity(-1)).toBe(0);
    expect(clampOpacity(Number.NaN)).toBe(0.5);
    expect(() => windyTileOptions(5.5, 0.5, 'Test attribution')).toThrow(RangeError);
  });
});
