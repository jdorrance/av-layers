import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { solarTerrainIndexSchema, type TerrainTile } from '@av/contracts';
import { BUILD_BUDGETS } from '../../capacity.ts';
import { startSolarTerrain } from './build.ts';
import { solarFixture } from './test-fixtures.ts';
import parity from './parity.json';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const generatedAt = '2026-11-05T00:00:00Z';

// Original Windgrams outputs, with only the gzip OS byte canonicalized to 255.
describe('solar terrain compatibility', () => {
  for (const name of ['flat', 'plane', 'ridge', 'missing', 'seam'] as const) it(`preserves ${name} normals, horizons, tiles and relief`, () => {
    const { site, fine, ...options } = solarFixture(name), build = startSolarTerrain(site, options), tiles: TerrainTile[] = [];
    for (const block of [...build.blocks].reverse()) tiles.push(...build.addBlock(block, fine));
    const product = build.finish({ generatedAt }), expected = parity[name];
    const { objects: _objects, ...legacyTiles } = product.index.tiles;
    const { sha256, ...legacyRelief } = product.index.relief;
    expect({ ...product.index, tiles: legacyTiles, relief: legacyRelief }).toEqual(expected.index);
    const tileRecords = tiles.map(({ z, x, y, body }) => ({ z, x, y, bytes: body.length, sha256: sha(body) }));
    const sort = (a: { z: number; x: number; y: number }, b: { z: number; x: number; y: number }) => a.z - b.z || a.x - b.x || a.y - b.y;
    expect(tileRecords.sort(sort)).toEqual([...expected.tiles].sort(sort));
    expect(sha(product.relief.body)).toBe(expected.reliefSha256);
    expect(sha256).toBe(expected.reliefSha256);
    expect(product.index.tiles.objects.flatMap(group => group.columns.flatMap(column => column.rows.map(([y, bytes, sha256]) => ({ z: group.z, x: column.x, y, bytes, sha256 }))))).toEqual(tileRecords);
    expect(solarTerrainIndexSchema.safeParse(product.index).success).toBe(true);
    expect(() => build.finish()).toThrow('finished');
  });

  it('binds generation to the DEM data identity', () => {
    const { site, ...options } = solarFixture('flat');
    const first = startSolarTerrain(site, options), second = startSolarTerrain(site, { ...options, sources: {
      ...options.sources, surface: { ...options.sources.surface, id: 'another-catalog-digest' } } });
    expect(second.generation).not.toBe(first.generation);
  });

  it('requires each owned block once and complete publication', () => {
    const { site, fine, ...options } = solarFixture('seam'), build = startSolarTerrain(site, options);
    expect(build.blocks).toHaveLength(2);
    expect(() => build.finish()).toThrow('not built');
    expect(() => build.addBlock(build.domain, fine)).toThrow('outside this build');
    build.addBlock(build.blocks[0]!, fine);
    expect(() => build.addBlock(build.blocks[0]!, fine)).toThrow('already completed');
    build.addBlock(build.blocks[1]!, fine);
    expect(build.finish({ generatedAt }).index.tiles.count).toBe(8);
  });

  it('rejects oversized domains before allocating blocks and honors the build deadline', () => {
    const { site, ...options } = solarFixture('flat');
    expect(() => startSolarTerrain(site, { ...options, area: undefined, radiusKm: 1000 })).toThrow('metadata budget');
    const build = startSolarTerrain(site, options);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + BUILD_BUDGETS.elapsedMs + 1);
    try { expect(() => build.addBlock(build.blocks[0]!, options.fine)).toThrow('elapsed budget'); }
    finally { now.mockRestore(); }
  });

  it('invalidates a partially computed build after a kernel failure', () => {
    const { site, fine, ...options } = solarFixture('flat');
    const build = startSolarTerrain(site, { ...options, log: message => { if (message.includes('surface normals')) throw new Error('stopped'); } });
    expect(() => build.addBlock(build.blocks[0]!, fine)).toThrow('stopped');
    expect(() => build.finish()).toThrow('failed');
    expect(() => build.addBlock(build.blocks[0]!, fine)).toThrow('failed');
  });

  it('rejects an invalid asset inventory or source identity', () => {
    const { site, fine, ...options } = solarFixture('flat'), build = startSolarTerrain(site, options);
    for (const block of build.blocks) build.addBlock(block, fine);
    const { index } = build.finish({ generatedAt }), invalid = structuredClone(index);
    invalid.tiles.objects[0]!.columns[0]!.rows.push([...invalid.tiles.objects[0]!.columns[0]!.rows[0]!]);
    expect(solarTerrainIndexSchema.safeParse(invalid).success).toBe(false);
    invalid.tiles.objects = index.tiles.objects; invalid.inputs.sources.surface = 'wrong-digest';
    expect(solarTerrainIndexSchema.safeParse(invalid).success).toBe(false);
  });
});

it('preserves complete nodata absence without manufacturing tile assets', () => {
  const { site, fine, ...options } = solarFixture('flat'); fine.values.fill(NaN);
  const build = startSolarTerrain(site, options);
  expect(build.blocks.flatMap(block => build.addBlock(block, fine))).toHaveLength(0);
  const { index } = build.finish({ generatedAt });
  expect(index.tiles.objects).toEqual([]);
  expect(index.tiles.count).toBe(0);
  expect(index.launch?.elevationM).toBeNull();
  expect(index.relief.minM).toBeNull();
});
