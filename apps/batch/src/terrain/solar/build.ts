import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { solarSiteSchema, solarTerrainSourceSchema, solarTerrainIndexSchema, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, MAX_SOLAR_ASSET_BYTES } from '@av/contracts';
import { BUILD_BUDGETS } from '../../capacity.ts';
import { SCHEMA_VERSION, ALGORITHM_VERSION, DEFAULT_RADIUS_KM, DEFAULT_MAX_DISTANCE_KM, MAX_ZOOM, MIN_ZOOM, TILE_SIZE, AZIMUTHS_DEG, DEG, HORIZON_CELLS, HORIZON_BORDER, HORIZON_STEP_DEG, round } from './constants.ts';
import { domainOf, blocksOf, lonToX, latToY, sampleGrid } from './grid.ts';
import { surfaceLevel } from './surface.ts';
import { traceHorizons, fillSkyView, horizonsAtPixel } from './horizon.ts';
import { halveLevel, tileRange, encodeTile } from './encoding.ts';
import { reliefFrame, fillRelief, encodeRelief } from './relief.ts';
import type { SolarSite, SolarTerrainOptions, SolarTerrainBuild, SolarTerrainProduct, SolarTerrainIndex, TerrainTile, TerrainDomain, ElevationGrid } from './types.ts';

// ── Whole product ───────────────────────────────────────────────────────────

/** Short content id for a set of inputs; part of the tile path so tiles can be cached forever. */
function generationOf(inputs: SolarTerrainIndex['inputs']): string {
  return createHash("sha256").update(JSON.stringify({ ...inputs, schemaVersion: SCHEMA_VERSION })).digest("hex").slice(0, 12);
}

function gridBytes(grid: ElevationGrid): number {
  if (!(grid.values instanceof Float32Array) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height)
    || grid.width < 1 || grid.height < 1 || grid.width * grid.height !== grid.values.length
    || ![grid.west, grid.north, grid.dLon, grid.dLat].every(Number.isFinite) || grid.dLon <= 0 || grid.dLat <= 0) throw new Error('Invalid solar elevation grid');
  return grid.values.byteLength;
}



/**
 * Starts building one launch's tiles, block by block, so a large area never
 * has to be in memory at once:
 *
 *   const build = startSolarTerrain(site, { coarse, sources, radiusKm or area, maxDistanceKm });
 *   for (const block of build.blocks) tiles = build.addBlock(block, fineGridCoveringTheBlock);
 *   const { index, relief } = build.finish();
 *
 * `area` ({ name, south, west, north, east }) replaces the square of `radiusKm`
 * around the launch; the launch must be inside it.
 */
