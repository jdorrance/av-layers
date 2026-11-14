import { expect, it } from 'vitest';
import { PALETTES, SUPPORT_CUMULUS, SUPPORT_OVERDEVELOPED,
  SUPPORT_CLOUD_CAPPED, SUPPORT_PARCEL_CROSSING, paletteSchema, type LayerId } from '@av/contracts';
import { fixtureBuild, fixtureManifestV5 } from '../../../tests/forecast-fixture';
import { activePalettes, buildDiagnosticRows, deriveTerrainM, formatAltitude, formatSupportFlags, layerMaxZoom, planViewportPrefetch, pointFrameView, pointSeriesSelection, seriesTable, viewportTiles } from './client-view';


it('formats independent physical support and cloud regime flags', () => {
  expect(formatSupportFlags(SUPPORT_PARCEL_CROSSING | SUPPORT_CUMULUS | SUPPORT_OVERDEVELOPED | SUPPORT_CLOUD_CAPPED)).toBe('parcel+Cu+OD+capped');
  expect(formatSupportFlags(0)).toBe('—');
});

it('honors pinned sample-only delivery for legends and every prefetch path', () => {
  const build = fixtureBuild();
  build.manifest.descriptors.layers['usable-lift-msl'].delivery = 'samples-only';
  expect(activePalettes(build.manifest.descriptors.palettes, 'usable-lift-msl', build.manifest.descriptors.layers)).toEqual([]);
  const options = { build, activeFrame: 'f006', viewportTiles: [{ z: 3, x: 3, y: 3 }] };
  expect(planViewportPrefetch({ ...options, activeLayer: 'usable-lift-msl' })).toEqual([]);
  const urls = planViewportPrefetch({ ...options, activeLayer: 'usable-lift-agl' });
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.some(url => url.includes('/usable-lift-msl/'))).toBe(false);
});

it('serializes stepped interpolation without changing retained palette compatibility', () => {
  expect(paletteSchema.parse(JSON.parse(JSON.stringify(PALETTES.lift))).interpolation).toBe('step');
  const { interpolation: _, ...retained } = PALETTES.lift;
  expect(paletteSchema.parse(retained).interpolation).toBeUndefined();
  expect(paletteSchema.safeParse({ ...PALETTES.lift, interpolation: 'spline' }).success).toBe(false);
});

it('shows the actual horizon for irregular frames in channel order', () => {
  const frames = fixtureManifestV5().frames;
  const build = fixtureBuild({ frames: [frames[2], frames[0], frames.at(-1)!] });
  expect(buildDiagnosticRows(build).find(([label]) => label === 'Horizon')).toEqual([
    'Horizon', `${frames[0].validTime} → ${frames.at(-1)!.validTime}`
  ]);
  expect(build.manifest.frames.map(frame => frame.id)).toEqual([frames[2].id, frames[0].id, frames.at(-1)!.id]);
});

it('shows the pinned vertical reference and surface for each point value', () => {
  const manifest = fixtureManifestV5();
  const payload = { frames: [{ ...manifest.frames[0], layers: {
    'usable-lift-agl': { value: 300, status: 'valid' as const, support: 0, interpolated: false, surfaceId: 'gfs-fine' },
    'precip-rate': { value: 7, status: 'valid' as const, support: 0, interpolated: false, surfaceId: 'gfs-native' }
  } }] };
  const table = seriesTable(payload, ['usable-lift-agl', 'precip-rate'], manifest.descriptors.layers);
  expect(table.headings[2]).toBe('Usable lift depth (terrain AGL) (m AGL)');
  expect(table.headings[3]).toContain(manifest.descriptors.layers['precip-rate'].label);
  expect(table.rows[0][4]).toContain('gfs-fine');
  expect(table.rows[0][5]).toContain('gfs-native');
});

it('uses the zoom limit of the layer’s owning surface', () => {
  const { manifest } = fixtureBuild();
  expect(layerMaxZoom(manifest, 'precip-rate')).toBe(7);
  expect(layerMaxZoom(manifest, 'usable-lift-msl')).toBe(9);
  expect(layerMaxZoom(manifest, 'usable-lift-agl')).toBe(9);
});

