import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_SPLIT_OBJECT_BYTES, type SplitSource } from './source.js';

export interface DecodedSplitGribField {
  readonly discipline: number;
  readonly identification: { centre: number; year: number; month: number; day: number; hour: number; minute: number; second: number };
  readonly grid: {
    kind: 'latlon'; ni: number; nj: number; numberOfDataPoints: number; scanningMode: number; uvRelativeToGrid: boolean;
    latitudeOfFirstGridPoint: number; latitudeOfLastGridPoint: number; longitudeOfFirstGridPoint: number; longitudeOfLastGridPoint: number;
    iDirectionIncrement: number; jDirectionIncrement: number;
  };
  readonly product: {
    templateNumber: number; parameterCategory: number; parameterNumber: number;
    firstFixedSurfaceType: number; firstFixedSurfaceValue: number | null;
    secondFixedSurfaceType: number; secondFixedSurfaceValue: number | null;
    coordinateValueCount: number; validTimeIso: string; startHour: number; endHour: number; statisticalProcessCode: number | null;
  };
  readonly representation: {
    dataRepresentationTemplateNumber: number; codedValueCount: number; bitsPerValue: number; referenceValue: number;
    binaryScaleFactor: number; decimalScaleFactor: number; packingError: number;
  };
  readonly expandedBytes: number;
  readonly values: Float32Array | Float64Array;
  readonly missing: Uint8Array;
}

type Target = { values: Float32Array; missing: Uint8Array };
type Metadata = Omit<DecodedSplitGribField, 'values' | 'missing'> & { precision: 4 | 8; peakNativeRssBytes: number; error?: string };
const MAX_METADATA_BYTES = 32 * 1024;
const DECODE_TIMEOUT_MS = 60_000;
const MAX_PENDING_FIELDS = 8;
const NATIVE_RUNTIME_BYTES = 320 * 1024 ** 2;

function nativeWorkspaceBytes(cells: number, activeCells: number): number {
  return NATIVE_RUNTIME_BYTES + 32 * cells + 18 * activeCells + 3 * MAX_SPLIT_OBJECT_BYTES;
}

/** Native scratch, IPC buffers and the acquisition queue share this admission allowance. */
export function splitGribWorkspaceBytes(cells: number, activeCells: number): number {
  if (!Number.isSafeInteger(cells) || cells < 1 || !Number.isSafeInteger(activeCells) || activeCells < 0 || activeCells > cells) throw new RangeError('Invalid Split GRIB workspace dimensions');
  const bytes = nativeWorkspaceBytes(cells, activeCells) + 9 * activeCells + MAX_PENDING_FIELDS * MAX_SPLIT_OBJECT_BYTES + MAX_METADATA_BYTES;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('Unsafe Split GRIB workspace size');
  return bytes;
}

