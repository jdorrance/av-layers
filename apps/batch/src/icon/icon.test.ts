import { describe, expect, it } from 'vitest';
import fixture from './fixtures/icon-armenia-extract.json';
import {
  ICON_ARMENIA_BBOX,
  ICON_ARMENIA_EXPORT_GRID,
  ICON_ARMENIA_MAX_CELLS,
  ICON_ARMENIA_INTERVAL_HOURS,
  ICON_HALF_LEVELS,
  ICON_LEVEL_NUMBERS_ASCENDING,
  ICON_LEVELS,
  ICON_REQUIRED_FIELDS,
  discoverIconArmeniaRun,
  iconWindowMeanUpwardFlux,
  iconWindowPrecipitationRate,
  IconAdapterError,
  buildIconExportMapping,
  buildIconNativeGeometry,
  mapFrameToExport,
  normalizeIconExtract,
} from './index.ts';
import type { IconFieldMetadata, IconRecord } from './types.ts';

interface TestRecord {
  field: string;
  hour: number;
  level: number | null;
  metadata: IconFieldMetadata;
  values: (number | null)[];
  source?: unknown;
}
interface TestExtract {
  model: string;
  referenceTime: string;
  levels: number[];
  forecastHours: number[];
  intervalHours: number;
  bbox: { west: number; south: number; east: number; north: number };
  grid: { type: string; uuid: string; number: number; pointCount: number };
  cells: { index: number; id: string; latitude: number; longitude: number; terrainM: number }[];
  records: Record<string, TestRecord>;
  provenance: { provider: string; accessProduct: string; attribution: string; capturedAt: string };
}

const load = (): TestExtract => structuredClone(fixture) as unknown as TestExtract;
const asRecords = (extract: TestExtract): Record<string, IconRecord> => extract.records as unknown as Record<string, IconRecord>;
const mutable = (record: IconRecord): IconRecord & { values: (number | null)[] } => structuredClone(record) as unknown as IconRecord & { values: (number | null)[] };

describe('ICON Armenia stripped field contract', () => {
  it('admits only the stripped native field list', () => {
    expect(ICON_REQUIRED_FIELDS).toEqual(['CLAT', 'CLON', 'HSURF', 'HHL', 'T_2M', 'TD_2M', 'PS', 'MH', 'ASHFL_S', 'ALHFL_S', 'TOT_PREC', 'P', 'T']);
    for (const field of ['U_10M', 'V_10M', 'CLCT', 'PMSL', 'VMAX_10M', 'CAPE_ML', 'CIN_ML', 'CLCL', 'CLCM', 'CLCH', 'QV', 'U', 'V']) {
      expect(ICON_REQUIRED_FIELDS).not.toContain(field);
    }
    const fields = new Set(Object.values(load().records).map((record) => record.field));
    for (const field of ICON_REQUIRED_FIELDS) expect(fields.has(field)).toBe(true);
  });

  it('rejects a record outside the admitted field list', () => {
    const extract = load();
    extract.records['U_10M:3:None'] = {
      field: 'U_10M', hour: 3, level: null,
      metadata: { shortName: '10u', units: 'm s**-1', stepType: 'instant', startHour: 3, endHour: 3 },
      values: [1, 2, 3],
    };
    expect(() => normalizeIconExtract(extract)).toThrow(/not in the stripped required-field list/);
  });
});

