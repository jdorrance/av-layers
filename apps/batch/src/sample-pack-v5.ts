import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CELL_BYTES, MAX_SAMPLE_VALUES, SAMPLE_BLOCK_SIZE, STATUS_OUTSIDE, sparseCoverageLookup, type SparseCoverage } from '@av/contracts';
import { SAMPLE_SHARD_TARGET_BYTES, type GridField, type PackedGridField, type ShardedSamplePackLayout } from '@av/forecast';
import { localPath } from './validate.js';

const WRITE_CHUNK_BYTES = Math.floor(1024 * 1024 / CELL_BYTES) * CELL_BYTES;
const MAX_OPEN_SHARDS = 32;
const MAX_BLOCK_CELLS = (SAMPLE_BLOCK_SIZE + 1) * (SAMPLE_BLOCK_SIZE + 1);

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
}

export interface ShardedSamplePackInput {
  readonly root: string;
  readonly channelCount: number;
  readonly shards: readonly ShardedSamplePackShard[];
}

function component(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) throw new RangeError(`Invalid sample shard ${name}`);
  return value;
}

export function sampleShardKey(model: string, buildId: string, surfaceId: string, index: number, group?: number): string {
  component(model, 'model');
  component(buildId, 'build ID');
  component(surfaceId, 'surface ID');
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid sample shard index');
  if (group !== undefined && (!Number.isSafeInteger(group) || group < 0)) throw new RangeError('Invalid sample frame group');
  return `builds/${model}/${buildId}/surfaces/${surfaceId}/samples/${group === undefined ? index : `g${group}-b${index}`}.bin`;
}

function assertChannels(channelCount: number): void {
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > MAX_SAMPLE_VALUES) throw new RangeError('Invalid sample channel count');
}

function assertLayout(layout: ShardedSamplePackLayout): void {
  if (!layout || !Number.isSafeInteger(layout.blockCount) || layout.blockCount < 1 || !Number.isSafeInteger(layout.storedCells) || layout.storedCells < 1 || !Array.isArray(layout.shards) || !layout.shards.length) throw new RangeError('Invalid sharded sample layout');
  assertChannels(layout.channelCount);
}

