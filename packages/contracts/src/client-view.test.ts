import { expect, it } from 'vitest';
import { fixtureBuild, fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture';
import { buildDiagnosticRows, formatSeriesSummary, paletteLegend, seriesTable } from './client-view';
import { PALETTES, paletteSchema } from './layers';

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
