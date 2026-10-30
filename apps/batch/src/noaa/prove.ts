import { GFS_CONTRACT_GRID, GFS_PRESSURE_LEVELS_HPA } from './constants.ts';
import { acquireGfsFrame, contractIndexToNativeIndex, validateActiveIndices, validateCycle, validateHour } from './acquire.ts';
import { discoverGfsRun } from './discover.ts';
import { NoaaError } from './errors.ts';
import { inspectGfsField } from './admission.ts';
import { cycleStamp, gfsCompanionSpecs, gfsCurrentSpecs, gfsFileUrl, gfsProductName, gfsWindowNeedsCompanion } from './fields.ts';
import { admitNoaaWindowPair, gfsWindowStart } from './intervals.ts';
import { NoaaFieldSampler } from './sampling.ts';
import { NoaaTransport, selectGfsRecord, type NoaaTransportStats } from './transport.ts';
import type {
  DecodedFieldReceipt,
  DiagnoseGfsInputsOptions,
  DiagnoseGfsInputsReport,
  GfsFrameAcquisition,
  ProveGfsInputsOptions,
  ProveGfsInputsReport,
} from './types.ts';

const DEFAULT_PROOF_INDEX = (() => {
  const row = Math.round((GFS_CONTRACT_GRID.lat0 - 40) / -GFS_CONTRACT_GRID.dy);
  const column = Math.round((-105 - GFS_CONTRACT_GRID.lon0) / GFS_CONTRACT_GRID.dx);
  return row * GFS_CONTRACT_GRID.width + column;
})();

