import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { createNormalizedFrameTarget } from '../provider.js';
import { createSplitGribAcquisitionSession } from './acquire.js';
import { splitGribRunSentinelUrls } from './discover.js';
import { splitGribFieldUrl } from './fields.js';
import { splitSource, type SplitSource } from './source.js';

const cycle = '2026-11-13T06:00:00.000Z';
const product = getProduct('icon-eu')!;
const configured = splitSource(product);
const source = splitSource({ ...product,
  grid: { kind: 'regular-latlon', width: 2, height: 2, lat0: 50, lon0: 10, dx: 0.0625, dy: -0.0625,
    earthRadiusM: 6371229, wrapLongitude: false },
  capabilities: { ...product.capabilities, maxVerticalLevels: 1 },
  upstream: { ...configured.upstream, modelLevels: [74], nativeGrid: { ...configured.upstream.nativeGrid!, pointCount: 4 },
    auxSurface: { u10mMps: configured.upstream.auxSurface!.u10mMps!, v10mMps: configured.upstream.auxSurface!.v10mMps! },
    auxLevels: { uWindMps: configured.upstream.auxLevels!.uWindMps!, vWindMps: configured.upstream.auxLevels!.vWindMps! } }
});
const activeIndices = Uint32Array.of(0, 1, 2, 3);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function cacheDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'native-acquire-')); directories.push(path); return path;
}

type Request = { field: string; hour: number; level: number | null };
function request(url: string): Request {
  const path = new URL(url).pathname;
  const match = /\/p\/([^/]+)(?:\/lvt1\/150\/lv1\/(\d+))?\/r\/2026-11-13T06%3A00\/s\/PT(\d{3})H00M\.grib2$/.exec(path);
  if (!match) throw new Error(`Unexpected native field URL ${url}`);
  return { field: match[1]!, level: match[2] ? Number(match[2]) : null, hour: Number(match[3]) };
}

function values({ field, hour, level }: Request): readonly number[] {
  if (field === 'CLAT') return [49.9375, 50, 49.9375, 50];
  if (field === 'CLON') return [10.0625, 10, 10, 10.0625];
  const offset = { HSURF: 100, HHL: level === 75 ? 100 : 120, T_2M: 280, QV_2M: 1 / 256,
    PS: 100000, T: 270, P: 99000, U: -2, V: 4, U_10M: -2, V_10M: 4 }[field];
  return Array.from({ length: 4 }, (_, cell) => {
    if (field === 'ASHFL_S') return -10 * (hour - 1) - cell;
    if (field === 'ALHFL_S') return -10 * (hour + 1) - cell;
    if (field === 'TOT_PREC') return hour * (cell + 1);
    if (offset === undefined) throw new Error(`Unexpected fixture field ${field}`);
    return offset + (field === 'QV_2M' ? 0 : field === 'V' || field === 'V_10M' ? -cell : field === 'HSURF' || field === 'HHL' ? 10 * cell : cell);
  });
}

// Four native cells in SE, NW, SW, NE order exercise the adapter's spatial join.
function fieldBytes(spec: SplitSource['specs'][string], selected: Request, data: readonly (number | null)[]): Buffer {
  const section = (id: number, length: number) => { const bytes = Buffer.alloc(length); bytes.writeUInt32BE(length); bytes[4] = id; return bytes; };
  const s1 = section(1, 21); s1.writeUInt16BE(78, 5); s1.writeUInt16BE(2026, 12); s1[14] = 11; s1[15] = 13; s1[16] = 6;
  const s3 = section(3, 35); s3.writeUInt32BE(4, 6); s3.writeUInt16BE(101, 12); s3[14] = 6; s3[17] = 62; s3[18] = 1;
  s3.set(Buffer.from(configured.upstream.nativeGrid!.uuid, 'hex'), 19);
  const s4 = section(4, spec.templateNumber === 8 ? 58 : 34);
  s4.writeUInt16BE(spec.templateNumber, 7); s4[9] = spec.parameterCategory; s4[10] = spec.parameterNumber; s4[11] = 2; s4[17] = 1;
  s4.writeUInt32BE(spec.templateNumber === 8 ? 0 : selected.hour, 18);
  s4[22] = spec.firstFixedSurfaceType; s4.writeUInt32BE(selected.level ?? spec.firstFixedSurfaceValue ?? 0, 24);
  s4[28] = spec.secondFixedSurfaceType;
  if (spec.secondFixedSurfaceType === 255) s4.fill(255, 29, 34);
  else s4.writeUInt32BE(spec.kind === 'model-level' ? selected.level! + 1 : spec.secondFixedSurfaceValue ?? 0, 30);
  if (spec.templateNumber === 8) {
    s4.writeUInt16BE(2026, 34); s4[36] = 11; s4[37] = 13; s4[38] = 6 + selected.hour; s4[41] = 1;
    s4[46] = spec.statisticalProcessCode!; s4[47] = 2; s4[48] = 1; s4.writeUInt32BE(selected.hour, 49); s4[53] = 255;
  }
  const coded = data.filter((value): value is number => value !== null), reference = Math.min(...coded);
  const scale = selected.field === 'CLAT' || selected.field === 'CLON' ? -4 : 0;
  const s5 = section(5, 21); s5.writeUInt32BE(coded.length, 5); s5.writeFloatBE(reference, 11);
  s5.writeUInt16BE(scale < 0 ? 0x8000 | -scale : scale, 15); s5[19] = 8;
  const s6 = section(6, coded.length === data.length ? 6 : 7); s6[5] = coded.length === data.length ? 255 : 0;
  if (s6.length === 7) data.forEach((value, index) => { if (value !== null) s6[6]! |= 0x80 >> index; });
  const s7 = section(7, 5 + coded.length); coded.forEach((value, index) => { s7[5 + index] = (value - reference) / 2 ** scale; });
  const header = Buffer.alloc(16); header.write('GRIB'); header[7] = 2;
  const bytes = Buffer.concat([header, s1, s3, s4, s5, s6, s7, Buffer.from('7777')]); bytes.writeBigUInt64BE(BigInt(bytes.length), 8);
  return bytes;
}

