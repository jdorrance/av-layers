import { z } from 'zod';
import { gridSchema } from './geometry.js';

const blob = z.object({ bytes: z.number().int().positive().max(512 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
/** Hash the exact UTF-8 descriptor bytes; all bitsets live beneath that content identity. */
export const coverageDescriptorSchema = z.object({
  version: z.literal(1), id: z.string().min(1).max(128), grid: gridSchema,
  bounds: z.tuple([z.number().finite(), z.number().min(-90).max(90), z.number().finite(), z.number().min(-90).max(90)]),
  policy: z.string().min(1).max(4096), maxZoom: z.number().int().min(0).max(8),
  supportHaloCells: z.number().int().min(0).max(64),
  sampleLayout: z.object({ format: z.literal('cell-major-blocks-v1'), blockSize: z.literal(16) }),
  files: z.object({ output: blob, halo: blob, tiles: blob })
}).superRefine((value, context) => {
  const cells = value.grid.width * value.grid.height;
  const cellBytes = Math.ceil(cells / 8), tileBytes = Math.ceil(((4 ** (value.maxZoom + 1) - 1) / 3) / 8);
  if (!Number.isSafeInteger(cells) || cells > 4_000_000 || value.files.output.bytes !== cellBytes || value.files.halo.bytes !== cellBytes || value.files.tiles.bytes !== tileBytes) {
    context.addIssue({ code: 'custom', message: 'Coverage bitset dimensions exceed the admitted layout or disagree with the grid' });
  }
  const [west, south, east, north] = value.bounds;
  if (west < -180 || west > 180 || east < -180 || east > 180 || west == east || south >= north) context.addIssue({ code: 'custom', message: 'Invalid coverage bounds' });
});
export type CoverageDescriptor = z.infer<typeof coverageDescriptorSchema>;
export const coveragePrefix = (hash: string): string => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid coverage hash');
  return `coverage/${hash}`;
};
