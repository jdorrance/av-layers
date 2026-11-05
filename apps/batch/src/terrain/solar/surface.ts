import { MAX_ZOOM } from './constants.ts';
import { xToLon, yToLat, metresPerPixel, sampleGrid } from './grid.ts';
import type { ElevationGrid, TerrainDomain, SurfaceLevel } from './types.ts';
// ── Surface normals ─────────────────────────────────────────────────────────

/**
 * Samples the fine elevation model at zoom-14 pixel centres and derives the
 * surface normal of every pixel (Horn's 3x3 gradient). Returns the zoom-14
 * level with unit normals (east, north, up) and the mean elevation.
 */
export function surfaceLevel(fine: ElevationGrid, domain: TerrainDomain): { level: SurfaceLevel; elevationSum: number; elevationCount: number } {
  const z = MAX_ZOOM;
  const width = domain.x1 - domain.x0;
  const height = domain.y1 - domain.y0;
  const W = width + 2;
  const H = height + 2;
  const elevation = new Float32Array(W * H);
  const lons = new Float64Array(W);
  for (let i = 0; i < W; i += 1) lons[i] = xToLon(domain.x0 + i - 1 + 0.5, z);
  let sum = 0;
  let count = 0;
  for (let j = 0; j < H; j += 1) {
    const lat = yToLat(domain.y0 + j - 1 + 0.5, z);
    const row = j * W;
    for (let i = 0; i < W; i += 1) {
      const v = sampleGrid(fine, lat, lons[i]);
      elevation[row + i] = v;
      if (i > 0 && j > 0 && i < W - 1 && j < H - 1 && !Number.isNaN(v)) {
        sum += v;
        count += 1;
      }
    }
  }

  const n = width * height;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const nz = new Float32Array(n);
  for (let j = 0; j < height; j += 1) {
    const size = metresPerPixel(yToLat(domain.y0 + j + 0.5, z), z);
    const k = 1 / (8 * size);
    for (let i = 0; i < width; i += 1) {
      const c = (j + 1) * W + (i + 1);
      const a = elevation[c - W - 1], b = elevation[c - W], cc = elevation[c - W + 1];
      const d = elevation[c - 1], f = elevation[c + 1];
      const g = elevation[c + W - 1], h = elevation[c + W], ii = elevation[c + W + 1];
      const east = (cc + 2 * f + ii - (a + 2 * d + g)) * k;
      // Rows run south, so the northward gradient is minus the row gradient.
      const north = -(g + 2 * h + ii - (a + 2 * b + cc)) * k;
      const o = j * width + i;
      if (Number.isNaN(east) || Number.isNaN(north)) {
        nx[o] = ny[o] = nz[o] = Number.NaN;
        continue;
      }
      const len = Math.hypot(east, north, 1);
      nx[o] = -east / len;
      ny[o] = -north / len;
      nz[o] = 1 / len;
    }
  }
  return {
    level: { z, x0: domain.x0, y0: domain.y0, width, height, nx, ny, nz, svf: new Float32Array(n) },
    elevationSum: sum,
    elevationCount: count,
  };
}

