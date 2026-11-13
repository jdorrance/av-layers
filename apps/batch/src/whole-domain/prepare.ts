import { canonicalGridJson, sameGrid, SAMPLE_BLOCK_SIZE, type CoverageMask, type LayerId, type ProductDefinition, type SparseCoverageMask, type SparseCoverageDescriptor, type WholeDomainGrid } from '@av/contracts';
import { createHash } from 'node:crypto';
import { preparePackedTerrainColumns, type PreparedPackedTerrainColumns } from '@av/forecast/refinement';
import { describeSparseCoverage, readSparseCoverage } from '../coverage.js';
import type { SparseTerrainRef } from '../terrain/sparse.js';
import { MAX_PACKED_COLUMN_BYTES, wholeDomainSurfaceLayers } from './capacity.js';
import { acquisitionSupport, loadBundledFineCoverage, stageFineCoverage, wholeDomainPlan, writeNativeCoverage } from './coverage.js';
import { loadWholeDomainTerrain, prepareWholeDomainTerrain, type WholeDomainTerrainOptions } from './terrain.js';

interface WholeDomainCoverage { mask: SparseCoverageMask; descriptor: SparseCoverageDescriptor; bytes: Uint8Array; hash: string }
export type WholeDomainOptions = (WholeDomainTerrainOptions & { fine?: WholeDomainCoverage })
  | { fine: WholeDomainCoverage; terrain: SparseTerrainRef };
export interface WholeDomainPrepared {
  plan: WholeDomainGrid;
  nativeMask: CoverageMask;
  native: WholeDomainCoverage;
  fine: WholeDomainCoverage;
  terrain: SparseTerrainRef;
  requiredDonors: Uint8Array;
  acquisitionActive: Uint32Array;
  columns: PreparedPackedTerrainColumns;
  nativeSurfaceLayers: LayerId[];
  fineSurfaceLayers: LayerId[];
}
export interface WholeDomainFrozenPlan {
  k: number; nativeCoverageHash: string;
  fineCoverage: { id: string; hash: string; maskKey: string; maxZoom: number; gridHash: string };
  terrain: SparseTerrainRef;
}

function sharedFineCoverage(fine: WholeDomainCoverage): WholeDomainCoverage {
  const bytes = (source: Uint8Array) => {
    if (source.buffer instanceof SharedArrayBuffer) return source;
    const result = new Uint8Array(new SharedArrayBuffer(source.byteLength)); result.set(source); return result;
  };
  const words = (source: Uint32Array) => {
    if (source.buffer instanceof SharedArrayBuffer) return source;
    const result = new Uint32Array(new SharedArrayBuffer(source.byteLength)); result.set(source); return result;
  };
  const coverage = fine.mask.coverage;
  return { ...fine, mask: { ...fine.mask, tiles: bytes(fine.mask.tiles), coverage: { ...coverage,
    blockIds: words(coverage.blockIds), offsets: words(coverage.offsets), output: bytes(coverage.output), halo: bytes(coverage.halo) } } };
}

export async function prepareWholeDomain(options: {
  product: ProductDefinition; mask: CoverageMask; out: string; maxLevels: number; wholeDomain?: WholeDomainOptions; signal?: AbortSignal;
}): Promise<WholeDomainPrepared> {
  const plan = wholeDomainPlan(options.product);
  if (!plan) throw new Error('Product does not configure whole-domain terrain subdivision');
  const inputs = options.wholeDomain;
  if (!inputs) throw new Error('Whole-domain product requires a terrain catalog or prepared terrain');
  options.signal?.throwIfAborted();
  const native = await writeNativeCoverage(options.out, options.mask, options.product);
  const fine = inputs.fine ?? await loadBundledFineCoverage(options.product, plan);
  if (inputs.fine) {
    const expected = describeSparseCoverage(fine.mask, options.product);
    if (!sameGrid(fine.mask.grid, plan.fine) || fine.mask.maxZoom < options.product.maxNativeZoom ||
        fine.hash !== expected.hash || !Buffer.from(fine.bytes).equals(expected.bytes) ||
        JSON.stringify(fine.descriptor) !== JSON.stringify(expected.descriptor)) throw new Error('Fine coverage descriptor mismatch');
  }
  await stageFineCoverage(options.out, fine);
  const terrain = 'catalogRef' in inputs
    ? await prepareWholeDomainTerrain({ ...inputs, out: options.out, grid: plan.fine,
      coverage: fine.mask.coverage, coverageDescriptor: fine.bytes, signal: options.signal })
    : inputs.terrain;
  const { required, active } = acquisitionSupport(plan, fine.mask.coverage, options.mask);
  const layers = wholeDomainSurfaceLayers(options.product);
  if (!layers.fine.length) throw new Error('Whole-domain product requires fine lift layers');
  const sharedFine = sharedFineCoverage(fine);
  const columns = preparePackedTerrainColumns(plan, sharedFine.mask.coverage, active, options.maxLevels, { maxBytes: MAX_PACKED_COLUMN_BYTES, clearanceFallback: 'unsupported', expectedGridHash: fine.descriptor.gridHash });
  return { plan, nativeMask: options.mask, native, fine: sharedFine, terrain, requiredDonors: required, acquisitionActive: active,
    columns, nativeSurfaceLayers: layers.native, fineSurfaceLayers: layers.fine };
}

