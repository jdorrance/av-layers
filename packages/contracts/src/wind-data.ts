import z from 'zod';
import { parseBoundedJson, ResourceLimitError } from './json.ts';
import type { Grid } from './geometry.ts';

export const WIND_HEIGHTS = [20, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000] as const;
export const WIND_OVERVIEW_TILE_SIZE = 32;
export const WIND_OVERVIEW_VALUES = WIND_HEIGHTS.length + 2;
export const WIND_OVERVIEW_CELL_BYTES = WIND_OVERVIEW_VALUES * 9;
export const WIND_CHUNK_LIMIT = 256 * 1024;
export const WIND_INDEX_ENTRIES = 512;
export const WIND_ROOT_LIMIT = 1024 * 1024;
export const WIND_FRAME_LIMIT = 32 * 1024;
export const WIND_FRAME_MAX_PAGES = 128;
export const WIND_FINE_CELL_BYTES = 10;

const pop8 = (v: number): number => {
  v -= (v >>> 1) & 0x55;
  v = (v & 0x33) + ((v >>> 2) & 0x33);
  return (v + (v >>> 4)) & 0x0f;
};

export interface TileMask {
  readonly count: number;
  readonly total: number;
  slot(tile: number): number;
}

export function encodeTileMask(present: Uint8Array, totalTiles: number): string | undefined {
  const expectedBytes = Math.ceil(totalTiles / 8);
  if (!Number.isSafeInteger(totalTiles) || totalTiles < 1 || present.length !== expectedBytes) throw new RangeError('Invalid tile mask length');
  const rem = totalTiles & 7;
  if (rem && (present[expectedBytes - 1]! >>> rem) !== 0) throw new RangeError('Invalid tile mask trailing bits');
  let count = 0;
  for (let i = 0; i < expectedBytes; i++) count += pop8(present[i]!);
  if (count === 0 || count === totalTiles) return undefined;
  let binary = '';
  for (let i = 0; i < expectedBytes; i++) binary += String.fromCharCode(present[i]!);
  return btoa(binary);
}

export function decodeTileMask(encoded: string | undefined, totalTiles: number): TileMask | null {
  if (!Number.isSafeInteger(totalTiles) || totalTiles < 1) throw new RangeError('Invalid tile mask total');
  if (encoded === undefined) return null;
  const expectedBytes = Math.ceil(totalTiles / 8);
  if (encoded.length !== Math.ceil(expectedBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid tile mask encoding');
  const raw = atob(encoded);
  if (raw.length !== expectedBytes || btoa(raw) !== encoded) throw new Error('Noncanonical tile mask encoding');
  const bytes = new Uint8Array(expectedBytes), ranks = new Uint32Array(expectedBytes + 1);
  let count = 0;
  for (let i = 0; i < expectedBytes; i++) {
    const b = raw.charCodeAt(i);
    bytes[i] = b; ranks[i] = count; count += pop8(b);
  }
  ranks[expectedBytes] = count;
  const rem = totalTiles & 7;
  if ((rem && (bytes[expectedBytes - 1]! >>> rem) !== 0) || count < 1 || count >= totalTiles) throw new Error('Invalid tile mask bit count');
  return {
    count,
    total: totalTiles,
    slot(tile: number): number {
      if (!Number.isSafeInteger(tile) || tile < 0 || tile >= totalTiles) return -1;
      const b = bytes[tile >> 3]!, bit = 1 << (tile & 7);
      return (b & bit) === 0 ? -1 : ranks[tile >> 3]! + pop8(b & (bit - 1));
    }
  };
}

export function windLayout(width: number, height: number, size: number, levels?: number, storedCount?: number) {
  const total = Math.ceil(width / size) * Math.ceil(height / size), count = storedCount ?? total;
  const chunkBytes = levels === undefined ? size ** 2 * WIND_FINE_CELL_BYTES : 12 + size ** 2 * (9 + 13 * levels);
  return { total, count, chunkBytes, pages: Math.ceil(count / WIND_INDEX_ENTRIES), pageCount: (page: number) => Math.min(WIND_INDEX_ENTRIES, count - page * WIND_INDEX_ENTRIES) };
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.strictObject({ sha256: digest, bytes: z.number().int().positive().max(WIND_FRAME_LIMIT) });
const shard = z.strictObject({ sha256: digest, bytes: z.number().int().positive().max(256 * 1024 * 1024), indexSha256: digest, count: z.number().int().positive().max(WIND_INDEX_ENTRIES) });
export const windDataSchema = z.strictObject({ version: z.literal(1), model: z.string(), buildId: z.string(),
  frames: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), ...reference.shape })).min(1).max(256)
});
export const windFrameSchema = z.strictObject({ version: z.literal(3), frame: z.string(), levels: z.number().int().min(1).max(256),
  tileSize: z.number().int().min(1).max(16), fineTileSize: z.literal(64),
  windMask: z.string().min(4).max(8192).optional(), fineMask: z.string().min(4).max(8192).optional(),
  wind: z.array(shard).min(1).max(WIND_FRAME_MAX_PAGES), fine: z.array(shard).min(1).max(WIND_FRAME_MAX_PAGES),
  overview: z.array(z.strictObject({ stride: z.number().int().min(2).max(65536), shards: z.array(shard).min(1).max(WIND_FRAME_MAX_PAGES) })).max(16).optional()
});
export type WindData = z.infer<typeof windDataSchema>;
export type WindFrame = z.infer<typeof windFrameSchema>;

