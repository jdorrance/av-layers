import {
  createSparseCoverage, getBit, gridSchema, MAX_GRID_CELLS, planWholeDomainGrid, prepareGridGeometry, sameGrid, snapGridCoordinate, sparseCoverageLookup,
  STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK, CLOUD_SUPPORT_MASK, TERRAIN_CLEARANCE_METHOD, TERRAIN_COLUMN_PARAMETERS,
  type CoverageMask, type Grid, type SparseCoverage, type WholeDomainGrid
} from '@av/contracts';
import { ReconstructedProfileWorkspace } from '@av/soaring';
import { DEFAULT_SOARING_PARAMETERS } from '@av/soaring/parameters';
import { saturationVaporPressureHpa } from '@av/thermodynamics';
import { THERMODYNAMIC_CONSTANTS } from '@av/thermodynamics/constants';
import { clearanceCell } from './clearance-cell.js';
import { createNativeColumnScratch, readNativeColumn } from './column-input.js';
import { buildIntervalDaylightTimestampsMs, createMaskDaylightTester } from './daylight.js';
import type { FrameDiagnostics } from './frame.js';
import type { NormalizedFrame } from './inputs.js';
import { planSample, type GridField } from './sampler.js';
import { columnResult, deriveColumn, type ColumnResult } from './science.js';

export interface TerrainColumnEvaluationOptions {
  readonly bridgeMode?: 'neutral' | 'lowest-layer';
  readonly maximumBelowGroundExtrapolationM?: 1000 | 1500;
  readonly clearanceFallback?: 'unsupported' | 'none';
}

export interface TerrainColumnClearance {
  readonly methodId: string;
  readonly validTime: string;
  readonly grid: Grid;
  readonly fields: { readonly 'usable-lift-msl': GridField; readonly 'usable-lift-agl': GridField };
}

export interface TerrainColumnNativeClearance {
  readonly validTime: string;
  readonly grid: Grid;
  readonly diagnostics: FrameDiagnostics;
  readonly flags: Uint8Array;
}

export interface TerrainColumnMetrics {
  outside: number; dark: number; invalidDem: number; missingDonor: number;
  invalidDonorInput: number; unsupportedHeight: number; belowGroundBridgeExceeded: number;
  invalidSurfaceState: number; solverRejected: number; valid: number; noLift: number;
  belowGroundBridge: number; profileTop: number;
  filledBelowGroundBridgeExceeded?: number; belowGroundBridgeExceededObserved?: number;
  column?: number; clearance?: number;
}

export interface TerrainColumnProbe {
  index: number; donorIndices: number[]; donorWeights: number[]; terrainM: number;
  referenceTerrainM: number | null; surfaceTemperatureK: number | null;
  groundEnvironmentK: number | null; surfaceExcessK: number | null;
  donorGroundEnvironmentK: number[]; donorSurfaceExcessK: number[]; donorGroundWeights: number[];
  surfacePressurePa: number | null; humidityKgKg: number | null;
  sensibleHeatFluxWm2: number | null; latentHeatFluxWm2: number | null;
  branch: string | null; depthM: number | null; msl: number | null; agl: number | null;
  reason: string | null;
  maxBelowGroundDepthM?: number | null;
  provenance?: 'column' | 'clearance' | null;
}

export interface TerrainColumnDerivation {
  fields: { 'usable-lift-msl': GridField; 'usable-lift-agl': GridField };
  metrics: TerrainColumnMetrics;
  probes: readonly TerrainColumnProbe[];
  daylightBufferBytes: number;
}

export interface PreparedTerrainColumns {
  readonly byteLength: number;
  readonly workspaceBytes: number;
  readonly workspaceBufferBytes: number;
  readonly workspaceObjectBudgetBytes: number;
  readonly daylightBufferBytes: number;
  derive(frame: NormalizedFrame, terrain: { elevationM: Float32Array; valid: Uint8Array },
    time: { intervalStart: string; validTime: string },
    options?: { daylightOnly?: boolean; probeIndices?: readonly number[]; clearance?: TerrainColumnClearance;
      nativeClearance?: TerrainColumnNativeClearance }): TerrainColumnDerivation;
}

interface ColumnTraversal {
  readonly targetCount: number;
  readonly outputCells: number;
  readonly slots: Uint32Array;
  readonly weights: Float64Array;
  readonly compactSlots: Uint32Array | null;
  readonly donorIndices: Uint32Array;
  readonly donorCount: number;
  readonly coverage?: SparseCoverage;
  createCursor(): (position: number) => { index: number; outputIndex: number; count: number; offset: number; group?: number } | undefined;
  readonly initializeOutput?: boolean;
  readonly outsideCount?: number;
}

export interface PreparedPackedTerrainColumns {
  readonly byteLength: number;
  readonly workspaceBufferBytes: number;
  readonly workspaceObjectBudgetBytes: number;
  readonly outputBufferBytes: number;
  derive(frame: NormalizedFrame, terrain: { elevationM: Float32Array; valid: Uint8Array },
    time: { intervalStart: string; validTime: string }, options?: { daylightOnly?: boolean; probeIndices?: readonly number[];
      nativeClearance?: TerrainColumnNativeClearance; output?: { 'usable-lift-msl': GridField; 'usable-lift-agl': GridField } }): TerrainColumnDerivation & {
        fields: { 'usable-lift-msl': GridField & { coverage: SparseCoverage }; 'usable-lift-agl': GridField & { coverage: SparseCoverage } }
      };
  deriveAsync(frame: NormalizedFrame, terrain: { elevationM: Float32Array; valid: Uint8Array },
    time: { intervalStart: string; validTime: string }, options: { daylightOnly?: boolean; probeIndices?: readonly number[];
      nativeClearance?: TerrainColumnNativeClearance; signal?: AbortSignal; deadlineAt?: number; yieldControl: () => Promise<void>;
      output?: { 'usable-lift-msl': GridField; 'usable-lift-agl': GridField } }):
    Promise<ReturnType<PreparedPackedTerrainColumns['derive']>>;
}

