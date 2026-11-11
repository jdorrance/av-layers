import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CELL_BYTES, MAX_PACK_CHANNELS, MAX_SAMPLE_VALUES, SAMPLE_BLOCK_SIZE, STATUS_OUTSIDE, sparseCoverageLookup, type SparseCoverage } from '@av/contracts';
import { MAX_PACK_RECORD_BYTES, SAMPLE_SHARD_TARGET_BYTES, type GridField, type PackedGridField, type ShardedSamplePackLayout } from '@av/forecast';
import { localPath } from './local-file.js';

const MAX_WRITE_CHUNK_BYTES = 1024 * 1024;
const MAX_OPEN_SHARDS = 32;
const MAX_BLOCK_CELLS = (SAMPLE_BLOCK_SIZE + 1) * (SAMPLE_BLOCK_SIZE + 1);
type RawRecords = Uint8Array | ((gridIndex: number) => Uint8Array);

export interface ShardedSamplePackShard {
  readonly firstBlock: number;
  readonly blockCount: number;
  readonly storedCells: number;
  readonly bytes: number;
  readonly key: string;
  readonly sha256: string;
}

export interface ShardedSamplePackTarget {
  readonly root: string;
  readonly model: string;
  readonly buildId: string;
  readonly surfaceId: string;
  readonly group?: number;
  readonly kind?: 'samples' | 'profiles';
  readonly role?: 'serving' | 'hour';
}

export interface ShardedSamplePackInput {
  readonly root: string;
  readonly recordBytes?: number;
  readonly channelCount: number;
  readonly selection?: { readonly firstChannel: number; readonly channelCount: number };
  readonly shards: readonly ShardedSamplePackShard[];
}

function component(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) throw new RangeError(`Invalid sample shard ${name}`);
  return value;
}

export function sampleShardKey(model: string, buildId: string, surfaceId: string, index: number, group?: number, kind: 'samples' | 'profiles' = 'samples', role: 'serving' | 'hour' = 'serving'): string {
  if (kind !== 'samples' && kind !== 'profiles') throw new RangeError('Invalid sample shard kind');
  if (role !== 'serving' && role !== 'hour') throw new RangeError('Invalid sample shard role');
  component(model, 'model');
  component(buildId, 'build ID');
  component(surfaceId, 'surface ID');
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid sample shard index');
  if (group !== undefined && (!Number.isSafeInteger(group) || group < 0)) throw new RangeError('Invalid sample frame group');
  const stem = group === undefined ? String(index) : `${role === 'hour' ? 'src-g' : 'g'}${group}-b${index}`;
  return `builds/${model}/${buildId}/surfaces/${surfaceId}/${kind}/${stem}.bin`;
}

function assertChannels(channelCount: number): void {
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > MAX_PACK_CHANNELS) throw new RangeError('Invalid sample channel count');
}

function assertLayout(layout: ShardedSamplePackLayout): void {
  if (!layout || !Number.isSafeInteger(layout.blockCount) || layout.blockCount < 1 || !Number.isSafeInteger(layout.storedCells) || layout.storedCells < 1 || !Array.isArray(layout.shards) || !layout.shards.length) throw new RangeError('Invalid sharded sample layout');
  assertChannels(layout.channelCount);
  if (!Number.isSafeInteger(layout.recordBytes) || layout.recordBytes < 1 || layout.recordBytes > MAX_PACK_RECORD_BYTES) throw new RangeError('Invalid sample record width');
  const bytes = layout.storedCells * layout.channelCount * layout.recordBytes;
  if (!Number.isSafeInteger(bytes) || bytes !== layout.byteLength) throw new RangeError('Invalid sample layout bytes');
  let nextBlock = 0, shardBytes = 0;
  for (const shard of layout.shards) {
    if (shard.firstBlock !== nextBlock || !Number.isSafeInteger(shard.blockCount) || shard.blockCount < 1
      || !Number.isSafeInteger(shard.byteLength) || shard.byteLength < 1 || shard.byteLength > SAMPLE_SHARD_TARGET_BYTES) throw new RangeError('Invalid sample shard layout');
    nextBlock += shard.blockCount; shardBytes += shard.byteLength;
  }
  if (nextBlock !== layout.blockCount || shardBytes !== bytes) throw new RangeError('Incomplete sample shard layout');
}

