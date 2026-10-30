import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { byteRange, parseIdx, type IdxRecord } from '@azohra/meteo.grib';
import { NoaaError } from './errors.ts';
import type { GfsDuplicateVerification, SelectedIdxRecord, SourceAssetReceipt } from './types.ts';

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

async function readCachedFile(path: string, expectedSize?: number): Promise<Buffer> {
  const bytes = await readFile(path);
  const size = bytes.byteLength;
  if (!Number.isSafeInteger(size) || size <= 0 || (expectedSize === undefined ? size > 65_536 : size !== expectedSize)) {
    throw new NoaaError('transport', `Wrong NOAA cache file size ${path}`);
  }
  return bytes;
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(90_000);
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, timeoutSignal()]) : timeoutSignal();
}

async function readRangeStream(response: Response, url: string, expectedLength: number, signal?: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new NoaaError('transport', `Missing NOAA byte range body for ${url}`);
  const bytes = Buffer.allocUnsafe(expectedLength);
  let position = 0;
  try {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      if (result.value.byteLength > bytes.length - position) {
        throw new NoaaError('transport', `Oversized NOAA byte range for ${url}`);
      }
      bytes.set(result.value, position);
      position += result.value.byteLength;
    }
    if (position !== bytes.length) throw new NoaaError('transport', `Truncated NOAA byte range for ${url}`);
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof NoaaError || signal?.aborted) throw error;
    throw new NoaaError('transport', `NOAA byte range read failed for ${url}: ${(error as Error).message}`);
  } finally {
    reader.releaseLock();
  }
}

export interface IndexResult {
  records: IdxRecord[];
  text: string;
  asset: SourceAssetReceipt;
}

export interface NoaaTransportStats {
  networkRequests: number;
  cacheReads: number;
  memoryIndexHits: number;
}

export class NoaaTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir?: string;
  private readonly signal?: AbortSignal;
  private readonly indexes = new Map<string, IndexResult>();
  private readonly pendingIndexes = new Map<string, Promise<IndexResult>>();
  readonly stats: NoaaTransportStats;

  constructor(options: { fetch?: typeof fetch; fetchImpl?: typeof fetch; signal?: AbortSignal; cacheDir?: string; stats?: NoaaTransportStats }) {
    this.fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
    this.cacheDir = options.cacheDir;
    this.signal = options.signal;
    this.stats = options.stats ?? { networkRequests: 0, cacheReads: 0, memoryIndexHits: 0 };
  }

  abort(): void {
    this.signal?.throwIfAborted();
  }

  async index(url: string, expectedStamp: string): Promise<IndexResult> {
    this.abort();
    const cacheKey = `${url}\n${expectedStamp}`;
    const prior = this.indexes.get(cacheKey);
    if (prior) {
      this.stats.memoryIndexHits++;
      return prior;
    }
    const pending = this.pendingIndexes.get(cacheKey);
    if (pending) {
      this.stats.memoryIndexHits++;
      return pending;
    }
    const promise = this.readIndex(url, expectedStamp);
    this.pendingIndexes.set(cacheKey, promise);
    try {
      const result = await promise;
      this.indexes.set(cacheKey, result);
      return result;
    } finally {
      this.pendingIndexes.delete(cacheKey);
    }
  }

  private async readIndex(url: string, expectedStamp: string): Promise<IndexResult> {
    const bytes = await this.read(url, null, buffer => {
      const lines = buffer.toString('utf8').trim().split('\n').filter(Boolean);
      if (!lines.length) throw new NoaaError('transport', `Empty NOAA index: ${url}`);
      for (const line of lines) {
        if (line.split(':')[2] !== `d=${expectedStamp}`) {
          throw new NoaaError('source-conflict', `NOAA index run mismatch in ${url}`, { line });
        }
      }
    });
    const text = bytes.bytes.toString('utf8');
    const result = { records: parseIdx(text), text, asset: bytes.asset };
    prepareIndex(result);
    return result;
  }

  async field(url: string, record: IdxRecord): Promise<{ bytes: Buffer; asset: SourceAssetReceipt }> {
    if (!Number.isSafeInteger(record.offset) || record.offset < 0) {
      throw new NoaaError('record-missing', `Invalid NOAA record offset for ${url}`);
    }
    if (!Number.isSafeInteger(record.length) || record.length === undefined || record.length <= 0 || !Number.isSafeInteger(record.offset + record.length - 1)) {
      throw new NoaaError('record-missing', `NOAA record has no bounded byte range for ${url}`);
    }
    return this.read(url, record, buffer => {
      if (buffer.length !== record.length) {
        throw new NoaaError('transport', `NOAA byte range length ${buffer.length} != ${record.length} for ${url}`);
      }
    });
  }

  private async readFromCache(url: string, rangeHeader: string | null, record: IdxRecord | null, receiptPath: string): Promise<{ bytes: Buffer; asset: SourceAssetReceipt } | null> {
    const receiptBytes = await readCachedFile(receiptPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!receiptBytes) return null;
    const receipt = JSON.parse(receiptBytes.toString('utf8')) as SourceAssetReceipt;
    if (
      receipt.url !== url ||
      receipt.range !== rangeHeader ||
      !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
      !Number.isSafeInteger(receipt.size) ||
      receipt.size <= 0 ||
      !receipt.file ||
      receipt.file !== `${receipt.sha256}.bin`
    ) {
      throw new NoaaError('transport', `Invalid NOAA cache receipt ${receiptPath}`);
    }
    if (record && receipt.size !== record.length) throw new NoaaError('transport', `Wrong NOAA cache size ${receipt.file}`);
    const bytes = await readCachedFile(join(this.cacheDir!, receipt.file), receipt.size);
    if (bytes.length !== receipt.size || sha256(bytes) !== receipt.sha256) {
      throw new NoaaError('transport', `Corrupt cached NOAA bytes ${receipt.file}`);
    }
    return { bytes, asset: receipt };
  }

  private async read(
    url: string,
    record: IdxRecord | null,
    validate: (bytes: Buffer) => void,
  ): Promise<{ bytes: Buffer; asset: SourceAssetReceipt }> {
    this.abort();
    const rangeHeader = record ? byteRange(record) : null;
    const key = sha256(`${url}\n${rangeHeader}`);
    const receiptPath = this.cacheDir ? join(this.cacheDir, `${key}.json`) : null;
    if (receiptPath) {
      const cached = await this.readFromCache(url, rangeHeader, record, receiptPath);
      if (cached) {
        validate(cached.bytes);
        this.stats.cacheReads++;
        return cached;
      }
    }
    this.abort();
    this.stats.networkRequests++;
    const response = await this.fetchImpl(url, {
      headers: rangeHeader ? { Range: rangeHeader } : {},
      redirect: 'error',
      signal: combinedSignal(this.signal),
    }).catch(error => {
      if (this.signal?.aborted) throw error;
      throw new NoaaError('transport', `NOAA fetch failed for ${url}: ${(error as Error).message}`);
    });
    const expectedStatus = record ? 206 : 200;
    if (response.status !== expectedStatus) {
      throw new NoaaError('transport', `HTTP ${response.status} for ${url}; expected ${expectedStatus}`);
    }
    if (record) {
      const contentRange = response.headers.get('content-range');
      const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
      if (
        !parsed ||
        Number(parsed[1]) !== record.offset ||
        Number(parsed[2]) !== record.offset + record.length! - 1 ||
        !Number.isSafeInteger(Number(parsed[3])) ||
        Number(parsed[3]) <= Number(parsed[2])
      ) {
        throw new NoaaError('transport', `Wrong NOAA Content-Range for ${url}: ${contentRange ?? 'missing'}`);
      }
    }
    const bytes = record
      ? await readRangeStream(response, url, record.length!, this.signal)
      : Buffer.from(await response.arrayBuffer());
    validate(bytes);
    const digest = sha256(bytes);
    const asset: SourceAssetReceipt = {
      url,
      range: rangeHeader,
      sha256: digest,
      size: bytes.length,
      file: this.cacheDir ? `${digest}.bin` : null,
    };
    if (this.cacheDir) {
      await mkdir(this.cacheDir, { recursive: true });
      await atomicWrite(join(this.cacheDir, asset.file!), bytes);
      await atomicWrite(receiptPath!, `${JSON.stringify(asset)}\n`);
    }
    return { bytes, asset };
  }
}

