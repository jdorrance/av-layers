import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StationObservation, StationPredictionRow } from './evaluation-stations.js';
import {
  assertBuildComponentsUnchanged,
  loadFrozenObservationSource,
  pairedGateSummary,
  poolPredictionRows,
  resourceMaxRssBytes,
  temperatureGateBaseline,
  temperatureGateEvidence,
  runWithStagedPredictions,
  variantDefinitions,
  writeImmutableReport
} from './station-replay.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function observation(overrides: Partial<StationObservation> = {}): StationObservation {
  return {
    stationId: 'hydromet_am:1',
    lat: 40.5,
    lon: 44.5,
    elevationM: 2000,
    validAt: '2026-10-15T06:00:00.000Z',
    temperatureC: 8,
    precipitationState: 'dry',
    observationSource: 'ogimet-synop',
    ...overrides
  };
}

function row(overrides: Partial<StationPredictionRow> = {}): StationPredictionRow {
  return {
    variantId: 'candidate',
    observation: observation(),
    band: '>=200',
    hourUtc: 6,
    predictionC: 10,
    ...overrides
  };
}

function paired(count: number, uniqueStations: number, candidateBiasC: number, baselineBiasC: number) {
  return {
    count,
    uniqueStations,
    uniqueDays: 10,
    candidateBiasC,
    candidateMaeC: Math.abs(candidateBiasC),
    candidateRmseC: Math.abs(candidateBiasC),
    baselineBiasC,
    baselineMaeC: Math.abs(baselineBiasC),
    baselineRmseC: Math.abs(baselineBiasC),
    coldBiasReductionC: candidateBiasC - baselineBiasC
  };
}

describe('poolPredictionRows', () => {
  it('pools prediction errors directly and keeps exact station identities', () => {
    const rows = [
      row({ observation: observation({ stationId: 'hydromet_am:1', temperatureC: 8 }), predictionC: 10 }),
      row({ observation: observation({ stationId: 'hydromet_am:2', temperatureC: 8 }), predictionC: 6 }),
      row({ observation: observation({ stationId: 'hydromet_am:2', validAt: '2026-10-16T06:00:00.000Z', temperatureC: 8 }), predictionC: 10, band: '0..200' })
    ];
    const pooled = poolPredictionRows(rows);
    expect(pooled.count).toBe(3);
    expect(pooled.biasC).toBeCloseTo(2 / 3, 10);
    expect(pooled.maeC).toBeCloseTo(2, 10);
    expect(pooled.rmseC).toBeCloseTo(2, 10);
    expect(pooled.uniqueStations).toBe(2);
    expect(pooled.uniqueDays).toBe(2);
    expect(pooled.byYear).toEqual({ '2026': 3 });
    expect(poolPredictionRows([])).toEqual({ count: 0, biasC: null, maeC: null, rmseC: null, uniqueStations: 0, uniqueDays: 0, byYear: {} });
  });
});

describe('runWithStagedPredictions', () => {
  it('commits no rows from a frame whose later variant throws', () => {
    const target = new Map<string, StationPredictionRow[]>([['candidate', []], ['baseline', []]]);
    expect(() => runWithStagedPredictions(
      onPrediction => {
        onPrediction(row());
        onPrediction(row({ observation: observation({ validAt: '2026-10-15T09:00:00.000Z' }) }));
        throw new Error('later variant failed');
      },
      rows => { for (const prediction of rows) target.get(prediction.variantId)!.push(prediction); }
    )).toThrow('later variant failed');
    expect(target.get('candidate')).toHaveLength(0);
    expect(pairedGateSummary(target.get('candidate')!, [row({ variantId: 'baseline' })]).count).toBe(0);
  });
});