function blockCells(layout: ShardedSamplePackLayout, ordinal: number): number {
  const block = layout.block(ordinal);
  return block.width * block.height;
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
  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const finalKeys = layout.shards.map((_, index) => sampleShardKey(target.model, target.buildId, target.surfaceId, index, target.group));
  const finalPaths = finalKeys.map(key => localPath(target.root, key));
  const tempPaths = finalPaths.map(path => join(dirname(path), `.${basename(path)}.${suffix}.channels`));
  const finalTempPaths = finalPaths.map(path => join(dirname(path), `.${basename(path)}.${suffix}.partial`));
  const starts = layout.shards.map(() => new Array<number>(layout.channelCount).fill(-1));
  const ends = layout.shards.map(() => 0);
  const written = new Uint8Array(layout.channelCount), compatibleCoverages = new WeakSet<SparseCoverage>([coverage]);
  const handles = new Map<number, FileHandle>(), finalHandles = new Set<FileHandle>(), created = new Set<string>(), linked = new Set<string>(), blockBuffer = Buffer.allocUnsafe(MAX_BLOCK_CELLS * CELL_BYTES);
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

  async function writeShardChannel(shard: number, channel: number, field: GridField, packed: SparseCoverage | undefined): Promise<void> {
    const descriptor = layout.shards[shard], sectionBytes = descriptor.byteLength / layout.channelCount;
    const chunk = Buffer.allocUnsafe(Math.min(sectionBytes, WRITE_CHUNK_BYTES));
    const width = layout.grid.width, wrap = layout.grid.wrapLongitude, { flags } = field;
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
      for (let i = 0; i < cells; i++) {
        const x = i % block.width, y = (i - x) / block.width;
        const column = wrap ? (block.column + x) % width : block.column + x;
        const row = block.row + y, destination = i * CELL_BYTES;
        const lookup = sparseCoverageLookup(coverage, column, row);
        if (!lookup) {
          blockBuffer[destination] = 0; blockBuffer[destination + 1] = 0; blockBuffer[destination + 2] = 0; blockBuffer[destination + 3] = 0;
          blockBuffer[destination + 4] = STATUS_OUTSIDE;
          continue;
        }
        const index = packed ? (packed === coverage ? lookup.offset : sparseCoverageLookup(packed, column, row)!.offset) : row * width + column;
        blockBuffer.writeFloatLE(field.values[index], destination);
        blockBuffer[destination + 4] = flags[index];
      }
      const blockBytes = cells * CELL_BYTES;
      if (chunkFill + blockBytes > chunk.length) await flush();
      blockBuffer.copy(chunk, chunkFill, 0, blockBytes);
      chunkFill += blockBytes;
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

  return {
    writeChannel(channel: number, field: GridField): Promise<void> {
      return run(async () => {
        if (closed || finished || failed) check();
        try { check(); } catch (error) { return fail(error); }
        if (!Number.isSafeInteger(channel) || channel < 0 || channel >= layout.channelCount) throw new RangeError('Invalid sample channel index');
        if (written[channel]) throw new Error(`Sample channel ${channel} was already written`);
        if (!(field.values instanceof Float32Array) || !(field.flags instanceof Uint8Array) || field.flags.length !== field.values.length) throw new RangeError('Invalid sample field shape');
        const packed = packedCoverage(field);
        const expected = packed ? packed.offsets[packed.offsets.length - 1] : layout.grid.width * layout.grid.height;
        if (field.values.length !== expected) throw new RangeError('Invalid sample field shape');
        try {
          for (let shard = 0; shard < layout.shards.length; shard++) {
            check();
            await writeShardChannel(shard, channel, field, packed);
          }
          check();
        } catch (error) { return fail(error); }
        written[channel] = 1;
        completed++;
      });
    },

    finish(): Promise<readonly ShardedSamplePackShard[]> {
      return run(async () => {
        if (closed || finished || failed) check();
        try { check(); } catch (error) { return fail(error); }
        if (completed !== layout.channelCount) return fail(new Error(`Incomplete sample pack: ${completed}/${layout.channelCount} channels`));
        const descriptors: ShardedSamplePackShard[] = [];
        try {
          for (let shard = 0; shard < layout.shards.length; shard++) {
            check();
            const descriptor = layout.shards[shard], shardBytes = descriptor.byteLength;
            const buffer = Buffer.allocUnsafe(shardBytes), blocks: { cells: number; byteOffset: number }[] = [];
            let cells = 0;
            for (let ordinal = descriptor.firstBlock; ordinal < descriptor.firstBlock + descriptor.blockCount; ordinal++) {
              const block = layout.block(ordinal);
              blocks.push({ cells: block.width * block.height, byteOffset: block.byteOffset });
              cells += block.width * block.height;
            }
            const sectionBytes = shardBytes / layout.channelCount;
            if (!Number.isSafeInteger(sectionBytes) || sectionBytes % CELL_BYTES !== 0) throw new Error('Invalid sample shard channel alignment');
            const chunk = Buffer.allocUnsafe(Math.min(sectionBytes, WRITE_CHUNK_BYTES));
            for (let channel = 0; channel < layout.channelCount; channel++) {
              check();
              const handle = await handleFor(shard);
              let seen = 0, blockIndex = 0, within = 0, remaining = sectionBytes, position = starts[shard][channel];
              while (remaining > 0) {
                check();
                const length = Math.min(chunk.length, remaining);
                if (length % CELL_BYTES !== 0) throw new Error('Invalid sample shard chunk alignment');
                await readAll(handle, chunk, 0, length, position, check);
                for (let offset = 0; offset < length; offset += CELL_BYTES) {
                  while (blockIndex + 1 < blocks.length && within === blocks[blockIndex].cells) { blockIndex++; within = 0; }
                  if (within >= blocks[blockIndex].cells) throw new Error('Sample shard channel data exceeds its blocks');
                  const destination = blocks[blockIndex].byteOffset + (within * layout.channelCount + channel) * CELL_BYTES;
                  chunk.copy(buffer, destination, offset, offset + CELL_BYTES);
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
              storedCells: shardBytes / (layout.channelCount * CELL_BYTES), bytes: shardBytes,
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
  if (!inputs.length || inputs.length > MAX_SAMPLE_VALUES) throw new RangeError('Invalid sample pack input count');
  let channels = 0;
  for (const input of inputs) {
    assertChannels(input.channelCount);
    channels += input.channelCount;
    if (channels > MAX_SAMPLE_VALUES || typeof input.root !== 'string' || !input.root || !Array.isArray(input.shards) || !input.shards.length) throw new RangeError('Invalid sample pack input');
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
      const bytes = cells * input.channelCount * CELL_BYTES;
      if (!Number.isSafeInteger(bytes) || shard.storedCells !== cells || shard.bytes !== bytes || bytes > SAMPLE_SHARD_TARGET_BYTES) throw new Error('Sample shard size mismatch');
      next = end; stored += cells; previousKey = shard.key;
    }
    if (next !== layout.blockCount || stored !== layout.storedCells) throw new Error('Incomplete sample shard ranges');
  }
  if (channels !== layout.channelCount) throw new RangeError('Sample pack channel total does not match layout');
  options.signal?.throwIfAborted();

  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const finalKeys = layout.shards.map((_, index) => sampleShardKey(target.model, target.buildId, target.surfaceId, index, target.group));
  const finalPaths = finalKeys.map(key => localPath(target.root, key)), tempPaths = finalPaths.map(path => join(dirname(path), `.${basename(path)}.${suffix}.partial`));
  const linked = new Set<string>(), created = new Set<string>(), finalStride = layout.channelCount * CELL_BYTES;
  const shardStates = layout.shards.map(() => ({ handle: undefined as FileHandle | undefined, hash: undefined as ReturnType<typeof createHash> | undefined, bytes: 0 }));
  const cursors = inputs.map(input => ({
    input, shard: 0, handle: undefined as FileHandle | undefined, hash: undefined as ReturnType<typeof createHash> | undefined,
    remaining: 0, position: 0, buffer: Buffer.allocUnsafe(MAX_BLOCK_CELLS * input.channelCount * CELL_BYTES)
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
  try {
    for (let ordinal = 0; ordinal < layout.blockCount; ordinal++) {
      options.signal?.throwIfAborted();
      const block = layout.block(ordinal), cells = block.width * block.height, outputBytes = cells * finalStride;
      const output = Buffer.allocUnsafe(outputBytes);
      let channelOffset = 0;
      for (const cursor of cursors) {
        const inputStride = cursor.input.channelCount * CELL_BYTES;
        await readBlock(cursor, ordinal, cells * inputStride);
        if (cursors.length === 1 && inputStride === finalStride) cursor.buffer.copy(output, 0, 0, outputBytes);
        else for (let cell = 0; cell < cells; cell++) cursor.buffer.copy(output, cell * finalStride + channelOffset, cell * inputStride, (cell + 1) * inputStride);
        channelOffset += inputStride;
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
