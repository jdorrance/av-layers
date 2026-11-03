import { describe, expect, it } from 'vitest';
import { setBit, type CoverageMask } from '@av/contracts';
import { fixtureManifest, fixturePatch } from '../../../../tests/forecast-fixture.js';
import { validateRefinementCoverage } from './coverage.js';

function fixture() {
  const patch = fixturePatch(fixtureManifest());
  const mask: CoverageMask = { grid: patch.grid, bounds: patch.descriptors.bounds, maxZoom: patch.coverage.maxZoom,
    output: new Uint8Array(2), halo: Uint8Array.of(0xff, 1), tiles: new Uint8Array(2731) };
  setBit(mask.output, 4);
  const base: CoverageMask = { ...mask, grid: { kind: 'regular-latlon', earthRadiusM: 6371229, width: 3, height: 3,
    lon0: -1, lat0: 1, dx: 1, dy: -1, wrapLongitude: false }, bounds: [-1, -1, 1, 1] };
  return { patch, mask, base };
}

describe('refinement coverage admission', () => {
  it('admits a polygon-owned interior with complete halo support inside base coverage', () => {
    const { base, mask, patch } = fixture();
    expect(() => validateRefinementCoverage(base, mask, { geometry: patch.geometry, bounds: patch.descriptors.bounds })).not.toThrow();
  });
  it.each(['empty', 'base', 'polygon', 'edge', 'halo'] as const)('rejects %s coverage before publishing a numeric surface', defect => {
    const { base, mask, patch } = fixture();
    if (defect === 'empty') mask.output.fill(0);
    if (defect === 'base') base.output = new Uint8Array(2);
    if (defect === 'polygon') patch.descriptors.bounds = [0.1, 0.1, 0.2, 0.2];
    if (defect === 'edge') { mask.output.fill(0); setBit(mask.output, 0); }
    if (defect === 'halo') setBit(mask.halo, 8, false);
    expect(() => validateRefinementCoverage(base, mask, { geometry: patch.geometry, bounds: patch.descriptors.bounds })).toThrow(/Refinement/);
  });
});