describe('ICON native geometry', () => {
  it('validates cap heights, terrain and export spacing', () => {
    const acquisition = normalizeIconExtract(load());
    expect(acquisition.native.cells).toHaveLength(3);
    expect(acquisition.native.levelNumbers).toEqual(ICON_LEVEL_NUMBERS_ASCENDING);
    expect(acquisition.native.levelNumbers[0]).toBe(74);
    expect(acquisition.native.levelNumbers.at(-1)).toBe(45);
    for (let cell = 0; cell < acquisition.native.cells.length; cell++) {
      let previous = acquisition.native.cells[cell].terrainM;
      for (let k = 0; k < ICON_LEVELS.length; k++) {
        const height = acquisition.native.levelHeightsM[cell * ICON_LEVELS.length + k];
        expect(height).toBeGreaterThan(previous);
        previous = height;
      }
    }
    expect(acquisition.receipt.native.selectedCount).toBe(3);
    expect(acquisition.receipt.export.width).toBe(ICON_ARMENIA_EXPORT_GRID.width);
    expect(acquisition.receipt.export.spacingDeg).toBe(0.0625);
    expect(acquisition.receipt.native.spacingDegEstimate).toBeGreaterThan(0);
    expect(acquisition.receipt.gating.regionalPublication).toBe('gated');
    expect(acquisition.receipt.attribution.reuse.notMIT).toBe(true);
    expect(acquisition.receipt.attribution.reuse.publicLicense).toBeNull();
  });

  it('rejects inverted half-level heights', () => {
    const extract = load();
    extract.records['HHL:0:50'].values[0] = extract.records['HHL:0:51'].values[0];
    expect(() => normalizeIconExtract(extract)).toThrow(/not strictly descending/);
  });

  it('rejects a bottom interface that differs from model terrain', () => {
    const extract = load();
    extract.records['HHL:0:75'].values[1] = (extract.records['HHL:0:75'].values[1] ?? 0) + 100;
    expect(() => normalizeIconExtract(extract)).toThrow(/bottom interface differs/);
  });

  it('rejects malformed native coordinates', () => {
    const extract = load();
    extract.cells[0].latitude = 200;
    expect(() => normalizeIconExtract(extract)).toThrow(/outside valid ranges/);
  });

  it('rejects a selection above the admitted cell cap', () => {
    const extract = load();
    extract.grid.pointCount = ICON_ARMENIA_MAX_CELLS + 1;
    for (const record of Object.values(extract.records)) record.metadata.numberOfDataPoints = extract.grid.pointCount;
    extract.cells = Array.from({ length: ICON_ARMENIA_MAX_CELLS + 1 }, (_, index) => ({ index, id: `cell-${index}`, latitude: 40, longitude: 45, terrainM: 1000 }));
    expect(() => normalizeIconExtract(extract)).toThrow(/exceeds the admitted cap/);
  });
});

describe('ICON initialization means and accumulation', () => {
  it('differences exact windows and preserves physical cooling', () => {
    const records = asRecords(load());
    expect(iconWindowMeanUpwardFlux(records['ASHFL_S:3:None'], undefined, 0, 3, 0)).toBe(-300);
    expect(iconWindowMeanUpwardFlux(records['ASHFL_S:6:None'], records['ASHFL_S:3:None'], 3, 6, 0)).toBe(-100);
    expect(iconWindowMeanUpwardFlux(records['ALHFL_S:6:None'], records['ALHFL_S:3:None'], 3, 6, 0)).toBe(0);
  });

  it('rejects mismatched starts, ends and units', () => {
    const records = asRecords(load());
    const current = structuredClone(records['ASHFL_S:6:None']);
    current.metadata.startHour = 3;
    expect(() => iconWindowMeanUpwardFlux(current, records['ASHFL_S:3:None'], 3, 6, 0)).toThrow(/initialization mean/);
    const wrongEnd = structuredClone(records['ASHFL_S:6:None']);
    wrongEnd.metadata.endHour = 9;
    expect(() => iconWindowMeanUpwardFlux(wrongEnd, records['ASHFL_S:3:None'], 3, 6, 0)).toThrow(/initialization mean/);
    const wrongUnits = structuredClone(records['ASHFL_S:6:None']);
    wrongUnits.metadata.units = 'J m**-2';
    expect(() => iconWindowMeanUpwardFlux(wrongUnits, records['ASHFL_S:3:None'], 3, 6, 0)).toThrow(/run-mean/);
  });

  it('converts initialization accumulation to an exact interval rate', () => {
    const records = asRecords(load());
    expect(iconWindowPrecipitationRate(records['TOT_PREC:3:None'], undefined, 0, 3, 0)).toEqual({ mm: 1.5, mmPerHour: 0.5 });
    const window = iconWindowPrecipitationRate(records['TOT_PREC:6:None'], records['TOT_PREC:3:None'], 3, 6, 0);
    expect(window?.mm).toBeCloseTo(2.5, 10);
    expect(window?.mmPerHour).toBeCloseTo(2.5 / 3, 10);
  });

  it('clamps quantization noise only within packing tolerance and rejects larger resets', () => {
    const records = asRecords(load());
    const current = mutable(records['TOT_PREC:6:None']);
    const previous = mutable(records['TOT_PREC:3:None']);
    current.values[0] = 1.4999999995;
    previous.values[0] = 1.5;
    expect(iconWindowPrecipitationRate(current, previous, 3, 6, 0)?.mm).toBe(0);
    const reset = mutable(current);
    reset.values[0] = 1;
    expect(() => iconWindowPrecipitationRate(reset, previous, 3, 6, 0)).toThrow(/beyond packing tolerance/);
  });
});