export function startSolarTerrain(site: SolarSite, { coarse, sources, radiusKm = DEFAULT_RADIUS_KM, area, maxDistanceKm = DEFAULT_MAX_DISTANCE_KM, log = () => {} }: SolarTerrainOptions): SolarTerrainBuild {
  solarSiteSchema.parse(site);
  solarTerrainSourceSchema.parse(sources.surface); solarTerrainSourceSchema.parse(sources.horizon);
  if (![radiusKm, maxDistanceKm].every(value => Number.isFinite(value * 1000) && value > 0)) throw new Error('Invalid sunlight radius');
  const coarseBytes = gridBytes(coarse), started = Date.now();
  const checkTime = () => { if (Date.now() - started > BUILD_BUDGETS.elapsedMs) throw new Error('Solar terrain elapsed budget exceeded'); };
  const inputs: SolarTerrainIndex['inputs'] = {
    latitude: site.latitude,
    longitude: site.longitude,
    ...(area ? { area } : { radiusKm }),
    maxDistanceKm,
    algorithmVersion: ALGORITHM_VERSION,
    sources: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.id])) as SolarTerrainIndex['inputs']['sources'],
  };
  const generation = generationOf(inputs);
  const domain = domainOf(site, { radiusKm, area });
  if (domain.y0 < 0 || domain.y1 > TILE_SIZE * 2 ** MAX_ZOOM) throw new Error('Solar terrain exceeds Web Mercator latitude bounds');
  let maximumTiles = 0;
  for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom++) {
    const size = TILE_SIZE * 2 ** (MAX_ZOOM - zoom);
    maximumTiles += (Math.ceil(domain.x1 / size) - Math.floor(domain.x0 / size)) * (Math.ceil(domain.y1 / size) - Math.floor(domain.y0 / size));
  }
  if (!Number.isSafeInteger(maximumTiles) || maximumTiles < 1 || maximumTiles * 5 > MAX_MANIFEST_JSON_TOKENS) throw new Error('Solar terrain inventory exceeds metadata budget');
  const LX = Math.floor(lonToX(site.longitude, MAX_ZOOM));
  const LY = Math.floor(latToY(site.latitude, MAX_ZOOM));
  if (LX < domain.x0 || LX >= domain.x1 || LY < domain.y0 || LY >= domain.y1) throw new Error(`${site.slug}: the launch is outside its sunlight area`);
  const blocks = blocksOf(domain);
  const blockKey = ({ x0, y0, x1, y1 }: TerrainDomain) => `${x0}/${y0}/${x1}/${y1}`;
  const pendingBlocks = new Set(blocks.map(blockKey));
  const blockCount = pendingBlocks.size;
  log(`${site.slug}: ${(domain.x1 - domain.x0) / TILE_SIZE} x ${(domain.y1 - domain.y0) / TILE_SIZE} tiles at zoom ${MAX_ZOOM}${blocks.length > 1 ? `, in ${blocks.length} blocks` : ""}`);

  const frame = reliefFrame(domain);
  const ranges: Record<string, [number, number, number, number]> = {};
  const objects = new Map<number, Map<number, [number, number, string][]>>();
  let count = 0, bytes = 0, rawBytes = 0, elevationSum = 0, elevationCount = 0;
  let state: 'building' | 'failed' | 'finished' = 'building';
  let launch: SolarTerrainIndex['launch'] = null;

  function addBlock(block: TerrainDomain, fine: ElevationGrid): TerrainTile[] {
    if (state !== 'building') throw new Error(`Solar terrain build ${state}`);
    const key = blockKey(block);
    if (!pendingBlocks.has(key)) throw new Error(`${site.slug}: terrain block is outside this build or already completed`);
    checkTime();
    // 64 bytes/pixel covers live pyramids, halo heights, horizons and retained gzip tiles.
    if (coarseBytes + gridBytes(fine) + (block.x1 - block.x0) * (block.y1 - block.y0) * 64 + 512 * 1024 ** 2 > BUILD_BUDGETS.peakRssBytes) throw new Error('Solar terrain memory budget exceeded');
    try {
    const label = blockCount > 1 ? `${site.slug} block ${blockCount - pendingBlocks.size + 1}/${blockCount}` : site.slug;
    let t = Date.now();
    const { level: top, elevationSum: sum, elevationCount: n } = surfaceLevel(fine, block);
    elevationSum += sum;
    elevationCount += n;
    log(`${label}: surface normals in ${Date.now() - t} ms`);
    t = Date.now();
    const horizonGrid = traceHorizons(coarse, domain, { maxDistanceM: maxDistanceKm * 1000, block, log: message => { checkTime(); log(message); } });
    log(`${label}: horizons for ${horizonGrid.width * horizonGrid.height} cells in ${Math.round((Date.now() - t) / 1000)} s`);
    t = Date.now();
    fillSkyView(top, horizonGrid);
    log(`${label}: sky-view factor in ${Math.round((Date.now() - t) / 1000)} s`);

    const levels = [top];
    while (levels[0].z > MIN_ZOOM) levels.unshift(halveLevel(levels[0]));
    const tiles = [];
    for (const level of levels) {
      const [x0, y0, x1, y1] = tileRange(level);
      const r = ranges[level.z];
      ranges[level.z] = r ? [Math.min(r[0], x0), Math.min(r[1], y0), Math.max(r[2], x1), Math.max(r[3], y1)] : [x0, y0, x1, y1];
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const { bytes: raw, valid } = encodeTile(level, horizonGrid, x, y);
          if (valid === 0) continue;
          rawBytes += raw.length;
          const body = gzipSync(raw, { level: 9 }), columns = objects.get(level.z) ?? new Map<number, [number, number, string][]>();
          if (body.length > MAX_SOLAR_ASSET_BYTES) throw new Error('Solar tile exceeds asset byte budget');
          objects.set(level.z, columns);
          const rows = columns.get(x) ?? [];
          if (rows.length >= 256 || (!columns.has(x) && columns.size >= 256)) throw new Error('Solar terrain inventory exceeds container budget');
          columns.set(x, rows); rows.push([y, body.length, createHash('sha256').update(body).digest('hex')]);
          tiles.push({ z: level.z, x, y, body });
        }
      }
    }
    count += tiles.length;
    bytes += tiles.reduce((s, tile) => s + tile.body.length, 0);
    fillRelief(frame, fine, block);

    // The launch itself, for checks and for the page.
    if (LX >= block.x0 && LX < block.x1 && LY >= block.y0 && LY < block.y1) {
      const o = (LY - top.y0) * top.width + (LX - top.x0);
      const horizons = horizonsAtPixel(horizonGrid, LX, LY, new Float32Array(AZIMUTHS_DEG.length));
      launch = {
        elevationM: round(sampleGrid(fine, site.latitude, site.longitude), 1),
        slopeDeg: round(Math.acos(Math.min(1, top.nz[o])) / DEG, 1),
        aspectDeg: round((Math.atan2(top.nx[o], top.ny[o]) / DEG + 360) % 360, 0),
        skyViewFactor: round(top.svf[o], 3),
        horizonDeg: Array.from(horizons, (h) => round(h, 1)),
      };
    }
    pendingBlocks.delete(key);
    return tiles;
    } catch (error) { state = 'failed'; throw error; }
  }

  function finish({ generatedAt }: { generatedAt?: string } = {}): SolarTerrainProduct {
    if (state !== 'building') throw new Error(`Solar terrain build ${state}`);
    if (pendingBlocks.size) throw new Error(`${site.slug}: ${pendingBlocks.size} block(s) not built`);
    checkTime();
    log(`${site.slug}: ${count} tiles, ${(bytes / 1e6).toFixed(1)} MB compressed (${(rawBytes / 1e6).toFixed(0)} MB raw)`);
    const relief = encodeRelief(frame, generation);
    if (relief.body.length > MAX_SOLAR_ASSET_BYTES) throw new Error('Solar relief exceeds asset byte budget');
    log(`${site.slug}: relief ${relief.meta.width} x ${relief.meta.height} at zoom ${relief.meta.zoom}, ${relief.meta.minM}–${relief.meta.maxM} m, ${(relief.body.length / 1e3).toFixed(0)} kB`);
    const index: SolarTerrainIndex = {
      schemaVersion: SCHEMA_VERSION,
      slug: site.slug,
      generatedAt: generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      generation,
      inputs,
      sources,
      bounds: { south: round(domain.bounds.south, 6)!, west: round(domain.bounds.west, 6)!, north: round(domain.bounds.north, 6)!, east: round(domain.bounds.east, 6)! },
      referenceElevationM: round(elevationCount > 0 ? elevationSum / elevationCount : Number.NaN, 0),
      tiles: {
        path: `${generation}/{z}/{x}/{y}.bin.gz`,
        size: TILE_SIZE,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        ranges,
        count,
        bytes,
        objects: [...objects].sort(([a], [b]) => a - b).map(([z, columns]) => ({ z,
          columns: [...columns].sort(([a], [b]) => a - b).map(([x, rows]) => ({ x, rows: rows.sort(([a], [b]) => a - b) })) })),
      },
      encoding: {
        planes: ["nx", "ny", "nz", "svf"],
        normal: "nx, ny: byte / 127.5 - 1 (east, north components); nz, svf: byte / 255; nz = 0 marks no data",
        horizonCells: HORIZON_CELLS,
        horizonBorder: HORIZON_BORDER,
        azimuthsDeg: [...AZIMUTHS_DEG],
        horizonStepDeg: HORIZON_STEP_DEG,
        delta: "row",
        compression: "gzip",
      },
      launch,
      relief: relief.meta,
    };
    solarTerrainIndexSchema.parse(index);
    encodeBoundedJson(index, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS);
    state = 'finished';
    return { index, relief };
  }

  return { domain, blocks, generation, addBlock, finish };
}

