import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { LAYERS, manifestV5Schema } from '@av/contracts';
import snapshots from './fixtures/retained-v5.json' with { type: 'json' };
import { manifest } from '../src/publication';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-05T20:00:00Z');
});
afterEach(() => vi.useRealTimers());

function retainedFixture(snapshot: (typeof snapshots)[number]) {
  const retained = manifestV5Schema.parse(snapshot), product = getProduct(retained.model)!;
  const key = `builds/${retained.model}/${retained.buildId}/manifest.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const get = vi.fn(async (requested: string) => requested === key ? { size: bytes.length,
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null);
  const read = () => manifest({ get } as unknown as R2Bucket, retained.model, retained.buildId,
    { buildId: retained.buildId, manifestKey: key, cycle: retained.cycle, expiresAt: retained.expiresAt }, undefined, product);
  return { retained, product, get, read };
}

// Production latest?expand=manifest snapshots captured 2026-11-05; metrics omitted.
it.each(snapshots)('serves retained $model v5 metadata after the point-product registry expands', async snapshot => {
  const { retained, product, get, read } = retainedFixture(snapshot);
  expect(product.layers.length).toBeGreaterThan(retained.layers.length);
  const served = await read();
  expect(served.descriptors).toEqual(retained.descriptors);
  expect(served.layers).toEqual(retained.layers);
  expect(served.artifacts).toEqual(retained.artifacts);
  expect(get).toHaveBeenCalledTimes(1);
});

it('preserves the published display label and enforces measurement units', async () => {
  const { retained, read } = retainedFixture(snapshots.find(snapshot => snapshot.model === 'gfs')!);
  const precipitation = LAYERS['precip-rate'];
  const { label, units } = precipitation;
  try {
    precipitation.label = 'Rain rate';
    const served = await read();
    expect(served.descriptors.layers['precip-rate'].label).toBe(retained.descriptors.layers['precip-rate'].label);
    expect(served.descriptors.layers['precip-rate'].label).not.toBe(precipitation.label);
    precipitation.units = 'cm/h';
    await expect(read()).rejects.toMatchObject({ status: 503, code: 'publication-invalid' });
  } finally {
    precipitation.label = label;
    precipitation.units = units;
  }
});
