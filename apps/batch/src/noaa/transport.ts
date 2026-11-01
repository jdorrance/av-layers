import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { byteRange, parseIdx, type IdxRecord } from '@azohra/meteo.grib';
import { NoaaError } from './errors.ts';
import type { GfsDuplicateVerification, SelectedIdxRecord, SourceAssetReceipt, NoaaFetchOptions } from './types.ts';

export function sha256(bytes: Uint8Array | string | readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  if (Array.isArray(bytes)) for (const chunk of bytes) hash.update(chunk);
  else hash.update(bytes as Uint8Array | string);
  return hash.digest('hex');
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

export const MAX_NOAA_INDEX_BYTES = 1024 * 1024;
const MAX_NOAA_RECORD_BYTES = 128 * 1024 * 1024;

async function readCachedFile(path: string, expectedSize?: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const limit = expectedSize ?? 65_536;
    if (!Number.isSafeInteger(size) || size <= 0 || size > limit || (expectedSize !== undefined && size !== expectedSize)) throw new NoaaError('transport', `Wrong NOAA cache file size ${path}`);
    const bytes = Buffer.alloc(size);
    const { bytesRead } = await file.read(bytes, 0, size, 0);
    if (bytesRead !== size || (await file.stat()).size !== size) throw new NoaaError('transport', `Changed NOAA cache file size ${path}`);
    return bytes;
  } finally { await file.close(); }
}

class RetryableTransportError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message); }
}

/** Bounds both inventory and range bodies independently of untrusted Content-Length. */
async function readBody(response: Response, url: string, limit: number, signal: AbortSignal, exactLength?: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new NoaaError('transport', `Missing NOAA response body for ${url}`);
  const chunks: Uint8Array[] = [], bytes = exactLength === undefined ? undefined : Buffer.allocUnsafe(exactLength);
  let position = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      signal.throwIfAborted();
      if (result.value.byteLength > limit - position) throw new NoaaError('transport', `Oversized NOAA ${bytes ? 'byte range' : 'index'} for ${url}`);
      if (bytes) bytes.set(result.value, position); else chunks.push(result.value);
      position += result.value.byteLength;
    }
    signal.throwIfAborted();
    if (exactLength !== undefined && position !== exactLength) throw new NoaaError('transport', `Truncated NOAA byte range for ${url}`);
    return bytes ?? Buffer.concat(chunks, position);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof NoaaError || signal.aborted) throw error;
    throw new RetryableTransportError(`NOAA response read failed for ${url}: ${(error as Error).message}`);
  } finally {
    signal.removeEventListener('abort', abort);
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
  retries?: number;
}