function blockCells(layout: ShardedSamplePackLayout, ordinal: number): number {
  const block = layout.block(ordinal);
  return block.width * block.height;
}

function maximumBlockCells(layout: ShardedSamplePackLayout): number {
  let maximum = 0;
  for (let ordinal = 0; ordinal < layout.blockCount; ordinal++) {
    const cells = blockCells(layout, ordinal);
    if (!Number.isSafeInteger(cells) || cells < 1 || cells > MAX_BLOCK_CELLS) throw new RangeError('Invalid sample block size');
    maximum = Math.max(maximum, cells);
  }
  if (maximum * layout.channelCount * layout.recordBytes > SAMPLE_SHARD_TARGET_BYTES) throw new RangeError('Sample block exceeds shard target');
  return maximum;
}

function writerBuffers(layout: ShardedSamplePackLayout) {
  const sectionBytes = layout.shards.reduce((maximum, shard) => Math.max(maximum, shard.byteLength / layout.channelCount), 0);
  return { block: maximumBlockCells(layout) * layout.recordBytes,
    chunk: Math.min(sectionBytes, Math.floor(MAX_WRITE_CHUNK_BYTES / layout.recordBytes) * layout.recordBytes) };
}

export function samplePackAssemblyBufferBytes(shards: ShardedSamplePackLayout['shards']): number {
  return shards.reduce((maximum, shard) => Math.max(maximum, shard.byteLength), 0);
}

/** Reusable block and chunk buffers retained by one serialized writer. */
export function samplePackWriterBufferBytes(layout: ShardedSamplePackLayout): number {
  const buffers = writerBuffers(layout);
  return buffers.block + buffers.chunk;
}

function assertCoverage(layout: ShardedSamplePackLayout, coverage: SparseCoverage): void {
  const { grid } = layout;
  if (coverage.width !== grid.width || coverage.height !== grid.height || coverage.wrapLongitude !== grid.wrapLongitude
      || !(coverage.blockIds instanceof Uint32Array) || coverage.blockIds.length !== layout.blockCount
      || !(coverage.offsets instanceof Uint32Array) || coverage.offsets.length !== layout.blockCount + 1
      || !(coverage.output instanceof Uint8Array) || !(coverage.halo instanceof Uint8Array)) throw new RangeError('Sample coverage differs from layout');
  for (let i = 0; i < coverage.blockIds.length; i++) if (coverage.blockIds[i] !== layout.block(i).slot) throw new RangeError('Sample coverage differs from layout');
}

function sameCoverage(a: SparseCoverage, b: SparseCoverage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.wrapLongitude !== b.wrapLongitude
      || a.gridHash !== b.gridHash || a.blockIds.length !== b.blockIds.length || a.offsets.length !== b.offsets.length
      || a.output.length !== b.output.length || a.halo.length !== b.halo.length) return false;
  for (let i = 0; i < a.blockIds.length; i++) if (a.blockIds[i] !== b.blockIds[i] || a.offsets[i] !== b.offsets[i]) return false;
  if (a.offsets[a.blockIds.length] !== b.offsets[b.blockIds.length]) return false;
  for (let i = 0; i < a.output.length; i++) if (a.output[i] !== b.output[i] || a.halo[i] !== b.halo[i]) return false;
  return true;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number, check: () => void): Promise<void> {
  let done = 0;
  while (done < length) {
    check();
    const { bytesWritten } = await handle.write(bytes, offset + done, length - done, position + done);
    if (!bytesWritten) throw new Error('Short sample shard write');
    done += bytesWritten;
  }
}

