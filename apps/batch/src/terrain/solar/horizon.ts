import { DEG, MAX_ZOOM, HORIZON_ZOOM, HORIZON_BORDER, CELL_PX, MIN_ZOOM, DEFAULT_MAX_DISTANCE_KM, REFRACTION_K, MEAN_EARTH_RADIUS_M, AZIMUTHS_DEG } from './constants.ts';
import { metresPerDegree, xToLon, yToLat, bilinearAt } from './grid.ts';
import type { ElevationGrid, TerrainDomain, SurfaceLevel, HorizonGrid } from './types.ts';
// ── Horizons ────────────────────────────────────────────────────────────────

/** Ray-march distances (m): every 25 m near the cell, then growing 2 % per step. */
export function rayDistances(maxDistanceM: number, firstStepM = 25): number[] {
  const out = [];
  for (let d = firstStepM; d <= maxDistanceM; d += Math.max(firstStepM, 0.02 * d)) out.push(d);
  return out;
}

/**
 * Traces the horizon angle (degrees above horizontal, never below 0) in every
 * direction of AZIMUTHS_DEG from the centre of each zoom-12 pixel in the domain
 * plus a one-cell ring, over the coarse elevation model. Accounts for earth
 * curvature and standard refraction.
 *
 * With `block`, only the cells that block's tiles read: the block and the
 * horizon border of its zoom-11 tiles, never past the domain's own ring, so a
 * domain built block by block gets exactly the tiles it gets in one go.
 */
