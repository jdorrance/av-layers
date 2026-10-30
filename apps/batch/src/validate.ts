import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles, Compression, TileType } from 'pmtiles';
import { PNG } from 'pngjs';
import { CELL_BYTES, expectedTiles, getBit, GFS_GRID, LAYER_IDS, manifestSchema, STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, type CoverageMask, type LayerId, type Manifest } from '@av/contracts';

const COVERAGE_DIR = fileURLToPath(new URL('../../../packages/contracts/coverage', import.meta.url));

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

export function localPath(root: string, key: string): string {
  const base = resolve(root), path = resolve(base, key);
  if (!path.startsWith(base + sep)) throw new Error(`Invalid artifact key: ${key}`);
  return path;
}

export async function loadCoverage(): Promise<CoverageMask> {
  const [output, halo, tiles] = await Promise.all(['output.bin', 'halo.bin', 'tiles.bin'].map(name => readFile(resolve(COVERAGE_DIR, name))));
  const mask = { grid: GFS_GRID, output, halo, tiles, maxZoom: 5 };
  await verifyCoverage(mask);
  return mask;
}

export async function verifyCoverage(mask: CoverageMask): Promise<string> {
  const bytes = await readFile(resolve(COVERAGE_DIR, 'manifest.json'));
  const metadata: unknown = JSON.parse(bytes.toString('utf8'));
  if (!metadata || typeof metadata !== 'object') throw new Error('Invalid coverage manifest');
  const record = metadata as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.id !== 'soaring-land-v1' || mask.maxZoom !== 5 || JSON.stringify(mask.grid) !== JSON.stringify(GFS_GRID)) throw new Error('Coverage identity mismatch');
  for (const [name, data, length] of [['output', mask.output, 129780], ['halo', mask.halo, 129780], ['tiles', mask.tiles, 171]] as const) {
    const item = record[name];
    if (!item || typeof item !== 'object' || data.length !== length || (item as Record<string, unknown>).bytes !== length || (item as Record<string, unknown>).sha256 !== sha256(data)) throw new Error(`Coverage ${name} bitset hash mismatch`);
  }
  return sha256(bytes);
}

export async function validateArchive(path: string, mask: CoverageMask): Promise<void> {
  const file = await open(path, 'r');
  try {
    const archive = new PMTiles({ getKey: () => path, async getBytes(offset, length) { const data = Buffer.alloc(length); const { bytesRead } = await file.read(data, 0, length, offset); if (!bytesRead) throw new Error('Short archive read'); return { data: data.buffer.slice(data.byteOffset, data.byteOffset + bytesRead) }; } });
    const header = await archive.getHeader();
    if (header.tileType !== TileType.Png || header.tileCompression !== Compression.None || ![Compression.None, Compression.Gzip].includes(header.internalCompression) || header.minZoom !== 0 || header.maxZoom !== mask.maxZoom) throw new Error(`Unsupported archive ${path}: ${JSON.stringify({ type: header.tileType, tileCompression: header.tileCompression, internalCompression: header.internalCompression, minZoom: header.minZoom, maxZoom: header.maxZoom })}`);
    for (let z = 0; z <= mask.maxZoom; z++) for (const tile of expectedTiles(mask, z)) {
      const result = await archive.getZxy(tile.z, tile.x, tile.y);
      if (!result || result.data.byteLength < 8 || Buffer.from(result.data).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Missing or invalid active tile ${path} ${z}/${tile.x}/${tile.y}`);
      const png = PNG.sync.read(Buffer.from(result.data));
      if (png.width !== 256 || png.height !== 256) throw new Error(`Invalid tile dimensions ${path} ${z}/${tile.x}/${tile.y}`);
    }
  } finally { await file.close(); }
}

export function validateSamples(samples: Buffer, mask: CoverageMask, layer: LayerId, key: string): void {
  for (let offset = 0; offset < samples.length; offset += CELL_BYTES) {
    const flags = samples[offset + 4], status = flags & STATUS_MASK;
    if (flags & ~31 || (layer === 'precip-rate' && (status === STATUS_NO_LIFT || flags & ~STATUS_MASK))) throw new Error(`Invalid sample flags in ${key}`);
    if (status < STATUS_UNAVAILABLE && !Number.isFinite(samples.readFloatLE(offset))) throw new Error(`Invalid sample value in ${key}`);
    if (status === STATUS_OUTSIDE && flags !== STATUS_OUTSIDE) throw new Error(`Invalid outside flags in ${key}`);
    const index = offset / CELL_BYTES;
    if ((status === STATUS_OUTSIDE) === (getBit(mask.output, index) || getBit(mask.halo, index))) throw new Error(`Sample coverage mismatch in ${key}`);
  }
}

export async function validateBuild(root: string, raw: unknown, mask: CoverageMask): Promise<Manifest> {
  const manifest = manifestSchema.parse(raw);
  if (manifest.model !== 'gfs' || JSON.stringify(manifest.grid) !== JSON.stringify(GFS_GRID) || manifest.coverage.maxZoom !== 5) throw new Error('Unsupported model, grid or zoom');
  if (manifest.coverage.id !== 'soaring-land-v1' || manifest.coverage.hash !== await verifyCoverage(mask)) throw new Error('Coverage identity mismatch');
  const cycle = Date.parse(manifest.cycle), created = Date.parse(manifest.createdAt), expiry = Date.parse(manifest.expiresAt);
  if (!(created < expiry) || expiry > created + 7 * 86400000 || !Number.isFinite(cycle)) throw new Error('Invalid build timestamps');
  const frames = Array.from({ length: 8 }, (_, i) => `f${String((i + 1) * 3).padStart(3, '0')}`);
  if (manifest.frames.length !== 8 || manifest.layers.length !== 3 || new Set(manifest.layers).size !== 3 || LAYER_IDS.some(layer => !manifest.layers.includes(layer))) throw new Error('Incomplete frame or layer set');
  for (let i = 0; i < 8; i++) {
    const frame = manifest.frames[i];
    if (frame.id !== frames[i] || Date.parse(frame.intervalStart) !== cycle + i * 10800000 || Date.parse(frame.intervalEnd) !== cycle + (i + 1) * 10800000 || Date.parse(frame.validTime) !== cycle + (i + 1) * 10800000) throw new Error(`Invalid frame interval ${frame.id}`);
  }
  if (manifest.artifacts.length !== 24 || new Set(manifest.artifacts.map(a => `${a.layer}/${a.frame}`)).size !== 24) throw new Error('Incomplete artifact set');
  const prefix = `builds/${manifest.model}/${manifest.buildId}/`;
  for (const layer of LAYER_IDS) for (const frame of frames) {
    const artifact = manifest.artifacts.find(a => a.layer === layer && a.frame === frame);
    if (!artifact || artifact.tilesKey !== `${prefix}${layer}/${frame}.pmtiles` || artifact.samplesKey !== `${prefix}samples/${layer}/${frame}.bin`) throw new Error(`Invalid artifact keys for ${layer}/${frame}`);
    const samples = await readFile(localPath(root, artifact.samplesKey));
    if (samples.length !== manifest.grid.width * manifest.grid.height * CELL_BYTES || sha256(samples) !== artifact.samplesSha256) throw new Error(`Invalid samples ${artifact.samplesKey}`);
    validateSamples(samples, mask, layer, artifact.samplesKey);
    const bytes = await readFile(localPath(root, artifact.tilesKey));
    if (sha256(bytes) !== artifact.tilesSha256) throw new Error(`Invalid archive hash ${artifact.tilesKey}`);
    await validateArchive(localPath(root, artifact.tilesKey), mask);
  }
  return manifest;
}
