import { describe, expect, it } from 'vitest';
import { coverageIndices, STATUS_OUTSIDE, TERRAIN_CLEARANCE_METHOD, type CoverageMask } from '@av/contracts';
import { deriveSelectedFrameDiagnostics } from '@av/forecast/frame';
import type { NormalizedFrame } from '@av/forecast/inputs';
import { prepareTerrainClearance, prepareTerrainColumns, type PreparedTerrainColumns, type TerrainColumnClearance, type TerrainColumnProbe } from '@av/forecast/refinement';
import {
  ELEVATION_OFFSET_BANDS,
  evaluateStations,
  parseStationObservations,
  prepareSparseFrameDiagnostics,
  type StationObservation,
  type StationVariant,
  type StationTarget,
  type StationPredictionRow
} from './evaluation-stations.js';
import { pairedGateSummary } from './station-replay.js';

const FRAME_TIME = '2026-10-15T01:00:00.000Z';
const GRID = {
  kind: 'regular-latlon' as const,
  width: 2,
  height: 2,
  earthRadiusM: 6371229,
  lon0: 0,
  lat0: 1,
  dx: 1,
  dy: -1,
  wrapLongitude: false
};

function frame(validAt = FRAME_TIME): NormalizedFrame {
  const missing = () => [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)];
  return {
    cycle: '2026-10-15T00:00:00.000Z',
    hour: 1,
    validAt,
    capturedAt: '2026-10-15T00:10:00.000Z',
    grid: GRID,
    activeIndices: Uint32Array.from([0, 1, 2, 3]),
    terrainM: Float32Array.from([1000, 2000, 500, 1500]),
    surfacePressurePa: Float32Array.from([90000, 80000, 95000, 85000]),
    temp2mK: Float32Array.from([283.15, 275.15, 280.15, 270.15]),
    specificHumidity2mKgKg: Float32Array.from([0.008, 0.006, 0.009, 0.007]),
    sensibleHeatFluxWm2: Float32Array.from([100, 120, 80, 90]),
    latentHeatFluxWm2: Float32Array.from([20, 30, 10, 15]),
    hgtM: [
      Float32Array.from([1000, 2000, 500, 1500]),
      Float32Array.from([1800, 2800, 1300, 2300]),
      Float32Array.from([3000, 4000, 2500, 3500])
    ],
    tempK: [
      Float32Array.from([283.15, 275.15, 280.15, 270.15]),
      Float32Array.from([278.15, 270.15, 275.15, 265.15]),
      Float32Array.from([268.15, 260.15, 265.15, 255.15])
    ],
    pressureLevelsHpa: [900, 800, 700],
    missing: {
      terrain: new Uint8Array(4),
      surfacePressure: new Uint8Array(4),
      temp2m: new Uint8Array(4),
      humidity2m: new Uint8Array(4),
      sensibleHeatFlux: new Uint8Array(4),
      latentHeatFlux: new Uint8Array(4),
      hgt: missing(),
      temp: missing()
    },
    intervals: {
      profileTime: '2026-10-15T00:00:00.000Z',
      fluxWindow: { start: '2026-10-15T00:00:00.000Z', end: '2026-10-15T01:00:00.000Z' },
      fluxSourceWindow: { start: '2026-10-15T00:00:00.000Z', end: '2026-10-15T01:00:00.000Z' },
      usedCompanion: false
    },
    receipt: {}
  };
}

function target(outputIndices: readonly number[], elevationM: readonly number[]): {
  mask: CoverageMask;
  terrain: { elevationM: Float32Array; valid: Uint8Array };
} {
  const output = new Uint8Array(1);
  for (const index of outputIndices) output[0] |= 1 << index;
  return {
    mask: { grid: GRID, bounds: [0, 0, 1, 1], output, halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0 },
    terrain: { elevationM: Float32Array.from(elevationM), valid: Uint8Array.of(1, 1, 1, 1) }
  };
}

function observation(overrides: Partial<StationObservation> = {}): StationObservation {
  return {
    stationId: 'hydromet_am:1',
    lat: 1,
    lon: 0,
    elevationM: 1000,
    validAt: FRAME_TIME,
    temperatureC: 8,
    precipitationState: 'dry',
    observationSource: 'ogimet-synop',
    ...overrides
  };
}