export function selectUniqueRecord(
  records: readonly IdxRecord[],
  text: string,
  spec: { key: string; variable: string; level: string; forecast: string },
): SelectedIdxRecord {
  const matches = records.filter(
    record =>
      record.variable === spec.variable &&
      record.level === spec.level &&
      record.forecast === spec.forecast,
  );
  if (matches.length === 0) {
    throw new NoaaError('record-missing', `Missing required NOAA record ${spec.key}`, {
      variable: spec.variable,
      level: spec.level,
      forecast: spec.forecast,
    });
  }
  if (matches.length > 1) {
    throw new NoaaError('record-ambiguous', `Ambiguous NOAA record ${spec.key}`, {
      matches: matches.map(record => ({
        variable: record.variable,
        level: record.level,
        forecast: record.forecast,
        offset: record.offset,
        length: record.length,
      })),
    });
  }
  const record = matches[0]!;
  if (
    record.length === undefined ||
    !Number.isSafeInteger(record.length) ||
    record.length <= 0 ||
    !Number.isSafeInteger(record.offset) ||
    record.offset < 0 ||
    !Number.isSafeInteger(record.offset + record.length - 1)
  ) {
    throw new NoaaError('record-missing', `NOAA record has unsupported byte range for ${spec.key}`);
  }
  const lines = text.split('\n');
  const indexLine = lines.findIndex(line => {
    const parts = line.split(':');
    return (
      parts[1] === String(record.offset) &&
      parts[2]?.startsWith('d=') &&
      parts[3] === record.variable &&
      parts[4] === record.level &&
      parts[5] === record.forecast
    );
  });
  if (indexLine < 0) throw new NoaaError('source-conflict', `NOAA idx line not found for ${spec.key}`);
  return { record, line: lines[indexLine]!, indexLine: indexLine + 1 };
}