export async function loadFrozenWholeDomain(options: {
  product: ProductDefinition; frozen: WholeDomainFrozenPlan; out: string; maxLevels: number; signal?: AbortSignal;
}): Promise<WholeDomainPrepared> {
  const { product, frozen, out } = options;
  const plan = wholeDomainPlan(product);
  if (!plan || plan.k !== frozen.k) throw new Error('Frozen whole-domain grid differs from the product');
  options.signal?.throwIfAborted();
  const nativeRead = await readSparseCoverage(out, frozen.nativeCoverageHash);
  const fineRead = await readSparseCoverage(out, frozen.fineCoverage.hash);
  const native = { ...nativeRead, hash: frozen.nativeCoverageHash };
  const fine = { ...fineRead, hash: frozen.fineCoverage.hash };
  if (!sameGrid(fine.mask.grid, plan.fine) || fine.descriptor.gridHash !== frozen.fineCoverage.gridHash || fine.descriptor.id !== frozen.fineCoverage.id || fine.descriptor.id !== product.coverageId || JSON.stringify(fine.descriptor.bounds) !== JSON.stringify(product.bounds) || fine.mask.maxZoom !== frozen.fineCoverage.maxZoom || fine.mask.maxZoom < product.maxNativeZoom || frozen.fineCoverage.maskKey !== `coverage/${fine.hash}/manifest.json`) throw new Error('Frozen fine coverage differs from its plan');
  const nativeGridHash = createHash('sha256').update(canonicalGridJson(plan.native)).digest('hex');
  if (!sameGrid(native.mask.grid, plan.native) || native.descriptor.gridHash !== nativeGridHash || native.mask.coverage.gridHash !== nativeGridHash || native.mask.maxZoom < product.maxNativeZoom || JSON.stringify(describeSparseCoverage(native.mask, product).descriptor) !== JSON.stringify(native.descriptor)) throw new Error('Frozen native coverage differs from its plan');
  const nativeMask = denseCoverageMask(native.mask);
  const { required, active } = acquisitionSupport(plan, fine.mask.coverage, nativeMask);
  const layers = wholeDomainSurfaceLayers(product);
  const sharedFine = sharedFineCoverage(fine);
  const columns = preparePackedTerrainColumns(plan, sharedFine.mask.coverage, active, options.maxLevels, { maxBytes: MAX_PACKED_COLUMN_BYTES, clearanceFallback: 'unsupported', expectedGridHash: fine.descriptor.gridHash });
  return { plan, nativeMask, native, fine: sharedFine, terrain: frozen.terrain, requiredDonors: required, acquisitionActive: active,
    columns, nativeSurfaceLayers: layers.native, fineSurfaceLayers: layers.fine };
}

export function denseCoverageMask(mask: SparseCoverageMask): CoverageMask {
  return { grid: mask.grid, bounds: mask.bounds, output: dense(mask, 'output'), halo: dense(mask, 'halo'), tiles: mask.tiles, maxZoom: mask.maxZoom };
}
function dense(mask: SparseCoverageMask, name: 'output' | 'halo'): Uint8Array {
  const coverage = mask.coverage, cells = coverage.width * coverage.height, bits = new Uint8Array(Math.ceil(cells / 8)), size = SAMPLE_BLOCK_SIZE, columns = Math.ceil(coverage.width / size), blockBytes = size * size / 8;
  for (let block = 0; block < coverage.blockIds.length; block++) {
    const id = coverage.blockIds[block]!, x0 = (id % columns) * size, y0 = Math.floor(id / columns) * size;
    for (let local = 0; local < size * size; local++) {
      if ((coverage[name][block * blockBytes + (local >> 3)]! & (1 << (local & 7))) === 0) continue;
      const x = x0 + local % size, y = y0 + Math.floor(local / size);
      if (x < coverage.width && y < coverage.height) bits[(y * coverage.width + x) >> 3] |= 1 << ((y * coverage.width + x) & 7);
    }
  }
  return bits;
}

export { loadWholeDomainTerrain };
export function frozenWholeDomain(prepared: WholeDomainPrepared): WholeDomainFrozenPlan {
  return { k: prepared.plan.k, nativeCoverageHash: prepared.native.hash,
    fineCoverage: { id: prepared.fine.descriptor.id, hash: prepared.fine.hash, maskKey: `coverage/${prepared.fine.hash}/manifest.json`,
      maxZoom: prepared.fine.mask.maxZoom, gridHash: prepared.fine.descriptor.gridHash },
    terrain: prepared.terrain };
}