/** One lazy ecCodes process per acquisition session; queued fields share one native scratch allocation. */
export function createSplitGribDecoder(source: SplitSource, activeIndices: Uint32Array, signal?: AbortSignal) {
  const count = activeIndices.length, cells = source.grid.width * source.grid.height;
  if (count > cells || activeIndices.some(index => index >= cells)) throw new RangeError('Active cell index exceeds Split GRIB grid size');
  const stats = { decodeCalls: 0, decodeMs: 0, peakNativeRssBytes: 0, ipcBytes: 0 };
  let child: ChildProcessWithoutNullStreams | undefined, stopped: Error | undefined;
  let output: AsyncIterator<Buffer>, remaining: Buffer = Buffer.alloc(0), stderr = '';
  let exited: Promise<void> | undefined, pending = Promise.resolve(), queued = 0;

  function stop(reason: unknown): void {
    stopped ??= reason instanceof Error ? reason : new Error(String(reason));
    child?.kill('SIGKILL');
  }
  function protocolError(message: string): never { const error = new Error(message); stop(error); throw error; }
  const abort = () => stop(signal?.reason ?? new Error('Split GRIB decoder aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  function start(): void {
    if (stopped) throw stopped;
    if (child) return;
    const python = process.env.AV_ECCODES_PYTHON ?? fileURLToPath(new URL('../../../../.tools/eccodes/bin/python', import.meta.url));
    child = spawn(python, ['-u', fileURLToPath(new URL('./decode.py', import.meta.url))], { stdio: 'pipe' });
    output = child.stdout[Symbol.asyncIterator]();
    exited = new Promise(resolve => {
      child!.once('error', error => { stop(new Error(`Cannot start ecCodes decoder; run pnpm tools:eccodes: ${error.message}`)); resolve(); });
      child!.once('exit', (code, signal) => { stopped ??= new Error(`ecCodes decoder exited (${signal ?? code}): ${stderr}`); resolve(); });
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.stdin.on('error', stop);
    const config = Buffer.from(JSON.stringify({ width: source.grid.width, height: source.grid.height, count, maxBytes: MAX_SPLIT_OBJECT_BYTES }));
    const header = Buffer.alloc(4); header.writeUInt32LE(config.byteLength);
    child.stdin.write(header); child.stdin.write(config);
    child.stdin.write(Buffer.from(activeIndices.buffer, activeIndices.byteOffset, activeIndices.byteLength));
    stats.ipcBytes += header.length + config.length + activeIndices.byteLength;
  }

  async function read(size: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(size);
    for (let offset = 0; offset < size;) {
      if (!remaining.length) {
        const next = await output.next();
        if (next.done) { await exited; throw stopped ?? new Error('Truncated ecCodes decoder output'); }
        remaining = next.value;
      }
      const copied = Math.min(size - offset, remaining.length);
      result.set(remaining.subarray(0, copied), offset);
      remaining = remaining.subarray(copied); offset += copied;
    }
    stats.ipcBytes += size;
    return result;
  }

  async function run(bytes: Uint8Array, target?: Target): Promise<DecodedSplitGribField> {
    start();
    const started = performance.now(), timeout = setTimeout(() => stop(new Error('Split GRIB decode deadline exceeded')), DECODE_TIMEOUT_MS);
    try {
      const header = Buffer.alloc(8); header.writeUInt32LE(bytes.byteLength); header.writeUInt32LE(Number(target !== undefined), 4);
      child!.stdin.write(header); child!.stdin.write(bytes);
      stats.ipcBytes += header.length + bytes.byteLength;
      const response = await read(8), metadataBytes = response.readUInt32LE(), payloadBytes = response.readUInt32LE(4);
      if (!metadataBytes || metadataBytes > MAX_METADATA_BYTES || payloadBytes > count * 9) protocolError('ecCodes response exceeds byte limit');
      let metadata: Metadata;
      try { metadata = JSON.parse((await read(metadataBytes)).toString()) as Metadata; }
      catch { protocolError('Invalid ecCodes response metadata'); }
      if (!metadata || !Number.isSafeInteger(metadata.peakNativeRssBytes) || metadata.peakNativeRssBytes < 0) protocolError('Invalid ecCodes response memory measurement');
      stats.peakNativeRssBytes = Math.max(stats.peakNativeRssBytes, metadata.peakNativeRssBytes);
      if (metadata.peakNativeRssBytes > nativeWorkspaceBytes(cells, count)) protocolError('ecCodes native memory exceeds admitted workspace');
      if (metadata.error) {
        if (payloadBytes || typeof metadata.error !== 'string') protocolError('Invalid ecCodes error response');
        throw new Error(metadata.error);
      }
      if (![4, 8].includes(metadata.precision) || (target && metadata.precision !== 4) || payloadBytes !== count * (metadata.precision + 1)) protocolError('Invalid ecCodes response array layout');
      const payload = await read(payloadBytes), valueBytes = metadata.precision * count;
      const values = target?.values ?? (metadata.precision === 8 ? new Float64Array(count) : new Float32Array(count));
      const missing = target?.missing ?? new Uint8Array(count);
      // Buffer byte offsets need not align to the wire element width.
      const view = new DataView(payload.buffer, payload.byteOffset, valueBytes);
      for (let i = 0; i < count; i++) values[i] = metadata.precision === 8 ? view.getFloat64(i * 8, true) : view.getFloat32(i * 4, true);
      missing.set(payload.subarray(valueBytes));
      const { precision: _, peakNativeRssBytes: __, ...field } = metadata;
      if (stopped) throw stopped;
      stats.decodeCalls++;
      return { ...field, values, missing };
    } finally { clearTimeout(timeout); stats.decodeMs += performance.now() - started; }
  }

  return {
    stats,
    decode(bytes: Uint8Array, target?: Target): Promise<DecodedSplitGribField> {
      if (stopped) return Promise.reject(stopped);
      if (!bytes.byteLength || bytes.byteLength > MAX_SPLIT_OBJECT_BYTES) return Promise.reject(new RangeError('Split GRIB object byte length out of bounds'));
      if (target && (target.values.length !== count || target.missing.length !== count)) return Promise.reject(new RangeError('Split GRIB target length mismatch'));
      if (queued >= MAX_PENDING_FIELDS) return Promise.reject(new Error('Split GRIB decoder queue exceeds concurrency limit'));
      queued++;
      const result = pending.then(() => run(bytes, target));
      pending = result.then(() => {}, () => {}).finally(() => { queued--; });
      return result;
    },
    async close(): Promise<void> {
      signal?.removeEventListener('abort', abort);
      stop(new Error('Split GRIB decoder is closed'));
      await Promise.allSettled([pending, exited]);
    }
  };
}
