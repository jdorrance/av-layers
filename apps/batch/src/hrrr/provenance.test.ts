import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const provenance = JSON.parse(readFileSync(new URL('./provenance.json', import.meta.url), 'utf8')) as {
  reuse: { repository?: string; package?: string; revision?: string; version?: string; license: string }[];
  liveObservation: { cycle: string; grid: { gridKey: string; ni: number; nj: number } };
};

describe('HRRR provenance', () => {
  it('records the private Windgrams revision with no public license found', () => {
    const source = provenance.reuse.find((item) => item.repository === 'windgrams')!;
    expect(source.revision).toBe('32fdd75db7a4a1a302ae901b969b0f6625712368');
    expect(source.license).toMatch(/No public license found/);
  });

  it('records the meteo decoder version and MIT license', () => {
    const decoder = provenance.reuse.find((item) => item.package === '@azohra/meteo.grib')!;
    expect(decoder.version).toBe('0.1.4');
    expect(decoder.license).toBe('MIT');
    expect(decoder.revision).toBe('0296c1fb54aa9c8415e7962d7a4580b496e7ebf8');
  });

  it('pins the observed native HRRR grid', () => {
    expect(provenance.liveObservation.cycle).toBe('2026-10-30T06:00:00Z');
    expect(provenance.liveObservation.grid).toMatchObject({ gridKey: '8c8b3013f8c77310', ni: 1799, nj: 1059 });
  });
});
