import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { PMTiles } from 'pmtiles';
import { manifestV5Schema, setBit, type CoverageMask, type ManifestV5, type ProductDefinition } from '@av/contracts';
import { INDEXED_PRODUCT } from '../../tests/model-fixtures.js';
import { normalizedFixtureFrame } from '../../scripts/fixtures/normalized-provider.js';
import type { ForecastProvider } from './src/provider.js';
import type { ObjectStorage } from './src/storage.js';
import { localPath } from './src/validate.js';
import { decodeWebp } from './src/webp.js';

export const CYCLE = '2026-06-21T00:00:00.000Z';
export const product: ProductDefinition = {
  ...INDEXED_PRODUCT,
  modelId: 'parallel-fixture', id: 'parallel-fixture-recipe',
  source: { modelFamily: 'fixture-model', configurationId: 'parallel-fixture-provider', domainId: 'synthetic' },
  label: 'Parallel build fixture', attribution: 'Synthetic test data',
  coverageDescription: 'Synthetic grid spanning block and longitude-wrap boundaries',
  bounds: [-180, 70, 180, 72],
  grid: { kind: 'regular-latlon', width: 18, height: 3, earthRadiusM: 6371229, lon0: -180, lat0: 72, dx: 20, dy: -1, wrapLongitude: true },
  coverageId: 'parallel-fixture-coverage', maxNativeZoom: 0, terrainSubdivisionFactor: 2,
  frameHours: [2, 4, 6, 8], intervalHours: 2
};
const cellCount = product.grid.width * product.grid.height;
export const mask: CoverageMask = {
  grid: product.grid, bounds: product.bounds, maxZoom: 0,
  output: new Uint8Array(Math.ceil(cellCount / 8)),
  halo: new Uint8Array(Math.ceil(cellCount / 8)), tiles: Uint8Array.of(1)
};
for (let index = 0; index < cellCount - 1; index++) setBit(mask.output, index);
setBit(mask.halo, cellCount - 1);

export function fixtureProvider(options: { failHour?: number; abort?: AbortController; returnedCycle?: string; beforeAcquire?: (hour: number) => Promise<void> } = {}) {
  const observed = { cycles: [] as (string | undefined)[], hours: [] as number[], closed: 0, sessions: 0, peakSessions: 0 };
  const close = vi.fn(async () => { observed.closed++; observed.sessions--; });
  const acquire = vi.fn();
  const open = vi.fn<ForecastProvider['open']>(async ({ cycle, activeIndices }) => {
    observed.cycles.push(cycle);
    observed.sessions++;
    observed.peakSessions = Math.max(observed.peakSessions, observed.sessions);
    return {
      cycle: options.returnedCycle ?? cycle ?? CYCLE,
      stats: { fixture: true, networkRequests: 0 },
      async acquire(hour) {
        acquire(hour);
        observed.hours.push(hour);
        await options.beforeAcquire?.(hour);
        if (hour === options.failHour) {
          options.abort?.abort(new Error('Fixture cancellation'));
          throw new Error('Fixture acquisition failure');
        }
        const frame = normalizedFixtureFrame(product.grid, activeIndices, cycle ?? CYCLE, hour, product.intervalHours);
        for (let index = 0; index < activeIndices.length; index++) {
          const elevation = activeIndices[index] * 2;
          frame.terrainM[index] += elevation;
          frame.temp2mK[index] += hour * 0.25;
          for (const heights of frame.hgtM) heights[index] += elevation;
        }
        frame.missing.temp[0][5] = 1;
        return frame;
      },
      close
    };
  });
  const provider: ForecastProvider = {
    id: product.source.configurationId, provider: 'Synthetic fixture', maxLevels: 3,
    open
  };
  return { provider, open, close, acquire, observed };
}

export async function readManifest(path: string): Promise<ManifestV5> {
  return manifestV5Schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function tilePixels(root: string, artifact: ManifestV5['artifacts'][number]): Promise<Uint8Array> {
  const bytes = await readFile(localPath(root, artifact.tilesKey));
  const archive = new PMTiles({
    getKey: () => artifact.tilesKey,
    async getBytes(offset, length) {
      const selected = bytes.subarray(offset, offset + length);
      return { data: selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength) };
    }
  });
  const tile = await archive.getZxy(0, 0, 0);
  expect(tile).toBeDefined();
  return (await decodeWebp(new Uint8Array(tile!.data))).data;
}

const temporary: string[] = [];
export async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'av-parallel-test-'));
  temporary.push(root);
  return root;
}
export async function cleanupTemporaryRoots(): Promise<void> {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
}

export class PublicationStore implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array; etag: string; metadata?: Record<string, string> }>();
  failKey = '';
  failAfterPointer = false;
  async get(key: string, range?: { offset: number; length: number }) {
    const item = this.objects.get(key);
    return item ? { bytes: range ? item.bytes.slice(range.offset, range.offset + range.length) : item.bytes.slice(), etag: item.etag } : null;
  }
  async head(key: string) { const item = this.objects.get(key); return item ? { size: item.bytes.length, etag: item.etag, metadata: item.metadata } : null; }
  async put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, _type?: string, _md5?: string, metadata?: Record<string, string>) {
    if (key === this.failKey) throw new Error('injected upload failure');
    const previous = this.objects.get(key);
    if ((condition.ifNoneMatch && previous) || (condition.ifMatch && condition.ifMatch !== previous?.etag)) throw new Error('precondition failed');
    this.objects.set(key, { bytes: Buffer.from(bytes), etag: `"${createHash('md5').update(bytes).digest('hex')}"`, metadata });
    if (key === 'catalog/gfs/latest.json' && this.failAfterPointer) { this.failAfterPointer = false; throw new Error('lost pointer response'); }
  }
  async list(prefix: string) { return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, item]) => ({ key, size: item.bytes.length, lastModified: new Date(0) })); }
  async delete(keys: string[]) { for (const key of keys) this.objects.delete(key); }
}