function sum(values: Uint8Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function checkFrame(frame: GfsFrameAcquisition): void {
  const n = frame.activeIndices.length;
  const arrays: [string, Float32Array | Uint8Array][] = [
    ['terrain', frame.terrainM],
    ['surfacePressure', frame.surfacePressurePa],
    ['temp2m', frame.temp2mK],
    ['humidity2m', frame.specificHumidity2mKgKg],
    ['pbl', frame.pblHeightM],
    ['sensibleHeatFlux', frame.sensibleHeatFluxWm2],
    ['latentHeatFlux', frame.latentHeatFluxWm2],
    ['precipitation', frame.precipitationMmPerHour],
    ...frame.hgtM.map((values, i) => [`hgt.${frame.pressureLevelsHpa[i]}`, values] as [string, Float32Array]),
    ...frame.tempK.map((values, i) => [`temp.${frame.pressureLevelsHpa[i]}`, values] as [string, Float32Array]),
  ];
  for (const [name, values] of arrays) {
    if (values.length !== n) throw new NoaaError('decode', `Proof array ${name} has ${values.length} values, expected ${n}`);
  }
  for (const [name, bytes] of [
    ['terrain', frame.missing.terrain],
    ['surfacePressure', frame.missing.surfacePressure],
    ['temp2m', frame.missing.temp2m],
    ['humidity2m', frame.missing.humidity2m],
    ['pbl', frame.missing.pbl],
    ['sensibleHeatFlux', frame.missing.sensibleHeatFlux],
    ['latentHeatFlux', frame.missing.latentHeatFlux],
    ['precipitation', frame.missing.precipitation],
  ] as const) {
    if (bytes.length !== n) throw new NoaaError('decode', `Proof mask ${name} has ${bytes.length} values, expected ${n}`);
  }
  for (let i = 0; i < GFS_PRESSURE_LEVELS_HPA.length; i++) {
    if (frame.hgtM[i]!.length !== n || frame.tempK[i]!.length !== n) {
      throw new NoaaError('decode', `Proof pressure level ${GFS_PRESSURE_LEVELS_HPA[i]} has wrong length`);
    }
    if (frame.missing.hgt[i]!.length !== n || frame.missing.temp[i]!.length !== n) {
      throw new NoaaError('decode', `Proof pressure mask ${GFS_PRESSURE_LEVELS_HPA[i]} has wrong length`);
    }
  }
  for (const window of [frame.intervals.fluxWindow, frame.intervals.precipitationWindow]) {
    const hours = (Date.parse(window.end) - Date.parse(window.start)) / 3_600_000;
    if (hours !== 3) throw new NoaaError('source-conflict', `Proof window ${window.start}..${window.end} is not three hours`);
  }
}

export function proveGfsInputs(options: DiagnoseGfsInputsOptions): Promise<DiagnoseGfsInputsReport>;
export function proveGfsInputs(options?: ProveGfsInputsOptions): Promise<ProveGfsInputsReport>;
export async function proveGfsInputs(options: ProveGfsInputsOptions | DiagnoseGfsInputsOptions = {}): Promise<ProveGfsInputsReport | DiagnoseGfsInputsReport> {
  if (options.diagnostic) return diagnoseGfsInputs(options);
  const hour = options.hour ?? 6;
  const activeIndices = options.activeIndices ?? Uint32Array.of(DEFAULT_PROOF_INDEX);
  const stats: NoaaTransportStats = { networkRequests: 0, cacheReads: 0, memoryIndexHits: 0 };
  const discovered = options.cycle
    ? null
    : await discoverGfsRun({
        now: options.now,
        fetch: options.fetch,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        cacheDir: options.cacheDir,
      }, stats);
  const cycle = options.cycle ?? discovered!.cycle;
  const frame = await acquireGfsFrame({
    cycle,
    hour,
    activeIndices,
    cacheDir: options.cacheDir,
    fetch: options.fetch,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  }, stats);
  checkFrame(frame);
  const missingCounts: Record<string, number> = {
    terrain: sum(frame.missing.terrain),
    surfacePressure: sum(frame.missing.surfacePressure),
    temp2m: sum(frame.missing.temp2m),
    humidity2m: sum(frame.missing.humidity2m),
    pbl: sum(frame.missing.pbl),
    sensibleHeatFlux: sum(frame.missing.sensibleHeatFlux),
    latentHeatFlux: sum(frame.missing.latentHeatFlux),
    precipitation: sum(frame.missing.precipitation),
    hgt: frame.missing.hgt.reduce((total, mask) => total + sum(mask), 0),
    temp: frame.missing.temp.reduce((total, mask) => total + sum(mask), 0),
  };
  const report: ProveGfsInputsReport = {
    ok: true,
    ticket: 'GFS-INPUT-PROOF',
    discovered,
    acquisition: {
      cycle: frame.cycle,
      hour: frame.hour,
      validAt: frame.validAt,
      grid: frame.grid,
      activeIndices: Array.from(frame.activeIndices),
      pressureLevelsHpa: frame.pressureLevelsHpa,
      intervals: frame.intervals,
      fieldCount: frame.receipt.fields.length,
      missingCounts,
      sourceBytes: frame.receipt.fields.reduce((total, field) => total + field.asset.size, 0),
      requestCount: stats.networkRequests,
      transport: { ...stats },
      receipt: frame.receipt,
    },
  };
  const logger = options.logger ?? ((line: string) => console.log(line));
  logger(JSON.stringify(report, null, 2));
  return report;
}

async function diagnoseGfsInputs(options: DiagnoseGfsInputsOptions): Promise<DiagnoseGfsInputsReport> {
  const cycle = validateCycle(options.cycle);
  const hour = options.hour ?? 6;
  validateHour(hour);
  const activeIndices = validateActiveIndices(options.activeIndices ?? Uint32Array.of(DEFAULT_PROOF_INDEX));
  const nativeIndices = Uint32Array.from(activeIndices, contractIndexToNativeIndex);
  const transport = new NoaaTransport({ ...options });
  const sampler = new NoaaFieldSampler();
  const fields: DiagnoseGfsInputsReport['fields'] = [];
  const receipts = new Map<string, DecodedFieldReceipt>();
  let gridKey: string | undefined;
  const companions = gfsWindowNeedsCompanion(hour) ? gfsCompanionSpecs(hour) : [];
  try {
    for (const spec of [...gfsCurrentSpecs(hour), ...companions]) {
      options.signal?.throwIfAborted();
      try {
        const endHour = spec.role === 'companion' ? hour - 3 : hour;
        const url = gfsFileUrl(cycle, endHour, gfsProductName(spec.product));
        const index = await transport.index(`${url}.idx`, cycleStamp(cycle));
        const selection = await selectGfsRecord(transport, url, index, spec);
        const selected = selection.selected;
        const bytes = selection.bytes ?? await transport.field(url, selected.record);
        const inspected = inspectGfsField(bytes.bytes, {
          cycle, spec, expectedStartHour: spec.statistic === 'instant' ? endHour : gfsWindowStart(hour),
          expectedEndHour: endHour, expectedGridKey: gridKey,
        });
        gridKey ??= inspected.grid.gridKey;
        const sampled = await sampler.sample(inspected, nativeIndices);
        const receipt: DecodedFieldReceipt = {
          ...inspected.receipt, product: spec.product, productFile: gfsProductName(spec.product), url,
          idxLine: selected.line, idxLineNumber: selected.indexLine, asset: bytes.asset,
          ...(selection.duplicates ? { duplicates: selection.duplicates } : {}),
          decodedMissingCount: sampled.missingCount,
        };
        receipts.set(`${spec.role ?? 'current'}:${spec.key}`, receipt);
        fields.push({ spec, status: 'admitted', receipt, values: Array.from(sampled.values, (value, i) => sampled.missing[i] ? null : value), missing: Array.from(sampled.missing) });
      } catch (error) {
        options.signal?.throwIfAborted();
        const e = error instanceof Error ? error : new Error(String(error));
        fields.push({ spec, status: 'failed', error: { name: e.name, message: e.message, ...(e instanceof NoaaError ? { code: e.code, details: e.details } : {}) } });
      }
    }
  } finally {
    await sampler.close();
  }
  const pairs: DiagnoseGfsInputsReport['pairs'] = companions.map((spec) => {
    const current = receipts.get(`current:${spec.key}`);
    const previous = receipts.get(`companion:${spec.key}`);
    if (!current || !previous) return { key: spec.key, status: 'failed', error: 'Current or companion field was not admitted' };
    try {
      admitNoaaWindowPair(current, previous);
      return { key: spec.key, status: 'admitted' };
    } catch (error) {
      return { key: spec.key, status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  });
  const report: DiagnoseGfsInputsReport = {
    ok: fields.every((field) => field.status === 'admitted') && pairs.every((pair) => pair.status === 'admitted'),
    ticket: 'GFS-INPUT-DIAGNOSTIC', publicationEligible: false, cycle, hour,
    activeIndices: Array.from(activeIndices), nativeIndices: Array.from(nativeIndices),
    pressureLevelsHpa: GFS_PRESSURE_LEVELS_HPA, transport: { ...transport.stats }, fields, pairs,
  };
  (options.logger ?? ((line: string) => console.log(line)))(JSON.stringify(report, null, 2));
  return report;
}