it('reports each surface and its grid once', () => {
  const v5 = fixtureBuild();
  const rows = buildDiagnosticRows(v5);
  expect(rows).toContainEqual(['Usable lift depth (terrain AGL)', `m AGL · terrain-AGL · interval-flux-endpoint-profile · ${v5.manifest.descriptors.layers['usable-lift-agl'].methodId}`]);
  expect(rows.some(([label]) => label === 'Grid' || label === 'Display')).toBe(false);
  expect(rows.filter(([label]) => label.startsWith('Surface '))).toEqual([
    ['Surface gfs-native', '1440 × 721 · 0.25° × 0.25° · precip-rate · z0–7'],
    ['Surface gfs-fine', '2880 × 1441 · 0.125° × 0.125° · usable-lift-msl, usable-lift-agl · z0–9 · DSM · EGM2008']
  ]);
});

it('warms the sibling viewport before forecast steps and perimeter', () => {
  const build = fixtureBuild(), activeLayer = 'usable-lift-agl' as const;
  const urls = planViewportPrefetch({ build, activeLayer, activeFrame: 'f006', viewportTiles: [{ z: 3, x: 3, y: 3 }] });
  const tile = (layer: string, frame: string, x = 3, y = 3) => `https://api.test/tiles/${build.manifest.model}/${build.manifest.buildId}/${layer}/${frame}/3/${x}/${y}.webp`;
  expect(urls.slice(0, 5)).toEqual([
    tile('usable-lift-msl', 'f006'), tile(activeLayer, 'f009'), tile(activeLayer, 'f003'), tile(activeLayer, 'f012'), tile(activeLayer, 'f006', 2, 2)
  ]);
  expect(urls).toHaveLength(12);
  expect(new Set(urls).size).toBe(urls.length);
  expect(urls).not.toContain(tile(activeLayer, 'f006'));
});
it('uses owning surface zooms for overzoomed viewport prefetches', () => {
  const build = fixtureBuild(), viewportTiles = [{ z: 9, x: 256, y: 256 }];
  const rain = planViewportPrefetch({ build, activeLayer: 'precip-rate', activeFrame: 'f006', viewportTiles });
  expect(rain[0]).toContain('/precip-rate/f009/7/64/64.webp');
  expect(rain.every(url => !url.includes('usable-lift'))).toBe(true);
  expect(rain).not.toContain(`https://api.test/tiles/${build.manifest.model}/${build.manifest.buildId}/precip-rate/f006/7/64/64.webp`);
  const lift = planViewportPrefetch({ build, activeLayer: 'usable-lift-agl', activeFrame: 'f006', viewportTiles });
  expect(lift[0]).toContain('/usable-lift-msl/f006/9/256/256.webp');
});
it('filters bounds and invalid tile coordinates and wraps only longitude-wrapping surfaces', () => {
  const build = fixtureBuild();
  build.manifest.descriptors.bounds = [-1, -1, 1, 1];
  expect(planViewportPrefetch({ build, activeLayer: 'usable-lift-agl', activeFrame: 'f006', viewportTiles: [{ z: 5, x: 0, y: 0 }] })).toEqual([]);
  build.manifest.descriptors.bounds = [-180, -85, 180, 85];
  const options = { build, activeLayer: 'usable-lift-agl' as const, activeFrame: 'f006', viewportTiles: [{ z: 2, x: -1, y: 1 }] };
  expect(planViewportPrefetch(options)[0]).toContain('/2/3/1.webp');
  if (build.manifest.version !== 5) throw new Error('requires surfaces');
  build.manifest.surfaces.find(surface => surface.layers.includes(options.activeLayer))!.grid.wrapLongitude = false;
  expect(planViewportPrefetch(options)).toEqual([]);
  expect(planViewportPrefetch({ ...options, viewportTiles: [{ z: 2, x: 0, y: -1 }, { z: 2, x: 1.5, y: 0 }, { z: NaN, x: 0, y: 0 }] })).toEqual([]);
});
it('bounds prefetch URL count and omits frames beyond the timeline', () => {
  const build = fixtureBuild();
  const viewportTiles = Array.from({ length: 40 }, (_, x) => ({ z: 7, x, y: 60 }));
  const urls = planViewportPrefetch({ build, activeLayer: 'usable-lift-msl', activeFrame: 'f006', viewportTiles });
  expect(urls).toHaveLength(64);
  expect(urls.slice(0, 40).every(url => url.includes('/usable-lift-agl/f006/'))).toBe(true);
  expect(urls.slice(40).every(url => url.includes('/usable-lift-msl/f009/'))).toBe(true);
  const last = planViewportPrefetch({ build, activeLayer: 'precip-rate', activeFrame: 'f024', viewportTiles: [{ z: 3, x: 3, y: 3 }] });
  expect(last[0]).toContain('/f021/');
  expect(last.every(url => url.includes('/f021/') || url.includes('/f024/'))).toBe(true);
  expect(planViewportPrefetch({ build, activeLayer: 'precip-rate', activeFrame: 'missing', viewportTiles })).toEqual([]);
});

