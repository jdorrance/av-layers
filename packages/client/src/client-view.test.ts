import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { expect, it } from 'vitest';
import { CELL_BYTES, manifestV5Schema, PALETTES, SUPPORT_CUMULUS, SUPPORT_OVERDEVELOPED,
  SUPPORT_CLOUD_CAPPED, SUPPORT_PARCEL_CROSSING, paletteSchema, TERRAIN_COLUMN_METHOD, createWholeDomainDescriptors, type LayerId } from '@av/contracts';
import type { PinnedBuild } from './client-types';
import { fixtureBuild, fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture';
import { activePalettes, buildDiagnosticRows, deriveTerrainM, formatAltitude, formatSupportFlags, layerMaxZoom, paletteLegend, planViewportPrefetch, pointFrameView, pointSeriesSelection, seriesTable, viewportTiles } from './client-view';

function v5Build(): PinnedBuild {
  const base = fixtureBuild();
  if (base.manifest.version === 5) throw new Error('fixture requires a legacy manifest');
  const { version: _version, coverage, grid, samples: _samples, ...rest } = base.manifest;
  if (grid.kind !== 'regular-latlon') throw new Error('fixture requires a regular latitude/longitude grid');
  const prefix = `builds/${base.manifest.model}/${base.manifest.buildId}`;
  const fineGrid = { ...grid, width: grid.width * 2, height: grid.height * 2, dx: grid.dx / 2, dy: grid.dy / 2 };
  const descriptors = createWholeDomainDescriptors(INDEXED_PRODUCT);
  const blocks = (value: typeof grid) => Math.ceil(value.width / 16) * Math.ceil(value.height / 16);
  const surface = (id: string, kind: 'native' | 'fine', layers: string[], gridValue: typeof grid, gridHash: string, coverageHash: string, maxZoom: number, terrain: boolean) => {
    const blockCount = blocks(gridValue), channelCount = base.manifest.frames.length * layers.length;
    return {
      id, kind, grid: gridValue, gridHash,
      coverage: { id, hash: coverageHash, maskKey: `coverage/${coverageHash}/manifest.json`, maxZoom, gridHash },
      layers,
      samples: {
        format: 'cell-major-block-shards-v1' as const, blockSize: 16 as const, channelOrder: 'frame-then-layer' as const,
        channelCount, coverageHash, blockCount, storedCells: blockCount,
        shards: [{ firstBlock: 0, blockCount, storedCells: blockCount, bytes: blockCount * channelCount * CELL_BYTES, key: `${prefix}/surfaces/${id}/samples/0.bin`, sha256: 'd'.repeat(64) }]
      },
      ...(terrain ? { terrain: {
        dataId: 'e'.repeat(64), key: `terrain/prepared/${'e'.repeat(64)}/manifest.json`, sha256: 'e'.repeat(64),
        verticalDatum: 'EGM2008', surface: 'DSM', gridHash, coverageHash, layoutVersion: 1 as const
      } } : {})
    };
  };
  return {
    ...base,
    manifest: manifestV5Schema.parse({
      ...rest, version: 5, descriptors,
      method: { ...rest.method, id: [...new Set(rest.layers.map(layer => descriptors.layers[layer].methodId))].join('+') },
      surfaces: [
        surface('gfs-native', 'native', ['precip-rate'], grid, 'a'.repeat(64), coverage.hash, 7, false),
        surface('gfs-fine', 'fine', ['usable-lift-msl', 'usable-lift-agl'], fineGrid, 'b'.repeat(64), 'c'.repeat(64), 9, true)
      ]
    })
  };
}

it('keeps retained palette snapshots discrete when interpolation is absent', () => {
  const { interpolation: _, ...retained } = PALETTES.lift;
  const palette = paletteSchema.parse(retained);
  const model = paletteLegend(palette);
  expect(palette.interpolation).toBeUndefined();
  expect(model.gradient).toBeUndefined();
  expect(model.rows.slice(0, palette.colors.length).map(row => row.color)).toEqual(palette.colors);
  expect(model.rows[0].label).toBe('0–300');
});

it('formats independent physical support and cloud regime flags', () => {
  expect(formatSupportFlags(SUPPORT_PARCEL_CROSSING | SUPPORT_CUMULUS | SUPPORT_OVERDEVELOPED | SUPPORT_CLOUD_CAPPED)).toBe('parcel+Cu+OD+capped');
  expect(formatSupportFlags(0)).toBe('—');
});

it('honors pinned sample-only delivery for legends and every prefetch path', () => {
  const build = v5Build();
  build.manifest.descriptors.layers['usable-lift-msl'].delivery = 'samples-only';
  expect(activePalettes(build.manifest.descriptors.palettes, 'usable-lift-msl', build.manifest.descriptors.layers)).toEqual([]);
  const options = { build, activeFrame: 'f006', viewportTiles: [{ z: 3, x: 3, y: 3 }] };
  expect(planViewportPrefetch({ ...options, activeLayer: 'usable-lift-msl' })).toEqual([]);
  const urls = planViewportPrefetch({ ...options, activeLayer: 'usable-lift-agl' });
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.some(url => url.includes('/usable-lift-msl/'))).toBe(false);
});