export class NoaaTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir?: string;
  private readonly signal?: AbortSignal;
  private readonly indexes = new Map<string, IndexResult>();
  private readonly pendingIndexes = new Map<string, Promise<IndexResult>>();
  readonly stats: NoaaTransportStats;
  private readonly retry: Required<NonNullable<NoaaFetchOptions['retry']>>;

  constructor(options: NoaaFetchOptions & { cacheDir?: string; stats?: NoaaTransportStats }) {
    this.fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
    this.cacheDir = options.cacheDir;
    this.signal = options.signal;
    this.stats = options.stats ?? { networkRequests: 0, cacheReads: 0, memoryIndexHits: 0 };
    this.retry = { maxAttempts: 3, deadlineMs: 120_000, attemptTimeoutMs: 90_000, baseDelayMs: 250, maxDelayMs: 5_000, ...options.retry };
    const r = this.retry;
    if (Object.values(r).some(n => !Number.isSafeInteger(n) || n < 0) || r.maxAttempts < 1 || r.maxAttempts > 5 || r.deadlineMs < 1 || r.deadlineMs > 300_000 || r.attemptTimeoutMs < 1 || r.attemptTimeoutMs > r.deadlineMs || r.maxDelayMs > r.deadlineMs || r.baseDelayMs > r.maxDelayMs) throw new RangeError('Invalid NOAA retry policy');
  }

  abort(): void {
    this.signal?.throwIfAborted();
  }

  async index(url: string, expectedStamp: string, refresh = false): Promise<IndexResult> {
    this.abort();
    const cacheKey = `${url}\n${expectedStamp}`;
    if (refresh) this.indexes.delete(cacheKey);
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
    const promise = this.readIndex(url, expectedStamp, refresh);
    this.pendingIndexes.set(cacheKey, promise);
    try {
      const result = await promise;
      this.indexes.set(cacheKey, result);
      return result;
    } finally {
      this.pendingIndexes.delete(cacheKey);
    }
  }

  private async readIndex(url: string, expectedStamp: string, refresh: boolean): Promise<IndexResult> {
    const bytes = await this.read(url, null, buffer => {
      const lines = buffer.toString('utf8').trim().split('\n').filter(Boolean);
      if (!lines.length) throw new NoaaError('transport', `Empty NOAA index: ${url}`);
      for (const line of lines) {
        if (line.split(':')[2] !== `d=${expectedStamp}`) {
          throw new NoaaError('source-conflict', `NOAA index run mismatch in ${url}`, { line });
        }
      }
    }, refresh);
    const text = bytes.bytes.toString('utf8');
    const result = { records: parseIdx(text), text, asset: bytes.asset };
    prepareIndex(result);
    return result;
  }

  async field(url: string, record: IdxRecord): Promise<{ bytes: Buffer; asset: SourceAssetReceipt }> {
    if (!Number.isSafeInteger(record.offset) || record.offset < 0) {
      throw new NoaaError('record-missing', `Invalid NOAA record offset for ${url}`);
    }
    if (!Number.isSafeInteger(record.length) || record.length === undefined || record.length <= 0 || record.length > MAX_NOAA_RECORD_BYTES || !Number.isSafeInteger(record.offset + record.length - 1)) {
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
      receipt.size > (record ? MAX_NOAA_RECORD_BYTES : MAX_NOAA_INDEX_BYTES) ||
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
    refresh = false,
  ): Promise<{ bytes: Buffer; asset: SourceAssetReceipt }> {
    this.abort();
    const rangeHeader = record ? byteRange(record) : null;
    const key = sha256(`${url}\n${rangeHeader}`);
    const receiptPath = this.cacheDir ? join(this.cacheDir, `${key}.json`) : null;
    if (receiptPath && !refresh) {
      const cached = await this.readFromCache(url, rangeHeader, record, receiptPath);
      if (cached) {
        validate(cached.bytes);
        this.stats.cacheReads++;
        return cached;
      }
    }
    const deadline = Date.now() + this.retry.deadlineMs;
    let bytes: Buffer | undefined;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      this.abort();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new NoaaError('transport', `NOAA request deadline exceeded for ${url}`, { reason: 'deadline', attempt });
      const timeout = AbortSignal.timeout(Math.min(remaining, this.retry.attemptTimeoutMs));
      const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
      let response: Response | undefined;
      try {
        this.stats.networkRequests++;
        response = await this.fetchImpl(url, { headers: rangeHeader ? { Range: rangeHeader } : {}, redirect: 'error', signal });
        const expectedStatus = record ? 206 : 200;
        if (response.status !== expectedStatus) {
          if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
            const after = response.headers.get('retry-after');
            const retryAfterMs = after === null ? 0 : /^\d+$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now());
            throw new RetryableTransportError(`HTTP ${response.status} for ${url}; expected ${expectedStatus}`, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
          }
          throw new NoaaError('transport', `HTTP ${response.status} for ${url}; expected ${expectedStatus}`, { reason: response.status === 404 ? 'upstream-not-ready' : 'http-status', status: response.status });
        }
        if (record) {
          const contentRange = response.headers.get('content-range'), parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
          if (!parsed || Number(parsed[1]) !== record.offset || Number(parsed[2]) !== record.offset + record.length! - 1 || !Number.isSafeInteger(Number(parsed[3])) || Number(parsed[3]) <= Number(parsed[2])) throw new NoaaError('transport', `Wrong NOAA Content-Range for ${url}: ${contentRange ?? 'missing'}`);
        }
        bytes = await readBody(response, url, record?.length ?? MAX_NOAA_INDEX_BYTES, signal, record?.length);
        break;
      } catch (error) {
        await response?.body?.cancel().catch(() => {});
        this.abort();
        if (error instanceof NoaaError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === this.retry.maxAttempts || Date.now() >= deadline) throw new NoaaError('transport', `NOAA fetch failed after ${attempt} attempts for ${url}: ${message}`, { reason: timeout.aborted ? 'timeout' : 'transient-exhausted', attempts: attempt });
        this.stats.retries = (this.stats.retries ?? 0) + 1;
        const jitter = this.retry.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
        const requestedDelay = error instanceof RetryableTransportError ? Math.max(jitter, error.retryAfterMs) : jitter;
        const wait = Math.min(this.retry.maxDelayMs, Math.ceil(requestedDelay), Math.max(0, deadline - Date.now()));
        if (wait > 0) await delay(wait, undefined, { signal: this.signal });
      }
    }
    if (!bytes) throw new NoaaError('transport', `NOAA request produced no bytes for ${url}`);
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