export function traceHorizons(coarse: ElevationGrid, domain: TerrainDomain, { maxDistanceM = DEFAULT_MAX_DISTANCE_KM * 1000, block = null, log = () => {} }: { maxDistanceM?: number; block?: TerrainDomain | null; log?: (message: string) => void } = {}): HorizonGrid {
  const shift = 2 ** (MAX_ZOOM - HORIZON_ZOOM);
  let x0 = domain.x0 / shift - 1;
  let y0 = domain.y0 / shift - 1;
  let x1 = domain.x1 / shift + 1;
  let y1 = domain.y1 / shift + 1;
  if (block) {
    const pad = HORIZON_BORDER * CELL_PX * 2 ** (HORIZON_ZOOM - MIN_ZOOM);
    x0 = Math.max(x0, block.x0 / shift - pad);
    y0 = Math.max(y0, block.y0 / shift - pad);
    x1 = Math.min(x1, block.x1 / shift + pad);
    y1 = Math.min(y1, block.y1 / shift + pad);
  }
  const width = x1 - x0;
  const height = y1 - y0;
  const midLat = (domain.bounds.south + domain.bounds.north) / 2;
  const m = metresPerDegree(midLat);
  const dist = rayDistances(maxDistanceM);
  const steps = dist.length;
  const drop = Float64Array.from(dist, (d) => (d * d * (1 - REFRACTION_K)) / (2 * MEAN_EARTH_RADIUS_M));
  const offsets = AZIMUTHS_DEG.map((az) => ({
    dc: Float64Array.from(dist, (d) => (d * Math.sin(az * DEG)) / (m.lon * coarse.dLon)),
    dr: Float64Array.from(dist, (d) => -(d * Math.cos(az * DEG)) / (m.lat * coarse.dLat)),
  }));
  const { values, width: GW, height: GH } = coarse;
  let zMax = -Infinity;
  for (const v of values) if (v > zMax) zMax = v;

  const horizons = AZIMUTHS_DEG.map(() => new Float32Array(width * height));
  const lons = Float64Array.from({ length: width }, (_, i) => xToLon(x0 + i + 0.5, HORIZON_ZOOM));
  const started = Date.now();
  for (let j = 0; j < height; j += 1) {
    const lat = yToLat(y0 + j + 0.5, HORIZON_ZOOM);
    const rp = (coarse.north - lat) / coarse.dLat - 0.5;
    for (let i = 0; i < width; i += 1) {
      const cp = (lons[i] - coarse.west) / coarse.dLon - 0.5;
      const zp = bilinearAt(values, GW, GH, cp, rp);
      const o = j * width + i;
      if (Number.isNaN(zp)) continue; // no ground here: leave an open horizon
      for (let d = 0; d < AZIMUTHS_DEG.length; d += 1) {
        const { dc, dr } = offsets[d];
        let best = 0;
        for (let k = 0; k < steps; k += 1) {
          if ((zMax - zp) / dist[k] <= best) break; // nothing further can rise above the horizon found
          const x = cp + dc[k];
          const y = rp + dr[k];
          if (x < 0 || y < 0 || x > GW - 1 || y > GH - 1) break;
          const xi = x | 0;
          const yi = y | 0;
          const fx = x - xi;
          const fy = y - yi;
          const p = yi * GW + xi;
          const x1 = xi + 1 < GW ? 1 : 0;
          const y1 = yi + 1 < GH ? GW : 0;
          const z = (values[p] * (1 - fx) + values[p + x1] * fx) * (1 - fy) + (values[p + y1] * (1 - fx) + values[p + y1 + x1] * fx) * fy;
          const t = (z - drop[k] - zp) / dist[k];
          if (t > best) best = t;
        }
        horizons[d][o] = Math.atan(best) / DEG;
      }
    }
    if (j % 200 === 199) log(`  horizons: ${j + 1}/${height} rows (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  return { x0, y0, width, height, horizons };
}

/** Horizon angles (degrees) in every direction at a zoom-14 pixel centre. */
export function horizonsAtPixel(grid: HorizonGrid, X: number, Y: number, out: Float32Array): Float32Array {
  const shift = 2 ** (MAX_ZOOM - HORIZON_ZOOM);
  const fx = (X + 0.5) / shift - 0.5 - grid.x0;
  const fy = (Y + 0.5) / shift - 0.5 - grid.y0;
  const x = Math.min(Math.max(fx, 0), grid.width - 1);
  const y = Math.min(Math.max(fy, 0), grid.height - 1);
  const xi = Math.min(Math.floor(x), grid.width - 2);
  const yi = Math.min(Math.floor(y), grid.height - 2);
  const ax = x - xi;
  const ay = y - yi;
  const p = yi * grid.width + xi;
  for (let d = 0; d < out.length; d += 1) {
    const h = grid.horizons[d];
    out[d] = (h[p] * (1 - ax) + h[p + 1] * ax) * (1 - ay) + (h[p + grid.width] * (1 - ax) + h[p + grid.width + 1] * ax) * ay;
  }
  return out;
}

// ── Sky-view factor ─────────────────────────────────────────────────────────

const SIN_AZ = AZIMUTHS_DEG.map((a) => Math.sin(a * DEG));
const COS_AZ = AZIMUTHS_DEG.map((a) => Math.cos(a * DEG));

/**
 * Fraction of an isotropic sky seen by a surface with unit normal (nx, ny, nz)
 * under the given horizon angles (degrees, one per AZIMUTHS_DEG entry):
 * Dozier & Frew (1990), with the surface's own plane as a minimum horizon.
 * 1 for open flat ground, (1 + cos slope) / 2 for an open plane.
 */
export function skyViewFactor(nx: number, ny: number, nz: number, horizonsDeg: ArrayLike<number>): number {
  let sum = 0;
  for (let d = 0; d < horizonsDeg.length; d += 1) {
    const tilt = nx * SIN_AZ[d] + ny * COS_AZ[d]; // tan(slope) * cos(azimuth - aspect) * nz
    const plane = nz > 1e-6 ? Math.atan(-tilt / nz) : tilt > 0 ? -Math.PI / 2 : Math.PI / 2;
    const h = Math.max(horizonsDeg[d] * DEG, plane);
    const H = Math.PI / 2 - h;
    const s = Math.sin(H);
    sum += nz * s * s + tilt * (H - s * Math.cos(H));
  }
  return Math.min(Math.max(sum / horizonsDeg.length, 0), 1);
}

export function fillSkyView(level: SurfaceLevel, horizonGrid: HorizonGrid): void {
  const out = new Float32Array(AZIMUTHS_DEG.length);
  for (let j = 0; j < level.height; j += 1) {
    for (let i = 0; i < level.width; i += 1) {
      const o = j * level.width + i;
      if (Number.isNaN(level.nz[o])) {
        level.svf[o] = Number.NaN;
        continue;
      }
      horizonsAtPixel(horizonGrid, level.x0 + i, level.y0 + j, out);
      level.svf[o] = skyViewFactor(level.nx[o], level.ny[o], level.nz[o], out);
    }
  }
}

