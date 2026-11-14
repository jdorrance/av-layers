import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getProduct, PRODUCTS } from '@av/contracts/models';
import { planWholeDomainGrid, sparseCoverageFromDense, type ManifestV5 } from '@av/contracts';
import { WIND_FINE_CELL_BYTES, windLayout } from '@av/contracts/wind-data';
import { STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, SUPPORT_CUMULUS } from '@av/contracts/layers';
import type { NormalizedFrame } from '@av/forecast/inputs';
import type { WholeDomainPrepared } from './whole-domain/prepare.js';
import { BUILD_BUDGETS } from './capacity.js';
import { createWindDataWriter, localWindData } from './wind-data.js';

it('admits the complete encoded, index and descriptor estimate before creating artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-wind-budget-'));
  try {
    const grid = { kind: 'regular-latlon' as const, width: 2, height: 2, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
    const plan = { native: grid, fine: grid }, frames = 2, levels = 3;
    const chunkBytes = 12 + 16 * 16 * (9 + 13 * levels), fineBytes = 64 * 64 * WIND_FINE_CELL_BYTES;
    const estimate = frames * (chunkBytes + fineBytes + 2 * 32 + 1024 + 2 * 256) + 1024 + frames * 256;
    const capacity = { mapFrames: frames, numericBytes: BUILD_BUDGETS.numericBytes - estimate, estimatedPeakBytes: 0 };
    expect(() => createWindDataWriter(root, 'gfs', 'build', levels, plan, capacity)).not.toThrow();
    expect(() => createWindDataWriter(root, 'gfs', 'build', levels, plan, { ...capacity, numericBytes: capacity.numericBytes + 1 })).toThrow('Wind data exceeds build capacity');
    expect(() => createWindDataWriter(root, 'gfs', 'build', levels, plan, { ...capacity, estimatedPeakBytes: BUILD_BUDGETS.workingSetBytes })).toThrow('Wind data exceeds build capacity');
    const reserved = 8 * 1024 * 1024 + 2 * Math.max(1 * chunkBytes, 1 * fineBytes);
    expect(() => createWindDataWriter(root, 'gfs', 'build', levels, plan, { ...capacity, estimatedPeakBytes: BUILD_BUDGETS.workingSetBytes - reserved })).not.toThrow();
    expect(() => createWindDataWriter(root, 'gfs', 'build', levels, plan, { ...capacity, estimatedPeakBytes: BUILD_BUDGETS.workingSetBytes - reserved + 1 })).toThrow('Wind data exceeds build capacity');
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('admits the GFS wind estimate alongside existing numeric products', () => {
  const product = getProduct('gfs')!, plan = planWholeDomainGrid(product.grid, product.terrainSubdivisionFactor!);
  const native = windLayout(plan.native.width, plan.native.height, 16, product.capabilities.maxVerticalLevels);
  const fine = windLayout(plan.fine.width, plan.fine.height, 64);
  const frame = native.count * native.chunkBytes + fine.count * fine.chunkBytes + (native.count + fine.count) * 32 + 1024 + (native.pages + fine.pages) * 256;
  const total = 40 * frame + 1024 + 40 * 256, existing = 11_696_592_960;
  expect(frame).toBe(1_341_294_768);
  expect(BUILD_BUDGETS.numericBytes - total - existing).toBe(3_371_081_792);
  expect(() => createWindDataWriter('.', 'gfs', 'build', product.capabilities.maxVerticalLevels, plan, { mapFrames: 40, numericBytes: existing, estimatedPeakBytes: 0 })).not.toThrow();
});

it.each(PRODUCTS)('admits actual full and partial shard pages for $modelId', product => {
  const plan = planWholeDomainGrid(product.grid, product.terrainSubdivisionFactor!);
  expect(() => createWindDataWriter('.', product.modelId, 'build', product.capabilities.maxVerticalLevels, plan,
    { mapFrames: 1, numericBytes: 0, estimatedPeakBytes: 0 })).not.toThrow();
});

it('rejects an encoded object set that cannot fit its receipt before creating artifacts', () => {
  const grid = { kind: 'regular-latlon' as const, width: 16 * 512 * 32, height: 16, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
  expect(() => createWindDataWriter('.', 'gfs', 'build', 1, { native: grid, fine: grid },
    { mapFrames: 120, numericBytes: 0, estimatedPeakBytes: 0 })).toThrow('Wind objects exceed receipt budget');
});

it('preserves exact fine terrain and lift targets with statuses, support and coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-wind-fine-'));
  try {
    const grid = { kind: 'regular-latlon' as const, width: 8, height: 1, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
    const plan = { native: grid, fine: grid };
    const coverage = sparseCoverageFromDense({ width: 8, height: 1, wrapLongitude: false, gridHash: 'a'.repeat(64), output: Uint8Array.of(0x3f), halo: Uint8Array.of(0x40) });
    const prepared = { plan, fine: { mask: { coverage } } } as unknown as WholeDomainPrepared;
    const terrain = { elevationM: Float32Array.of(123.4, -45.6, 40000, -40000, NaN, Infinity, 21), valid: Uint8Array.of(1, 1, 1, 1, 1, 1, 0) };
    const lift = { values: Float32Array.of(345.4, -20.6, 40000, -40000, NaN, Infinity, 22), flags: Uint8Array.of(0, STATUS_NO_LIFT | SUPPORT_CUMULUS, 0, 0, 0, 0, STATUS_UNAVAILABLE) };
    const writer = createWindDataWriter(root, 'gfs', 'build', 1, plan, { mapFrames: 1, numericBytes: 0, estimatedPeakBytes: 0 });
    const frame = { hgtM: [new Float32Array()], activeIndices: new Uint32Array() } as unknown as NormalizedFrame;
    await writer.writeFrame(frame, 'f1', lift, prepared, terrain);
    const bytes = await readFile(join(root, 'builds/gfs/build/map-data/f1/fine-0.bin'));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cell = (i: number) => ({ terrain: view.getFloat32(i * WIND_FINE_CELL_BYTES, true), lift: view.getFloat32(i * WIND_FINE_CELL_BYTES + 4, true), flags: view.getUint8(i * WIND_FINE_CELL_BYTES + 8), support: view.getUint8(i * WIND_FINE_CELL_BYTES + 9) });
    expect(cell(0)).toEqual({ terrain: terrain.elevationM[0], lift: lift.values[0], flags: 16, support: 0 });
    expect(cell(1)).toEqual({ terrain: terrain.elevationM[1], lift: lift.values[1], flags: 16 | (STATUS_NO_LIFT << 2), support: SUPPORT_CUMULUS });
    for (const i of [0, 1]) {
      expect(cell(i).terrain).toBe(terrain.elevationM[i]);
      expect(cell(i).lift).toBe(lift.values[i]);
    }
    expect(cell(2)).toMatchObject({ terrain: 40000, lift: 40000 });
    expect(cell(3)).toMatchObject({ terrain: -40000, lift: -40000 });
    for (const i of [4, 5]) expect(cell(i)).toEqual({ terrain: 0, lift: 0, flags: 16 | STATUS_UNAVAILABLE | (STATUS_UNAVAILABLE << 2), support: 0 });
    expect(cell(6)).toEqual({ terrain: 0, lift: 22, flags: STATUS_UNAVAILABLE | (STATUS_UNAVAILABLE << 2), support: 0 });
    expect(cell(7)).toEqual({ terrain: 0, lift: 0, flags: STATUS_OUTSIDE | (STATUS_OUTSIDE << 2), support: 0 });
    expect(JSON.parse(await readFile(join(root, 'builds/gfs/build/map-data/f1.json'), 'utf8')).version).toBe(3);
    expect(writer.finishShard().frames).toHaveLength(1);
    const reference = await writer.finish(), controller = new AbortController();
    const manifest = { model: 'gfs', buildId: 'build', frames: [{ id: 'f1' }],
      surfaces: [{ kind: 'native', grid }, { kind: 'fine', grid }] } as ManifestV5;
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (++checks === 4) controller.abort(new Error('verification cancelled'));
      check();
    });
    await expect(localWindData(root, manifest, controller.signal)).rejects.toThrow('verification cancelled');
    expect((await localWindData(root, manifest))!.reference).toEqual(reference);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('aborts mid-frame without registering partial objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-wind-abort-'));
  try {
    const grid = { kind: 'regular-latlon' as const, width: 33, height: 1, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
    const plan = { native: grid, fine: grid }, controller = new AbortController(), local = new AbortController();
    const combined = AbortSignal.any([controller.signal, local.signal]);
    const check = AbortSignal.prototype.throwIfAborted;
    let calls = 0;
    const spy = vi.spyOn(AbortSignal.prototype, 'throwIfAborted').mockImplementation(function (this: AbortSignal) { if (++calls === 4) local.abort(new Error('cancelled')); check.call(this); });
    const writer = createWindDataWriter(root, 'gfs', 'build', 1, plan, { mapFrames: 1, numericBytes: 0, estimatedPeakBytes: 0 }, controller.signal);
    const frame = { hgtM: [new Float32Array()], activeIndices: new Uint32Array() } as unknown as NormalizedFrame;
    await expect(writer.writeFrame(frame, 'f1', { values: new Float32Array(), flags: new Uint8Array() }, { plan } as WholeDomainPrepared, { elevationM: new Float32Array(), valid: new Uint8Array() }, combined)).rejects.toThrow('cancelled');
    expect((await stat(join(root, 'builds/gfs/build/map-data/f1/wind-0.bin'))).size).toBeGreaterThan(0);
    expect(() => writer.finishShard()).toThrow('Wind frame count differs');
    spy.mockRestore();
  } finally { await rm(root, { recursive: true, force: true }); }
});