async function readAll(handle: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number, check: () => void): Promise<void> {
  let done = 0;
  while (done < length) {
    check();
    const { bytesRead } = await handle.read(bytes, offset + done, length - done, position + done);
    if (!bytesRead) throw new Error('Short sample shard read');
    done += bytesRead;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createShardedSamplePackWriter(
  layout: ShardedSamplePackLayout,
  coverage: SparseCoverage,
  target: ShardedSamplePackTarget,
  options: { signal?: AbortSignal } = {}
) {
  assertLayout(layout);
  assertCoverage(layout, coverage);
  const recordBytes = layout.recordBytes, buffers = writerBuffers(layout);
  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const role = target.role ?? (target.group !== undefined && target.kind !== 'profiles' ? 'hour' : 'serving');
  const finalKeys = layout.shards.map((_, index) => sampleShardKey(target.model, target.buildId, target.surfaceId, index, target.group, target.kind, role));
  const finalPaths = finalKeys.map(key => localPath(target.root, key));
  const tempPaths = finalPaths.map(path => join(dirname(path), `.${basename(path)}.${suffix}.channels`));
  const finalTempPaths = finalPaths.map(path => join(dirname(path), `.${basename(path)}.${suffix}.partial`));
  const starts = layout.shards.map(() => new Array<number>(layout.channelCount).fill(-1));
  const ends = layout.shards.map(() => 0);
  const written = new Uint8Array(layout.channelCount), compatibleCoverages = new WeakSet<SparseCoverage>([coverage]);
  const handles = new Map<number, FileHandle>(), finalHandles = new Set<FileHandle>(), created = new Set<string>(), linked = new Set<string>(), blockBuffer = Buffer.allocUnsafe(buffers.block), chunk = Buffer.allocUnsafe(buffers.chunk);
  let finished = false, closed = false, failed = false, completed = 0;
  let inFlight: Promise<unknown> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const check = (): void => {
    if (closed || finished) throw new Error('Sample shard writer is closed');
    if (failed) throw new Error('Sample shard writer failed');
    options.signal?.throwIfAborted();
  };

  async function closeHandles(): Promise<void> {
    const openHandles = [...handles.entries()];
    const results = await Promise.allSettled([
      ...openHandles.map(async ([shard, handle]) => { await handle.close(); handles.delete(shard); }),
      ...[...finalHandles].map(async handle => { await handle.close(); finalHandles.delete(handle); })
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    const result = (async () => {
      const errors: unknown[] = [];
      try { await closeHandles(); } catch (error) { errors.push(error); }
      for (const paths of [created, linked]) {
        await Promise.all([...paths].map(async path => {
          try { await rm(path, { force: true }); paths.delete(path); } catch (error) { errors.push(error); }
        }));
      }
      if (errors.length) throw new AggregateError(errors, 'Sample shard cleanup failed');
    })();
    cleanupPromise = result;
    void result.finally(() => { cleanupPromise = undefined; }).catch(() => undefined);
    return result;
  }

  async function fail(error: unknown): Promise<never> {
    failed = true; closed = true;
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `Sample shard cleanup failed: ${String(error)}`); }
    throw error;
  }

  async function handleFor(shard: number): Promise<FileHandle> {
    const prior = handles.get(shard);
    if (prior) { handles.delete(shard); handles.set(shard, prior); return prior; }
    if (handles.size >= MAX_OPEN_SHARDS) {
      const [oldest, handle] = handles.entries().next().value as [number, FileHandle];
      await handle.close();
      handles.delete(oldest);
    }
    await mkdir(dirname(tempPaths[shard]), { recursive: true });
    const path = tempPaths[shard];
    const handle = await open(path, created.has(path) ? 'r+' : 'wx+');
    created.add(path);
    handles.set(shard, handle);
    return handle;
  }

  function packedCoverage(field: GridField): SparseCoverage | undefined {
    if (!('coverage' in field)) return undefined;
    const packed = (field as PackedGridField).coverage;
    if (!compatibleCoverages.has(packed)) {
      if (!sameCoverage(coverage, packed)) throw new RangeError('Packed field coverage differs from layout');
      compatibleCoverages.add(packed);
    }
    return packed;
  }

  async function writeShardChannel(shard: number, channel: number, source: GridField | RawRecords, packed: SparseCoverage | undefined, outsideRecord?: Uint8Array): Promise<void> {
    const descriptor = layout.shards[shard], sectionBytes = descriptor.byteLength / layout.channelCount;
    const width = layout.grid.width, wrap = layout.grid.wrapLongitude;
    const raw = source instanceof Uint8Array ? Buffer.from(source.buffer, source.byteOffset, source.byteLength) : undefined;
    const readRecord = typeof source === 'function' ? source : undefined;
    const field = raw || readRecord ? undefined : source as GridField;
    let chunkFill = 0, position = ends[shard];
    starts[shard][channel] = position;
    ends[shard] += sectionBytes;
    const flush = async (): Promise<void> => {
      if (!chunkFill) return;
      await writeAll(await handleFor(shard), chunk, 0, chunkFill, position, check);
      position += chunkFill; chunkFill = 0;
    };
    for (let ordinal = descriptor.firstBlock; ordinal < descriptor.firstBlock + descriptor.blockCount; ordinal++) {
      check();
      const block = layout.block(ordinal), cells = block.width * block.height;
      const coreWidth = Math.min(SAMPLE_BLOCK_SIZE, width - block.column);
      let coreOffset = coverage.offsets[ordinal]!;
      for (let i = 0; i < cells; i++) {
        const x = i % block.width, y = (i - x) / block.width;
        const column = wrap ? (block.column + x) % width : block.column + x;
        const row = block.row + y, destination = i * recordBytes;
        let sourceOffset: number | undefined;
        if (x < coreWidth && y < SAMPLE_BLOCK_SIZE) {
          const local = y * SAMPLE_BLOCK_SIZE + x, byte = ordinal * (SAMPLE_BLOCK_SIZE * SAMPLE_BLOCK_SIZE / 8) + (local >>> 3);
          if (((coverage.output[byte]! | coverage.halo[byte]!) & (1 << (local & 7))) !== 0) sourceOffset = coreOffset++;
        } else sourceOffset = sparseCoverageLookup(coverage, column, row)?.offset;
        if (sourceOffset === undefined) {
          if (outsideRecord) blockBuffer.set(outsideRecord, destination);
          else { blockBuffer.fill(0, destination, destination + recordBytes); blockBuffer[destination + 4] = STATUS_OUTSIDE; }
          continue;
        }
        const index = packed ? (packed === coverage ? sourceOffset : sparseCoverageLookup(packed, column, row)!.offset) : row * width + column;
        if (readRecord) {
          const record = readRecord(row * width + column);
          if (!(record instanceof Uint8Array) || record.byteLength !== recordBytes) throw new RangeError('Invalid callback record width');
          blockBuffer.set(record, destination);
        } else if (raw) raw.copy(blockBuffer, destination, index * recordBytes, (index + 1) * recordBytes);
        else { blockBuffer.writeFloatLE(field!.values[index], destination); blockBuffer[destination + 4] = field!.flags[index]; }
      }
      const blockBytes = cells * recordBytes;
      for (let offset = 0; offset < blockBytes;) {
        const length = Math.min(chunk.length - chunkFill, blockBytes - offset);
        blockBuffer.copy(chunk, chunkFill, offset, offset + length);
        chunkFill += length; offset += length;
        if (chunkFill === chunk.length) await flush();
      }
    }
    await flush();
    if (position !== starts[shard][channel] + sectionBytes) throw new Error('Sample shard channel length mismatch');
  }

  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (inFlight) return Promise.reject(new Error('Sample shard writer is busy'));
    const result = operation();
    inFlight = result;
    void result.finally(() => { inFlight = undefined; }).catch(() => undefined);
    return result;
  }

  function writeSource(channel: number, source: GridField | RawRecords, rawOptions?: { outsideRecord: Uint8Array; coverage?: SparseCoverage }): Promise<void> {
    return run(async () => {
      if (closed || finished || failed) check();
      try { check(); } catch (error) { return fail(error); }
      if (!Number.isSafeInteger(channel) || channel < 0 || channel >= layout.channelCount) throw new RangeError('Invalid sample channel index');
      if (written[channel]) throw new Error(`Sample channel ${channel} was already written`);
      const raw = source instanceof Uint8Array || typeof source === 'function';
      let packed: SparseCoverage | undefined;
      if (raw) {
        packed = rawOptions?.coverage ?? coverage;
        if (!compatibleCoverages.has(packed)) {
          if (!sameCoverage(coverage, packed)) throw new RangeError('Packed record coverage differs from layout');
          compatibleCoverages.add(packed);
        }
        if (!(rawOptions?.outsideRecord instanceof Uint8Array) || rawOptions.outsideRecord.byteLength !== recordBytes
          || (source instanceof Uint8Array && source.byteLength !== packed.offsets[packed.offsets.length - 1]! * recordBytes)) throw new RangeError('Invalid raw record shape');
      } else {
        if (recordBytes !== CELL_BYTES) throw new RangeError('Scalar writing requires five-byte records');
        if (!(source.values instanceof Float32Array) || !(source.flags instanceof Uint8Array) || source.flags.length !== source.values.length) throw new RangeError('Invalid sample field shape');
        packed = packedCoverage(source);
        const expected = packed ? packed.offsets[packed.offsets.length - 1] : layout.grid.width * layout.grid.height;
        if (source.values.length !== expected) throw new RangeError('Invalid sample field shape');
      }
      try {
        for (let shard = 0; shard < layout.shards.length; shard++) {
          check();
          await writeShardChannel(shard, channel, source, packed, rawOptions?.outsideRecord);
        }
        check();
      } catch (error) { return fail(error); }
      written[channel] = 1;
      completed++;
    });
  }

  return {
    writeChannel(channel: number, field: GridField): Promise<void> { return writeSource(channel, field); },
    /** Arrays follow sparse offsets; callbacks borrow one record per global grid index until copied. */
    writeRawChannel(channel: number, records: RawRecords, rawOptions: { outsideRecord: Uint8Array; coverage?: SparseCoverage }): Promise<void> {
      return writeSource(channel, records, rawOptions);
    },

    /** Borrow the assembly buffer until finish resolves or rejects. */
    finish(assembly?: Buffer): Promise<readonly ShardedSamplePackShard[]> {
      return run(async () => {
        if (closed || finished || failed) check();
        try { check(); } catch (error) { return fail(error); }
        if (completed !== layout.channelCount) return fail(new Error(`Incomplete sample pack: ${completed}/${layout.channelCount} channels`));
        const descriptors: ShardedSamplePackShard[] = [];
        try {
          const requiredBytes = samplePackAssemblyBufferBytes(layout.shards);
          if (assembly && assembly.byteLength < requiredBytes) throw new RangeError('Sample shard assembly buffer is too small');
          const workspace = assembly ?? Buffer.allocUnsafe(requiredBytes);
          for (let shard = 0; shard < layout.shards.length; shard++) {
            check();
            const descriptor = layout.shards[shard], shardBytes = descriptor.byteLength;
            const buffer = workspace.subarray(0, shardBytes), blocks: { cells: number; byteOffset: number }[] = [];
            let cells = 0;
            for (let ordinal = descriptor.firstBlock; ordinal < descriptor.firstBlock + descriptor.blockCount; ordinal++) {
              const block = layout.block(ordinal);
              blocks.push({ cells: block.width * block.height, byteOffset: block.byteOffset });
              cells += block.width * block.height;
            }
            const sectionBytes = shardBytes / layout.channelCount;
            if (!Number.isSafeInteger(sectionBytes) || sectionBytes % recordBytes !== 0) throw new Error('Invalid sample shard channel alignment');
            for (let channel = 0; channel < layout.channelCount; channel++) {
              check();
              const handle = await handleFor(shard);
              let seen = 0, blockIndex = 0, within = 0, remaining = sectionBytes, position = starts[shard][channel];
              while (remaining > 0) {
                check();
                const length = Math.min(chunk.length, remaining);
                if (length % recordBytes !== 0) throw new Error('Invalid sample shard chunk alignment');
                await readAll(handle, chunk, 0, length, position, check);
                for (let offset = 0; offset < length; offset += recordBytes) {
                  while (blockIndex + 1 < blocks.length && within === blocks[blockIndex].cells) { blockIndex++; within = 0; }
                  if (within >= blocks[blockIndex].cells) throw new Error('Sample shard channel data exceeds its blocks');
                  const destination = blocks[blockIndex].byteOffset + (within * layout.channelCount + channel) * recordBytes;
                  chunk.copy(buffer, destination, offset, offset + recordBytes);
                  within++; seen++;
                }
                position += length; remaining -= length;
              }
              if (seen !== cells) throw new Error('Sample shard channel data length mismatch');
            }
            await closeHandles();
            const temp = finalTempPaths[shard], handle = await open(temp, 'wx');
            created.add(temp);
            finalHandles.add(handle);
            try { await writeAll(handle, buffer, 0, buffer.byteLength, 0, check); }
            finally { await handle.close(); finalHandles.delete(handle); }
            check();
            await link(temp, finalPaths[shard]);
            linked.add(finalPaths[shard]);
            await rm(temp, { force: true });
            created.delete(temp);
            await rm(tempPaths[shard], { force: true });
            created.delete(tempPaths[shard]);
            descriptors.push({
              firstBlock: descriptor.firstBlock, blockCount: descriptor.blockCount,
              storedCells: shardBytes / (layout.channelCount * recordBytes), bytes: shardBytes,
              key: finalKeys[shard], sha256: sha256(buffer)
            });
          }
          check();
        } catch (error) { return fail(error); }
        finished = true; closed = true;
        return descriptors;
      });
    },

    async close(): Promise<void> {
      if (finished) return;
      closed = true;
      if (inFlight) await inFlight.catch(() => undefined);
      await cleanup();
    }
  };
}

export async function mergeShardedSamplePacks(
  layout: ShardedSamplePackLayout,
  inputs: readonly ShardedSamplePackInput[],
  target: ShardedSamplePackTarget,
  options: { signal?: AbortSignal } = {}
): Promise<readonly ShardedSamplePackShard[]> {
  assertLayout(layout);
  const recordBytes = layout.recordBytes;
  if (!inputs.length || inputs.length > MAX_SAMPLE_VALUES) throw new RangeError('Invalid sample pack input count');
  let channels = 0, sourceChannels = 0;
  for (const input of inputs) {
    assertChannels(input.channelCount);
    if ((input.recordBytes ?? CELL_BYTES) !== recordBytes) throw new RangeError('Sample record width mismatch');
    const selection = input.selection ?? { firstChannel: 0, channelCount: input.channelCount };
    if (![selection.firstChannel, selection.channelCount].every(Number.isSafeInteger) || selection.firstChannel < 0 || selection.channelCount < 1
        || selection.firstChannel + selection.channelCount > input.channelCount) throw new RangeError('Invalid sample channel selection');
    channels += selection.channelCount; sourceChannels += input.channelCount;
    if (channels > MAX_PACK_CHANNELS || sourceChannels > MAX_PACK_CHANNELS || typeof input.root !== 'string' || !input.root || !Array.isArray(input.shards) || !input.shards.length) throw new RangeError('Invalid sample pack input');
    let next = 0, stored = 0, previousKey = '';
    for (const shard of input.shards) {
      if (!Number.isSafeInteger(shard.firstBlock) || shard.firstBlock !== next || !Number.isSafeInteger(shard.blockCount) || shard.blockCount < 1
          || !/^[0-9a-f]{64}$/.test(shard.sha256) || typeof shard.key !== 'string' || !shard.key || shard.key === previousKey) {
        throw new Error('Invalid sample pack shard descriptor');
      }
      const end = shard.firstBlock + shard.blockCount;
      if (!Number.isSafeInteger(end) || end > layout.blockCount) throw new Error('Incomplete sample shard ranges');
      let cells = 0;
      for (let ordinal = shard.firstBlock; ordinal < end; ordinal++) cells += blockCells(layout, ordinal);
      const bytes = cells * input.channelCount * recordBytes;
      if (!Number.isSafeInteger(bytes) || shard.storedCells !== cells || shard.bytes !== bytes || bytes > SAMPLE_SHARD_TARGET_BYTES) throw new Error('Sample shard size mismatch');
      next = end; stored += cells; previousKey = shard.key;
    }
    if (next !== layout.blockCount || stored !== layout.storedCells) throw new Error('Incomplete sample shard ranges');
  }
  if (channels !== layout.channelCount) throw new RangeError('Sample pack channel total does not match layout');
  options.signal?.throwIfAborted();

  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const role = target.role ?? (target.group !== undefined && target.kind !== 'profiles' ? 'hour' : 'serving');
  const finalKeys = layout.shards.map((_, index) => sampleShardKey(target.model, target.buildId, target.surfaceId, index, target.group, target.kind, role));
  const finalPaths = finalKeys.map(key => localPath(target.root, key)), tempPaths = finalPaths.map(path => join(dirname(path), `.${basename(path)}.${suffix}.partial`));
  const linked = new Set<string>(), created = new Set<string>(), finalStride = layout.channelCount * recordBytes;
  const shardStates = layout.shards.map(() => ({ handle: undefined as FileHandle | undefined, hash: undefined as ReturnType<typeof createHash> | undefined, bytes: 0 }));
  const maxCells = maximumBlockCells(layout);
  const cursors = inputs.map(input => ({
    input, shard: 0, handle: undefined as FileHandle | undefined, hash: undefined as ReturnType<typeof createHash> | undefined,
    remaining: 0, position: 0, buffer: Buffer.allocUnsafe(maxCells * input.channelCount * recordBytes)
  }));

  async function openShard(cursor: (typeof cursors)[number]): Promise<void> {
    const descriptor = cursor.input.shards[cursor.shard];
    if (!descriptor) throw new Error('Incomplete sample shard ranges');
    const path = localPath(cursor.input.root, descriptor.key), handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== descriptor.bytes) throw new Error(`Sample shard has changed length: ${descriptor.key}`);
    } catch (error) { await handle.close(); throw error; }
    cursor.handle = handle; cursor.hash = createHash('sha256'); cursor.remaining = descriptor.bytes; cursor.position = 0;
  }

  async function closeShard(cursor: (typeof cursors)[number]): Promise<void> {
    const descriptor = cursor.input.shards[cursor.shard], handle = cursor.handle!, hash = cursor.hash!;
    cursor.handle = undefined;
    try {
      if (cursor.remaining !== 0) throw new Error(`Sample shard range mismatch: ${descriptor.key}`);
      if (hash.digest('hex') !== descriptor.sha256) throw new Error(`Sample shard hash mismatch: ${descriptor.key}`);
    } finally { await handle.close(); }
    cursor.shard++;
  }

  async function readBlock(cursor: (typeof cursors)[number], ordinal: number, bytes: number): Promise<void> {
    while (cursor.shard < cursor.input.shards.length) {
      const descriptor = cursor.input.shards[cursor.shard];
      if (ordinal < descriptor.firstBlock + descriptor.blockCount) break;
      if (!cursor.handle) throw new Error('Missing sample shard reader');
      await closeShard(cursor);
    }
    if (cursor.shard >= cursor.input.shards.length) throw new Error('Incomplete sample shard ranges');
    if (!cursor.handle) await openShard(cursor);
    if (bytes > cursor.remaining) throw new Error('Sample shard block crosses a shard boundary');
    await readAll(cursor.handle!, cursor.buffer, 0, bytes, cursor.position, () => options.signal?.throwIfAborted());
    cursor.hash!.update(cursor.buffer.subarray(0, bytes));
    cursor.position += bytes; cursor.remaining -= bytes;
    options.signal?.throwIfAborted();
  }

  async function cleanup(): Promise<void> {
    const closeResults = await Promise.allSettled([
      ...cursors.map(async cursor => { if (cursor.handle) await cursor.handle.close(); }),
      ...shardStates.map(async state => { if (state.handle) await state.handle.close(); })
    ]);
    const results = [...closeResults, ...await Promise.allSettled([...created, ...linked].map(path => rm(path, { force: true })))];
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Sample shard cleanup failed');
  }

  let shard = 0;
  const outputBuffer = Buffer.allocUnsafe(maxCells * finalStride);
  try {
    for (let ordinal = 0; ordinal < layout.blockCount; ordinal++) {
      options.signal?.throwIfAborted();
      const block = layout.block(ordinal), cells = block.width * block.height, outputBytes = cells * finalStride;
      const output = outputBuffer.subarray(0, outputBytes);
      let channelOffset = 0;
      for (const cursor of cursors) {
        const inputStride = cursor.input.channelCount * recordBytes;
        const selected = cursor.input.selection ?? { firstChannel: 0, channelCount: cursor.input.channelCount };
        const start = selected.firstChannel * recordBytes, copyBytes = selected.channelCount * recordBytes;
        await readBlock(cursor, ordinal, cells * inputStride);
        if (cursors.length === 1 && inputStride === finalStride && start === 0) cursor.buffer.copy(output, 0, 0, outputBytes);
        else for (let cell = 0; cell < cells; cell++) cursor.buffer.copy(output, cell * finalStride + channelOffset, cell * inputStride + start, cell * inputStride + start + copyBytes);
        channelOffset += copyBytes;
      }
      if (channelOffset !== finalStride) throw new Error('Sample channel ordering mismatch');
      while (ordinal >= layout.shards[shard].firstBlock + layout.shards[shard].blockCount) {
        await shardStates[shard].handle!.close();
        shardStates[shard].handle = undefined;
        shard++;
      }
      const state = shardStates[shard];
      if (!state.handle) {
        await mkdir(dirname(tempPaths[shard]), { recursive: true });
         state.handle = await open(tempPaths[shard], 'wx');
        created.add(tempPaths[shard]);
        state.hash = createHash('sha256');
      }
      await writeAll(state.handle!, output, 0, outputBytes, block.byteOffset, () => options.signal?.throwIfAborted());
      state.hash!.update(output); state.bytes += outputBytes;
    }
    for (const cursor of cursors) while (cursor.shard < cursor.input.shards.length) {
      if (!cursor.handle) throw new Error('Missing sample shard reader');
      await closeShard(cursor);
    }
    if (shardStates[shard].handle) {
      await shardStates[shard].handle!.close();
      shardStates[shard].handle = undefined;
    }
    const descriptors: ShardedSamplePackShard[] = [];
    for (let index = 0; index < layout.shards.length; index++) {
      options.signal?.throwIfAborted();
      const state = shardStates[index], descriptor = layout.shards[index];
      if (!state.hash || state.bytes !== descriptor.byteLength) throw new Error('Incomplete sample shard output');
      await link(tempPaths[index], finalPaths[index]);
      linked.add(finalPaths[index]);
      await rm(tempPaths[index], { force: true });
      created.delete(tempPaths[index]);
      descriptors.push({
        firstBlock: descriptor.firstBlock, blockCount: descriptor.blockCount,
        storedCells: descriptor.byteLength / finalStride, bytes: descriptor.byteLength,
        key: finalKeys[index], sha256: state.hash!.digest('hex')
      });
    }
    options.signal?.throwIfAborted();
    return descriptors;
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `Sample shard cleanup failed: ${String(error)}`); }
    throw error;
  }
}