const { kelvinOffset: K, pascalsPerHectopascal: PA, waterDryAirMolarMassRatio: EPSILON,
  gravityMps2: G, dryAirGasConstantJkgK: RD } = THERMODYNAMIC_CONSTANTS;

export function terrainColumnDaylightBufferBytes(grid: Grid, timestampCount: number): number {
  if (!Number.isSafeInteger(timestampCount) || timestampCount < 0 || timestampCount > 3 ||
      !Number.isSafeInteger(grid.width) || grid.width < 1 || !Number.isSafeInteger(grid.height) || grid.height < 1 ||
      grid.width * grid.height > MAX_GRID_CELLS) throw new RangeError('Invalid terrain column daylight capacity');
  return daylightBytes(grid, timestampCount);
}

function daylightBytes(grid: Grid, timestampCount: number): number {
  if (timestampCount === 0) return 0;
  return grid.kind === 'regular-latlon' ? 16 * grid.height + 8 * timestampCount * grid.width + 16 * timestampCount : 24 * timestampCount;
}

export function terrainColumnCapacity(sourceActiveCells: number, targetActiveCells: number, maxLevels: number,
  targetGrid: Grid, donorCount = Math.min(sourceActiveCells, targetActiveCells * 4)) {
  if (![sourceActiveCells, targetActiveCells, maxLevels, donorCount].every(Number.isSafeInteger) ||
      sourceActiveCells < 0 || sourceActiveCells > MAX_GRID_CELLS || targetActiveCells < 0 || targetActiveCells > MAX_GRID_CELLS ||
      maxLevels < 1 || donorCount < 0 || donorCount > Math.min(sourceActiveCells, targetActiveCells * 4)) {
    throw new RangeError('Invalid terrain column capacity');
  }
  const mappingBufferBytes = sourceActiveCells * 4 + targetActiveCells * 53 + donorCount * 8;
  const daylightBufferBytes = terrainColumnDaylightBufferBytes(targetGrid, 3);
  const workspaceBufferBytes = donorCount * (maxLevels * 16 + 45) + 4 * (maxLevels + 3) * 58 + 4 + daylightBufferBytes;
  const workspaceObjectBudgetBytes = 66560 + maxLevels * 256;
  const workspaceBytes = workspaceBufferBytes + workspaceObjectBudgetBytes;
  if (![mappingBufferBytes, workspaceBufferBytes, workspaceObjectBudgetBytes, workspaceBytes].every(Number.isSafeInteger)) {
    throw new RangeError('Terrain column capacity exceeded');
  }
  return { mappingBufferBytes, workspaceBufferBytes, workspaceObjectBudgetBytes, workspaceBytes, daylightBufferBytes };
}

export function prepareTerrainColumns(sourceMask: CoverageMask, targetMask: CoverageMask,
  sourceActiveIndices: Uint32Array, maxLevels: number,
  evaluationOptions: TerrainColumnEvaluationOptions = {}): PreparedTerrainColumns {
  if ('surfaceMode' in evaluationOptions) throw new RangeError('surfaceMode was removed; use supported donor-ground anomalies');
  const source = gridSchema.parse(sourceMask.grid), target = gridSchema.parse(targetMask.grid);
  const sourceCells = source.width * source.height, targetCells = target.width * target.height;
  if (sourceCells > MAX_GRID_CELLS || targetCells > MAX_GRID_CELLS ||
      !(sourceActiveIndices instanceof Uint32Array) || !Number.isSafeInteger(maxLevels) || maxLevels < 1 ||
      sourceMask.output.length !== Math.ceil(sourceCells / 8) || sourceMask.halo.length !== Math.ceil(sourceCells / 8) ||
      targetMask.output.length !== Math.ceil(targetCells / 8) || targetMask.halo.length !== Math.ceil(targetCells / 8)) {
    throw new RangeError('Invalid terrain column dimensions');
  }
  for (let i = 0; i < sourceActiveIndices.length; i++) {
    const index = sourceActiveIndices[i]!;
    if (index >= sourceCells || (i > 0 && index <= sourceActiveIndices[i - 1]!) ||
        (!getBit(sourceMask.output, index) && !getBit(sourceMask.halo, index))) throw new RangeError('Invalid active indices');
  }
  const bridgeM = evaluationOptions.maximumBelowGroundExtrapolationM ?? TERRAIN_COLUMN_PARAMETERS.maximumBelowGroundExtrapolationM;
  const bridgeMode = evaluationOptions.bridgeMode ?? 'neutral';
  const fallbackMode = evaluationOptions.clearanceFallback ?? 'none';
  if ((bridgeM !== TERRAIN_COLUMN_PARAMETERS.maximumBelowGroundExtrapolationM && bridgeM !== 1500) || (bridgeMode !== 'neutral' && bridgeMode !== 'lowest-layer') ||
      (fallbackMode !== 'unsupported' && fallbackMode !== 'none')) throw new RangeError('Invalid terrain column options');
  let targetCount = 0;
  for (let i = 0; i < targetCells; i++) if (getBit(targetMask.output, i) || getBit(targetMask.halo, i)) targetCount++;
  terrainColumnCapacity(sourceActiveIndices.length, targetCount, maxLevels, target);
  const activeIndices = sourceActiveIndices.slice();
  const targets = new Uint32Array(targetCount), counts = new Uint8Array(targetCount);
  const slots = new Uint32Array(targetCount * 4), weights = new Float64Array(targetCount * 4);
  const donors = new Map<number, number>(), compact: number[] = [], globals: number[] = [];
  const pending = new Uint32Array(4);
  const geometry = prepareGridGeometry(target);
  let targetSlot = 0;
  for (let index = 0; index < targetCells; index++) {
    if (!getBit(targetMask.output, index) && !getBit(targetMask.halo, index)) continue;
    const targetIndex = targetSlot++;
    targets[targetIndex] = index;
    const point = geometry.gridToGeographic(index % target.width, Math.floor(index / target.width));
    const plan = point && planSample(source, point.lat, point.lon);
    if (!plan) continue;
    let count = 0, complete = true;
    for (const contributor of plan.contributors) {
      if (contributor.weight <= 0) continue;
      if (!getBit(sourceMask.output, contributor.index) && !getBit(sourceMask.halo, contributor.index)) { complete = false; break; }
      let lo = 0, hi = activeIndices.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (activeIndices[mid]! < contributor.index) lo = mid + 1; else hi = mid; }
      if (activeIndices[lo] !== contributor.index) { complete = false; break; }
      pending[count] = lo;
      weights[targetIndex * 4 + count] = contributor.weight;
      count++;
    }
    if (complete) {
      counts[targetIndex] = count;
      for (let i = 0; i < count; i++) {
        const compactIndex = pending[i]!;
        let donor = donors.get(compactIndex);
        if (donor === undefined) { donor = compact.length; donors.set(compactIndex, donor); compact.push(compactIndex); globals.push(activeIndices[compactIndex]!); }
        slots[targetIndex * 4 + i] = donor;
      }
    }
  }
  const compactSlots = Uint32Array.from(compact), donorIndices = Uint32Array.from(globals);
  const byteLength = activeIndices.byteLength + targets.byteLength + counts.byteLength + slots.byteLength +
    weights.byteLength + compactSlots.byteLength + donorIndices.byteLength;
  const { workspaceBufferBytes, workspaceObjectBudgetBytes, workspaceBytes, daylightBufferBytes } =
    terrainColumnCapacity(activeIndices.length, targetCount, maxLevels, target, compactSlots.length);
  const traversal: ColumnTraversal = {
    targetCount, outputCells: targetCells, slots, weights, compactSlots, donorIndices, donorCount: compactSlots.length,
    createCursor() {
      const cell = { index: 0, outputIndex: 0, count: 0, offset: 0 };
      return t => { cell.index = targets[t]!; cell.outputIndex = cell.index; cell.count = counts[t]!; cell.offset = t * 4; return cell; };
    }
  };
  return {
    byteLength, workspaceBytes, workspaceBufferBytes, workspaceObjectBudgetBytes, daylightBufferBytes,
    derive: columnDeriver(source, target, activeIndices, maxLevels, bridgeM, bridgeMode, fallbackMode, traversal).derive
  };
}

