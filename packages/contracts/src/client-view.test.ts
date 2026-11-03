import { expect, it } from 'vitest';
import { fixtureBuild, fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture';
import { buildDiagnosticRows, formatSeriesSummary, seriesTable } from './client-view';

it('shows the actual horizon for irregular frames in channel order', () => {
  const frames = fixtureManifest().frames;
  const build = fixtureBuild({ frames: [frames[2], frames[0], frames.at(-1)!] });
  expect(buildDiagnosticRows(build).find(([label]) => label === 'Horizon')).toEqual([
    'Horizon', `${frames[0].validTime} → ${frames.at(-1)!.validTime}`
  ]);
  expect(build.manifest.frames.map(frame => frame.id)).toEqual([frames[2].id, frames[0].id, frames.at(-1)!.id]);
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
