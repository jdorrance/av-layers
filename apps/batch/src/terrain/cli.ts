import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { getProduct } from '@av/contracts/models';
import { gridSchema, modelIdSchema, type Grid, type GeographicBounds } from '@av/contracts';
import { putImmutable } from '../immutable-upload.js';
import { readLocalFile } from '../local-file.js';
import { r2Storage } from '../storage.js';
import { loadWranglerConfig } from '../../../../scripts/operations.js';
import { CATALOG_MAX_BYTES, encodeJson, parseJson, terrainAssetSchema, terrainInventorySchema, type TerrainStorage } from './contract.js';
import { fetchSourceInventory } from './source.js';
import { finalizeTerrainCatalog, syncTerrainShard } from './ingest.js';
import { localTerrainStorage } from './local-store.js';
import { prepareTerrain, preparedTerrainRefSchema } from './prepare.js';
import { loadTerrainCatalog, stagePreparedTerrain } from './staging.js';
import { createTerrainReader } from './reader.js';

const COMMON = ['store-dir', 'out'] as const;
export const TERRAIN_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  inventory: COMMON,
  sync: [...COMMON, 'inventory', 'shard', 'shards', 'concurrency'],
  finalize: [...COMMON, 'inventory'],
  prepare: [...COMMON, 'catalog-ref', 'grid'],
  'prepare-model': [...COMMON, 'catalog-ref', 'model', 'source-cache-dir'],
  stage: [...COMMON, 'prepared-ref', 'grid'],
  inspect: [...COMMON, 'catalog-ref', 'bounds']
};
export function terrainArguments(args: string[]) {
  const command = args[0], allowed = Object.hasOwn(TERRAIN_COMMANDS, command) ? TERRAIN_COMMANDS[command] : undefined;
  if (!allowed) throw new Error(`Usage: pnpm terrain ${Object.keys(TERRAIN_COMMANDS).join('|')} --out PATH [options]`);
  const { values, positionals } = parseArgs({ args: args.slice(1), strict: true, allowPositionals: false,
    options: Object.fromEntries(allowed.map(option => [option, { type: 'string' as const }])) });
  if (positionals.length || typeof values.out !== 'string' || !values.out) throw new Error('--out is required');
  if (values['store-dir'] !== undefined && !values['store-dir'].trim()) throw new Error('--store-dir must be a nonempty directory');
  if (values['source-cache-dir'] !== undefined && !values['source-cache-dir'].trim()) throw new Error('--source-cache-dir must be a nonempty directory');
  const required: Record<string, string[]> = { sync: ['inventory'], finalize: ['inventory'], prepare: ['catalog-ref', 'grid'], 'prepare-model': ['catalog-ref', 'model'], stage: ['prepared-ref', 'grid'], inspect: ['catalog-ref', 'bounds'] };
  for (const option of required[command] ?? []) if (!values[option]) throw new Error(`--${option} is required`);
  return { command, values: values as Record<string, string> };
}
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  return Number(value);
}
function storage(directory?: string): TerrainStorage {
  if (directory) return localTerrainStorage(directory);
  const env = { ...process.env };
  if (!env.R2_BUCKET && (env.TARGET_ENV === 'staging' || env.TARGET_ENV === 'production')) env.R2_BUCKET = loadWranglerConfig()[env.TARGET_ENV].bucket;
  return r2Storage(env);
}
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodeJson(value));
}
async function readGrid(path: string): Promise<Grid> {
  return parseJson(await readLocalFile(path, 16 * 1024), gridSchema, 16 * 1024);
}
export async function runTerrain(args = process.argv.slice(2)): Promise<void> {
  const { command, values } = terrainArguments(args), store = storage(values['store-dir']);
  const controller = new AbortController(), signal = controller.signal;
  const stop = () => controller.abort(new Error('Terrain operation interrupted'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (command === 'inventory') {
      const { inventory, bytes } = await fetchSourceInventory({ signal });
      await putImmutable(store, `terrain/inventories/${inventory.sha256}.txt`, bytes, 'text/plain', signal);
      await writeJson(values.out, inventory);
      console.log(JSON.stringify({ source: inventory.source.id, tiles: inventory.tiles.length, inventorySha256: inventory.sha256 }));
      return;
    }
    if (command === 'sync' || command === 'finalize') {
      const inventory = parseJson(await readLocalFile(values.inventory, CATALOG_MAX_BYTES), terrainInventorySchema);
      const result = command === 'sync'
        ? await syncTerrainShard({ store, inventory, shardIndex: integer(values.shard, 0, 0, 63), shardCount: integer(values.shards, 1, 1, 64), concurrency: integer(values.concurrency, 2, 1, 4), signal,
          onProgress: progress => { if ((progress.completed + progress.reused) % 50 === 0) console.log(JSON.stringify(progress)); } })
        : await finalizeTerrainCatalog({ store, inventory, signal });
      await writeJson(values.out, result);
      console.log(JSON.stringify(result));
      return;
    }
    if (command === 'stage') {
      const ref = parseJson(await readLocalFile(values['prepared-ref'], 16 * 1024), preparedTerrainRefSchema, 16 * 1024);
      await stagePreparedTerrain({ ref, storage: store, out: values.out, grid: await readGrid(values.grid), signal });
      console.log(JSON.stringify({ staged: ref.key, out: values.out }));
      return;
    }
    const catalogRef = parseJson(await readLocalFile(values['catalog-ref'], 16 * 1024), terrainAssetSchema, 16 * 1024);
    if (command === 'prepare-model') {
      const model = modelIdSchema.parse(values.model), product = getProduct(model);
      if (!product) throw new Error(`No configured product for ${model}`);
      const [{ wholeDomainPlan, loadBundledFineCoverage }, { ensureWholeDomainTerrain }] = await Promise.all([
        import('../whole-domain/coverage.js'), import('../whole-domain/terrain.js')
      ]);
      const plan = wholeDomainPlan(product);
      if (!plan) throw new Error(`No whole-domain terrain grid for ${model}`);
      const fine = await loadBundledFineCoverage(product, plan);
      const ref = await ensureWholeDomainTerrain({ catalogRef, storage: store, grid: plan.fine,
        coverage: fine.mask.coverage, coverageDescriptor: fine.bytes, signal,
        sourceCacheDir: values['source-cache-dir'] ?? `.cache/terrain-source/${model}` });
      await writeJson(values.out, ref);
      console.log(JSON.stringify({ model, ...ref }));
      return;
    }
    const catalog = await loadTerrainCatalog(catalogRef, store, signal);
    if (command === 'prepare') {
      const ref = await prepareTerrain({ catalog, storage: store, grid: await readGrid(values.grid), signal, onReport: report => console.error(JSON.stringify(report)) });
      await writeJson(values.out, ref);
      console.log(JSON.stringify(ref));
      return;
    }
    const numbers = values.bounds.split(',').map(Number);
    if (numbers.length !== 4 || numbers.some(value => !Number.isFinite(value))) throw new Error('--bounds must be west,south,east,north');
    const reader = await createTerrainReader({ catalog, storage: store, signal });
    try {
      const windows = [];
      for await (const window of reader.readWindows(numbers as unknown as GeographicBounds)) {
        let validCells = 0, minimum = Infinity, maximum = -Infinity;
        for (let index = 0; index < window.values.length; index++) if (!window.missing[index]) {
          validCells++; minimum = Math.min(minimum, window.values[index]); maximum = Math.max(maximum, window.values[index]);
        }
        windows.push({ geometry: window.geometry, validCells, minElevationM: validCells ? minimum : null, maxElevationM: validCells ? maximum : null });
      }
      const result = { dataId: catalog.dataId, bounds: numbers, windows, metrics: reader.stats() };
      await writeJson(values.out, result);
      console.log(JSON.stringify(result));
    } finally { await reader.close(); }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTerrain().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