export function packedTerrainColumnBudget(plan: WholeDomainGrid, coverage: SparseCoverage, sourceActiveIndices: Uint32Array,
  maxLevels: number, options: TerrainColumnEvaluationOptions & { maxBytes: number; expectedGridHash: string; partition?: { index: number; count: number } }): Pick<PreparedPackedTerrainColumns, 'byteLength' | 'workspaceBufferBytes' | 'workspaceObjectBudgetBytes' | 'outputBufferBytes'> {
  return preparePackedTerrainColumns(plan, coverage, sourceActiveIndices, maxLevels, { ...options, budgetOnly: true });
}

export function preparePackedTerrainColumns(plan: WholeDomainGrid, coverage: SparseCoverage, sourceActiveIndices: Uint32Array,
  maxLevels: number, options: TerrainColumnEvaluationOptions & { maxBytes: number; expectedGridHash: string; partition?: { index: number; count: number }; budgetOnly?: boolean }): PreparedPackedTerrainColumns {
  const expected = planWholeDomainGrid(plan.native, plan.k);
  if (!sameGrid(expected.fine, plan.fine)) throw new RangeError('Invalid whole-domain terrain column grid');
  const source = expected.native, target = expected.fine;
  createSparseCoverage(coverage);
  if (typeof options.expectedGridHash !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedGridHash) ||
      coverage.gridHash !== options.expectedGridHash) throw new RangeError('Packed terrain column grid identity mismatch');
  if (coverage.width !== target.width || coverage.height !== target.height || coverage.wrapLongitude !== target.wrapLongitude ||
      !(sourceActiveIndices instanceof Uint32Array) || !Number.isSafeInteger(maxLevels) || maxLevels < 1 ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > 2 * 1024 ** 3) {
    throw new RangeError('Invalid packed terrain column dimensions or budget');
  }
  for (let i = 0; i < sourceActiveIndices.length; i++) {
    if (sourceActiveIndices[i]! >= source.width * source.height || (i > 0 && sourceActiveIndices[i]! <= sourceActiveIndices[i - 1]!)) {
      throw new RangeError('Invalid active indices');
    }
  }
  const bridgeM = options.maximumBelowGroundExtrapolationM ?? TERRAIN_COLUMN_PARAMETERS.maximumBelowGroundExtrapolationM;
  const bridgeMode = options.bridgeMode ?? 'neutral', fallbackMode = options.clearanceFallback ?? 'none';
  if ((bridgeM !== TERRAIN_COLUMN_PARAMETERS.maximumBelowGroundExtrapolationM && bridgeM !== 1500) ||
      (bridgeMode !== 'neutral' && bridgeMode !== 'lowest-layer') || (fallbackMode !== 'unsupported' && fallbackMode !== 'none')) {
    throw new RangeError('Invalid terrain column options');
  }
  const targetCount = coverage.offsets[coverage.blockIds.length]!;
  const partition = options.partition;
  if (partition && (!Number.isSafeInteger(partition.index) || !Number.isSafeInteger(partition.count) || partition.count < 1 || partition.index < 0 || partition.index >= partition.count)) throw new RangeError('Invalid terrain column partition');
  const byteLength = sourceActiveIndices.length * 4 + (target.width + target.height) * 12 +
    (source.width + source.height) * 8 + Math.ceil(source.width * source.height / 8) + 96;
  const workspaceBufferBytes = Math.min(4, sourceActiveIndices.length) * (maxLevels * 16 + 45) + 4 * (maxLevels + 3) * 58 + 4 + daylightBytes(target, 3);
  const workspaceObjectBudgetBytes = 66560 + maxLevels * 256;
  const outputBufferBytes = targetCount * 10;
  const admittedBytes = byteLength + workspaceBufferBytes + workspaceObjectBudgetBytes + outputBufferBytes;
  if (!Number.isSafeInteger(admittedBytes) || admittedBytes > options.maxBytes) throw new RangeError('Packed terrain column byte budget exceeded');
  if (options.budgetOnly) {
    const unavailable = () => { throw new Error('Packed terrain column budget does not derive'); };
    return { byteLength, workspaceBufferBytes, workspaceObjectBudgetBytes, outputBufferBytes, derive: unavailable, deriveAsync: async () => unavailable() };
  }
  const activeIndices = sourceActiveIndices.slice(), xCoordinates = new Float64Array(target.width), yCoordinates = new Float64Array(target.height);
  if (source.kind === 'regular-latlon' && target.kind === 'regular-latlon') {
    for (let x = 0; x < target.width; x++) {
      const longitude = target.lon0 + x * target.dx;
      const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
      let value = snapGridCoordinate((wrapped - source.lon0) / source.dx);
      if (source.wrapLongitude) value = snapGridCoordinate(((value % source.width) + source.width) % source.width);
      xCoordinates[x] = Number.isFinite(value) && (source.wrapLongitude || (value >= 0 && value <= source.width - 1)) ? value : NaN;
    }
    for (let y = 0; y < target.height; y++) {
      const latitude = target.lat0 + y * target.dy;
      const value = snapGridCoordinate((latitude - source.lat0) / source.dy);
      yCoordinates[y] = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(value) &&
        value >= 0 && value <= source.height - 1 ? value : NaN;
    }
  } else {
    for (let x = 0; x < target.width; x++) xCoordinates[x] = snapGridCoordinate(x / expected.k);
    for (let y = 0; y < target.height; y++) yCoordinates[y] = snapGridCoordinate(y / expected.k);
  }
  const xNext = new Uint32Array(target.width), yNext = new Uint32Array(target.height);
  const xHeads = new Uint32Array(source.width * 2), yHeads = new Uint32Array(source.height * 2);
  for (let x = target.width - 1; x >= 0; x--) {
    const value = xCoordinates[x]!;
    if (!Number.isFinite(value)) continue;
    const group = Math.floor(value) * 2 + (value % 1 === 0 ? 0 : 1);
    xNext[x] = xHeads[group]!; xHeads[group] = x + 1;
  }
  for (let y = target.height - 1; y >= 0; y--) {
    const value = yCoordinates[y]!;
    if (!Number.isFinite(value)) continue;
    const group = Math.floor(value) * 2 + (value % 1 === 0 ? 0 : 1);
    yNext[y] = yHeads[group]!; yHeads[group] = y + 1;
  }
  const quads = new Uint8Array(Math.ceil(source.width * source.height / 8));
  const columns = Math.ceil(target.width / 16);
  let hasInvalid = false;
  for (let block = 0; block < coverage.blockIds.length; block++) {
    const id = coverage.blockIds[block]!;
    for (let bit = 0; bit < 256; bit++) {
      const maskIndex = block * 32 + (bit >> 3);
      if (((coverage.output[maskIndex]! | coverage.halo[maskIndex]!) & (1 << (bit & 7))) === 0) continue;
      const x = (id % columns) * 16 + bit % 16, y = Math.floor(id / columns) * 16 + Math.floor(bit / 16);
      const nx = xCoordinates[x]!, ny = yCoordinates[y]!;
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) { hasInvalid = true; continue; }
      const quad = Math.floor(ny) * source.width + Math.floor(nx), byte = Math.floor(quad / 8);
      quads[byte] |= 1 << (quad % 8);
    }
  }
  const slots = new Uint32Array(4), weights = new Float64Array(4), quadSlots = new Uint32Array(4);
  const localSlots = new Uint32Array(4), localIndices = new Uint32Array(4);
  const traversal: ColumnTraversal = {
    targetCount, outputCells: targetCount, slots, weights, compactSlots: localSlots, donorIndices: localIndices,
    donorCount: Math.min(4, activeIndices.length), coverage,
    initializeOutput: !partition,
    outsideCount: !partition || partition.index === 0 ? target.width * target.height - targetCount : 0,
    createCursor() {
      const cell = { index: 0, outputIndex: 0, count: 0, offset: 0, group: -1 };
      function* cells() {
        for (let byte = 0; byte < quads.length; byte++) {
          let bits = quads[byte]!;
          while (bits) {
            const bit = 31 - Math.clz32(bits & -bits), quad = byte * 8 + bit;
            bits &= bits - 1;
            if (partition && (quad < Math.floor(source.width * source.height * partition.index / partition.count) || quad >= Math.floor(source.width * source.height * (partition.index + 1) / partition.count))) continue;
            const x0 = quad % source.width, y0 = Math.floor(quad / source.width);
            for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
              const x = x0 + dx, y = y0 + dy, position = dy * 2 + dx;
              if (y >= source.height || (!source.wrapLongitude && x >= source.width)) { quadSlots[position] = 0xffffffff; continue; }
              const global = y * source.width + x % source.width;
              let lo = 0, hi = activeIndices.length;
              while (lo < hi) { const mid = (lo + hi) >>> 1; if (activeIndices[mid]! < global) lo = mid + 1; else hi = mid; }
              quadSlots[position] = activeIndices[lo] === global ? lo : 0xffffffff;
            }
            let next = 0;
            for (let position = 0; position < 4; position++) {
              const compact = quadSlots[position]!;
              if (compact === 0xffffffff) continue;
              let slot = 0;
              while (slot < next && localSlots[slot] !== compact) slot++;
              if (slot === next) { localSlots[next] = compact; localIndices[next] = activeIndices[compact]!; next++; }
              quadSlots[position] = slot;
            }
            for (let subset = 3; subset >= 0; subset--) {
              for (let yp = yHeads[y0 * 2 + (subset >> 1)]!; yp; yp = yNext[yp - 1]!) {
                const y = yp - 1, fy = yCoordinates[y]! - y0;
                for (let xp = xHeads[x0 * 2 + (subset & 1)]!; xp; xp = xNext[xp - 1]!) {
                  const x = xp - 1, packed = sparseCoverageLookup(coverage, x, y);
                  if (!packed) continue;
                  const fx = xCoordinates[x]! - x0;
                  cell.index = y * target.width + x; cell.outputIndex = packed.offset; cell.count = 0; cell.group = quad;
                  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                    if ((dx && fx === 0) || (dy && fy === 0)) continue;
                    const weight = (dy === 0 ? 1 - fy : fy) * (dx === 0 ? 1 - fx : fx);
                    if (weight <= 0) continue;
                    const slot = quadSlots[dy * 2 + dx]!;
                    if (slot === 0xffffffff) throw new RangeError(`Whole-domain donor ${(y0 + dy) * source.width + (x0 + dx) % source.width} is not an active native index`);
                    slots[cell.count] = slot; weights[cell.count++] = weight;
                  }
                  yield cell;
                }
              }
            }
          }
        }
        if (hasInvalid && (!partition || partition.index === 0)) for (let block = 0; block < coverage.blockIds.length; block++) {
          const id = coverage.blockIds[block]!;
          let offset = coverage.offsets[block]!;
          for (let bit = 0; bit < 256; bit++) {
            const maskIndex = block * 32 + (bit >> 3);
            if (((coverage.output[maskIndex]! | coverage.halo[maskIndex]!) & (1 << (bit & 7))) === 0) continue;
            const x = (id % columns) * 16 + bit % 16, y = Math.floor(id / columns) * 16 + Math.floor(bit / 16);
            const outputIndex = offset++;
            if (Number.isFinite(xCoordinates[x]!) && Number.isFinite(yCoordinates[y]!)) continue;
            cell.index = y * target.width + x; cell.outputIndex = outputIndex; cell.count = 0; cell.group = -1;
            yield cell;
          }
        }
      }
      const iterator = cells();
      return () => {
        const next = iterator.next();
        if (next.done) return undefined;
        return next.value;
      };
    }
  };
  const validate = traversal.createCursor();
  let partitionCount = 0;
  while (validate(partitionCount)) partitionCount++;
  if (!partition && partitionCount !== targetCount) throw new RangeError('Packed terrain column coverage changed');
  Object.assign(traversal, { targetCount: partitionCount });
  const deriver = columnDeriver(source, target, activeIndices, maxLevels, bridgeM, bridgeMode, fallbackMode, traversal);
  let busy = false;
  return { byteLength, workspaceBufferBytes, workspaceObjectBudgetBytes, outputBufferBytes,
    derive: (frame, terrain, time, deriveOptions) => {
      if (deriveOptions && 'clearance' in deriveOptions) throw new RangeError('Packed terrain columns do not accept dense clearance');
      if (partition && !deriveOptions?.output) throw new RangeError('Partitioned terrain columns require output');
      if (busy) throw new Error('Packed terrain column derivation is already running');
      return deriver.derive(frame, terrain, time, deriveOptions) as ReturnType<PreparedPackedTerrainColumns['derive']>;
    },
    deriveAsync: async (frame, terrain, time, deriveOptions) => {
      if (deriveOptions && 'clearance' in deriveOptions) throw new RangeError('Packed terrain columns do not accept dense clearance');
      if (partition && !deriveOptions.output) throw new RangeError('Partitioned terrain columns require output');
      if (busy) throw new Error('Packed terrain column derivation is already running');
      busy = true;
      try {
        return await deriver.deriveAsync(frame, terrain, time, deriveOptions) as ReturnType<PreparedPackedTerrainColumns['derive']>;
      } finally { busy = false; }
    } };
}

