import z from 'zod';

export const MODEL_IDS = ['gfs', 'hrrr', 'icon-armenia'] as const;
export const LAYER_IDS = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const;
export const modelIdSchema = z.enum(MODEL_IDS);
export const layerIdSchema = z.enum(LAYER_IDS);
export type ModelId = z.infer<typeof modelIdSchema>;
export type LayerId = z.infer<typeof layerIdSchema>;
export const gridSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive(), lon0: z.number().finite(), lat0: z.number().finite(), dx: z.number().finite().refine(v => v !== 0), dy: z.number().finite().refine(v => v !== 0), wrapLongitude: z.boolean() });
export type Grid = z.infer<typeof gridSchema>;
export const GFS_GRID: Grid = { width: 1440, height: 721, lon0: -180, lat0: 90, dx: 0.25, dy: -0.25, wrapLongitude: true };
export const CELL_BYTES = 5;
export const STATUS_VALID = 0, STATUS_NO_LIFT = 1, STATUS_UNAVAILABLE = 2, STATUS_OUTSIDE = 3, STATUS_MASK = 3;
export const SUPPORT_PARCEL_CROSSING = 4, SUPPORT_PROFILE_TOP = 8, SUPPORT_PBL_CLOSURE = 16, SUPPORT_MASK = 28;

export interface CoverageMask { grid: Grid; output: Uint8Array; halo: Uint8Array; tiles: Uint8Array; maxZoom: number }
export function getBit(bits: Uint8Array, index: number): boolean { return Number.isSafeInteger(index) && index >= 0 && index < bits.length * 8 && (bits[Math.floor(index / 8)] & (1 << (index % 8))) !== 0; }
export function setBit(bits: Uint8Array, index: number, value = true): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bits.length * 8) throw new RangeError('bit index out of bounds');
  const i = Math.floor(index / 8), bit = 1 << (index % 8);
  bits[i] = value ? bits[i] | bit : bits[i] & ~bit;
}
const snap = (n: number) => Math.abs(n - Math.round(n)) <= 1e-10 ? Math.round(n) : n;
export function isCovered(mask: CoverageMask, lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -55 || lat > 65 || lon < -180 || lon > 180) return false;
  const { grid } = mask;
  let x = snap((lon - grid.lon0) / grid.dx);
  const y = snap((lat - grid.lat0) / grid.dy);
  if (grid.wrapLongitude) x = snap(((x % grid.width) + grid.width) % grid.width);
  if ((!grid.wrapLongitude && (x < -0.5 || x > grid.width - 0.5)) || y < -0.5 || y > grid.height - 0.5) return false;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const c0 = grid.wrapLongitude ? ((x0 % grid.width) + grid.width) % grid.width : x0;
  const c1 = grid.wrapLongitude ? (((x0 + 1) % grid.width) + grid.width) % grid.width : x0 + 1;
  const col = fx === 0 ? c0 : fx < 0.5 ? c0 : fx > 0.5 ? c1 : Math.min(c0, c1);
  const row = fy <= 0.5 ? Math.max(0, y0) : Math.min(grid.height - 1, y0 + 1);
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return false;
  return getBit(mask.output, row * grid.width + col);
}
export function isTileCovered(mask: CoverageMask, z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || z < 0 || z > mask.maxZoom || z > 24 || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return false;
  return getBit(mask.tiles, (4 ** z - 1) / 3 + y * 2 ** z + x);
}
export function expectedTiles(mask: CoverageMask, z: number): { z: number; x: number; y: number }[] {
  if (!Number.isInteger(z) || z < 0 || z > mask.maxZoom || z > 24) return [];
  const result: { z: number; x: number; y: number }[] = [];
  for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) if (isTileCovered(mask, z, x, y)) result.push({ z, x, y });
  return result;
}

