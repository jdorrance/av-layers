import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { expect, it } from 'vitest';
import { CELL_BYTES } from './format';
import { manifestV5Schema } from './publication';
import type { PinnedBuild } from './client-types';
import { fixtureBuild, fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture';
import { buildDiagnosticRows, formatSeriesSummary, layerMaxZoom, paletteLegend, seriesTable } from './client-view';
import { PALETTES, paletteSchema } from './layers';
import { TERRAIN_COLUMN_METHOD, createWholeDomainDescriptors } from './index';

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
  expect(formatSeriesSummary(payload, ['usable-lift-agl', 'precip-rate'], { lat: 0, lon: 0 })).toContain(`base method ${manifest.method.id} · refinement ${patch.id}`);
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
    ['Surface gfs-fine', '2880 × 1442 · 0.125° × 0.125° · usable-lift-msl, usable-lift-agl · z0–9']
  ]);
});
