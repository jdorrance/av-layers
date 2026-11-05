import { createHash } from 'node:crypto';
import { SOLAR_TERRAIN_FORMAT } from '@av/contracts';
import { gzipSync } from 'node:zlib';
import { MAX_ZOOM, round } from './constants.ts';
import { sampleGrid, xToLon, yToLat } from './grid.ts';
import type { TerrainDomain, ElevationGrid, ReliefFrame, ReliefProduct } from './types.ts';

// ── Relief (the 3D view's ground) ───────────────────────────────────────────

const { reliefVersion: RELIEF_VERSION, reliefZoom: RELIEF_ZOOM, reliefMaxSide: RELIEF_MAX_SIDE,
  reliefOffsetM: RELIEF_OFFSET_M, reliefScale: RELIEF_SCALE } = SOLAR_TERRAIN_FORMAT;

/** The finest zoom (RELIEF_ZOOM at most) whose relief of the domain fits RELIEF_MAX_SIDE. */
function reliefZoomFor(domain: TerrainDomain): number {
  let z = RELIEF_ZOOM;
  while (z > 0 && Math.max(domain.x1 - domain.x0, domain.y1 - domain.y0) / 2 ** (MAX_ZOOM - z) + 2 > RELIEF_MAX_SIDE) z -= 1;
  return z;
}

/** An empty relief grid over the domain, filled block by block with fillRelief. */
export function reliefFrame(domain: TerrainDomain): ReliefFrame {
  const zoom = reliefZoomFor(domain);
  const f = 2 ** (MAX_ZOOM - zoom);
  const x0 = Math.floor(domain.x0 / f);
  const y0 = Math.floor(domain.y0 / f);
  const width = Math.ceil(domain.x1 / f) - x0 + 1;
  const height = Math.ceil(domain.y1 / f) - y0 + 1;
  return { domain, zoom, f, x0, y0, width, height, values: new Uint16Array(width * height), min: Infinity, max: -Infinity };
}

/**
 * Fills the relief heights that fall in `block` (all of them without one) from
 * a fine elevation grid covering it. Heights on a block edge are filled by
 * both blocks, with the same value.
 */
export function fillRelief(frame: ReliefFrame, fine: ElevationGrid, block = frame.domain): void {
  const { domain, zoom, f, x0, y0, width, height, values } = frame;
  const within = (p: number, lo: number, hi: number, blo: number, bhi: number) => {
    const c = Math.min(Math.max(p, lo), hi);
    return c >= blo && c <= bhi;
  };
  for (let j = 0; j < height; j += 1) {
    if (!within((y0 + j) * f, domain.y0, domain.y1, block.y0, block.y1)) continue;
    const lat = yToLat(y0 + j, zoom);
    for (let i = 0; i < width; i += 1) {
      if (!within((x0 + i) * f, domain.x0, domain.x1, block.x0, block.x1)) continue;
      const v = sampleGrid(fine, lat, xToLon(x0 + i, zoom));
      if (Number.isNaN(v)) continue;
      values[j * width + i] = Math.min(65535, Math.max(1, Math.round((v + RELIEF_OFFSET_M) * RELIEF_SCALE)));
      frame.min = Math.min(frame.min, v);
      frame.max = Math.max(frame.max, v);
    }
  }
}

/** The relief file and its index entry. */
export function encodeRelief(frame: ReliefFrame, generation: string): ReliefProduct {
  const { zoom, x0, y0, width, height, values } = frame;
  const bytes = Buffer.alloc(values.length * 2);
  for (let k = 0; k < values.length; k += 1) {
    const prev = k % width === 0 ? (k === 0 ? 0 : values[k - width]) : values[k - 1];
    bytes.writeUInt16LE((values[k] - prev) & 0xffff, k * 2);
  }
  const body = gzipSync(bytes, { level: 9 });
  return {
    body,
    meta: {
      version: RELIEF_VERSION,
      path: `${generation}/relief-v${RELIEF_VERSION}.bin.gz`,
      zoom,
      x0,
      y0,
      width,
      height,
      offsetM: RELIEF_OFFSET_M,
      scale: RELIEF_SCALE,
      minM: round(frame.min, 0),
      maxM: round(frame.max, 0),
      encoding: "uint16 little-endian, (elevation m + offsetM) * scale, 0 = no data; row-delta (mod 65536); gzip",
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    },
  };
}

