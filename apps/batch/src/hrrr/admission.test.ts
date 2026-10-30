import { readFileSync } from 'node:fs';
import { parseIdx, parseProduct, type GribField, type Identification } from '@azohra/meteo.grib';
import { describe, expect, it } from 'vitest';
import { readNoaaStatisticalInterval } from '../noaa/intervals.ts';
import { selectUniqueRecord } from '../noaa/transport.ts';
import { admitHrrrInterval, admitHrrrProduct, packingMetadata } from './admission.ts';
import { hrrrFieldSpecs, hrrrPrecipitationForecastLabel, hrrrSurfaceSpecs } from './fields.ts';

const bytes = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const json = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const cycle = '2026-10-30T06:00:00Z';

describe('HRRR source-specific admission', () => {
  it('decodes signed-magnitude binary and decimal packing scales', () => {
    const section5 = new Uint8Array(21);
    const view = new DataView(section5.buffer);
    view.setUint32(5, 20);
    view.setUint16(15, 0x8002);
    view.setUint16(17, 0x8001);
    expect(packingMetadata({ section5 } as GribField)).toEqual({ packing: 0, codedCount: 20, packingError: 1.25 });
    view.setUint16(15, 2);
    view.setUint16(17, 1);
    expect(packingMetadata({ section5 } as GribField).packingError).toBeCloseTo(0.2);
  });
  it('admits the live instantaneous surface flux product without relabelling it as a mean', () => {
    const expected = json<{ identification: Identification }>('hrrr-shtfl-instant.expect.json');
    const product = parseProduct(bytes('hrrr-shtfl-instant.section4.bin'));
    const spec = hrrrSurfaceSpecs(1).find((item) => item.key === 'sensibleHeatFlux')!;
    expect(() => admitHrrrProduct(product, spec)).not.toThrow();
    const interval = readNoaaStatisticalInterval(bytes('hrrr-shtfl-instant.section4.bin'), expected.identification);
    expect(interval.kind).toBe('instant');
    expect(() => admitHrrrInterval(interval, spec, cycle, 1)).not.toThrow();
    const precipitation = hrrrSurfaceSpecs(1).find((item) => item.key === 'precipitation')!;
    expect(() => admitHrrrInterval(interval, precipitation, cycle, 1)).toThrow(/requires a statistical interval/);
  });

  it('admits the exact one-hour trailing APCP interval and rejects other products for the rain layer', () => {
    const expected = json<{ identification: Identification }>('hrrr-apcp-0-1.expect.json');
    const product = parseProduct(bytes('hrrr-apcp-0-1.section4.bin'));
    const precipitation = hrrrSurfaceSpecs(1).find((item) => item.key === 'precipitation')!;
    expect(() => admitHrrrProduct(product, precipitation)).not.toThrow();
    const interval = readNoaaStatisticalInterval(bytes('hrrr-apcp-0-1.section4.bin'), expected.identification);
    expect(interval.kind).toBe('window');
    if (interval.kind === 'window') {
      expect(interval.start).toBe('2026-10-30T06:00:00.000Z');
      expect(interval.end).toBe('2026-10-30T07:00:00.000Z');
      expect(interval.ranges[0].rangeLength).toBe(1);
      expect(interval.ranges[0].increment).toBe(0);
    }
    expect(() => admitHrrrInterval(interval, precipitation, cycle, 1)).not.toThrow();
    const flux = hrrrSurfaceSpecs(1).find((item) => item.key === 'sensibleHeatFlux')!;
    expect(() => admitHrrrInterval(interval, flux, cycle, 1)).toThrow(/must remain instantaneous/);
  });

  it('admits the f002 trailing 1-2 hour record and does not rely on idx substring collisions', () => {
    const expected = json<{ identification: Identification }>('hrrr-apcp-1-2.expect.json');
    const interval = readNoaaStatisticalInterval(bytes('hrrr-apcp-1-2.section4.bin'), expected.identification);
    const precipitation = hrrrSurfaceSpecs(2).find((item) => item.key === 'precipitation')!;
    expect(() => admitHrrrInterval(interval, precipitation, cycle, 2)).not.toThrow();
    const records = parseIdx(text('hrrr.t06z.wrfsfcf02.excerpt.idx'));
    expect(records.filter((record) => record.variable === 'APCP').length).toBe(2);
    expect(selectUniqueRecord(records, text('hrrr.t06z.wrfsfcf02.excerpt.idx'), precipitation).record.forecast).toBe('1-2 hour acc fcst');
    expect(() => selectUniqueRecord(records, text('hrrr.t06z.wrfsfcf02.excerpt.idx'), { ...precipitation, forecast: '2 hour acc fcst' })).toThrow(/Missing required NOAA record/);
  });

  it('rejects discrete statistical increments and mismatched range lengths', () => {
    const expected = json<{ identification: Identification }>('hrrr-apcp-0-1.expect.json');
    const increment = bytes('hrrr-apcp-0-1.section4.bin');
    new DataView(increment.buffer).setUint32(54, 1);
    expect(() => readNoaaStatisticalInterval(increment, expected.identification)).toThrow(/continuous increment 0/);
    const range = bytes('hrrr-apcp-0-1.section4.bin');
    new DataView(range.buffer).setUint32(49, 2);
    expect(() => readNoaaStatisticalInterval(range, expected.identification)).toThrow(/endpoints and range length differ/);
  });

  it('has no invented f000 precipitation window', () => {
    expect(() => hrrrPrecipitationForecastLabel(0)).toThrow();
    expect(() => hrrrFieldSpecs(0)).toThrow(/starts at f001/);
  });
});