describe('ICON normalized frames', () => {
  it('normalizes surface state, flux sign, rain and 3D levels', () => {
    const acquisition = normalizeIconExtract(load());
    expect(acquisition.forecastHours).toEqual([3, 6]);
    expect(acquisition.intervalHours).toBe(ICON_ARMENIA_INTERVAL_HOURS);
    const first = acquisition.frames[0];
    const second = acquisition.frames[1];
    expect(first.validAt).toBe('2026-10-30T03:00:00Z');
    expect(first.intervals.flux.start).toBe('2026-10-30T00:00:00Z');
    expect(first.intervals.flux.end).toBe('2026-10-30T03:00:00Z');
    expect(first.temp2mK[0]).toBeCloseTo(293.15, 3);
    expect(first.dewPoint2mK[0]).toBeCloseTo(283.15, 3);
    expect(first.sensibleHeatFluxWm2[0]).toBe(-300);
    expect(second.sensibleHeatFluxWm2[0]).toBe(-100);
    expect(second.latentHeatFluxWm2[0]).toBe(0);
    expect(first.precipitationMmPerHour[0]).toBeCloseTo(0.5, 6);
    expect(second.precipitationMmPerHour[0]).toBeCloseTo(2.5 / 3, 6);
    expect(first.levelPressurePa).toHaveLength(3 * ICON_LEVELS.length);
    expect(second.levelTemperatureK[0]).toBeCloseTo(288.15 - 0.0065 * ((75 - 74 - 0.5) * 500) + 1, 3);
    expect(first.missing.sensible.every((value) => value === 0)).toBe(true);
    expect(acquisition.receipt.provenance).toMatchObject({ sourceSynthetic: true, publicationReady: false });
    expect(acquisition.receipt.gating.publicationReady).toBe(false);
    expect(first.receipt).toMatchObject({ sourceSynthetic: true, publicationReady: false });
    expect(acquisition.receipt.attribution.data.provider).toBe('synthetic fixture');
    expect(acquisition.receipt.fields.every((field) => field.asset?.sourceKind === 'fixture' && field.asset.url.startsWith('fixture://') && field.asset.sha256 === null)).toBe(true);
  });

  it('rejects average endpoints and mismatched field, grid, run or level identities', () => {
    for (const key of ['T_2M:3:None', 'TD_2M:3:None', 'PS:3:None', 'MH:3:None', 'T:3:74', 'P:3:74', 'HHL:0:74']) {
      const extract = load();
      extract.records[key].metadata.stepType = 'avg';
      expect(() => normalizeIconExtract(extract)).toThrow(/instantaneous endpoint/);
    }
    for (const [key, property, value] of [
      ['T:3:74', 'startHour', 0], ['T:3:74', 'shortName', 'pres'],
      ['P:3:74', 'uuidOfHGrid', 'other'], ['T:3:74', 'validityTime', 600],
      ['P:3:74', 'scaledValueOfFirstFixedSurface', 73],
    ] as const) {
      const extract = load();
      Object.assign(extract.records[key].metadata, { [property]: value });
      expect(() => normalizeIconExtract(extract)).toThrow(/identity|instantaneous endpoint|native level mismatch/);
    }
  });

  it('rejects synthetic provenance mixed with source-like assets', () => {
    const extract = load();
    extract.records['T:3:74'].source = { sourceKind: 'source', url: 'https://opendata.dwd.de/fake', sha256: 'a'.repeat(64), bytes: 1 };
    expect(() => normalizeIconExtract(extract)).toThrow(/synthetic provenance disagree/);
    const invalid = load();
    invalid.records['T:3:74'].source = { sourceKind: 'fixture', url: 'https://opendata.dwd.de/fake', sha256: null, bytes: null, range: null, lastModified: null };
    expect(() => normalizeIconExtract(invalid)).toThrow(/Invalid synthetic/);
  });

  it('rejects missing required fields and unphysical dewpoint', () => {
    const missing = load();
    delete missing.records['T:3:74'];
    expect(() => normalizeIconExtract(missing)).toThrow(/required field T at hour 3 level 74/);
    const dewpoint = load();
    dewpoint.records['TD_2M:3:None'].values[0] = 310;
    expect(() => normalizeIconExtract(dewpoint)).toThrow(/TD_2M exceeds T_2M/);
  });

  it('keeps native and export spacing receipt values explicit', () => {
    const acquisition = normalizeIconExtract(load());
    expect(acquisition.mapping.policy).toBe('nearest-native');
    expect(acquisition.mapping.activeIndices.length).toBeGreaterThan(0);
    expect(acquisition.mapping.activeIndices.length).toBe(acquisition.mapping.nativeForExport.length);
    for (let i = 0; i < acquisition.mapping.activeIndices.length; i++) {
      expect(acquisition.mapping.distanceDeg[i]).toBeLessThanOrEqual(acquisition.mapping.maxDistanceDeg);
      expect(acquisition.mapping.nativeForExport[i]).toBeLessThan(acquisition.native.cells.length);
    }
    expect(acquisition.receipt.mapping.spacingRatio).toBeCloseTo(0.0625 / acquisition.receipt.native.spacingDegEstimate, 10);
  });

  it('maps native frame values to export cells without inventing data', () => {
    const acquisition = normalizeIconExtract(load());
    const exported = mapFrameToExport(acquisition.frames[0], acquisition.mapping, acquisition.native.levelHeightsM);
    expect(exported.activeIndices).toBe(acquisition.mapping.activeIndices);
    expect(exported.terrainM).toHaveLength(acquisition.mapping.activeIndices.length);
    for (let position = 0; position < exported.terrainM.length; position++) {
      const source = acquisition.mapping.nativeForExport[position];
      expect(exported.terrainM[position]).toBe(acquisition.frames[0].terrainM[source]);
      expect(exported.sensibleHeatFluxWm2[position]).toBe(acquisition.frames[0].sensibleHeatFluxWm2[source]);
    }
  });
});

