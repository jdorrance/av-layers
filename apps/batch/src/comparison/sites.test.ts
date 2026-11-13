import { describe, expect, it } from 'vitest';
import { loadSites, parseSites } from './sites.js';

const site = {
  id: 'test-site', name: 'Test site', lat: 40, lon: 44, region: 'europe-caucasus',
  terrain: 'valley', timezone: 'Asia/Yerevan', source: 'Test fixture'
};

describe('comparison locations', () => {
  it('loads the frozen cohort and preserves the supplied coordinate', async () => {
    const sites = await loadSites();
    expect(sites).toHaveLength(50);
    expect(sites.find(value => value.id === 'armenia-reference')).toMatchObject({
      lat: 39.69873414348142, lon: 44.9560546875
    });
  });

  it('rejects ambiguous IDs and invalid geographic or local-time inputs', () => {
    expect(() => parseSites([site, site])).toThrow('Duplicate site ID');
    expect(() => parseSites([site, { ...site, id: 'another-site' }])).toThrow('Duplicate site coordinates');
    expect(() => parseSites([{ ...site, timezone: 'Mars/Olympus' }])).toThrow('Invalid IANA timezone');
    expect(() => parseSites([{ ...site, lat: 91 }])).toThrow();
    expect(() => parseSites([{ ...site, lon: -181 }])).toThrow();
    expect(() => parseSites([{ ...site, lat: Number.NaN }])).toThrow();
  });
});
