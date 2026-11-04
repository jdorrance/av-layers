import {
  getBit, gridSchema, MAX_GRID_CELLS, prepareGridGeometry, sameGrid,
  STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK, TERRAIN_CLEARANCE_METHOD,
  type CoverageMask, type Grid
} from '@av/contracts';
import { ReconstructedProfileWorkspace } from '@av/soaring';
import { DEFAULT_SOARING_PARAMETERS } from '@av/soaring/parameters';
import { saturationVaporPressureHpa } from '@av/thermodynamics';
import { THERMODYNAMIC_CONSTANTS } from '@av/thermodynamics/constants';
import { createNativeColumnScratch, readNativeColumn } from './column-input.js';
import { buildIntervalDaylightTimestampsMs, createMaskDaylightTester } from './daylight.js';
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
    options?: { daylightOnly?: boolean; probeIndices?: readonly number[]; clearance?: TerrainColumnClearance }): TerrainColumnDerivation;
}

const { kelvinOffset: K, pascalsPerHectopascal: PA, waterDryAirMolarMassRatio: EPSILON,
  gravityMps2: G, dryAirGasConstantJkgK: RD } = THERMODYNAMIC_CONSTANTS;

export function terrainColumnDaylightBufferBytes(grid: Grid, timestampCount: number): number {
  if (!Number.isSafeInteger(timestampCount) || timestampCount < 0 || timestampCount > 3 ||
      !Number.isSafeInteger(grid.width) || grid.width < 1 || !Number.isSafeInteger(grid.height) || grid.height < 1 ||
      grid.width * grid.height > MAX_GRID_CELLS) throw new RangeError('Invalid terrain column daylight capacity');
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
  const workspaceBufferBytes = donorCount * (maxLevels * 16 + 29) + 4 * (maxLevels + 3) * 24 + daylightBufferBytes;
  const workspaceObjectBudgetBytes = 65536 + maxLevels * 256;
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
  const bridgeM = evaluationOptions.maximumBelowGroundExtrapolationM ?? 1000;
  const bridgeMode = evaluationOptions.bridgeMode ?? 'neutral';
  const fallbackMode = evaluationOptions.clearanceFallback ?? 'none';
  if ((bridgeM !== 1000 && bridgeM !== 1500) || (bridgeMode !== 'neutral' && bridgeMode !== 'lowest-layer') ||
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

  return {
    byteLength, workspaceBytes, workspaceBufferBytes, workspaceObjectBudgetBytes, daylightBufferBytes,
    derive(frame, terrain, time, options = {}) {
      if (!sameGrid(frame.grid, source) || frame.activeIndices.length !== activeIndices.length ||
          frame.activeIndices.some((value, i) => value !== activeIndices[i])) throw new Error('Normalized input grid or active-index identity mismatch');
      const levelCount = frame.pressurePa?.length ?? frame.pressureLevelsHpa?.length ?? 0;
      if (levelCount < 1 || levelCount > maxLevels || !(terrain.elevationM instanceof Float32Array) ||
          !(terrain.valid instanceof Uint8Array) || terrain.elevationM.length !== targetCells || terrain.valid.length !== targetCells) {
        throw new RangeError('Invalid terrain column frame or terrain');
      }
      const requested = options.probeIndices ?? [];
      if (requested.length > 64 || new Set(requested).size !== requested.length ||
          requested.some(index => !Number.isSafeInteger(index) || index < 0 || index >= targetCells)) throw new RangeError('Invalid terrain column probes');
      const probeSet = new Set(requested), probes: TerrainColumnProbe[] = [];
      const start = Date.parse(time.intervalStart), end = Date.parse(time.validTime);
      if (options.daylightOnly !== false && (!Number.isFinite(start) || !Number.isFinite(end) || start > end)) throw new RangeError('Invalid terrain column daylight interval');
      const clearance = options.clearance;
      if (clearance) {
        const cm = clearance.fields?.['usable-lift-msl'], ca = clearance.fields?.['usable-lift-agl'];
        if (clearance.methodId !== TERRAIN_CLEARANCE_METHOD.id || !sameGrid(clearance.grid, target) || !Number.isFinite(end) || Date.parse(clearance.validTime) !== end ||
            Date.parse(frame.validAt) !== end || !(cm?.values instanceof Float32Array) || !(cm.flags instanceof Uint8Array) ||
            !(ca?.values instanceof Float32Array) || !(ca.flags instanceof Uint8Array) ||
            cm.values.length !== targetCells || cm.flags.length !== targetCells || ca.values.length !== targetCells || ca.flags.length !== targetCells) {
          throw new RangeError('Invalid terrain clearance frame, grid or fields');
        }
      }
      const timestamps = options.daylightOnly === false ? [] : buildIntervalDaylightTimestampsMs(start, end);
      const actualDaylightBufferBytes = terrainColumnDaylightBufferBytes(target, timestamps.length);
      const daylight = createMaskDaylightTester(target, timestamps);
      const msl: GridField = { values: new Float32Array(targetCells), flags: new Uint8Array(targetCells).fill(STATUS_OUTSIDE) };
      const agl: GridField = { values: new Float32Array(targetCells), flags: new Uint8Array(targetCells).fill(STATUS_OUTSIDE) };
      const metrics: TerrainColumnMetrics = { outside: targetCells - targetCount, dark: 0, invalidDem: 0, missingDonor: 0,
        invalidDonorInput: 0, unsupportedHeight: 0, belowGroundBridgeExceeded: 0, invalidSurfaceState: 0,
        solverRejected: 0, valid: 0, noLift: 0, belowGroundBridge: 0, profileTop: 0,
        filledBelowGroundBridgeExceeded: 0, belowGroundBridgeExceededObserved: 0, column: 0, clearance: 0 };
      const workspace = new ReconstructedProfileWorkspace(compactSlots.length, maxLevels);
      const donorState = new Uint8Array(compactSlots.length), scratch = createNativeColumnScratch(maxLevels);
      for (let t = 0; t < targetCount; t++) {
        const index = targets[t]!, h = terrain.elevationM[index]!, count = counts[t]!, offset = t * 4;
        msl.values[index] = NaN; agl.values[index] = NaN;
        msl.flags[index] = STATUS_UNAVAILABLE; agl.flags[index] = STATUS_UNAVAILABLE;
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
        if (terrain.valid[index] !== 1 || !Number.isFinite(h)) { fail('invalidDem'); continue; }
        if (!count) { fail('missingDonor'); continue; }
        if (!daylight(index)) {
          msl.values[index] = h; agl.values[index] = 0; msl.flags[index] = STATUS_NO_LIFT; agl.flags[index] = STATUS_NO_LIFT;
          metrics.dark++; if (probe) { probe.reason = 'dark'; probe.msl = h; probe.agl = 0; }
          continue;
        }
        let bad: 'missingDonor' | 'invalidDonorInput' | null = null;
        for (let i = 0; i < count; i++) {
          const donor = slots[offset + i]!, compactSlot = compactSlots[donor]!;
          if (!donorState[donor]) {
            const n = readNativeColumn(frame, compactSlot, scratch);
            let missing = ![scratch.terrainM, scratch.surfaceTemperatureC, scratch.surfacePressureHpa,
              scratch.humidity.specificHumidityKgKg, scratch.sensibleHeatFluxWm2, scratch.latentHeatFluxWm2].every(Number.isFinite);
            for (let j = 0; j < n; j++) missing ||= !Number.isFinite(scratch.levels[j]!.heightM) || !Number.isFinite(scratch.levels[j]!.temperatureC);
            donorState[donor] = missing ? 2 : workspace.admit(donor, scratch, n) ? 1 : 3;
          }
          if (donorState[donor] !== 1) { bad = donorState[donor] === 2 ? 'missingDonor' : 'invalidDonorInput'; break; }
        }
        if (bad) { fail(bad); continue; }
        let t0 = 0, p0 = 0, q0 = 0, sh = 0, lh = 0;
        for (let i = 0; i < count; i++) {
          const j = compactSlots[slots[offset + i]!]!, w = weights[offset + i]!;
          t0 += w * frame.temp2mK[j]!; p0 += w * frame.surfacePressurePa[j]!; q0 += w * frame.specificHumidity2mKgKg[j]!;
          sh += w * frame.sensibleHeatFluxWm2[j]!; lh += w * frame.latentHeatFluxWm2[j]!;
        }
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
        const cm = clearance?.fields['usable-lift-msl'], ca = clearance?.fields['usable-lift-agl'];
        const cf = ca?.flags[index], mf = cm?.flags[index], cv = ca?.values[index], mv = cm?.values[index];
        const clearanceKnown = fallbackMode === 'unsupported' && cf !== undefined && mf !== undefined && cv !== undefined && mv !== undefined &&
          cf === mf && (cf & ~(STATUS_MASK | SUPPORT_MASK)) === 0 &&
          ((cf & STATUS_MASK) === STATUS_VALID ? Number.isFinite(cv) && cv > 0 : (cf & STATUS_MASK) === STATUS_NO_LIFT && cv === 0) &&
          Number.isFinite(mv) && mv === Math.fround(h + cv);
        if (!reconstructed) {
          if (probe) for (let i = 0; i < count; i++) probe.donorGroundWeights.push(0);
          if (workspace.failure === 'belowGroundBridgeExceeded') metrics.belowGroundBridgeExceededObserved!++;
          if (workspace.failure !== 'belowGroundBridgeExceeded' || !clearanceKnown) {
            fail(workspace.failure ?? 'unsupportedHeight'); continue;
          }
          const r = q0 / (1 - q0), vapor = p0 / PA * r / (EPSILON + r);
          const rh = vapor / saturationVaporPressureHpa(t0 - K);
          if (!Number.isFinite(rh) || rh < 0 || rh > 1 + DEFAULT_SOARING_PARAMETERS.saturationRelativeTolerance) {
            fail('invalidSurfaceState'); continue;
          }
          msl.values[index] = mv!; agl.values[index] = cv!; msl.flags[index] = mf!; agl.flags[index] = cf!;
          metrics.filledBelowGroundBridgeExceeded!++; metrics.clearance!++;
          if ((cf! & STATUS_MASK) === STATUS_VALID) metrics.valid++; else metrics.noLift++;
          if (probe) Object.assign(probe, { provenance: 'clearance', msl: mv, agl: cv, reason: 'belowGroundBridgeExceeded' });
          continue;
        }
        if (workspace.bridgeUsed) metrics.belowGroundBridge++;
        const h0 = workspace.referenceTerrainM, ef = workspace.surfaceEnvironmentAtGroundC + K;
        t0 = 0; p0 = 0; q0 = 0; sh = 0; lh = 0;
        let hSup = 0;
        for (let i = 0; i < count; i++) {
          const slot = slots[offset + i]!, j = compactSlots[slot]!;
          const gw = workspace.groundEnvironmentWeight(slot, weights[offset + i]!);
          if (probe) probe.donorGroundWeights.push(gw);
          t0 += gw * frame.temp2mK[j]!; p0 += gw * frame.surfacePressurePa[j]!; q0 += gw * frame.specificHumidity2mKgKg[j]!;
          sh += gw * frame.sensibleHeatFluxWm2[j]!; lh += gw * frame.latentHeatFluxWm2[j]!;
          hSup += gw * frame.terrainM[j]!;
        }
        let result: ColumnResult;
        const nativeGround = count === 1 && weights[offset] === 1 && h === frame.terrainM[compactSlots[slots[offset]!]!];
        if (nativeGround) {
          const n = readNativeColumn(frame, compactSlots[slots[offset]!]!, scratch);
          result = deriveColumn(scratch, n);
          if (probe) Object.assign(probe, { referenceTerrainM: h0, surfaceTemperatureK: t0, groundEnvironmentK: ef,
            surfacePressurePa: p0, humidityKgKg: q0, sensibleHeatFluxWm2: sh, latentHeatFluxWm2: lh });
        } else {
          const tf = ef + excess;
          const r0 = q0 / (1 - q0), tv = (t0 + tf) / 2 * (1 + r0 / EPSILON) / (1 + r0);
          const pf = p0 * Math.exp(-G * (h - hSup) / (RD * tv));
          const vapor = p0 / PA * r0 / (EPSILON + r0), rh = vapor / saturationVaporPressureHpa(t0 - K);
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
        agl.values[index] = result.agl.value; agl.flags[index] = result.agl.flags;
        msl.values[index] = nativeGround ? result.msl.value : h + agl.values[index]!; msl.flags[index] = result.msl.flags;
        metrics.column!++;
        if ((agl.flags[index]! & STATUS_MASK) === STATUS_VALID) metrics.valid++; else metrics.noLift++;
        if (result.branch === 'profile-top') metrics.profileTop++;
        if (probe) Object.assign(probe, { branch: result.branch, depthM: result.depthM, msl: msl.values[index], agl: agl.values[index], provenance: 'column' });
      }
      return { fields: { 'usable-lift-msl': msl, 'usable-lift-agl': agl }, metrics, probes, daylightBufferBytes: actualDaylightBufferBytes };
    }
  };
}
