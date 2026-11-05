import { createHash } from 'node:crypto';
import { DEFAULT_REQUEST_TIMEOUT_MS, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, MAX_SOLAR_ASSET_BYTES, parseBoundedJson, solarSiteSchema, solarTerrainIndexSchema, type SolarSite, type SolarTerrainIndex, type TerrainSources } from '@av/contracts';
import { BUILD_BUDGETS } from '../../capacity.js';
import { putImmutable } from '../../immutable-upload.js';
import { sha256, type TerrainAsset, type TerrainCatalog, type TerrainStorage } from '../contract.js';
import { createTerrainReader } from '../reader.js';
import { readSolarElevationGrid } from './glo90.js';
import { DEFAULT_MAX_DISTANCE_KM, DEFAULT_RADIUS_KM, domainOf, expandBounds, FINE_MARGIN_M, startSolarTerrain } from './index.js';

interface PublishOptions {
  site: SolarSite; catalog: TerrainCatalog; catalogRef: TerrainAsset; storage: TerrainStorage;
  signal?: AbortSignal; log?: (message: string) => void;
}

function indexFromBytes(bytes: Uint8Array, site: SolarSite, generation: string, sources: TerrainSources): SolarTerrainIndex {
  const index = solarTerrainIndexSchema.parse(parseBoundedJson(bytes, MAX_MANIFEST_JSON_TOKENS));
  if (index.slug !== site.slug || index.generation !== generation || index.inputs.latitude !== site.latitude || index.inputs.longitude !== site.longitude
    || index.inputs.radiusKm !== DEFAULT_RADIUS_KM || index.inputs.area !== undefined || index.inputs.maxDistanceKm !== DEFAULT_MAX_DISTANCE_KM
    || index.inputs.sources.surface !== sources.surface.id || index.inputs.sources.horizon !== sources.horizon.id) throw new Error('Solar terrain generation identity mismatch');
  return index;
}

async function verifyAssets(storage: TerrainStorage, prefix: string, index: SolarTerrainIndex, signal: AbortSignal): Promise<void> {
  const verify = async (key: string, bytes: number, digest: string) => {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_SOLAR_ASSET_BYTES) throw new Error('Solar terrain asset exceeds byte budget');
    const object = await storage.get(key, undefined, bytes, signal);
    if (!object || object.bytes.length !== bytes || sha256(object.bytes) !== digest) throw new Error(`Solar terrain asset verification failed: ${key}`);
  };
  for (const group of index.tiles.objects) for (const column of group.columns) for (const [y, bytes, digest] of column.rows) {
    await verify(`${prefix}/${index.generation}/${group.z}/${column.x}/${y}.bin.gz`, bytes, digest);
  }
  await verify(`${prefix}/${index.relief.path}`, index.relief.bytes, index.relief.sha256);
}

/** Publish verified immutable assets and a generation index, then CAS the launch index. */
export async function publishSolarTerrain(options: PublishOptions) {
  const site = solarSiteSchema.parse(options.site), { catalog, catalogRef, storage } = options, started = Date.now();
  const deadline = AbortSignal.timeout(BUILD_BUDGETS.elapsedMs), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const log = (message: string) => { signal.throwIfAborted(); options.log?.(message); };
  const prefix = `terrain/solar/${site.slug}`, key = `${prefix}/index.json`, previous = await storage.head(key, signal);
  const source = { id: `${catalog.source.id}:${catalog.dataId}:${catalogRef.sha256}`, name: 'Copernicus GLO-90 2021 (EGM2008 DSM)', resolutionM: 90,
    licence: 'Copernicus DEM licence', url: 'https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model' };
  const sources = { surface: source, horizon: source }, reader = await createTerrainReader({ catalog, storage, signal });
  try {
    const domain = domainOf(site), coarse = await readSolarElevationGrid(reader, expandBounds(domain.bounds, DEFAULT_MAX_DISTANCE_KM * 1000));
    const build = startSolarTerrain(site, { coarse, sources, log }), generationKey = `${prefix}/${build.generation}/index.json`;
    let object = await storage.get(generationKey, undefined, MAX_MANIFEST_BYTES, signal), reused = !!object;
    let verifiedDigest: string | undefined;
    if (!object) {
      for (const block of build.blocks) {
        signal.throwIfAborted();
        const fine = await readSolarElevationGrid(reader, expandBounds(block.bounds, FINE_MARGIN_M));
        for (const tile of build.addBlock(block, fine)) {
          if (tile.body.length > MAX_SOLAR_ASSET_BYTES) throw new Error('Solar terrain tile exceeds byte budget');
          await putImmutable(storage, `${prefix}/${build.generation}/${tile.z}/${tile.x}/${tile.y}.bin.gz`, tile.body, 'application/octet-stream', signal);
        }
      }
      const { index, relief } = build.finish();
      await putImmutable(storage, `${prefix}/${relief.meta.path}`, relief.body, 'application/octet-stream', signal);
      const bytes = encodeBoundedJson(index, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS);
      await verifyAssets(storage, prefix, index, signal);
      verifiedDigest = sha256(bytes);
      object = await storage.get(generationKey, undefined, MAX_MANIFEST_BYTES, signal);
      if (object) reused = true;
      else {
        try { await putImmutable(storage, generationKey, bytes, 'application/json', signal); }
        catch (error) {
          object = await storage.get(generationKey, undefined, MAX_MANIFEST_BYTES, signal);
          if (!object) throw error;
          reused = true;
        }
        object ??= await storage.get(generationKey, undefined, MAX_MANIFEST_BYTES, signal);
      }
    }
    if (!object) throw new Error('Solar terrain generation index is missing');
    const index = indexFromBytes(object.bytes, site, build.generation, sources);
    const digest = sha256(object.bytes), head = await storage.head(generationKey, signal);
    if (!head || head.size !== object.bytes.length || (head.metadata?.sha256 ?? head.computedSha256) !== digest) throw new Error('Solar terrain generation index hash metadata mismatch');
    if (verifiedDigest !== digest) await verifyAssets(storage, prefix, index, signal);
    const md5 = createHash('md5').update(object.bytes).digest('base64');
    try { await storage.put(key, object.bytes, previous ? { ifMatch: previous.etag } : { ifNoneMatch: '*' }, 'application/json', md5, { sha256: digest }); }
    catch (error) {
      const committed = await storage.get(key, undefined, MAX_MANIFEST_BYTES, AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS));
      if (!committed || sha256(committed.bytes) !== digest) throw error;
    }
    const committed = await storage.get(key, undefined, MAX_MANIFEST_BYTES, signal);
    if (!committed || committed.bytes.length !== object.bytes.length || sha256(committed.bytes) !== digest) throw new Error('Solar terrain index commit mismatch');
    return { key, generationKey, sha256: digest, bytes: object.bytes.length, reused, index, elapsedMs: Date.now() - started, reader: reader.stats() };
  } finally { await reader.close(); }
}