it('shows an encoded channel gradient with separate no-lift and endpoint units', () => {
  const palette = paletteSchema.parse({
    id: 'lift', units: 'm AGL', edges: [0, 300, 600], colors: ['#000000', '#ffffff'],
    noLiftColor: '#00000000', interpolation: 'linear-rgb'
  });
  const model = paletteLegend(palette);
  expect(model.gradient?.background).toContain('rgba(128,128,128,1) 50%');
  expect(model.gradient?.background).toContain('rgba(0,0,0,1) 0%');
  expect(model.gradient?.background).toContain('rgba(255,255,255,1) 100%');
  expect(model.gradient?.minimum).toBe('0 m AGL');
  expect(model.gradient?.maximum).toBe('≥ 300 m AGL');
  expect(model.rows).toEqual([{ color: '#00000000', label: 'no usable lift (transparent)' }]);
  expect(model.gradient!.background.length).toBeLessThan(1024);
});

it('serializes stepped interpolation without changing retained palette compatibility', () => {
  expect(paletteSchema.parse(JSON.parse(JSON.stringify(PALETTES.lift))).interpolation).toBe('step');
  expect(paletteLegend(paletteSchema.parse(PALETTES.lift)).rows).toHaveLength(PALETTES.lift.colors.length + 1);
  expect(paletteSchema.safeParse({ ...PALETTES.lift, interpolation: 'spline' }).success).toBe(false);
});

it('shows the actual horizon for irregular frames in channel order', () => {
  const frames = fixtureManifest().frames;
  const build = fixtureBuild({ frames: [frames[2], frames[0], frames.at(-1)!] });
  expect(buildDiagnosticRows(build).find(([label]) => label === 'Horizon')).toEqual([
    'Horizon', `${frames[0].validTime} → ${frames.at(-1)!.validTime}`
  ]);
  expect(build.manifest.frames.map(frame => frame.id)).toEqual([frames[2].id, frames[0].id, frames.at(-1)!.id]);
});

it('shows each refinement method and vertical reference in build diagnostics', () => {
  const manifest = fixtureManifest(), patch = fixturePatch(manifest);
  const build = fixtureBuild({ version: 4, patches: [patch] });
  const rows = buildDiagnosticRows(build);
  expect(rows).toContainEqual([`Refinement ${patch.id}`, `${patch.grid.width} × ${patch.grid.height} · ${patch.method.id}`]);
  for (const layer of patch.layers) {
    const descriptor = patch.descriptors.layers[layer];
    expect(rows).toContainEqual([`${patch.id} · ${descriptor.label}`, `${descriptor.units} · ${descriptor.verticalReference} · ${descriptor.methodId}`]);
  }
  expect(buildDiagnosticRows(fixtureBuild()).some(([label]) => label.startsWith('Refinement '))).toBe(false);
});