function transport(change?: (selected: Request, bytes: Buffer) => Buffer) {
  return vi.fn<typeof fetch>(async input => {
    const selected = request(String(input));
    const bytes = fieldBytes(source.specs[selected.field]!, selected, values(selected));
    return new Response(new Uint8Array(change ? change(selected, bytes) : bytes));
  });
}

it('uses v1 field, model-level and static paths and probes both coordinate objects', () => {
  const prefix = 'https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/';
  expect(splitGribFieldUrl(configured, 'T_2M', cycle, { hour: 3 })).toBe(`${prefix}T_2M/r/2026-11-13T06%3A00/s/PT003H00M.grib2`);
  expect(splitGribFieldUrl(configured, 'T', cycle, { hour: 3, level: 74 })).toBe(`${prefix}T/lvt1/150/lv1/74/r/2026-11-13T06%3A00/s/PT003H00M.grib2`);
  expect(splitGribFieldUrl(configured, 'HHL', cycle, { hour: 120, level: 75 })).toBe(`${prefix}HHL/lvt1/150/lv1/75/r/2026-11-13T06%3A00/s/PT000H00M.grib2`);
  const urls = splitGribRunSentinelUrls(configured, cycle);
  for (const field of ['CLAT', 'CLON']) expect(urls).toContain(`${prefix}${field}/r/2026-11-13T06%3A00/s/PT000H00M.grib2`);
  expect(new Set(urls).size).toBe(urls.length);
  expect(urls.every(url => url.startsWith(prefix) && url.endsWith('.grib2'))).toBe(true);
});

it('maps whole columns and statistical companions into shared targets and replays the cache offline', async () => {
  const cacheDir = await cacheDirectory(), fetchImpl = transport();
  const session = await createSplitGribAcquisitionSession(source, { cycle, activeIndices, cacheDir, fetchImpl });
  const target = createNormalizedFrameTarget(4, 1, true, true);
  try {
    const frame = await session.acquire(3, target);
    expect(frame.grid).toEqual(source.grid); expect([...frame.activeIndices]).toEqual([...activeIndices]);
    expect(frame.terrainM).toBe(target.terrainM); expect(frame.temp2mK).toBe(target.temp2mK); expect(frame.pressurePa[0]).toBe(target.pressurePa![0]);
    expect(frame.auxLevels!.uWindMps![0].values.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...frame.terrainM]).toEqual([110, 130, 120, 100]); expect([...frame.hgtM[0]!]).toEqual([120, 140, 130, 110]);
    expect([...frame.temp2mK]).toEqual([281, 283, 282, 280]); expect([...frame.tempK[0]!]).toEqual([271, 273, 272, 270]);
    expect([...frame.surfacePressurePa]).toEqual([100001, 100003, 100002, 100000]); expect([...frame.pressurePa[0]!]).toEqual([99001, 99003, 99002, 99000]);
    expect([...frame.auxSurface!.u10mMps!.values]).toEqual([-1, 1, 0, -2]); expect([...frame.auxLevels!.vWindMps![0].values]).toEqual([3, 1, 2, 4]);
    expect([...frame.sensibleHeatFluxWm2]).toEqual([41, 43, 42, 40]); expect([...frame.latentHeatFluxWm2]).toEqual([61, 63, 62, 60]);
    expect([...frame.precipitationMmPerHour!]).toEqual([2, 4, 3, 1]);
    expect(frame.intervals.usedCompanion).toBe(true);
    expect(frame.receipt.nativeGrid).toMatchObject({ number: 62, pointCount: 4, uuid: configured.upstream.nativeGrid!.uuid });
    expect(frame.receipt.remapping).toBeDefined();
    expect(frame.receipt.objects).toEqual(expect.arrayContaining(['CLAT', 'CLON'].map(field => expect.objectContaining({ field, hour: 0, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }))));
    await session.acquire(4);
    const requests = fetchImpl.mock.calls.map(([url]) => request(String(url)));
    for (const field of ['CLAT', 'CLON', 'HSURF']) expect(requests.filter(item => item.field === field)).toHaveLength(1);
    for (const field of ['ASHFL_S', 'ALHFL_S', 'TOT_PREC']) expect(requests.filter(item => item.field === field && item.hour === 3)).toHaveLength(1);
  } finally { await session.close(); }
  const offlineFetch = vi.fn<typeof fetch>();
  const offline = await createSplitGribAcquisitionSession(source, { cycle, activeIndices, cacheDir, fetchImpl: offlineFetch, offline: true });
  try {
    expect([...(await offline.acquire(3)).tempK[0]!]).toEqual([271, 273, 272, 270]);
    expect(offline.stats.downloads).toBe(0); expect(offline.stats.cacheHits).toBeGreaterThan(0); expect(offlineFetch).not.toHaveBeenCalled();
  } finally { await offline.close(); }
});

