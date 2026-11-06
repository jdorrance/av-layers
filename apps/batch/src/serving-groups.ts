import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CELL_BYTES, SAMPLE_BLOCK_SIZE, type Grid } from '@av/contracts';
import { prepareShardedSamplePackLayout, type ShardedSamplePackLayout } from '@av/forecast';
import { BUILD_BUDGETS, MAX_V5_SHARD_BYTES } from './capacity.js';
import { putImmutableReceipt, type ObjectReceipt } from './immutable-upload.js';
import { createLocalFileReader, localPath } from './local-file.js';
import { mergeShardedSamplePacks, sampleShardKey, type ShardedSamplePackInput } from './sample-pack-v5.js';
import type { ObjectStorage } from './storage.js';

const SERVING_GROUP_FRAMES = 24;

export interface HourSampleShard {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly firstBlock: number;
  readonly blockCount: number;
  readonly storedCells: number;
}

export interface HourSamplePart {
  readonly firstFrame: number;
  readonly frameCount: number;
  readonly shards: readonly HourSampleShard[];
}

export interface ServingSampleShard {
  readonly group: number;
  readonly firstFrame: number;
  readonly frameCount: number;
  readonly blockShard: number;
  readonly firstBlock: number;
  readonly blockCount: number;
  readonly storedCells: number;
  readonly bytes: number;
  readonly key: string;
  readonly sha256: string;
}

interface ServingPlan {
  readonly model: string;
  readonly buildId: string;
  readonly surfaceId: string;
  readonly grid: Pick<Grid, 'width' | 'height' | 'wrapLongitude'>;
  readonly blockIds: Uint32Array;
  readonly layers: number;
  readonly parts: readonly HourSamplePart[];
}

interface PlannedSource {
  readonly partIndex: number;
  readonly sourceFrame: number;
  readonly frames: number;
}

type PlannedShard = Omit<ServingSampleShard, 'sha256'>;

interface PlannedGroup {
  readonly group: number;
  readonly firstFrame: number;
  readonly frameCount: number;
  readonly layout: ShardedSamplePackLayout;
  readonly sources: readonly PlannedSource[];
  readonly shards: readonly PlannedShard[];
}

function assertHourLayout(layout: ShardedSamplePackLayout, shards: readonly HourSampleShard[]): void {
  if (layout.shards.length !== shards.length) throw new Error('Forecast shard surface layout mismatch');
  for (const [index, shard] of layout.shards.entries()) {
    const item = shards[index]!, cells = shard.byteLength / (layout.channelCount * layout.recordBytes);
    if (item.firstBlock !== shard.firstBlock || item.blockCount !== shard.blockCount || item.bytes !== shard.byteLength || item.storedCells !== cells) {
      throw new Error('Forecast shard surface layout mismatch');
    }
  }
}

function planGroups(input: ServingPlan): PlannedGroup[] {
  if (!input.parts.length || input.parts[0]!.firstFrame !== 0 || !Number.isSafeInteger(input.layers) || input.layers < 1) throw new Error('Sample serving groups must start at frame 0');
  let cursor = 0;
  for (const part of input.parts) {
    if (part.firstFrame !== cursor || !Number.isSafeInteger(part.frameCount) || part.frameCount < 1) throw new Error('Sample serving group has a frame gap');
    cursor += part.frameCount;
  }
  for (const part of input.parts) {
    const layout = prepareShardedSamplePackLayout(input.grid, input.blockIds, part.frameCount * input.layers, MAX_V5_SHARD_BYTES);
    assertHourLayout(layout, part.shards);
  }
  const groups: PlannedGroup[] = [];
  for (let firstFrame = 0, group = 0; firstFrame < cursor; group++) {
    const frameCount = Math.min(SERVING_GROUP_FRAMES, cursor - firstFrame), end = firstFrame + frameCount;
    const sources: PlannedSource[] = [];
    let covered = firstFrame;
    for (const [partIndex, part] of input.parts.entries()) {
      const from = Math.max(part.firstFrame, firstFrame), to = Math.min(part.firstFrame + part.frameCount, end);
      if (from >= to) continue;
      if (from !== covered) throw new Error('Sample serving group has a frame gap');
      sources.push({ partIndex, sourceFrame: from - part.firstFrame, frames: to - from });
      covered = to;
    }
    if (covered !== end) throw new Error('Sample serving group has a frame gap');
    const layout = prepareShardedSamplePackLayout(input.grid, input.blockIds, frameCount * input.layers, MAX_V5_SHARD_BYTES);
    const shards = layout.shards.map((shard, blockShard): PlannedShard => ({
      group, firstFrame, frameCount, blockShard, firstBlock: shard.firstBlock, blockCount: shard.blockCount,
      storedCells: shard.byteLength / (layout.channelCount * CELL_BYTES), bytes: shard.byteLength,
      key: sampleShardKey(input.model, input.buildId, input.surfaceId, blockShard, group)
    }));
    groups.push({ group, firstFrame, frameCount, layout, sources, shards });
    firstFrame = end;
  }
  return groups;
}