export function parseWindFrame(bytes: Uint8Array): WindFrame {
  if (bytes.byteLength > WIND_FRAME_LIMIT) throw new ResourceLimitError('Wind frame exceeds byte budget');
  return windFrameSchema.parse(parseBoundedJson(bytes));
}

/** Bind chunk and shard sizes to the publication's native and fine grids. */
export function assertWindFrameLayout(frame: WindFrame, grids: { native: Pick<Grid, 'width' | 'height'>; fine: Pick<Grid, 'width' | 'height'> }): void {
  for (const kind of ['wind', 'fine'] as const) {
    const grid = kind === 'wind' ? grids.native : grids.fine;
    const size = kind === 'wind' ? frame.tileSize : frame.fineTileSize;
    const total = Math.ceil(grid.width / size) * Math.ceil(grid.height / size);
    if (!Number.isSafeInteger(total) || total < 1) throw new Error('Wind layout mismatch');
    const mask = decodeTileMask(kind === 'wind' ? frame.windMask : frame.fineMask, total);
    const { count, chunkBytes, pages, pageCount } = windLayout(grid.width, grid.height, size, kind === 'wind' ? frame.levels : undefined, mask?.count);
    if (!Number.isSafeInteger(count) || count < 1 || chunkBytes > WIND_CHUNK_LIMIT || frame[kind].length !== pages) throw new Error('Wind layout mismatch');
    for (const [page, shard] of frame[kind].entries()) {
      const expected = pageCount(page);
      if (shard.count !== expected || shard.bytes !== expected * chunkBytes) throw new Error('Wind shard layout mismatch');
    }
  }
  let previous = 1;
  for (const level of frame.overview ?? []) {
    if (level.stride !== previous * 2) throw new Error('Wind overview stride mismatch');
    previous = level.stride;
    const layout = windOverviewLayout(grids.native, level.stride);
    if (level.shards.length !== layout.pages || layout.chunkBytes > WIND_CHUNK_LIMIT) throw new Error('Wind overview layout mismatch');
    for (const [page, shard] of level.shards.entries()) {
      const expected = layout.pageCount(page);
      if (shard.count !== expected || shard.bytes !== expected * layout.chunkBytes) throw new Error('Wind overview shard layout mismatch');
    }
  }
}

export function windOverviewLayout(grid: Pick<Grid, 'width' | 'height'>, stride: number) {
  const width = Math.ceil(grid.width / stride), height = Math.ceil(grid.height / stride);
  const count = Math.ceil(width / WIND_OVERVIEW_TILE_SIZE) * Math.ceil(height / WIND_OVERVIEW_TILE_SIZE);
  return { width, height, count, chunkBytes: WIND_OVERVIEW_TILE_SIZE ** 2 * WIND_OVERVIEW_CELL_BYTES, pages: Math.ceil(count / WIND_INDEX_ENTRIES), pageCount: (page: number) => Math.min(WIND_INDEX_ENTRIES, count - page * WIND_INDEX_ENTRIES) };
}

export function windFrameParts(frame: WindFrame): Array<{ kind: string; shards: WindFrame['wind'] }> {
  return [{ kind: 'wind', shards: frame.wind }, { kind: 'fine', shards: frame.fine }, ...(frame.overview ?? []).map(level => ({ kind: `overview-${level.stride}`, shards: level.shards }))];
}