describe('ICON export mapping policy', () => {
  it('chooses the lower native position on an exact tie', () => {
    const cells = [
      { index: 10, id: 'a', latitude: 40, longitude: 45, terrainM: 1000 },
      { index: 11, id: 'b', latitude: 40, longitude: 45.0625, terrainM: 1000 },
    ];
    const mapping = buildIconExportMapping(cells, { width: 3, height: 1, lon0: 45, lat0: 40, dx: 0.03125, dy: 1, wrapLongitude: false });
    expect(mapping.nativeForExport[1]).toBe(0);
    expect(mapping.nativeForExport[2]).toBe(1);
  });

  it('rejects an export grid that is not covered by admitted native cells', () => {
    const cells = [{ index: 1, id: 'a', latitude: 10, longitude: 10, terrainM: 100 }];
    expect(() => buildIconExportMapping(cells, { width: 2, height: 2, lon0: 40, lat0: 40, dx: 1, dy: 1, wrapLongitude: false })).toThrow(/do not cover/);
  });
});

describe('ICON discovery', () => {
  it('selects the newest complete main run from inventory probes', async () => {
    const inventory = '<a href="2026-10-30T00%3A00/">run</a><a href="2026-10-29T18%3A00/">run</a><a href="2026-10-29T13%3A00/">run</a>';
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('HSURF/r/')) return new Response(inventory, { status: 200 });
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const discovered = await discoverIconArmeniaRun({ now: new Date('2026-10-30T02:00:00Z'), fetchFn, lastForecastHour: 24 });
    expect(discovered.referenceTime).toBe('2026-10-30T00:00:00Z');
    expect(discovered.forecastHours).toEqual([3, 6, 9, 12, 15, 18, 21, 24]);
    expect(discovered.status).toBe('asset-heads-only');
    expect(discovered.completionUrls).toContain('https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/HHL/lvt1/150/lv1/75/r/2026-10-30T00%3A00/s/PT000H00M.grib2');
  });

  it('rejects missing earlier levels, surface fields, HHL and statistical predecessors', async () => {
    for (const [missing, hour, hours] of [
      ['/T/lvt1/150/lv1/45/', 'PT003H00M', [3, 6]],
      ['/T_2M/r/', 'PT006H00M', [6]],
      ['/HHL/lvt1/150/lv1/75/', 'PT000H00M', [6]],
      ['/ASHFL_S/r/', 'PT003H00M', [6]],
    ] as const) {
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('HSURF/r/')) return new Response('<a href="2026-10-30T00%3A00/">run</a>');
        if (init?.method === 'HEAD') return new Response(null, { status: url.includes(missing) && url.includes(hour) ? 404 : 200 });
        return new Response('', { status: 404 });
      }) as typeof fetch;
      await expect(discoverIconArmeniaRun({ now: new Date('2026-10-30T02:00:00Z'), fetchFn, forecastHours: hours, intervalHours: 3 })).rejects.toThrow(/no main run/);
    }
  });

  it('fails when no main run has all required fields', async () => {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('HSURF/r/')) return new Response('<a href="2026-10-30T00%3A00/">run</a>', { status: 200 });
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    await expect(discoverIconArmeniaRun({ now: new Date('2026-10-30T02:00:00Z'), fetchFn })).rejects.toBeInstanceOf(IconAdapterError);
  });
});

describe('ICON fixture identity', () => {
  it('uses the fixed Armenian bbox and half-level range', () => {
    expect(ICON_ARMENIA_BBOX).toEqual({ west: 43.25, south: 38.5, east: 46.75, north: 41.5 });
    expect(ICON_HALF_LEVELS).toHaveLength(31);
    expect(ICON_HALF_LEVELS[0]).toBe(45);
    expect(ICON_HALF_LEVELS.at(-1)).toBe(75);
    const geometry = buildIconNativeGeometry(load() as unknown as Parameters<typeof buildIconNativeGeometry>[0]);
    expect(geometry.cells).toHaveLength(3);
  });
});