describe('pairedGateSummary', () => {
  it('uses only exact stationId and validAt pairs shared by candidate and baseline', () => {
    const candidate = [
      row({ predictionC: 10 }),
      row({ observation: observation({ validAt: '2026-10-16T06:00:00.000Z' }), predictionC: 10 }),
      row({ observation: observation({ stationId: 'hydromet_am:2' }), predictionC: 10 })
    ];
    const baseline = [
      row({ variantId: 'baseline', predictionC: 8 }),
      row({ variantId: 'baseline', observation: observation({ validAt: '2026-10-16T06:00:00.000Z' }), predictionC: 8 }),
      row({ variantId: 'baseline', observation: observation({ stationId: 'hydromet_am:3' }), predictionC: 8 })
    ];
    const pairedRows = pairedGateSummary(candidate, baseline);
    expect(pairedRows.count).toBe(2);
    expect(pairedRows.uniqueStations).toBe(1);
    expect(pairedRows.candidateBiasC).toBeCloseTo(2, 10);
    expect(pairedRows.candidateRmseC).toBeCloseTo(2, 10);
    expect(pairedRows.baselineBiasC).toBeCloseTo(0, 10);
    expect(pairedRows.baselineRmseC).toBeCloseTo(0, 10);
    expect(pairedRows.coldBiasReductionC).toBeCloseTo(2, 10);
  });

  it('does not borrow baseline counts when the candidate loses a whole frame', () => {
    const rowsFor = (days: number, variantId: string) => {
      const rows: StationPredictionRow[] = [];
      for (let day = 0; day < days; day++) {
        for (let hour = 0; hour < 4; hour++) {
          for (let station = 1; station <= 3; station++) {
            rows.push(row({
              variantId,
              observation: observation({ stationId: `hydromet_am:${station}`, validAt: `2026-10-${String(15 + day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z` }),
              predictionC: variantId === 'candidate' ? 10 : 8
            }));
          }
        }
      }
      return rows;
    };
    const pairedRows = pairedGateSummary(rowsFor(5, 'candidate'), rowsFor(10, 'baseline'));
    expect(pairedRows.count).toBe(60);
    expect(pairedRows.uniqueStations).toBe(3);
    expect(temperatureGateEvidence({ model: 'icon-eu', variant: 'icon-neutral-b1000', baseline: 'icon-uncorrected', paired: pairedRows }).reason).toContain('insufficient paired station-hours');
  });

  it('rejects duplicate candidate rows instead of double-counting pairs', () => {
    expect(() => pairedGateSummary(
      [row(), row()],
      [row({ variantId: 'baseline' })]
    )).toThrow('Duplicate paired candidate prediction');
  });

  it('excludes mismatched valid sets instead of pairing across times', () => {
    const pairedRows = pairedGateSummary(
      [row({ observation: observation({ validAt: '2026-10-15T06:00:00.000Z' }) })],
      [row({ variantId: 'baseline', observation: observation({ validAt: '2026-10-15T09:00:00.000Z' }) })]
    );
    expect(pairedRows.count).toBe(0);
    expect(pairedRows.candidateBiasC).toBeNull();
  });
});

describe('variantDefinitions', () => {
  it('registers every required ICON and GFS kernel variant plus baselines', () => {
    expect(variantDefinitions('icon-eu').map(variant => variant.id)).toEqual([
      'icon-neutral-b1000', 'icon-supported-clearance', 'icon-uncorrected', 'icon-dry-adiabatic'
    ]);
    expect(variantDefinitions('gfs').map(variant => variant.id)).toEqual([
      'gfs-neutral-b1000', 'gfs-supported-clearance', 'gfs-uncorrected', 'gfs-dry-adiabatic'
    ]);
  });
});

describe('temperature gate baseline metadata', () => {
  it('uses raw temperature comparators and truthful RSS bytes', () => {
    expect(temperatureGateBaseline('icon-eu')).toBe('icon-uncorrected');
    expect(temperatureGateBaseline('gfs')).toBe('gfs-uncorrected');
    for (const model of ['icon-eu', 'gfs'] as const) {
      const definitions = variantDefinitions(model);
      expect(definitions.find(variant => variant.id.endsWith('-neutral-b1000'))).toMatchObject({ kind: 'kernel', options: { bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000 } });
      expect(definitions.find(variant => variant.id.endsWith('-supported-clearance'))).toMatchObject({ clearance: true, options: { bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000, clearanceFallback: 'unsupported' } });
    }
    expect(resourceMaxRssBytes(1_558_688)).toBe(1_596_096_512);
  });
});

describe('temperatureGateEvidence', () => {
  it('stays inconclusive below paired station-hour and site thresholds', () => {
    const gate = temperatureGateEvidence({ model: 'icon-eu', variant: 'icon-neutral-b1000', baseline: 'icon-uncorrected', paired: paired(99, 4, -1, -2) });
    expect(gate.status).toBe('inconclusive');
    expect(gate.reason).toContain('insufficient paired station-hours or sites');
  });

  it('passes when the fixed MAE target is met without regression', () => {
    const gate = temperatureGateEvidence({ model: 'icon-eu', variant: 'icon-neutral-b1000', baseline: 'icon-uncorrected', paired: paired(120, 3, -1, -2) });
    expect(gate.coldBiasReductionC).toBeCloseTo(1, 10);
    expect(gate.status).toBe('pass');
    expect(gate.paired.count).toBe(120);
  });

  it('fails on target or regression for each model', () => {
    expect(temperatureGateEvidence({ model: 'icon-eu', variant: 'x', baseline: 'raw', paired: paired(120, 3, -1.5, -2) }).status).toBe('fail');
    expect(temperatureGateEvidence({ model: 'gfs', variant: 'x', baseline: 'raw', paired: paired(120, 3, -1.6, -2) }).status).toBe('pass');
    expect(temperatureGateEvidence({ model: 'gfs', variant: 'x', baseline: 'raw', paired: paired(120, 3, -1.6, -1) }).status).toBe('fail');
  });
});

