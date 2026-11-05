import { TILE_SIZE, AZIMUTHS_DEG, HORIZON_SIDE, HORIZON_STEP_DEG, HORIZON_ZOOM, CELL_PX, HORIZON_BORDER } from './constants.ts';
import type { SurfaceLevel, HorizonGrid } from './types.ts';
// ── Pyramid ─────────────────────────────────────────────────────────────────

/**
 * Halves a level: each pixel is the mean of its (valid) children. Normals are
 * averaged without renormalising, so a coarse pixel's direct-beam irradiance is
 * exactly the mean of its children's (the dot product is linear).
 */
export function halveLevel(level: SurfaceLevel): SurfaceLevel {
  const x0 = Math.floor(level.x0 / 2);
  const y0 = Math.floor(level.y0 / 2);
  const width = Math.ceil((level.x0 + level.width) / 2) - x0;
  const height = Math.ceil((level.y0 + level.height) / 2) - y0;
  const n = width * height;
  const out = { z: level.z - 1, x0, y0, width, height, nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n), svf: new Float32Array(n) };
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      let sx = 0, sy = 0, sz = 0, sv = 0, count = 0;
      for (let dj = 0; dj < 2; dj += 1) {
        const cj = (y0 + j) * 2 + dj - level.y0;
        if (cj < 0 || cj >= level.height) continue;
        for (let di = 0; di < 2; di += 1) {
          const ci = (x0 + i) * 2 + di - level.x0;
          if (ci < 0 || ci >= level.width) continue;
          const c = cj * level.width + ci;
          if (Number.isNaN(level.nz[c])) continue;
          sx += level.nx[c]; sy += level.ny[c]; sz += level.nz[c]; sv += level.svf[c];
          count += 1;
        }
      }
      const o = j * width + i;
      if (count === 0) {
        out.nx[o] = out.ny[o] = out.nz[o] = out.svf[o] = Number.NaN;
      } else {
        out.nx[o] = sx / count; out.ny[o] = sy / count; out.nz[o] = sz / count; out.svf[o] = sv / count;
      }
    }
  }
  return out;
}

// ── Tiles ───────────────────────────────────────────────────────────────────

/** Byte layout of one tile before compression; see web/src/lib/solar-tile.ts. */
export const TILE_BYTES = 4 * TILE_SIZE * TILE_SIZE + AZIMUTHS_DEG.length * HORIZON_SIDE * HORIZON_SIDE;

const byteOfSigned = (v: number) => Math.min(255, Math.max(0, Math.round((v + 1) * 127.5)));
const byteOfUnit = (v: number) => Math.min(255, Math.max(1, Math.round(v * 255)));
const byteOfHorizon = (deg: number) => Math.min(255, Math.max(0, Math.round(deg / HORIZON_STEP_DEG)));

/**
 * Row-delta filter (like PNG's "Sub"): each byte becomes its difference from
 * the byte to its left, or from the byte above at the start of a row. Smooth
 * fields turn into runs of small numbers, which gzip compresses far better.
 */
function deltaEncode(plane: Uint8Array, width: number): Uint8Array {
  const out = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i += 1) {
    const prev = i % width === 0 ? (i === 0 ? 0 : plane[i - width]) : plane[i - 1];
    out[i] = (plane[i] - prev) & 255;
  }
  return out;
}

/** Mean zoom-12 horizon over a block of cells, clamped to the traced area. */
function blockHorizon(grid: HorizonGrid, d: number, s0x: number, s0y: number, size: number): number {
  const h = grid.horizons[d];
  let sum = 0;
  let count = 0;
  for (let y = s0y; y < s0y + size; y += 1) {
    const yy = Math.min(Math.max(y - grid.y0, 0), grid.height - 1);
    for (let x = s0x; x < s0x + size; x += 1) {
      const xx = Math.min(Math.max(x - grid.x0, 0), grid.width - 1);
      sum += h[yy * grid.width + xx];
      count += 1;
    }
  }
  return sum / count;
}

/** The uncompressed bytes of tile (tx, ty) of a level. */
export function encodeTile(level: SurfaceLevel, horizonGrid: HorizonGrid, tx: number, ty: number): { bytes: Uint8Array; valid: number } {
  const px = TILE_SIZE * TILE_SIZE;
  const bytes = new Uint8Array(TILE_BYTES);
  const nx = new Uint8Array(px), ny = new Uint8Array(px), nz = new Uint8Array(px), svf = new Uint8Array(px);
  let valid = 0;
  for (let j = 0; j < TILE_SIZE; j += 1) {
    const lj = ty * TILE_SIZE + j - level.y0;
    for (let i = 0; i < TILE_SIZE; i += 1) {
      const li = tx * TILE_SIZE + i - level.x0;
      const o = j * TILE_SIZE + i;
      const c = lj * level.width + li;
      if (li < 0 || lj < 0 || li >= level.width || lj >= level.height || Number.isNaN(level.nz[c])) {
        nx[o] = 128; ny[o] = 128; nz[o] = 0; svf[o] = 0; // nz = 0: no data
        continue;
      }
      nx[o] = byteOfSigned(level.nx[c]);
      ny[o] = byteOfSigned(level.ny[c]);
      nz[o] = byteOfUnit(level.nz[c]);
      svf[o] = byteOfUnit(level.svf[c]);
      valid += 1;
    }
  }
  [nx, ny, nz, svf].forEach((plane, p) => bytes.set(deltaEncode(plane, TILE_SIZE), p * px));

  // Horizon cells are CELL_PX tile pixels wide; in zoom-12 cells that is:
  const scale = 2 ** (HORIZON_ZOOM - level.z) * CELL_PX;
  let offset = 4 * px;
  const plane = new Uint8Array(HORIZON_SIDE * HORIZON_SIDE);
  for (let d = 0; d < AZIMUTHS_DEG.length; d += 1) {
    for (let cj = 0; cj < HORIZON_SIDE; cj += 1) {
      const sy = (ty * TILE_SIZE + (cj - HORIZON_BORDER) * CELL_PX) * 2 ** (HORIZON_ZOOM - level.z);
      for (let ci = 0; ci < HORIZON_SIDE; ci += 1) {
        const sx = (tx * TILE_SIZE + (ci - HORIZON_BORDER) * CELL_PX) * 2 ** (HORIZON_ZOOM - level.z);
        plane[cj * HORIZON_SIDE + ci] = byteOfHorizon(blockHorizon(horizonGrid, d, Math.floor(sx), Math.floor(sy), Math.max(1, scale)));
      }
    }
    bytes.set(deltaEncode(plane, HORIZON_SIDE), offset);
    offset += plane.length;
  }
  return { bytes, valid };
}

/** Tile index ranges [x0, y0, x1, y1] (inclusive) covering a level. */
export function tileRange(level: SurfaceLevel): [number, number, number, number] {
  return [
    Math.floor(level.x0 / TILE_SIZE),
    Math.floor(level.y0 / TILE_SIZE),
    Math.floor((level.x0 + level.width - 1) / TILE_SIZE),
    Math.floor((level.y0 + level.height - 1) / TILE_SIZE),
  ];
}