it('keeps wrapped perimeter tiles outside the visible set at world zoom', () => {
  const build = fixtureBuild();
  const urls = planViewportPrefetch({ build, activeLayer: 'precip-rate', activeFrame: 'f006', viewportTiles: [{ z: 0, x: 0, y: 0 }] });
  expect(urls).toHaveLength(3);
  expect(urls.every(url => !url.includes('/f006/'))).toBe(true);
});

it('enumerates bounded viewport tiles across the antimeridian and at the poles', () => {
  const wrapped = viewportTiles({ west: 170, south: -5, east: -170, north: 5 }, 2);
  expect(new Set(wrapped.map(tile => tile.x))).toEqual(new Set([3, 4]));
  expect(wrapped.every(tile => tile.y >= 0 && tile.y < 4)).toBe(true);
  expect(viewportTiles({ west: -180, south: -90, east: 180, north: 90 }, 0)).toEqual([{ z: 0, x: 0, y: 0 }]);
  expect(viewportTiles({ west: -180, south: -90, east: 180, north: 90 }, 10)).toHaveLength(64);
  expect(viewportTiles({ west: NaN, south: 0, east: 1, north: 1 }, 2)).toEqual([]);
  expect(viewportTiles({ west: 0, south: 0, east: 1, north: 1 }, -1)).toEqual([]);
});

it('selects the shared diurnal fields independently of wire page size', () => {
  const build = fixtureBuild();
  const native: LayerId[] = ['thermal-velocity', 'surface-lcl-msl', 'bl-mean-wind-u', 'bl-mean-wind-v', 'wind-10m-u', 'wind-10m-v', 'cloud-cover-total'];
  build.manifest.layers.push(...native);
  const selected = pointSeriesSelection(build);
  expect(selected.layers).toHaveLength(10);
  expect(selected.frames.length * selected.layers.length).toBeLessThanOrEqual(build.manifest.descriptors.maxSampleValues);
  expect(selected.layers.some(layer => layer.includes('80m'))).toBe(false);
  build.manifest.descriptors.maxSampleValues = 20;
  expect(pointSeriesSelection(build).frames).toEqual(selected.frames);
});

it('recovers terrain only when fine lift values share one uninterpolated basis', () => {
  const build = fixtureBuild();
  const layers = {
    'usable-lift-msl': { value: 2000, status: 'valid' as const, support: 4, interpolated: false, surfaceId: 'gfs-fine' },
    'usable-lift-agl': { value: 500, status: 'valid' as const, support: 4, interpolated: false, surfaceId: 'gfs-fine' }
  };
  const frame = { ...build.manifest.frames[0], layers };
  expect(deriveTerrainM(frame, build)).toBe(1500);
  layers['usable-lift-msl'].interpolated = true; layers['usable-lift-agl'].interpolated = true;
  expect(deriveTerrainM(frame, build)).toBeNull();
  layers['usable-lift-msl'].interpolated = false; layers['usable-lift-agl'].interpolated = false;
  layers['usable-lift-agl'].surfaceId = 'gfs-native';
  expect(deriveTerrainM(frame, build)).toBeNull();
  expect(deriveTerrainM(frame, fixtureBuild())).toBeNull();
});

