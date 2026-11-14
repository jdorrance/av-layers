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
export function windLayout(width: number, height: number, size: number, levels?: number) {
  const count = Math.ceil(width / size) * Math.ceil(height / size);
  const chunkBytes = levels === undefined ? size ** 2 * WIND_FINE_CELL_BYTES : 12 + size ** 2 * (9 + 13 * levels);
  return { count, chunkBytes, pages: Math.ceil(count / WIND_INDEX_ENTRIES), pageCount: (page: number) => Math.min(WIND_INDEX_ENTRIES, count - page * WIND_INDEX_ENTRIES) };
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.strictObject({ sha256: digest, bytes: z.number().int().positive().max(WIND_FRAME_LIMIT) });
const shard = z.strictObject({ sha256: digest, bytes: z.number().int().positive().max(256 * 1024 * 1024), indexSha256: digest, count: z.number().int().positive().max(WIND_INDEX_ENTRIES) });
export const windDataSchema = z.strictObject({ version: z.literal(1), model: z.string(), buildId: z.string(),
  frames: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), ...reference.shape })).min(1).max(256)
});
export const windFrameSchema = z.strictObject({ version: z.literal(3), frame: z.string(), levels: z.number().int().min(1).max(256),
  tileSize: z.number().int().min(1).max(16), fineTileSize: z.literal(64), wind: z.array(shard).min(1).max(WIND_FRAME_MAX_PAGES), fine: z.array(shard).min(1).max(WIND_FRAME_MAX_PAGES),
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
    const { count, chunkBytes, pages, pageCount } = windLayout(grid.width, grid.height, size, kind === 'wind' ? frame.levels : undefined);
    if (!Number.isSafeInteger(count) || count < 1 || chunkBytes > WIND_CHUNK_LIMIT || frame[kind].length !== pages) throw new Error('Wind layout mismatch');
    for (const [page, shard] of frame[kind].entries()) {
      const count = pageCount(page);
      if (shard.count !== count || shard.bytes !== count * chunkBytes) throw new Error('Wind shard layout mismatch');
    }
  }
  let previous = 1;
  for (const level of frame.overview ?? []) {
    if (level.stride !== previous * 2) throw new Error('Wind overview stride mismatch');
    previous = level.stride;
    const layout = windOverviewLayout(grids.native, level.stride);
    if (level.shards.length !== layout.pages || layout.chunkBytes > WIND_CHUNK_LIMIT) throw new Error('Wind overview layout mismatch');
    for (const [page, shard] of level.shards.entries()) {
      const count = layout.pageCount(page);
      if (shard.count !== count || shard.bytes !== count * layout.chunkBytes) throw new Error('Wind overview shard layout mismatch');
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