describe('loadFrozenObservationSource', () => {
  it('hashes the named observation, receipt, raw CSV and inventory files separately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-station-source-')), directory = join(root, 'observations');
    roots.push(root);
    await mkdir(directory);
    const observationsBytes = Buffer.from(JSON.stringify([observation()]));
    const rawBytes = Buffer.from('raw synop bytes\n');
    const receipt = {
      sha256: sha(rawBytes),
      bytes: rawBytes.byteLength,
      start: '2026-10-15T00:00:00.000Z',
      endExclusive: '2026-10-25T00:00:00.000Z'
    };
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    const inventoryBytes = Buffer.from(JSON.stringify({ observationsSha256: sha(observationsBytes) }));
    await writeFile(join(directory, 'observations-weather.json'), observationsBytes);
    await writeFile(join(directory, 'ogimet-synop.csv'), rawBytes);
    await writeFile(join(directory, 'receipt.json'), receiptBytes);
    await writeFile(join(root, 'source-inventory.json'), inventoryBytes);
    const source = await loadFrozenObservationSource(join(directory, 'observations-weather.json'), { rawSha256: sha(rawBytes) });
    expect(source.sha256).toBe(sha(observationsBytes));
    expect(source.receiptFileSha256).toBe(sha(receiptBytes));
    expect(source.receiptRawSha256).toBe(sha(rawBytes));
    expect(source.rawSha256).toBe(sha(rawBytes));
    expect(source.inventoryFileSha256).toBe(sha(inventoryBytes));
    expect(source.inventoryObservationsSha256).toBe(sha(observationsBytes));
  });

  it('rejects receipt fields that do not describe the actual raw CSV bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-station-source-')), directory = join(root, 'observations');
    roots.push(root);
    await mkdir(directory);
    const observationsBytes = Buffer.from(JSON.stringify([observation()]));
    const rawBytes = Buffer.from('raw synop bytes\n');
    const receiptBytes = Buffer.from(JSON.stringify({ sha256: sha(rawBytes), bytes: rawBytes.byteLength + 1, start: '2026-10-15T00:00:00.000Z', endExclusive: '2026-10-25T00:00:00.000Z' }));
    await writeFile(join(directory, 'observations-weather.json'), observationsBytes);
    await writeFile(join(directory, 'ogimet-synop.csv'), rawBytes);
    await writeFile(join(directory, 'receipt.json'), receiptBytes);
    await expect(loadFrozenObservationSource(join(directory, 'observations-weather.json'), { rawSha256: sha(rawBytes) })).rejects.toThrow('Receipt byte count');
  });

  it.each([
    ['observations-weather.json', 16 * 1024 * 1024],
    ['receipt.json', 64 * 1024],
    ['ogimet-synop.csv', 4 * 1024 * 1024],
    ['../source-inventory.json', 4 * 1024 * 1024]
  ])('rejects oversized sparse %s before parsing or hashing', async (name, limit) => {
    const root = await mkdtemp(join(tmpdir(), 'av-station-source-')), directory = join(root, 'observations');
    roots.push(root);
    await mkdir(directory);
    const observationsBytes = Buffer.from(JSON.stringify([observation()]));
    const rawBytes = Buffer.from('raw synop bytes\n');
    await writeFile(join(directory, 'observations-weather.json'), observationsBytes);
    await writeFile(join(directory, 'ogimet-synop.csv'), rawBytes);
    await writeFile(join(directory, 'receipt.json'), JSON.stringify({ sha256: sha(rawBytes), bytes: rawBytes.byteLength, start: '2026-10-15T00:00:00.000Z', endExclusive: '2026-10-25T00:00:00.000Z' }));
    const file = await open(join(directory, name), 'w');
    try { await file.truncate(limit + 1); } finally { await file.close(); }
    await expect(loadFrozenObservationSource(join(directory, 'observations-weather.json'), { rawSha256: sha(rawBytes) })).rejects.toThrow('Local file exceeds byte budget');
  });
});

describe('source identity guard', () => {
  it('fails when only the thermodynamics index content changes the science component', () => {
    const components = { adapter: 'a', science: 'before', contracts: 'c', configuration: 'cfg' };
    expect(() => assertBuildComponentsUnchanged(components, { ...components, science: 'after' })).toThrow('Candidate science source changed during replay');
    expect(() => assertBuildComponentsUnchanged(components, { ...components, configuration: 'changed' })).not.toThrow();
  });
});

describe('writeImmutableReport', () => {
  it('writes once with a content hash and refuses overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-station-replay-')); roots.push(root);
    const path = join(root, 'report.json'), bytes = Buffer.from('{"status":"complete"}\n');
    const written = await writeImmutableReport(path, bytes);
    expect(written.path).toBe(path);
    expect(written.bytes).toBe(bytes.byteLength);
    expect(written.sha256).toBe(sha(bytes));
    expect(await readFile(path, 'utf8')).toBe(bytes.toString());
    await expect(writeImmutableReport(path, bytes)).rejects.toThrow('already exists');
  });
});