it('formats point altitude, wind vectors and regime without inventing missing terrain', () => {
  const build = fixtureBuild();
  const frame = { ...build.manifest.frames[0], layers: {
    'usable-lift-msl': { value: null, status: 'no-usable-lift' as const, support: 0, interpolated: false, surfaceId: 'gfs-fine' },
    'usable-lift-agl': { value: 0, status: 'no-usable-lift' as const, support: SUPPORT_CUMULUS, interpolated: false, surfaceId: 'gfs-fine' },
    'wind-10m-u': { value: 0, status: 'valid' as const, support: 0, interpolated: false, surfaceId: 'gfs-native' },
    'wind-10m-v': { value: -5, status: 'valid' as const, support: 0, interpolated: false, surfaceId: 'gfs-native' },
    'thermal-velocity': { value: 1, status: 'valid' as const, support: SUPPORT_CUMULUS, interpolated: false, surfaceId: 'gfs-native' }
  } };
  const view = pointFrameView(frame, build, 'imperial');
  expect(view.terrainM).toBeNull(); expect(view.summary).toContain('Surface elevation unknown');
  expect(view.summary).toContain('10 m 11.2 mph 0°'); expect(view.summary).toContain('Cu');
  expect(view.summary).toContain('w* 197 ft/min');
  expect(pointFrameView(frame, build, 'metric').summary).toContain('w* 1.0 m/s');
  expect(view.summary).not.toContain('Blue');
  expect(formatAltitude(1000, 'imperial')).toBe('3281 ft');
  expect(formatAltitude(null, 'metric')).toBe('—');
});

it.each([
  { fine: 0, native: 0, top: 0, expected: 'Native cloud regime unknown' },
  { fine: 0, native: SUPPORT_CLOUD_CAPPED, top: 0, expected: 'capped' },
  { fine: 0, native: SUPPORT_CUMULUS, top: 0, expected: 'Cu' },
  { fine: SUPPORT_OVERDEVELOPED, native: 0, top: 0, expected: 'OD' },
  { fine: 0, native: 0, top: SUPPORT_OVERDEVELOPED, expected: 'OD' }
])('preserves independent cloud support and unknown clear-sky conditions: $expected', ({ fine, native, top, expected }) => {
  const build = fixtureBuild(), sample = (value: number, support = 0, surfaceId = 'gfs-native') => ({ value, support, surfaceId, status: 'valid' as const, interpolated: false });
  const frame = { ...build.manifest.frames[0], layers: {
    'usable-lift-msl': sample(2000, fine, 'gfs-fine'), 'usable-lift-agl': sample(500, fine, 'gfs-fine'),
    'thermal-velocity': sample(2, native), 'thermal-top-msl': sample(2500, top),
    'surface-lcl-msl': sample(3000), 'cloud-cover-total': sample(0)
  } };
  const summary = pointFrameView(frame, build, 'metric').summary;
  expect(summary).toContain(expected); expect(summary).not.toContain('Blue');
});