const preparedIndexes = new WeakMap<IndexResult, Map<string, SelectedIdxRecord[]>>();
const selectionKey = (spec: { variable: string; level: string; forecast: string }) => JSON.stringify([spec.variable, spec.level, spec.forecast]);

function prepareIndex(index: IndexResult): Map<string, SelectedIdxRecord[]> {
  const prior = preparedIndexes.get(index);
  if (prior) return prior;
  const lines = new Map<string, { line: string; indexLine: number }>();
  index.text.split('\n').forEach((line, i) => {
    const parts = line.split(':');
    if (parts[2]?.startsWith('d=')) {
      const key = JSON.stringify([parts[1], parts[3], parts[4], parts[5]]);
      if (!lines.has(key)) lines.set(key, { line, indexLine: i + 1 });
    }
  });
  const result = new Map<string, SelectedIdxRecord[]>();
  for (const record of index.records) {
    const source = lines.get(JSON.stringify([String(record.offset), record.variable, record.level, record.forecast]));
    const key = selectionKey(record), candidates = result.get(key) ?? [];
    candidates.push({ record, ...(source ?? { line: '', indexLine: 0 }) });
    result.set(key, candidates);
  }
  preparedIndexes.set(index, result);
  return result;
}

function candidatesFor(index: IndexResult, spec: { key: string; variable: string; level: string; forecast: string }): SelectedIdxRecord[] {
  const candidates = prepareIndex(index).get(selectionKey(spec));
  if (!candidates?.length) {
    selectUniqueRecord(index.records, index.text, spec);
    throw new NoaaError('source-conflict', `NOAA idx line not found for ${spec.key}`);
  }
  if (candidates.length > 8) throw new NoaaError('record-ambiguous', `Too many duplicate GFS records for ${spec.key}`);
  for (const { record, indexLine } of candidates) {
    if (
      !Number.isSafeInteger(record.offset) ||
      record.offset < 0 ||
      !Number.isSafeInteger(record.length) ||
      record.length === undefined ||
      record.length <= 0 ||
      !Number.isSafeInteger(record.offset + record.length - 1)
    ) {
      throw new NoaaError('record-missing', `NOAA record has unsupported byte range for ${spec.key}`);
    }
    if (indexLine === 0) throw new NoaaError('source-conflict', `NOAA idx line not found for ${spec.key}`);
  }
  return candidates;
}

export function gfsRecordWorkingBytes(index: IndexResult, spec: { key: string; variable: string; level: string; forecast: string }): number {
  const candidates = candidatesFor(index, spec);
  return Math.max(...candidates.map(candidate => candidate.record.length!)) * Math.min(2, candidates.length);
}

export async function selectGfsRecord(
  transport: NoaaTransport,
  url: string,
  index: IndexResult,
  spec: { key: string; variable: string; level: string; forecast: string },
): Promise<{ selected: SelectedIdxRecord; bytes?: { bytes: Buffer; asset: SourceAssetReceipt }; duplicates?: GfsDuplicateVerification }> {
  const matches = candidatesFor(index, spec);
  if (matches.length === 1) return { selected: matches[0]! };
  if (matches.length > 8) throw new NoaaError('record-ambiguous', `Too many duplicate GFS records for ${spec.key}`);
  const candidates = [...matches].sort((a, b) => a.record.offset - b.record.offset);
  const length = candidates[0]!.record.length!;
  if (
    length > 32 * 1024 * 1024 ||
    candidates.some((candidate, i) =>
      candidate.record.length !== length ||
      (i > 0 && candidate.record.offset < candidates[i - 1]!.record.offset + length) ||
      candidate.line.split(':').slice(2).join(':') !== candidates[0]!.line.split(':').slice(2).join(':')
    )
  ) {
    throw new NoaaError('record-ambiguous', `Conflicting duplicate GFS record ranges or labels for ${spec.key}`);
  }
  let representative: { bytes: Buffer; asset: SourceAssetReceipt } | undefined;
  const provenance: GfsDuplicateVerification['candidates'] = [];
  for (const candidate of candidates) {
    const result = await transport.field(url, candidate.record);
    const bytes = result.bytes;
    if (
      bytes.length < 20 ||
      bytes.toString('latin1', 0, 4) !== 'GRIB' ||
      bytes[7] !== 2 ||
      bytes.readBigUInt64BE(8) !== BigInt(bytes.length) ||
      bytes.toString('latin1', bytes.length - 4) !== '7777'
    ) {
      throw new NoaaError('source-conflict', `Invalid GRIB envelope for duplicate ${spec.key}`);
    }
    if (representative && !representative.bytes.equals(bytes)) {
      throw new NoaaError('record-ambiguous', `Conflicting duplicate GFS message bytes for ${spec.key}`);
    }
    representative ??= result;
    provenance.push({
      offset: candidate.record.offset,
      length,
      idxLine: candidate.line,
      idxLineNumber: candidate.indexLine,
      asset: result.asset
    });
  }
  return {
    selected: candidates[0]!,
    bytes: representative!,
    duplicates: { rule: 'full-grib-byte-identical-v1', selectedOffset: candidates[0]!.record.offset, candidates: provenance }
  };
}