it('shows the actual terrain reference for refined point values beside base layers', () => {
  const manifest = fixtureManifest(), patch = fixturePatch(manifest);
  const payload = { method: manifest.method, coverage: manifest.coverage, expiresAt: manifest.expiresAt, frames: [{ ...manifest.frames[0], layers: {
    'usable-lift-agl': { value: 300, status: 'valid' as const, support: 0, interpolated: false, patchId: patch.id },
    'precip-rate': { value: 7, status: 'valid' as const, support: 0, interpolated: false }
  } }] };
  const table = seriesTable(payload, ['usable-lift-agl', 'precip-rate'], manifest.descriptors.layers, [patch]);
  expect(table.headings[2]).toBe('Usable lift depth (terrain AGL) (m AGL)');
  expect(table.headings[3]).toContain(manifest.descriptors.layers['precip-rate'].label);
  expect(table.rows[0][4]).toContain(`${patch.id} · terrain-AGL · ${patch.method.id}`);
  expect(table.rows[0][5]).not.toContain(patch.id);
});

it('uses the layer surface max zoom for v5 and the manifest max zoom for legacy builds', () => {
  const legacy = fixtureBuild();
  expect(layerMaxZoom(legacy.manifest, 'precip-rate')).toBe(7);
  const v5 = v5Build();
  expect(layerMaxZoom(v5.manifest, 'precip-rate')).toBe(7);
  expect(layerMaxZoom(v5.manifest, 'usable-lift-msl')).toBe(9);
  expect(layerMaxZoom(v5.manifest, 'usable-lift-agl')).toBe(9);
});

it('keeps legacy display and grid diagnostics while v5 reports each surface once', () => {
  const patch = fixturePatch(fixtureManifest());
  for (const build of [fixtureBuild(), fixtureBuild({ version: 4, patches: [patch] })]) {
    const rows = buildDiagnosticRows(build);
    expect(rows).toContainEqual(['Display', 'z0–7 · 256 px raster · overzoomed above z7']);
    expect(rows).toContainEqual(['Grid', '1440 × 721 · 0.25° × 0.25° regular latitude/longitude']);
    expect(rows.some(([label]) => label.startsWith('Surface '))).toBe(false);
  }
  const v5 = v5Build();
  const rows = buildDiagnosticRows(v5);
  expect(rows).toContainEqual(['Usable lift depth (terrain AGL)', `m AGL · terrain-AGL · interval-flux-endpoint-profile · ${TERRAIN_COLUMN_METHOD.id}`]);
  expect(rows.some(([label]) => label === 'Grid' || label === 'Display')).toBe(false);
  expect(rows.filter(([label]) => label.startsWith('Surface '))).toEqual([
    ['Surface gfs-native', '1440 × 721 · 0.25° × 0.25° · precip-rate · z0–7'],
    ['Surface gfs-fine', '2880 × 1442 · 0.125° × 0.125° · usable-lift-msl, usable-lift-agl · z0–9 · DSM · EGM2008']
  ]);
});