it.each(['coordinate parameter', 'coordinate missingness', 'weather grid UUID'] as const)('rejects inconsistent %s before returning a frame', async failure => {
  const cacheDir = await cacheDirectory();
  const fetchImpl = transport((selected, bytes) => {
    if (failure === 'coordinate parameter' && selected.field === 'CLAT') bytes[16 + 21 + 35 + 10] = 2;
    if (failure === 'coordinate missingness' && selected.field === 'CLAT') return fieldBytes(source.specs.CLAT!, selected, [49.9375, null, 49.9375, 50]);
    if (failure === 'weather grid UUID' && selected.field === 'T') bytes[16 + 21 + 19]! ^= 1;
    return bytes;
  });
  const session = await createSplitGribAcquisitionSession(source, { cycle, activeIndices, cacheDir, fetchImpl });
  try { await expect(session.acquire(3)).rejects.toThrow(failure === 'coordinate parameter' ? /parameter\/template mismatch/ : failure === 'coordinate missingness' ? /coordinate/ : /native grid identity mismatch/); }
  finally { await session.close(); }
});

it('carries a native bitmap through the donor map and pairs missing wind components', async () => {
  const cacheDir = await cacheDirectory();
  const fetchImpl = transport((selected, bytes) => selected.field === 'T' || selected.field === 'V'
    ? fieldBytes(source.specs[selected.field]!, selected, [null, ...values(selected).slice(1)]) : bytes);
  const session = await createSplitGribAcquisitionSession(source, { cycle, activeIndices, cacheDir, fetchImpl });
  try {
    const frame = await session.acquire(3, createNormalizedFrameTarget(4, 1, true, true));
    expect([...frame.tempK[0]!]).toEqual([271, 273, 272, NaN]); expect([...frame.missing.temp[0]!]).toEqual([0, 0, 0, 1]);
    expect([...frame.auxLevels!.uWindMps![0].values]).toEqual([-1, 1, 0, NaN]);
    expect([...frame.auxLevels!.uWindMps![0].missing]).toEqual([0, 0, 0, 1]);
    expect([...frame.auxLevels!.vWindMps![0].missing]).toEqual([0, 0, 0, 1]);
  } finally { await session.close(); }
});

it('rejects a corrupt cached coordinate offline and repairs it through the normal loader', async () => {
  const cacheDir = await cacheDirectory(), fetchImpl = transport();
  const session = await createSplitGribAcquisitionSession(source, { cycle, activeIndices, cacheDir, fetchImpl });
  try { await session.acquire(3); } finally { await session.close(); }
  const url = splitGribFieldUrl(source, 'CLON', cycle), hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const path = join(cacheDir, 'objects', `${hash}-PT000H00M.grib2`), bytes = await readFile(path);
  bytes[16 + 21 + 19]! ^= 1; await writeFile(path, bytes);
  fetchImpl.mockClear();
  const offline = await createSplitGribAcquisitionSession(source, { cycle, activeIndices, cacheDir, fetchImpl, offline: true });
  try { await expect(offline.acquire(3)).rejects.toThrow(/offline cache miss or invalid object.*CLON/); }
  finally { await offline.close(); }
  expect(fetchImpl).not.toHaveBeenCalled();
  const repaired = await createSplitGribAcquisitionSession(source, { cycle, activeIndices, cacheDir, fetchImpl });
  try { expect([...(await repaired.acquire(3)).terrainM]).toEqual([110, 130, 120, 100]); }
  finally { await repaired.close(); }
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(request(String(fetchImpl.mock.calls[0]![0])).field).toBe('CLON');
});

it('aborts coordinate acquisition on close and starts no weather requests', async () => {
  const cacheDir = await cacheDirectory();
  let started!: () => void;
  const pendingRequest = new Promise<void>(resolve => { started = resolve; });
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); started();
  }));
  const session = await createSplitGribAcquisitionSession(source, { cycle, activeIndices, cacheDir, fetchImpl });
  const pending = session.acquire(3), rejected = expect(pending).rejects.toThrow(/closed/);
  await pendingRequest; await session.close(); await rejected;
  expect(fetchImpl.mock.calls.every(([url]) => ['CLAT', 'CLON'].includes(request(String(url)).field))).toBe(true);
  await expect(session.acquire(3)).rejects.toThrow(/closed/);
});