export const LIFT_EDGES = [0,300,600,900,1200,1500,1850,2150,2450,2750,3050,3350,3650,3950,4250,4550,4900,5200,5500,5800,6100,6400,6700] as const;
export const LIFT_COLORS = ['#55184d','#b93b88','#8f7fac','#62cbff','#0168ff','#00345d','#036d00','#35cd34','#9dff64','#fefa02','#cbc939','#d59b99','#d3595a','#f92d2d','#9b0900','#d87400','#ffa50b','#f1cd5d','#a6a7a9','#516565','#1c4f4f','#003333'] as const;
export const RAIN_EDGES = [0.1,0.5,1,2,5,10,20,50] as const;
export const RAIN_COLORS = ['#b9e5ff','#66b3ff','#2d78d2','#36a657','#f0dc43','#f09b32','#dc493c','#963f9c'] as const;
export const PALETTES = { lift: { id: 'lift', edges: LIFT_EDGES, colors: LIFT_COLORS, units: 'm', noLiftColor: LIFT_COLORS[0] }, rain: { id: 'rain', edges: RAIN_EDGES, colors: RAIN_COLORS, units: 'mm/h', transparentBelow: 0.1, provisional: true } } as const;
export const LAYERS = { 'usable-lift-msl': { id: 'usable-lift-msl', units: 'm MSL', palette: 'lift' }, 'usable-lift-agl': { id: 'usable-lift-agl', units: 'm AGL', palette: 'lift' }, 'precip-rate': { id: 'precip-rate', units: 'mm/h', palette: 'rain' } } as const;
export function paletteBinLabel(edges: readonly number[], colorCount: number, index: number): string {
  const from = edges[index], to = edges[index + 1];
  if (to === undefined) return `≥ ${from}`;
  return index === colorCount - 1 ? `${from}–${to}+` : `${from}–${to}`;
}
export function paletteColor(layer: LayerId, value: number | null, status: number): string | null {
  if ((status & STATUS_MASK) >= STATUS_UNAVAILABLE) return null;
  if (layer !== 'precip-rate' && (status & STATUS_MASK) === STATUS_NO_LIFT) return LIFT_COLORS[0];
  if (value === null || !Number.isFinite(value)) return null;
  if (layer === 'precip-rate') { if (value < 0.1) return null; let i = 0; while (i + 1 < RAIN_EDGES.length && value >= RAIN_EDGES[i + 1]) i++; return RAIN_COLORS[i]; }
  let i = 0; while (i + 1 < LIFT_COLORS.length && value >= LIFT_EDGES[i + 1]) i++; return LIFT_COLORS[i];
}

const timestamp = z.iso.datetime();
const key = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const frameSchema = z.object({ id: key, validTime: timestamp, intervalStart: timestamp, intervalEnd: timestamp });
export const artifactSchema = z.object({ layer: layerIdSchema, frame: key, tilesKey: key, samplesKey: key, tilesSha256: sha256, samplesSha256: sha256 });
export const manifestSchema = z.object({ version: z.literal(1), model: modelIdSchema, buildId: key, cycle: timestamp, createdAt: timestamp, expiresAt: timestamp, method: z.object({ id: key, hash: sha256 }), coverage: z.object({ id: key, hash: sha256, maskKey: key, maxZoom: z.number().int().nonnegative() }), grid: gridSchema, frames: z.array(frameSchema).min(1), layers: z.array(layerIdSchema).min(1), artifacts: z.array(artifactSchema).min(1), source: z.record(z.string(), z.unknown()), tool: z.record(z.string(), z.unknown()), palettes: z.array(key).min(1), metrics: z.record(z.string(), z.unknown()) });
export const retainedBuildSchema = z.object({ buildId: key, manifestKey: key, cycle: timestamp, expiresAt: timestamp });
export const modelPointerSchema = z.object({ version: z.literal(1), model: modelIdSchema, latestBuildId: key, retained: z.array(retainedBuildSchema).min(1).max(128) }).refine(p => p.retained.some(b => b.buildId === p.latestBuildId), { message: 'latest build must be retained' });
export type Manifest = z.infer<typeof manifestSchema>;
export type ModelPointer = z.infer<typeof modelPointerSchema>;