it('orders viewport prefetch by forecast step, sibling layer, then perimeter', () => {
  const build = v5Build(), activeLayer = 'usable-lift-agl' as const;
  const urls = planViewportPrefetch({ build, activeLayer, activeFrame: 'f006', viewportTiles: [{ z: 3, x: 3, y: 3 }] });
  const tile = (layer: string, frame: string, x = 3, y = 3) => `https://api.test/tiles/${build.manifest.model}/${build.manifest.buildId}/${layer}/${frame}/3/${x}/${y}.webp`;
  expect(urls.slice(0, 5)).toEqual([
    tile(activeLayer, 'f009'), tile(activeLayer, 'f003'), tile('usable-lift-msl', 'f006'), tile(activeLayer, 'f012'), tile(activeLayer, 'f006', 2, 2)
  ]);
  expect(urls).toHaveLength(12);
  expect(new Set(urls).size).toBe(urls.length);
  expect(urls).not.toContain(tile(activeLayer, 'f006'));
});
it('uses owning surface zooms for overzoomed viewport prefetches', () => {
  const build = v5Build(), viewportTiles = [{ z: 9, x: 256, y: 256 }];
  const rain = planViewportPrefetch({ build, activeLayer: 'precip-rate', activeFrame: 'f006', viewportTiles });
  expect(rain[0]).toContain('/precip-rate/f009/7/64/64.webp');
  expect(rain.every(url => !url.includes('usable-lift'))).toBe(true);
  expect(rain).not.toContain(`https://api.test/tiles/${build.manifest.model}/${build.manifest.buildId}/precip-rate/f006/7/64/64.webp`);
  const lift = planViewportPrefetch({ build, activeLayer: 'usable-lift-agl', activeFrame: 'f006', viewportTiles });
  expect(lift[0]).toContain('/usable-lift-agl/f009/9/256/256.webp');
});
it('filters bounds and invalid tile coordinates and wraps only longitude-wrapping surfaces', () => {
  const build = v5Build();
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
  expect(urls.slice(0, 40).every(url => url.includes('/f009/'))).toBe(true);
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
  const build = v5Build();
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
  const build = v5Build();
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
  const build = v5Build();
  const frame = { ...build.manifest.frames[0], layers: {
    'usable-lift-msl': { value: null, status: 'no-usable-lift' as const, support: 0, interpolated: false, surfaceId: 'gfs-fine' },
    'usable-lift-agl': { value: 0, status: 'no-usable-lift' as const, support: SUPPORT_CUMULUS, interpolated: false, surfaceId: 'gfs-fine' },
    'wind-10m-u': { value: 0, status: 'valid' as const, support: 0, interpolated: false, surfaceId: 'gfs-native' },
    'wind-10m-v': { value: -5, status: 'valid' as const, support: 0, interpolated: false, surfaceId: 'gfs-native' },
    'thermal-velocity': { value: 1, status: 'valid' as const, support: SUPPORT_CUMULUS, interpolated: false, surfaceId: 'gfs-native' }
  } };
  const view = pointFrameView(frame, build, 'imperial');
  expect(view.terrainM).toBeNull(); expect(view.summary).toContain('Surface elevation unknown');
  expect(view.summary).toContain('10 m 9.7 kt 0°'); expect(view.summary).toContain('Cu');
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
  const build = v5Build(), sample = (value: number, support = 0, surfaceId = 'gfs-native') => ({ value, support, surfaceId, status: 'valid' as const, interpolated: false });
  const frame = { ...build.manifest.frames[0], layers: {
    'usable-lift-msl': sample(2000, fine, 'gfs-fine'), 'usable-lift-agl': sample(500, fine, 'gfs-fine'),
    'thermal-velocity': sample(2, native), 'thermal-top-msl': sample(2500, top),
    'surface-lcl-msl': sample(3000), 'cloud-cover-total': sample(0)
  } };
  const summary = pointFrameView(frame, build, 'metric').summary;
  expect(summary).toContain(expected); expect(summary).not.toContain('Blue');
});

it('keeps raster prefetch inside the map prefix while the native point axis continues', () => {
  const build = v5Build();
  if (build.manifest.version !== 5) throw new Error('Expected v5');
  build.manifest.mapFrameCount = 2;
  const options = { build, activeLayer: 'usable-lift-agl' as const, activeFrame: 'f006', viewportTiles: [{ z: 3, x: 3, y: 3 }] };
  expect(planViewportPrefetch(options).some(url => /\/f009\//.test(url))).toBe(false);
  expect(planViewportPrefetch({ ...options, activeFrame: 'f009' })).toEqual([]);
  expect(pointSeriesSelection(build).frames).not.toContain('f009');
  expect(build.manifest.frames.some(frame => frame.id === 'f009')).toBe(true);
});
