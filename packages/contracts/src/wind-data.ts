import z from 'zod';
import { parseBoundedJson, ResourceLimitError } from './json.ts';

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
  tileSize: z.number().int().min(1).max(16), fineTileSize: z.literal(64), wind: z.array(shard).min(1).max(WIND_FRAME_MAX_PAGES), fine: z.array(shard).min(1).max(WIND_FRAME_MAX_PAGES)
});
export type WindData = z.infer<typeof windDataSchema>;
export type WindFrame = z.infer<typeof windFrameSchema>;

export function parseWindFrame(bytes: Uint8Array): WindFrame {
  if (bytes.byteLength > WIND_FRAME_LIMIT) throw new ResourceLimitError('Wind frame exceeds byte budget');
  return windFrameSchema.parse(parseBoundedJson(bytes));
}