function fakeKernel(surfaceTemperatureK: number): PreparedTerrainColumns {
  return {
    byteLength: 0,
    workspaceBytes: 0,
    workspaceBufferBytes: 0,
    workspaceObjectBudgetBytes: 0,
    daylightBufferBytes: 0,
    derive: () => ({
      fields: {
        'usable-lift-msl': { values: new Float32Array(1), flags: new Uint8Array(1) },
        'usable-lift-agl': { values: new Float32Array(1), flags: new Uint8Array(1) }
      },
      metrics: {
        outside: 0, dark: 0, invalidDem: 0, missingDonor: 0, invalidDonorInput: 0, unsupportedHeight: 0,
        belowGroundBridgeExceeded: 0, invalidSurfaceState: 0, solverRejected: 0, valid: 0, noLift: 0,
        belowGroundBridge: 0, profileTop: 0
      },
      daylightBufferBytes: 0,
      probes: [{
        index: 0, donorIndices: [], donorWeights: [], terrainM: 0, referenceTerrainM: null,
        surfaceTemperatureK, groundEnvironmentK: null, surfaceExcessK: null,
        donorGroundEnvironmentK: [], donorSurfaceExcessK: [], donorGroundWeights: [], surfacePressurePa: null,
        humidityKgKg: null, sensibleHeatFluxWm2: null, latentHeatFluxWm2: null, branch: null,
        depthM: null, msl: null, agl: null, reason: null, provenance: 'column'
      }]
    })
  };
}

function candidate(surfaceTemperatureK: (target: { latitude: number; longitude: number }) => number): StationVariant {
  return {
    id: 'candidate',
    prepare: targetValue => fakeKernel(surfaceTemperatureK(targetValue))
  };
}

function replay(options: {
  observations: readonly StationObservation[];
  variants?: readonly StationVariant[];
  frame?: NormalizedFrame;
  target?: ReturnType<typeof target>;
}) {
  const patch = options.target ?? target([0, 1], [1000, 2400, 0, 0]);
  return evaluateStations({
    frame: options.frame ?? frame(),
    sourceMask: { grid: GRID, bounds: [0, 0, 1, 1], output: Uint8Array.of(15), halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0 },
    targetMask: patch.mask,
    terrain: patch.terrain,
    observations: options.observations,
    variants: options.variants ?? [{ id: 'uncorrected', temperature: 'uncorrected' }],
    maxLevels: 3
  });
}

describe('parseStationObservations', () => {
  it('parses bounded valid records and rejects duplicate station timestamps', () => {
    const bytes = new TextEncoder().encode(JSON.stringify([observation()]));
    expect(parseStationObservations(bytes)).toHaveLength(1);
    const duplicate = new TextEncoder().encode(JSON.stringify([observation(), observation()]));
    expect(() => parseStationObservations(duplicate)).toThrow('Duplicate station observation');
  });

  it('rejects invalid records, Kelvin temperatures and row budget overflow', () => {
    for (const invalid of [
      observation({ temperatureC: 280 }),
      observation({ precipitationState: 'snow' as never }),
      observation({ validAt: '2026-10-15T01:00:00' }),
      observation({ stationId: 'not-a-station' })
    ]) {
      expect(() => parseStationObservations(new TextEncoder().encode(JSON.stringify([invalid])))).toThrow();
    }
    expect(() => parseStationObservations(new TextEncoder().encode(JSON.stringify([observation(), observation({ stationId: 'hydromet_am:2' })])), { maxRows: 1 })).toThrow('row budget');
  });
});