export function servingSampleShards(input: ServingPlan): PlannedShard[] {
  return planGroups(input).flatMap(group => group.shards);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Additional disk holds outputs and live remote inputs; local inputs use hardlinks. */
export function servingGroupResources(input: ServingPlan, localInputs: ReadonlySet<string> = new Set()): { diskBytes: number; workingBytes: number; sourceBytes: number; outputBytes: number } {
  const groups = planGroups(input), partBytes = input.parts.map(part => part.shards.reduce((n, shard) => n + shard.bytes, 0));
  const stagedBytes = input.parts.map(part => part.shards.reduce((n, shard) => n + (localInputs.has(shard.key) ? 0 : shard.bytes), 0));
  const lastUse = input.parts.map((_, index) => Math.max(...groups.filter(group => group.sources.some(source => source.partIndex === index)).map(group => group.group)));
  const staged = new Set<number>();
  let diskBytes = 0, outputBytes = 0, sourceBytes = 0, mergeBytes = 0;
  for (const group of groups) {
    for (const source of group.sources) if (!staged.has(source.partIndex)) { staged.add(source.partIndex); sourceBytes += partBytes[source.partIndex]!; }
    const retained = [...staged].reduce((n, index) => n + stagedBytes[index]!, 0);
    outputBytes += group.layout.byteLength;
    diskBytes = Math.max(diskBytes, outputBytes + retained);
    mergeBytes = Math.max(mergeBytes, (SAMPLE_BLOCK_SIZE + 1) ** 2 * CELL_BYTES * (group.layout.channelCount + group.sources.reduce((n, source) => n + input.parts[source.partIndex]!.frameCount * input.layers, 0)));
    for (const index of staged) if (lastUse[index] === group.group) staged.delete(index);
  }
  if (![diskBytes, sourceBytes, outputBytes, mergeBytes].every(Number.isSafeInteger) || outputBytes > BUILD_BUDGETS.numericBytes || sourceBytes > BUILD_BUDGETS.numericBytes) throw new Error('Serving sample bytes exceed build budget');
  // Borrowed local/upload buffer plus bounded SDK body, concatenation and transport storage.
  return { diskBytes, workingBytes: 4 * MAX_V5_SHARD_BYTES + mergeBytes, sourceBytes, outputBytes };
}

/** Stage each verified input once; merger cursors retain only individual blocks. */
export async function writeServingGroups(input: ServingPlan & { root: string; store?: ObjectStorage; signal?: AbortSignal }): Promise<{ shards: ServingSampleShard[]; objects: ObjectReceipt[] }> {
  const groups = planGroups(input), localInputs = new Set<string>();
  input.signal?.throwIfAborted();
  await mkdir(input.root, { recursive: true });
  // These canonical outputs belong to this compaction attempt; immutable remote keys remain protected.
  for (const group of groups) for (const shard of group.shards) await rm(localPath(input.root, shard.key), { force: true });
  for (const part of input.parts) for (const shard of part.shards) {
    input.signal?.throwIfAborted();
    try {
      const file = await stat(localPath(input.root, shard.key));
      if (!file.isFile() || file.size !== shard.bytes) throw new Error(`Local sample hour shard changed: ${shard.key}`);
      localInputs.add(shard.key);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const resources = servingGroupResources(input, localInputs);
  const disk = await statfs(input.root);
  if (disk.bavail * disk.bsize < resources.diskBytes) throw new Error(`Insufficient serving compaction disk: requires ${resources.diskBytes} bytes`);
  if (process.memoryUsage().rss + resources.workingBytes > BUILD_BUDGETS.peakRssBytes) throw new Error('Serving compaction exceeds memory budget');
  const staging = await mkdtemp(join(input.root, '.serving-')), read = createLocalFileReader(MAX_V5_SHARD_BYTES);
  const staged = new Set<number>(), lastUse = input.parts.map((_, index) => Math.max(...groups.filter(group => group.sources.some(source => source.partIndex === index)).map(group => group.group)));
  const shards: ServingSampleShard[] = [], objects: ObjectReceipt[] = [];
  async function stage(hour: HourSampleShard): Promise<void> {
    input.signal?.throwIfAborted();
    const destination = localPath(staging, hour.key);
    await mkdir(dirname(destination), { recursive: true });
    if (localInputs.has(hour.key)) {
      await link(localPath(input.root, hour.key), destination);
      return;
    }
    if (!input.store) throw new Error(`Missing sample hour shard ${hour.key}`);
    const object = await input.store.get(hour.key, undefined, hour.bytes, input.signal);
    input.signal?.throwIfAborted();
    if (!object || object.bytes.byteLength !== hour.bytes || digest(object.bytes) !== hour.sha256) throw new Error(`Sample hour shard hash mismatch: ${hour.key}`);
    await writeFile(destination, object.bytes, { flag: 'wx', signal: input.signal });
  }
  try {
    for (const group of groups) {
      input.signal?.throwIfAborted();
      for (const source of group.sources) if (!staged.has(source.partIndex)) {
        for (const hour of input.parts[source.partIndex]!.shards) await stage(hour);
        staged.add(source.partIndex);
      }
      const sources: ShardedSamplePackInput[] = group.sources.map(source => ({ root: staging,
        channelCount: input.parts[source.partIndex]!.frameCount * input.layers,
        selection: { firstChannel: source.sourceFrame * input.layers, channelCount: source.frames * input.layers },
        shards: input.parts[source.partIndex]!.shards }));
      const merged = await mergeShardedSamplePacks(group.layout, sources,
        { root: input.root, model: input.model, buildId: input.buildId, surfaceId: input.surfaceId, group: group.group, role: 'serving' }, { signal: input.signal });
      for (const [index, shard] of merged.entries()) {
        input.signal?.throwIfAborted();
        shards.push({ ...group.shards[index]!, sha256: shard.sha256 });
        if (input.store) await read(localPath(input.root, shard.key), shard.bytes, async bytes => {
          objects.push(await putImmutableReceipt(input.store!, shard.key, bytes, 'application/octet-stream', input.signal, shard.sha256));
        }, input.signal);
      }
      for (const index of staged) if (lastUse[index] === group.group) {
        for (const hour of input.parts[index]!.shards) await rm(localPath(staging, hour.key), { force: true });
        staged.delete(index);
      }
    }
    return { shards, objects };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