it('keeps raster prefetch inside the map prefix while the native point axis continues', () => {
  const build = fixtureBuild();
  if (build.manifest.version !== 5) throw new Error('Expected v5');
  build.manifest.mapFrameCount = 2;
  const options = { build, activeLayer: 'usable-lift-agl' as const, activeFrame: 'f006', viewportTiles: [{ z: 3, x: 3, y: 3 }] };
  expect(planViewportPrefetch(options).some(url => /\/f009\//.test(url))).toBe(false);
  expect(planViewportPrefetch({ ...options, activeFrame: 'f009' })).toEqual([]);
  expect(pointSeriesSelection(build).frames).not.toContain('f009');
  expect(build.manifest.frames.some(frame => frame.id === 'f009')).toBe(true);
});


it('warms a complete requested viewport before the sibling and other times', () => {
  const build = fixtureBuild(), activeLayer = 'usable-lift-agl' as const;
  const viewportTiles = Array.from({ length: 40 }, (_, x) => ({ z: 7, x, y: 60 }));
  const urls = planViewportPrefetch({ build, activeLayer, activeFrame: 'f006', viewportTiles,
    preferred: { layer: activeLayer, frame: 'f003' }, direction: -1 });
  expect(urls).toHaveLength(64);
  expect(urls.slice(0, 40).every(url => url.includes('/usable-lift-agl/f003/'))).toBe(true);
  expect(urls.slice(40).every(url => url.includes('/usable-lift-agl/f009/'))).toBe(true);
  expect(new Set(urls).size).toBe(urls.length);
});

it('follows backward scrub direction after the preferred target', () => {
  const build = fixtureBuild(), activeLayer = 'usable-lift-agl' as const;
  const urls = planViewportPrefetch({ build, activeLayer, activeFrame: 'f009', viewportTiles: [{ z: 3, x: 3, y: 3 }], direction: -1 });
  expect(urls.slice(0, 4).map(url => url.split('/').slice(-5, -3).join('/'))).toEqual([
    'usable-lift-msl/f009', 'usable-lift-agl/f006', 'usable-lift-agl/f012', 'usable-lift-agl/f003'
  ]);
});

it('ignores unavailable preferred frames and the already visible selection', () => {
  const build = fixtureBuild(), activeLayer = 'usable-lift-agl' as const;
  build.manifest.mapFrameCount = 2;
  const options = { build, activeLayer, activeFrame: 'f006', viewportTiles: [{ z: 3, x: 3, y: 3 }] };
  const missing = planViewportPrefetch({ ...options, preferred: { layer: activeLayer, frame: 'f009' } });
  expect(missing.some(url => url.includes('/f009/'))).toBe(false);
  const visible = planViewportPrefetch({ ...options, preferred: { layer: activeLayer, frame: 'f006' } });
  expect(visible.some(url => url.endsWith('/usable-lift-agl/f006/3/3/3.webp'))).toBe(false);
  expect(visible[0]).toContain('/usable-lift-agl/f003/');
});

it('uses the bounded byte window for unprepared timeline frames', () => {
  const build = fixtureBuild(), activeLayer = 'usable-lift-agl' as const;
  const viewportTiles = Array.from({ length: 40 }, (_, x) => ({ z: 7, x, y: 60 }));
  const urls = planViewportPrefetch({ build, activeLayer, activeFrame: 'f006', viewportTiles,
    preferred: { layer: activeLayer, frame: 'f009' },
    prepared: [{ layer: activeLayer, frame: 'f009' }, { layer: activeLayer, frame: 'f003' }],
    timelineFrames: ['f006', 'f009', 'missing', 'f012', 'f015', 'f003'] });
  expect(urls).toHaveLength(64);
  expect(urls.slice(0, 40).every(url => url.includes('/usable-lift-agl/f012/'))).toBe(true);
  expect(urls.slice(40).every(url => url.includes('/usable-lift-agl/f015/'))).toBe(true);
  expect(new Set(urls).size).toBe(64);
});

it('keeps explicit layer intent ahead of timeline bytes and still warms pan tiles', () => {
  const build = fixtureBuild(), activeLayer = 'usable-lift-agl' as const;
  const urls = planViewportPrefetch({ build, activeLayer, activeFrame: 'f006',
    viewportTiles: [{ z: 3, x: 3, y: 3 }],
    preferred: { layer: 'usable-lift-msl', frame: 'f006' },
    prepared: [{ layer: activeLayer, frame: 'f006' }], timelineFrames: ['f012'] });
  expect(urls[0]).toContain('/usable-lift-msl/f006/');
  expect(urls[1]).toContain('/usable-lift-agl/f012/');
  expect(urls.some(url => url.includes('/usable-lift-agl/f006/'))).toBe(true);
  expect(urls.some(url => url.endsWith('/usable-lift-agl/f006/3/3/3.webp'))).toBe(false);
});