describe('evaluateStations', () => {
  it('returns null empty metrics without fabricating counts', () => {
    const result = replay({ observations: [] });
    expect(result.counts.observations).toBe(0);
    expect(result.variants[0]!.gate).toEqual({ count: 0, biasC: null, maeC: null, rmseC: null, uniqueStations: 0, uniqueDays: 0 });
    expect(result.variants[0]!.byHourUtc).toHaveLength(24);
    expect(result.variants[0]!.byHourUtc.every(metrics => metrics.count === 0 && metrics.biasC === null)).toBe(true);
    for (const band of ELEVATION_OFFSET_BANDS) expect(result.variants[0]!.byElevationOffset[band].count).toBe(0);
  });

  it('excludes unknown and rainy precipitation from the gate while retaining diagnostics', () => {
    const result = replay({
      observations: [
        observation({ stationId: 'hydromet_am:1' }),
        observation({ stationId: 'hydromet_am:2', precipitationState: 'unknown' }),
        observation({ stationId: 'hydromet_am:3', precipitationState: 'wet' })
      ],
      variants: [candidate(() => 283.15)]
    });
    expect(result.counts.gateEligible).toBe(1);
    expect(result.counts.unknownPrecipitation).toBe(1);
    expect(result.counts.rainy).toBe(1);
    expect(result.exclusions.precipitationUnknown).toBe(1);
    expect(result.exclusions.rainy).toBe(1);
    expect(result.variants[0]!.gate.count).toBe(1);
    expect(result.variants[0]!.diagnostic.count).toBe(3);
  });

  it('rejects ClimateNet metadata elevations against the target DEM', () => {
    const result = replay({
      observations: [
        observation({ stationId: 'climatenet:11', lat: 1, lon: 0, elevationM: 2648 }),
        observation({ stationId: 'climatenet:30', lat: 1, lon: 1, elevationM: 2071 })
      ],
      target: target([0, 1], [1851, 733, 0, 0])
    });
    expect(result.counts.demAvailable).toBe(2);
    expect(result.counts.elevationAccepted).toBe(0);
    expect(result.exclusions.elevationMismatch).toBe(2);
    expect(result.variants[0]!.gate.count).toBe(0);
  });

  it('matches only the frame timestamp and excludes points outside target geometry', () => {
    const result = replay({
      observations: [
        observation({ stationId: 'hydromet_am:1' }),
        observation({ stationId: 'hydromet_am:2', validAt: '2026-10-15T02:00:00.000Z' }),
        observation({ stationId: 'hydromet_am:3', lat: 0, lon: 2 })
      ]
    });
    expect(result.counts.exactTime).toBe(2);
    expect(result.exclusions.timeMismatch).toBe(1);
    expect(result.counts.inTarget).toBe(1);
    expect(result.exclusions.outsideTarget).toBe(1);
    expect(result.counts.gateEligible).toBe(1);
  });

  it('uses prediction minus observation for bias, MAE and RMSE', () => {
    const result = replay({
      observations: [
        observation({ stationId: 'hydromet_am:1', lon: 0 }),
        observation({ stationId: 'hydromet_am:2', lon: 1, elevationM: 2400 })
      ],
      variants: [candidate(value => value.longitude === 0 ? 283.15 : 279.15)]
    });
    const gate = result.variants[0]!.gate;
    expect(gate.count).toBe(2);
    expect(gate.biasC).toBeCloseTo(0, 6);
    expect(gate.maeC).toBeCloseTo(2, 6);
    expect(gate.rmseC).toBeCloseTo(2, 6);
    expect(gate.uniqueStations).toBe(2);
    expect(gate.uniqueDays).toBe(1);
  });

  it('rejects Celsius-valued kernel probes and does not mix Kelvin into observations', () => {
    const result = replay({
      observations: [observation()],
      variants: [candidate(() => 10)]
    });
    expect(result.variants[0]!.exclusions.invalidProbe).toBe(1);
    expect(result.variants[0]!.gate.count).toBe(0);
    expect(() => parseStationObservations(new TextEncoder().encode(JSON.stringify([observation({ temperatureC: 280 })])))).toThrow();
  });

  it('classifies native elevation offsets into declared bands and UTC hours', () => {
    const result = replay({
      observations: [
        observation({ stationId: 'hydromet_am:1', lon: 0, elevationM: 1000 }),
        observation({ stationId: 'hydromet_am:2', lon: 1, elevationM: 2400 })
      ],
      variants: [candidate(() => 283.15)]
    });
    expect(result.variants[0]!.byElevationOffset['-100..0'].count).toBe(1);
    expect(result.variants[0]!.byElevationOffset['>=200'].count).toBe(1);
    expect(result.variants[0]!.byHourUtc[1]!.count).toBe(2);
    expect(result.variants[0]!.byHourUtc[2]!.count).toBe(0);
  });

  it('compares uncorrected and dry-adiabatic variants without kernel probes', () => {
    const result = replay({
      observations: [
        observation({ stationId: 'hydromet_am:1', lon: 0, elevationM: 1000 }),
        observation({ stationId: 'hydromet_am:2', lon: 1, elevationM: 2400 })
      ],
      variants: [
        { id: 'uncorrected', temperature: 'uncorrected' },
        { id: 'dry-adiabatic', temperature: 'dry-adiabatic' }
      ]
    });
    expect(result.variants[0]!.gate.count).toBe(2);
    expect(result.variants[0]!.gate.biasC).toBeCloseTo(-2, 4);
    expect(result.variants[1]!.gate.count).toBe(2);
    expect(result.variants[1]!.gate.biasC).toBeCloseTo(-3.96, 4);
  });

  it('derives only selected source nodes, with native-grid buffer parity', () => {
    const source = target([0, 1, 2, 3], [1000, 2000, 500, 1500]).mask;
    const station: StationTarget = {
      latitude: 1, longitude: 0, stationElevationM: 1000, demElevationM: 1000,
      mask: { ...source, grid: { ...GRID, width: 1, height: 1 }, output: Uint8Array.of(1) },
      terrain: { elevationM: Float32Array.of(1000), valid: Uint8Array.of(1) }
    };
    const input = frame();
    const sparse = prepareSparseFrameDiagnostics(input, source, [station]);
    const reference = deriveSelectedFrameDiagnostics(input, Uint32Array.of(0, 1, 2, 3));
    expect([...sparse.sourceIndices]).toEqual([0]);
    expect(sparse.bufferBytes).toBe(40);
    expect(sparse.flags[0]).toBe(reference.flags[0]);
    expect(sparse.diagnostics.ceilingMslM[0]).toBe(reference.diagnostics.ceilingMslM[0]);
    expect(sparse.diagnostics.buoyancyM2S3[0]).toBe(reference.diagnostics.buoyancyM2S3[0]);
    expect(sparse.diagnostics.branch[0]).toBe(reference.diagnostics.branch[0]);
    expect(sparse.flags[1]).toBe(STATUS_OUTSIDE);
  });

  it('passes canonical clearance derived at the Float32 station height and excludes fallback temperatures', () => {
    const input = frame();
    const elevationM = 1000.123456;
    let seen: TerrainColumnClearance | undefined;
    let stationTarget: StationTarget | undefined;
    const variants: StationVariant[] = [{ id: 'fallback', clearance: true, prepare: targetValue => {
      stationTarget = targetValue;
      const base = fakeKernel(283.15);
      return { ...base, derive: (f, terrain, time, options) => {
        seen = options?.clearance;
        expect(terrain.elevationM[0]).toBe(Math.fround(elevationM));
        const result = base.derive(f, terrain, time, options);
        return { ...result, probes: result.probes.map(probe => ({ ...probe, provenance: 'clearance' as const, surfaceTemperatureK: null })) };
      } };
    } }];
    const result = replay({ frame: input, observations: [observation({ elevationM })], variants });
    expect(seen).toMatchObject({ methodId: TERRAIN_CLEARANCE_METHOD.id, validTime: FRAME_TIME, grid: stationTarget!.mask.grid });
    const source = target([0, 1, 2, 3], [1000, 2000, 500, 1500]).mask;
    const sparse = prepareSparseFrameDiagnostics(input, source, [stationTarget!]);
    const expected = prepareTerrainClearance(source, stationTarget!.mask).derive(sparse.diagnostics, sparse.flags, stationTarget!.terrain,
      { intervalStart: input.intervals.profileTime, validTime: input.validAt }, false);
    expect(seen!.fields).toEqual(expected);
    expect(result.memory).toEqual({ sparseDiagnosticsBufferBytes: 40, sparseDonorIndices: 1, sparseIndexBufferBytes: 4, clearanceMappingBytes: 53 });
    expect(result.variants[0]!.exclusions.temperatureMissing).toBe(1);
    expect(result.variants[0]!.gate.count).toBe(0);
  });

  it('counts a null temperature even when clearance is unavailable', () => {
    const base = fakeKernel(283.15);
    const result = replay({ observations: [observation()], variants: [{ id: 'missing', prepare: () => ({
      ...base, derive: (f, terrain, time, options) => {
        const derived = base.derive(f, terrain, time, options);
        return { ...derived, probes: derived.probes.map(probe => ({ ...probe, provenance: null, surfaceTemperatureK: null })) };
      }
    }) }] });
    expect(result.variants[0]!.exclusions.temperatureMissing).toBe(1);
    expect(result.variants[0]!.diagnostic.count).toBe(0);
  });

  it.each([
    { provenance: null, reason: null },
    { provenance: 'column' as const, reason: 'solverRejected' }
  ])('rejects finite temperatures without a successful column: %o', state => {
    const base = fakeKernel(283.15);
    const result = replay({ observations: [observation()], variants: [{ id: 'candidate', prepare: () => ({
      ...base, derive: (f, terrain, time, options) => {
        const derived = base.derive(f, terrain, time, options);
        return { ...derived, probes: derived.probes.map(probe => ({ ...probe, ...state })) };
      }
    }) }] });
    expect(result.variants[0]!.exclusions.invalidProbe).toBe(1);
    expect(result.variants[0]!.gate.count).toBe(0);
  });

  it.each([false, true])('runs real unsupported-height clearance with missing native flux: %s', missing => {
    const input = frame();
    input.terrainM[0] = 2000;
    input.surfacePressurePa[0] = 90000;
    input.hgtM[0]![0] = 2400;
    input.hgtM[1]![0] = 3000;
    input.hgtM[2]![0] = 4000;
    input.missing.sensibleHeatFlux[0] = missing ? 1 : 0;
    const source = target([0, 1, 2, 3], [0, 0, 0, 0]).mask;
    let probe: TerrainColumnProbe | undefined;
    const result = evaluateStations({ frame: input, sourceMask: source, targetMask: target([0], [500, 0, 0, 0]).mask,
      terrain: target([0], [500, 0, 0, 0]).terrain, observations: [observation({ elevationM: 500 })], maxLevels: 3,
      variants: [{ id: 'supported', clearance: true, prepare: station => prepareTerrainColumns(source, station.mask,
        coverageIndices(source).active, 3, { bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000, clearanceFallback: 'unsupported' }) }],
      onProbe: (_id, _observation, value) => { probe = value; } });
    expect(probe!.surfaceTemperatureK).toBeNull();
    expect(probe!.provenance).toBe(missing ? null : 'clearance');
    expect(result.variants[0]!.exclusions.temperatureMissing).toBe(1);
    expect(result.variants[0]!.diagnostic.count).toBe(0);
  });

  it('does not pair finite temperatures from a real rejected column', () => {
    const input = frame();
    input.surfacePressurePa[0] = 90000;
    input.temp2mK[0] = 273.15 + 59;
    input.specificHumidity2mKgKg[0] = 0.005;
    input.sensibleHeatFluxWm2[0] = 200;
    input.latentHeatFluxWm2[0] = 0;
    input.pressureLevelsHpa = [850, 800, 750, 700, 650];
    input.hgtM = [1500, 2000, 2500, 3000, 3500].map(height => Float32Array.of(height, 2000, 500, 1500));
    input.tempK = [16, 13, 10, 7, 4].map(temperature => Float32Array.of(temperature + 273.15, 275, 280, 270));
    input.missing.hgt = input.hgtM.map(() => new Uint8Array(4));
    input.missing.temp = input.tempK.map(() => new Uint8Array(4));
    const source = target([0, 1, 2, 3], [0, 0, 0, 0]).mask;
    const patch = target([0], [100, 0, 0, 0]);
    const rows: StationPredictionRow[] = [];
    let probe: TerrainColumnProbe | undefined;
    const result = evaluateStations({ frame: input, sourceMask: source, targetMask: patch.mask, terrain: patch.terrain,
      observations: [observation({ elevationM: 100 })], maxLevels: 5,
      variants: [
        { id: 'candidate', clearance: true, prepare: station => prepareTerrainColumns(source, station.mask,
          coverageIndices(source).active, 5, { clearanceFallback: 'unsupported' }) },
        { id: 'raw', temperature: 'uncorrected' }
      ],
      onPrediction: value => rows.push(value), onProbe: (_id, _observation, value) => { probe = value; } });
    expect(probe).toMatchObject({ provenance: null, reason: 'solverRejected' });
    expect(probe!.surfaceTemperatureK!).toBeGreaterThan(333.15);
    expect(probe!.surfaceTemperatureK!).toBeLessThan(350);
    expect(result.variants[0]!.exclusions.invalidProbe).toBe(1);
    expect(result.variants[0]!.gate.count).toBe(0);
    expect(rows.map(row => row.variantId)).toEqual(['raw']);
    expect(pairedGateSummary(rows.filter(row => row.variantId === 'candidate'), rows.filter(row => row.variantId === 'raw')).count).toBe(0);
  });

  it('retains a successful real no-lift column temperature', () => {
    const input = frame();
    input.sensibleHeatFluxWm2[0] = 0;
    input.latentHeatFluxWm2[0] = 0;
    input.temp2mK[0] = 293.15;
    input.specificHumidity2mKgKg[0] = 0.005;
    input.pressureLevelsHpa = [850, 800, 750];
    for (let i = 0; i < 3; i++) {
      input.hgtM[i]![0] = 1500 + 500 * i;
      input.tempK[i]![0] = 289.15 - 3 * i;
    }
    const source = target([0, 1, 2, 3], [0, 0, 0, 0]).mask;
    const patch = target([0], [1000, 0, 0, 0]);
    let probe: TerrainColumnProbe | undefined;
    const result = evaluateStations({ frame: input, sourceMask: source, targetMask: patch.mask, terrain: patch.terrain,
      observations: [observation()], maxLevels: 3,
      variants: [{ id: 'column', prepare: station => prepareTerrainColumns(source, station.mask, coverageIndices(source).active, 3) }],
      onProbe: (_id, _observation, value) => { probe = value; } });
    expect(probe).toMatchObject({ provenance: 'column', reason: null, agl: 0 });
    expect(result.variants[0]!.gate.count).toBe(1);
  });
});
