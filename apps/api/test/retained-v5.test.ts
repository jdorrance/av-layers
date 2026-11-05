import { afterEach, expect, it, vi } from 'vitest';
import { getProduct, manifestV5Schema } from '@av/contracts';
import snapshots from './fixtures/retained-v5.json' with { type: 'json' };
import { manifest } from '../src/publication';

afterEach(() => vi.useRealTimers());

// Production latest?expand=manifest snapshots captured 2026-11-05; metrics omitted.
it.each(snapshots)('serves retained $model v5 metadata after the point-product registry expands', async snapshot => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-05T20:00:00Z');
  const retained = manifestV5Schema.parse(snapshot), product = getProduct(retained.model)!;
  expect(product.layers.length).toBeGreaterThan(retained.layers.length);
  const key = `builds/${retained.model}/${retained.buildId}/manifest.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const get = vi.fn(async (requested: string) => requested === key ? { size: bytes.length,
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null);
  const served = await manifest({ get } as unknown as R2Bucket, retained.model, retained.buildId,
    { buildId: retained.buildId, manifestKey: key, cycle: retained.cycle, expiresAt: retained.expiresAt }, undefined, product);
  expect(served.descriptors).toEqual(retained.descriptors);
  expect(served.layers).toEqual(retained.layers);
  expect(served.artifacts).toEqual(retained.artifacts);
  expect(get).toHaveBeenCalledTimes(1);
});