function columnDeriver(source: Grid, target: Grid, activeIndices: Uint32Array, maxLevels: number, bridgeM: number,
  bridgeMode: 'neutral' | 'lowest-layer', fallbackMode: 'unsupported' | 'none', traversal: ColumnTraversal) {
  const { targetCount, outputCells, slots, weights, compactSlots, donorIndices, donorCount } = traversal;
  const sourceCells = source.width * source.height, targetCells = target.width * target.height;
  let workspace: ReconstructedProfileWorkspace | undefined;
  let donorState: Uint8Array | undefined, donorSpecificHumidity: Float64Array | undefined, donorRelativeHumidity: Float64Array | undefined;
  function* run(frame: Parameters<PreparedTerrainColumns['derive']>[0], terrain: Parameters<PreparedTerrainColumns['derive']>[1],
    time: Parameters<PreparedTerrainColumns['derive']>[2], options: NonNullable<Parameters<PreparedTerrainColumns['derive']>[3]> & { output?: { 'usable-lift-msl': GridField; 'usable-lift-agl': GridField } } = {}):
    Generator<void, TerrainColumnDerivation> {
      if (!sameGrid(frame.grid, source) || frame.activeIndices.length !== activeIndices.length ||
          frame.activeIndices.some((value, i) => value !== activeIndices[i])) throw new Error('Normalized input grid or active-index identity mismatch');
      const levelCount = frame.pressurePa?.length ?? frame.pressureLevelsHpa?.length ?? 0;
      if (levelCount < 1 || levelCount > maxLevels || !(terrain.elevationM instanceof Float32Array) ||
          !(terrain.valid instanceof Uint8Array) || terrain.elevationM.length !== outputCells || terrain.valid.length !== outputCells) {
        throw new RangeError('Invalid terrain column frame or terrain');
      }
      const requested = options.probeIndices ?? [];
      if (requested.length > 64 || new Set(requested).size !== requested.length ||
          requested.some(index => !Number.isSafeInteger(index) || index < 0 || index >= targetCells)) throw new RangeError('Invalid terrain column probes');
      const probeSet = new Set(requested), probes: TerrainColumnProbe[] = [];
      const start = Date.parse(time.intervalStart), end = Date.parse(time.validTime);
      if (options.daylightOnly !== false && (!Number.isFinite(start) || !Number.isFinite(end) || start > end)) throw new RangeError('Invalid terrain column daylight interval');
      const clearance = options.clearance;
      const nativeClearance = options.nativeClearance;
      if (clearance && nativeClearance) throw new RangeError('Choose one terrain clearance input');
      if (clearance) {
        const cm = clearance.fields?.['usable-lift-msl'], ca = clearance.fields?.['usable-lift-agl'];
        if (clearance.methodId !== TERRAIN_CLEARANCE_METHOD.id || !sameGrid(clearance.grid, target) || !Number.isFinite(end) || Date.parse(clearance.validTime) !== end ||
            Date.parse(frame.validAt) !== end || !(cm?.values instanceof Float32Array) || !(cm.flags instanceof Uint8Array) ||
            !(ca?.values instanceof Float32Array) || !(ca.flags instanceof Uint8Array) ||
            cm.values.length !== targetCells || cm.flags.length !== targetCells || ca.values.length !== targetCells || ca.flags.length !== targetCells) {
          throw new RangeError('Invalid terrain clearance frame, grid or fields');
        }
      }
      if (nativeClearance) {
        const d = nativeClearance.diagnostics;
        if (!sameGrid(nativeClearance.grid, source) || !Number.isFinite(end) || Date.parse(nativeClearance.validTime) !== end ||
            Date.parse(frame.validAt) !== end || !(d?.ceilingMslM instanceof Float32Array) ||
            !(d.buoyancyM2S3 instanceof Float32Array) || !(d.branch instanceof Uint8Array) ||
            !(nativeClearance.flags instanceof Uint8Array) || d.ceilingMslM.length !== sourceCells ||
            d.buoyancyM2S3.length !== sourceCells || d.branch.length !== sourceCells || nativeClearance.flags.length !== sourceCells) {
          throw new RangeError('Invalid native terrain clearance frame, grid or fields');
        }
      }
      const timestamps = options.daylightOnly === false ? [] : buildIntervalDaylightTimestampsMs(start, end);
      const actualDaylightBufferBytes = daylightBytes(target, timestamps.length);
      const daylight = createMaskDaylightTester(target, timestamps);
      const msl: GridField = options.output?.['usable-lift-msl'] ?? { values: new Float32Array(outputCells), flags: new Uint8Array(outputCells) };
      const agl: GridField = options.output?.['usable-lift-agl'] ?? { values: new Float32Array(outputCells), flags: new Uint8Array(outputCells) };
      for (const field of [msl, agl]) {
        if (!(field.values instanceof Float32Array) || !(field.flags instanceof Uint8Array) || field.values.length !== outputCells || field.flags.length !== outputCells) throw new RangeError('Invalid terrain column output');
        if (traversal.initializeOutput !== false) field.flags.fill(STATUS_OUTSIDE);
      }
      const metrics: TerrainColumnMetrics = { outside: traversal.outsideCount ?? targetCells - targetCount, dark: 0, invalidDem: 0, missingDonor: 0,
        invalidDonorInput: 0, unsupportedHeight: 0, belowGroundBridgeExceeded: 0, invalidSurfaceState: 0,
        solverRejected: 0, valid: 0, noLift: 0, belowGroundBridge: 0, profileTop: 0,
        filledBelowGroundBridgeExceeded: 0, belowGroundBridgeExceededObserved: 0, column: 0, clearance: 0 };
      workspace ??= new ReconstructedProfileWorkspace(donorCount, maxLevels);
      workspace.reset();
      donorState ??= new Uint8Array(donorCount); donorState.fill(0);
      donorSpecificHumidity ??= new Float64Array(donorCount); donorRelativeHumidity ??= new Float64Array(donorCount);
      const scratch = createNativeColumnScratch(maxLevels);
      const clearanceResult = { msl: 0, agl: 0, flags: 0 };
      const cursor = traversal.createCursor();
      let group = -1;
      for (let t = 0; t < targetCount; t++) {
        if (t > 0 && t % 1024 === 0) yield;
        const cell = cursor(t);
        if (!cell) throw new RangeError('Packed terrain column coverage changed');
        if (traversal.compactSlots && traversal.coverage && cell.group !== group) {
          group = cell.group!; workspace.reset(); donorState.fill(0);
        }
        const index = cell.index, outputIndex = cell.outputIndex, h = terrain.elevationM[outputIndex]!, count = cell.count, offset = cell.offset;
        msl.values[outputIndex] = NaN; agl.values[outputIndex] = NaN;
        msl.flags[outputIndex] = STATUS_UNAVAILABLE; agl.flags[outputIndex] = STATUS_UNAVAILABLE;
        const probe: TerrainColumnProbe | undefined = probeSet.has(index) ? {
          index, donorIndices: [], donorWeights: [], terrainM: h, referenceTerrainM: null, surfaceTemperatureK: null,
          groundEnvironmentK: null, surfaceExcessK: null, donorGroundEnvironmentK: [], donorSurfaceExcessK: [], donorGroundWeights: [], surfacePressurePa: null, humidityKgKg: null,
          sensibleHeatFluxWm2: null, latentHeatFluxWm2: null, branch: null, depthM: null, msl: null, agl: null, reason: null,
          maxBelowGroundDepthM: null, provenance: null
        } : undefined;
        if (probe) {
          for (let i = 0; i < count; i++) { probe.donorIndices.push(donorIndices[slots[offset + i]!]!); probe.donorWeights.push(weights[offset + i]!); }
          probes.push(probe);
        }
        const fail = (reason: keyof TerrainColumnMetrics) => { metrics[reason]++; if (probe) probe.reason = reason; };
        if (terrain.valid[outputIndex] !== 1 || !Number.isFinite(h)) { fail('invalidDem'); continue; }
        if (!count) { fail('missingDonor'); continue; }
        if (!daylight(index)) {
          msl.values[outputIndex] = h; agl.values[outputIndex] = 0; msl.flags[outputIndex] = STATUS_NO_LIFT; agl.flags[outputIndex] = STATUS_NO_LIFT;
          metrics.dark++; if (probe) { probe.reason = 'dark'; probe.msl = h; probe.agl = 0; }
          continue;
        }
        let bad: 'missingDonor' | 'invalidDonorInput' | null = null;
        for (let i = 0; i < count; i++) {
          const donor = slots[offset + i]!, compactSlot = compactSlots ? compactSlots[donor]! : donor;
          if (!donorState[donor]) {
            const n = readNativeColumn(frame, compactSlot, scratch);
            let missing = ![scratch.terrainM, scratch.surfaceTemperatureC, scratch.surfacePressureHpa,
              scratch.humidity.specificHumidityKgKg, scratch.sensibleHeatFluxWm2, scratch.latentHeatFluxWm2].every(Number.isFinite);
            for (let j = 0; j < n; j++) missing ||= !Number.isFinite(scratch.levels[j]!.heightM) || !Number.isFinite(scratch.levels[j]!.temperatureC);
            donorState[donor] = missing ? 2 : workspace.admit(donor, scratch, n) ? 1 : 3;
            if (donorState[donor] === 1) {
              const q = scratch.humidity.specificHumidityKgKg, r = q / (1 - q);
              donorSpecificHumidity[donor] = q;
              donorRelativeHumidity[donor] = scratch.surfacePressureHpa * r / (EPSILON + r) / saturationVaporPressureHpa(scratch.surfaceTemperatureC);
            }
          }
          if (donorState[donor] !== 1) { bad = donorState[donor] === 2 ? 'missingDonor' : 'invalidDonorInput'; break; }
        }
        if (bad) { fail(bad); continue; }
        let excess = 0;
        for (let i = 0; i < count; i++) {
          const slot = slots[offset + i]!, weight = weights[offset + i]!;
          excess += weight * workspace.donorSurfaceExcessC(slot);
          if (probe) {
            probe.donorGroundEnvironmentK.push(workspace.donorGroundEnvironmentC(slot) + K);
            probe.donorSurfaceExcessK.push(workspace.donorSurfaceExcessC(slot));
          }
        }
        if (probe) probe.surfaceExcessK = excess;
        const reconstructed = workspace.reconstruct(slots, weights, offset, count, h, bridgeM, bridgeMode);
        const depth = workspace.maximumBelowGroundDepthM;
        if (probe && Number.isFinite(depth)) probe.maxBelowGroundDepthM = depth;
        if (!reconstructed) {
          if (probe) for (let i = 0; i < count; i++) probe.donorGroundWeights.push(0);
          if (workspace.failure === 'belowGroundBridgeExceeded') metrics.belowGroundBridgeExceededObserved!++;
          let mv: number | undefined, cv: number | undefined, mf: number | undefined, cf: number | undefined;
          if (fallbackMode === 'unsupported' && workspace.failure === 'belowGroundBridgeExceeded') {
            if (nativeClearance) {
              if (clearanceCell(nativeClearance.diagnostics, nativeClearance.flags, slots, weights, offset, count, h, clearanceResult, donorIndices)) {
                mv = clearanceResult.msl; cv = clearanceResult.agl; mf = clearanceResult.flags; cf = clearanceResult.flags;
              }
            } else {
              const cm = clearance?.fields['usable-lift-msl'], ca = clearance?.fields['usable-lift-agl'];
              cf = ca?.flags[index]; mf = cm?.flags[index]; cv = ca?.values[index]; mv = cm?.values[index];
            }
          }
          const clearanceKnown = cf !== undefined && mf !== undefined && cv !== undefined && mv !== undefined &&
            cf === mf && (cf & ~(STATUS_MASK | SUPPORT_MASK)) === 0 &&
            ((cf & STATUS_MASK) === STATUS_VALID ? Number.isFinite(cv) && cv > 0 : (cf & STATUS_MASK) === STATUS_NO_LIFT && cv === 0) &&
            Number.isFinite(mv) && mv === Math.fround(h + cv);
          if (workspace.failure !== 'belowGroundBridgeExceeded' || !clearanceKnown) {
            fail(workspace.failure ?? 'unsupportedHeight'); continue;
          }
          msl.values[outputIndex] = mv!; agl.values[outputIndex] = cv!; msl.flags[outputIndex] = mf!; agl.flags[outputIndex] = cf!;
          metrics.filledBelowGroundBridgeExceeded!++; metrics.clearance!++;
          if ((cf! & STATUS_MASK) === STATUS_VALID) metrics.valid++; else metrics.noLift++;
          if (probe) Object.assign(probe, { provenance: 'clearance', msl: mv, agl: cv, reason: 'belowGroundBridgeExceeded' });
          continue;
        }
        if (workspace.bridgeUsed) metrics.belowGroundBridge++;
        const h0 = workspace.referenceTerrainM, ef = workspace.surfaceEnvironmentAtGroundC + K;
        let t0 = 0, p0 = 0, q0 = 0, rh = 0, sh = 0, lh = 0, hSup = 0;
        for (let i = 0; i < count; i++) {
          const slot = slots[offset + i]!, j = compactSlots ? compactSlots[slot]! : slot;
          const gw = workspace.groundEnvironmentWeight(slot, weights[offset + i]!);
          if (probe) probe.donorGroundWeights.push(gw);
          t0 += gw * frame.temp2mK[j]!; p0 += gw * frame.surfacePressurePa[j]!; q0 += gw * donorSpecificHumidity[slot]!;
          rh += gw * donorRelativeHumidity[slot]!;
          sh += gw * frame.sensibleHeatFluxWm2[j]!; lh += gw * frame.latentHeatFluxWm2[j]!;
          hSup += gw * frame.terrainM[j]!;
        }
        let result: ColumnResult;
        const firstSlot = slots[offset]!;
        const nativeCompact = compactSlots ? compactSlots[firstSlot]! : firstSlot;
        const nativeGround = count === 1 && weights[offset] === 1 && h === frame.terrainM[nativeCompact];
        if (nativeGround) {
          const n = readNativeColumn(frame, nativeCompact, scratch);
          result = deriveColumn(scratch, n);
          if (probe) Object.assign(probe, { referenceTerrainM: h0, surfaceTemperatureK: t0, groundEnvironmentK: ef,
            surfacePressurePa: p0, humidityKgKg: q0, sensibleHeatFluxWm2: sh, latentHeatFluxWm2: lh });
        } else {
          const tf = ef + excess;
          const r0 = q0 / (1 - q0), tv = (t0 + tf) / 2 * (1 + r0 / EPSILON) / (1 + r0);
          const pf = p0 * Math.exp(-G * (h - hSup) / (RD * tv));
          const vf = rh * saturationVaporPressureHpa(tf - K), rf = EPSILON * vf / (pf / PA - vf), qf = rf / (1 + rf);
          if (![t0, tf, p0, q0, tv, pf, rh, vf, qf].every(Number.isFinite) || t0 <= 0 || tf <= 0 || tv <= 0 || pf <= 0 ||
              q0 < 0 || q0 >= 1 || rh < 0 || rh > 1 + DEFAULT_SOARING_PARAMETERS.saturationRelativeTolerance ||
              pf / PA <= vf || qf < 0 || qf >= 1) { fail('invalidSurfaceState'); continue; }
          if (probe) Object.assign(probe, { referenceTerrainM: h0, surfaceTemperatureK: tf, groundEnvironmentK: ef,
            surfacePressurePa: pf, humidityKgKg: qf, sensibleHeatFluxWm2: sh, latentHeatFluxWm2: lh });
          result = columnResult(h, workspace.solve({ surfaceTemperatureC: workspace.environmentAtGroundC + excess, surfacePressureHpa: pf / PA,
            humidity: { specificHumidityKgKg: qf }, sensibleHeatFluxWm2: sh, latentHeatFluxWm2: lh }));
        }
        if (result.msl.value === null || result.agl.value === null || !Number.isFinite(result.msl.value) || !Number.isFinite(result.agl.value)) {
          fail('solverRejected'); continue;
        }
        let cloudSupport = 0;
        if (nativeClearance) for (let i = 0; i < count; i++) cloudSupport |= nativeClearance.flags[donorIndices[slots[offset + i]!]!]! & CLOUD_SUPPORT_MASK;
        agl.values[outputIndex] = result.agl.value; agl.flags[outputIndex] = result.agl.flags | cloudSupport;
        msl.values[outputIndex] = nativeGround ? result.msl.value : h + agl.values[outputIndex]!; msl.flags[outputIndex] = result.msl.flags | cloudSupport;
        metrics.column!++;
        if ((agl.flags[outputIndex]! & STATUS_MASK) === STATUS_VALID) metrics.valid++; else metrics.noLift++;
        if (result.branch === 'profile-top') metrics.profileTop++;
        if (probe) Object.assign(probe, { branch: result.branch, depthM: result.depthM, msl: msl.values[outputIndex], agl: agl.values[outputIndex], provenance: 'column' });
      }
      if (traversal.coverage && probes.length > 1) {
        const coverage = traversal.coverage;
        probes.sort((a, b) => sparseCoverageLookup(coverage, a.index % target.width, Math.floor(a.index / target.width))!.offset -
          sparseCoverageLookup(coverage, b.index % target.width, Math.floor(b.index / target.width))!.offset);
      }
      const fields = traversal.coverage ? {
        'usable-lift-msl': { ...msl, coverage: traversal.coverage },
        'usable-lift-agl': { ...agl, coverage: traversal.coverage }
      } : { 'usable-lift-msl': msl, 'usable-lift-agl': agl };
      return { fields, metrics, probes, daylightBufferBytes: actualDaylightBufferBytes };
  }
  const derive: PreparedTerrainColumns['derive'] = (frame, terrain, time, options) => {
    const iterator = run(frame, terrain, time, options);
    for (;;) { const step = iterator.next(); if (step.done) return step.value; }
  };
  const deriveAsync: PreparedPackedTerrainColumns['deriveAsync'] = async (frame, terrain, time, options) => {
    const check = () => {
      options.signal?.throwIfAborted();
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new Error('Terrain column deadline exceeded');
    };
    if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) throw new RangeError('Invalid terrain column deadline');
    check();
    await options.yieldControl();
    check();
    const iterator = run(frame, terrain, time, options);
    for (;;) {
      const step = iterator.next();
      check();
      if (step.done) return step.value as ReturnType<PreparedPackedTerrainColumns['derive']>;
      await options.yieldControl();
      check();
    }
  };
  return { derive, deriveAsync };
}
