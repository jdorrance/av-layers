import z from 'zod';
import { LAYER_IDS, layerSurface, renderedLayers, type LayerId } from './layers.js';
import { layerDescriptorSchema, layerIdSchema, paletteSchema, sampleStatusSchema } from './layer-schemas.js';
import { methodDescriptorSchema, methodIdSchema } from './method-schemas.js';
import { gridSchema, sameGrid } from './grid-schema.js';
import { CELL_BYTES, SAMPLE_BLOCK_SIZE, MAX_SAMPLE_VALUES, MAX_RETAINED_BUILDS, MAX_NATIVE_ZOOM, PROFILE_PACK_FORMAT, PROFILE_HEADER_BYTES, PROFILE_LEVEL_BYTES, MAX_PROFILE_LEVELS } from './format.js';
import { MAX_JSON_CONTAINER_ENTRIES, MAX_PROVENANCE_BYTES } from './json.js';

export const modelIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export type ModelId = z.infer<typeof modelIdSchema>;

export const descriptorSchema = z.object({
  layers: z.record(z.string(), layerDescriptorSchema), palettes: z.array(paletteSchema).min(1).max(16),
  methods: z.record(methodIdSchema, methodDescriptorSchema),
  attribution: z.string().min(1).max(2048), coverageDescription: z.string().max(2048),
  bounds: z.tuple([z.number().finite(), z.number().min(-90).max(90), z.number().finite(), z.number().min(-90).max(90)]),
  maxSampleValues: z.number().int().positive().max(MAX_SAMPLE_VALUES)
}).superRefine((descriptors, ctx) => {
  for (const layer of Object.values(descriptors.layers)) {
    const method = descriptors.methods[layer.methodId];
    if (!method || !method.outputs.includes(layer.id)) ctx.addIssue({ code: 'custom', path: ['methods', layer.methodId], message: 'Layer lacks its declared method output' });
  }
  for (const [id, method] of Object.entries(descriptors.methods)) {
    if (method.id !== id || !Object.values(descriptors.layers).some(layer => layer.methodId === id)) ctx.addIssue({ code: 'custom', path: ['methods', id], message: 'Method identity or layer membership mismatch' });
  }
});
export const recipeIdentitySchema = z.object({
  id: z.string().min(1).max(128), hash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.object({ modelFamily: modelIdSchema, configurationId: z.string().min(1), domainId: z.string().min(1) }),
  sourceRevision: z.string().min(1).max(128), sourceDirty: z.boolean(), lockHash: z.string().regex(/^[a-f0-9]{64}$/)
});
const timestamp = z.iso.datetime();
const key = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const frameSchema = z.object({ id: key, validTime: timestamp, intervalStart: timestamp, intervalEnd: timestamp });
export const artifactSchema = z.object({ layer: layerIdSchema, frame: key, tilesKey: key, tilesSha256: sha256 });
export const methodIdentitySchema = z.object({ id: key, hash: sha256 });
export const coverageReferenceSchema = z.object({ id: key, hash: sha256, maskKey: key, maxZoom: z.number().int().min(0).max(MAX_NATIVE_ZOOM) });
export const publicationShape = {
  descriptors: descriptorSchema, recipe: recipeIdentitySchema, model: modelIdSchema,
  buildId: key, cycle: timestamp, createdAt: timestamp, expiresAt: timestamp, method: methodIdentitySchema,
  frames: z.array(frameSchema).min(1).max(MAX_JSON_CONTAINER_ENTRIES), layers: z.array(layerIdSchema).min(1).max(LAYER_IDS.length),
  artifacts: z.array(artifactSchema).min(1).max(MAX_JSON_CONTAINER_ENTRIES),
  source: z.object({ provider: key, provenanceKey: key, provenanceSha256: sha256 }).catchall(z.unknown()),
  tool: z.looseObject({ useStoredMslNoLift: z.literal(true).optional() }), palettes: z.array(key).min(1), metrics: z.record(z.string(), z.unknown())
};

const provenanceIdentity = { model: modelIdSchema, buildId: key, cycle: timestamp };
const provenanceDescription = { ...provenanceIdentity, provider: z.string().min(1).max(256).optional(), temporalApproximation: z.string().max(2048).optional() };
export const provenanceFrameReferenceSchema = z.strictObject({ hour: z.number().int().positive(), frame: key, key,
  bytes: z.number().int().positive().max(MAX_PROVENANCE_BYTES), sha256 });
export type ProvenanceFrameReference = z.infer<typeof provenanceFrameReferenceSchema>;
export const frameProvenanceSchema = z.strictObject({ version: z.literal(1), ...provenanceIdentity,
  frame: frameSchema, hour: z.number().int().positive(), intervals: z.unknown(), receipt: z.unknown() });
export const provenanceSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), ...provenanceDescription, frames: z.array(z.unknown()).max(MAX_JSON_CONTAINER_ENTRIES) }),
  z.strictObject({ version: z.literal(2), ...provenanceDescription, frames: z.array(provenanceFrameReferenceSchema).min(1).max(MAX_JSON_CONTAINER_ENTRIES) })
]);
export const retainedBuildSchema = z.object({ buildId: key, manifestKey: key, cycle: timestamp, expiresAt: timestamp });
export const modelPointerSchema = z.object({ version: z.literal(1), model: modelIdSchema, latestBuildId: key, retained: z.array(retainedBuildSchema).min(1).max(MAX_RETAINED_BUILDS) }).refine(p => p.retained.some(b => b.buildId === p.latestBuildId), { message: 'latest build must be retained' });
export const mapDataReferenceSchema = z.strictObject({ sha256, bytes: z.number().int().positive().max(1024 * 1024) });
export const storedModelPointerSchema = z.object({ version: z.literal(1), model: modelIdSchema, latestBuildId: key,
  retained: z.array(retainedBuildSchema.extend({ mapData: mapDataReferenceSchema.optional() })).min(1).max(MAX_RETAINED_BUILDS)
}).refine(p => p.retained.some(b => b.buildId === p.latestBuildId), { message: 'latest build must be retained' });
export type StoredModelPointer = z.infer<typeof storedModelPointerSchema>;
export const freshnessSchema = z.object({
  ageSeconds: z.number(),
  expiresAt: z.string(),
  cycle: z.string().optional(),
  cycleAgeSeconds: z.number().optional(),
  earliestValidTime: z.string().optional(),
  latestValidTime: z.string().optional(),
  horizonRemainingSeconds: z.number().optional(),
  horizonExhausted: z.boolean().optional()
});
export type ModelPointer = z.infer<typeof modelPointerSchema>;
export type FreshnessSummary = z.infer<typeof freshnessSchema>;

const safePositive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const safeNonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const shardSchema = z.strictObject({
  firstBlock: safeNonnegative, blockCount: safePositive, storedCells: safePositive,
  bytes: safePositive.max(64 * 1024 * 1024), key, sha256
});
export const frameGroupShardSchema = shardSchema.extend({
  group: safeNonnegative, firstFrame: safeNonnegative, frameCount: safePositive, blockShard: safeNonnegative
});
const sampleV5Base = {
  blockSize: z.literal(SAMPLE_BLOCK_SIZE), channelOrder: z.literal('frame-then-layer'), channelCount: safePositive,
  coverageHash: sha256, blockCount: safePositive, storedCells: safePositive
};
const profilePackSchema = z.strictObject({
  format: z.literal(PROFILE_PACK_FORMAT), blockSize: z.literal(SAMPLE_BLOCK_SIZE),
  levelCount: safePositive.max(MAX_PROFILE_LEVELS), recordBytes: safePositive,
  coverageHash: sha256, blockCount: safePositive, storedCells: safePositive,
  groups: z.array(z.strictObject({ firstFrame: safeNonnegative, frameCount: safePositive, shards: z.array(shardSchema).min(1).max(MAX_JSON_CONTAINER_ENTRIES) })).min(1).max(MAX_JSON_CONTAINER_ENTRIES)
}).refine(pack => pack.recordBytes === PROFILE_HEADER_BYTES + pack.levelCount * PROFILE_LEVEL_BYTES, 'Profile record width differs from level capacity');
const surfaceV5Schema = z.strictObject({
  id: modelIdSchema, kind: z.enum(['native', 'fine']), grid: gridSchema, gridHash: sha256,
  coverage: coverageReferenceSchema.extend({ gridHash: sha256 }).strict(),
  layers: z.array(layerIdSchema).min(1).max(LAYER_IDS.length),
  samples: z.discriminatedUnion('format', [
    z.strictObject({ ...sampleV5Base, format: z.literal('cell-major-block-shards-v1'), shards: z.array(shardSchema).min(1) }),
    z.strictObject({ ...sampleV5Base, format: z.literal('frame-group-block-shards-v1'), shards: z.array(frameGroupShardSchema).min(1) })
  ]),
  profiles: profilePackSchema.optional(),
  terrain: z.strictObject({
    dataId: sha256, key: z.string().regex(/^terrain\/prepared\/[a-f0-9]{64}\/manifest\.json$/),
    sha256, verticalDatum: z.string().min(1).max(80), surface: z.string().min(1).max(80),
    gridHash: sha256, coverageHash: sha256, layoutVersion: z.literal(1)
  }).optional()
});
export type ForecastSurfaceV5 = z.infer<typeof surfaceV5Schema>;
const { source, tool, palettes, metrics, ...publicationIdentity } = publicationShape;
const manifestV5BaseSchema = z.strictObject({
  version: z.literal(5), ...publicationIdentity, surfaces: z.array(surfaceV5Schema).min(1).max(2),
  source, tool, palettes, metrics, mapFrameCount: safePositive.optional()
});
export const manifestV5Schema = manifestV5BaseSchema.superRefine((manifest, ctx) => {
  try { validateV5Records(manifest); }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid v5 manifest' }); }
});
export type ManifestV5 = z.infer<typeof manifestV5Schema>;
export const latestV5Schema = z.object({ pointer: modelPointerSchema, manifest: manifestV5Schema.optional(), templates: z.record(z.string(), z.string()).optional(), freshness: freshnessSchema });

const sampleValueV5Schema = z.strictObject({ value: z.number().finite().nullable(), status: sampleStatusSchema,
  support: z.number().int(), interpolated: z.boolean(), surfaceId: modelIdSchema });
export const sampleResponseV5Schema = z.strictObject({
  version: z.literal(5), model: z.string(), buildId: z.string(),
  lat: z.number().finite(), lon: z.number().finite(), method: methodIdentitySchema,
  source: publicationShape.source, expiresAt: z.string(),
  surfaces: z.array(surfaceV5Schema.pick({ id: true, kind: true, layers: true, coverage: true })).min(1).max(2),
  frames: z.array(frameSchema.extend({ layers: z.record(z.string(), sampleValueV5Schema) }))
}).superRefine((response, ctx) => {
  const owners = new Map<string, string>(), ids = new Set<string>(), kinds = new Set<string>();
  for (const surface of response.surfaces) {
    if (ids.has(surface.id) || kinds.has(surface.kind)) ctx.addIssue({ code: 'custom', message: 'Duplicate surface identity' });
    ids.add(surface.id); kinds.add(surface.kind);
    for (const layer of surface.layers) {
      if (owners.has(layer) || surface.kind !== layerSurface(layer)) ctx.addIssue({ code: 'custom', message: 'Invalid layer ownership' });
      owners.set(layer, surface.id);
    }
  }
  for (const frame of response.frames) for (const [layer, value] of Object.entries(frame.layers)) {
    if (owners.get(layer) !== value.surfaceId) ctx.addIssue({ code: 'custom', message: 'Sample surface does not own layer' });
  }
});
const catalogBoundsSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90),
  z.number().min(-180).max(180), z.number().min(-90).max(90)]).refine(([, south, , north]) => south <= north);

export const catalogModelSchema = z.object({
  model: modelIdSchema,
  label: z.string().optional(),
  nominalDxMeters: z.number().int().positive().optional(),
  bounds: catalogBoundsSchema.optional(),
  available: z.boolean(),
  latest: z.string().optional(),
  cycle: z.string().optional(),
  expiresAt: z.string().optional(),
  surfaces: sampleResponseV5Schema.shape.surfaces.optional(),
  ageSeconds: z.number().optional(),
  freshness: freshnessSchema.optional(),
  error: z.string().optional()
});
export const catalogSchema = z.object({ models: z.array(catalogModelSchema).max(256) });
export type CatalogModelEntry = z.infer<typeof catalogModelSchema>;

export function validateArtifactRecordsV5(manifest: ManifestV5): void {
  validateV5Records(manifestV5BaseSchema.parse(manifest));
}

function validateV5Records(manifest: ManifestV5): void {
  if (manifest.mapFrameCount !== undefined && manifest.mapFrameCount > manifest.frames.length) throw new Error('Invalid map frame prefix');
  if (!/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(manifest.buildId)) throw new Error('Invalid build ID');
  const frames = new Set(manifest.frames.map(frame => frame.id)), mapFrames = new Set(renderedFrames(manifest).map(frame => frame.id)), layers = new Set(manifest.layers);
  if (frames.size !== manifest.frames.length || layers.size !== manifest.layers.length) throw new Error('Duplicate frames or layers');
  const methods = new Set<string>();
  for (const layer of manifest.layers) {
    const descriptor = manifest.descriptors.layers[layer];
    if (!descriptor || descriptor.id !== layer || (descriptor.delivery !== 'samples-only' && !manifest.descriptors.palettes.some(p => p.id === descriptor.palette))) throw new Error('Incomplete product descriptors');
    methods.add(descriptor.methodId);
  }
  if (manifest.method.id !== [...methods].join('+')) throw new Error('Method identity does not match published descriptor snapshots');
  for (const frame of manifest.frames) {
    if (Date.parse(frame.intervalStart) > Date.parse(frame.intervalEnd) || Date.parse(frame.validTime) !== Date.parse(frame.intervalEnd)) throw new Error('Invalid frame time support');
  }
  const prefix = `builds/${manifest.model}/${manifest.buildId}`;
  const owned = new Set<LayerId>(), ids = new Set<string>(), kinds = new Set<string>(), keys = new Set<string>();
  for (const surface of manifest.surfaces) {
    if (ids.has(surface.id) || kinds.has(surface.kind)) throw new Error('Duplicate surface identity');
    ids.add(surface.id); kinds.add(surface.kind);
    if (surface.coverage.gridHash !== surface.gridHash || surface.samples.coverageHash !== surface.coverage.hash
      || !new RegExp(`^coverage/${surface.coverage.hash}/[a-z0-9][a-z0-9._-]*$`).test(surface.coverage.maskKey)) throw new Error('Coverage identity mismatch');
    if ((surface.kind === 'fine') !== (surface.terrain !== undefined)) throw new Error('Fine surface requires terrain identity');
    if (surface.terrain && (surface.terrain.gridHash !== surface.gridHash || surface.terrain.coverageHash !== surface.coverage.hash)) throw new Error('Terrain identity mismatch');
    let previous = -1;
    for (const layer of surface.layers) {
      const index = manifest.layers.indexOf(layer);
      if (index <= previous || owned.has(layer) || surface.kind !== layerSurface(layer)) throw new Error('Invalid layer ownership or order');
      previous = index; owned.add(layer);
    }
    const expectedFrames = surfaceFrameCount(manifest, surface);
    const samples = surface.samples, expectedChannels = expectedFrames * surface.layers.length;
    if (samples.channelCount !== expectedChannels) throw new Error('Invalid channel count');
    const blockSlots = Math.ceil(surface.grid.width / SAMPLE_BLOCK_SIZE) * Math.ceil(surface.grid.height / SAMPLE_BLOCK_SIZE);
    if (!Number.isSafeInteger(blockSlots) || samples.blockCount > blockSlots) throw new Error('Invalid sample block count');
    let nextBlock = 0, cells = 0, nextFrame = 0, group = -1, blockShard = 0, groupFirstFrame = 0, groupFrameCount = 0;
    for (let i = 0; i < samples.shards.length; i++) {
      const shard = samples.shards[i];
      let channels = expectedChannels, expectedKey = `${prefix}/surfaces/${surface.id}/samples/${i}.bin`;
      if (samples.format === 'frame-group-block-shards-v1' && 'group' in shard) {
        if (shard.group !== group) {
          if (shard.group !== group + 1 || (group >= 0 && (nextBlock !== samples.blockCount || cells !== samples.storedCells))
            || shard.firstFrame !== nextFrame) throw new Error('Invalid sample frame group');
          group = shard.group; groupFirstFrame = shard.firstFrame; groupFrameCount = shard.frameCount;
          nextFrame += shard.frameCount; nextBlock = 0; cells = 0; blockShard = 0;
        }
        if (shard.firstFrame !== groupFirstFrame || shard.frameCount !== groupFrameCount || shard.blockShard !== blockShard++) throw new Error('Invalid sample frame group');
        channels = shard.frameCount * surface.layers.length;
        expectedKey = `${prefix}/surfaces/${surface.id}/samples/g${shard.group}-b${shard.blockShard}.bin`;
      }
      const bytes = shard.storedCells * channels * CELL_BYTES;
      if (shard.firstBlock !== nextBlock || shard.storedCells < shard.blockCount || shard.storedCells > shard.blockCount * (SAMPLE_BLOCK_SIZE + 1) ** 2
        || !Number.isSafeInteger(bytes) || shard.bytes !== bytes
        || shard.key !== expectedKey || keys.has(shard.key)) throw new Error('Invalid sample shard');
      nextBlock += shard.blockCount; cells += shard.storedCells; keys.add(shard.key);
      if (!Number.isSafeInteger(nextBlock) || !Number.isSafeInteger(cells)) throw new Error('Sample shard arithmetic overflow');
    }
    if (nextBlock !== samples.blockCount || cells !== samples.storedCells || (samples.format === 'frame-group-block-shards-v1' && nextFrame !== expectedFrames)) throw new Error('Incomplete sample shard ranges');
    if (surface.profiles) {
      const profiles = surface.profiles;
      if (surface.kind !== 'native' || profiles.coverageHash !== surface.coverage.hash || profiles.blockCount !== samples.blockCount || profiles.storedCells !== samples.storedCells) throw new Error('Profile coverage identity mismatch');
      validateProfileShards(profiles, manifest.frames.length, `${prefix}/surfaces/${surface.id}/profiles`, keys);
    }
  }
  if (owned.size !== layers.size || manifest.layers.some(layer => !owned.has(layer))) throw new Error('Incomplete layer ownership');
  if (manifest.artifacts.length !== mapFrames.size * renderedLayers(manifest.layers, manifest.descriptors.layers).length) throw new Error('Invalid artifact count');
  const combinations = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const combination = `${artifact.layer}/${artifact.frame}`;
    if (!layers.has(artifact.layer) || manifest.descriptors.layers[artifact.layer]?.delivery === 'samples-only' || !mapFrames.has(artifact.frame) || combinations.has(combination)
      || artifact.tilesKey !== `${prefix}/${artifact.layer}/${artifact.frame}.pmtiles` || keys.has(artifact.tilesKey)) throw new Error('Invalid artifact record');
    combinations.add(combination); keys.add(artifact.tilesKey);
  }
}

function validateProfileShards(profiles: z.infer<typeof profilePackSchema>, frames: number, prefix: string, keys: Set<string>): void {
  let nextFrame = 0;
  for (const [groupIndex, group] of profiles.groups.entries()) {
    if (group.firstFrame !== nextFrame) throw new Error('Invalid profile frame group');
    let nextBlock = 0, cells = 0;
    for (const [blockShard, shard] of group.shards.entries()) {
      const bytes = shard.storedCells * group.frameCount * profiles.recordBytes;
      if (shard.firstBlock !== nextBlock || shard.storedCells < shard.blockCount || shard.storedCells > shard.blockCount * (SAMPLE_BLOCK_SIZE + 1) ** 2
        || !Number.isSafeInteger(bytes) || shard.bytes !== bytes || keys.has(shard.key)
        || shard.key !== `${prefix}/g${groupIndex}-b${blockShard}.bin`) throw new Error('Invalid profile shard');
      nextBlock += shard.blockCount; cells += shard.storedCells; keys.add(shard.key);
      if (!Number.isSafeInteger(nextBlock) || !Number.isSafeInteger(cells)) throw new Error('Profile shard arithmetic overflow');
    }
    if (nextBlock !== profiles.blockCount || cells !== profiles.storedCells) throw new Error('Incomplete profile block ranges');
    nextFrame += group.frameCount;
  }
  if (nextFrame !== frames) throw new Error('Incomplete profile frame groups');
}

interface SurfaceLayoutBindingV5 { grid: ForecastSurfaceV5['grid']; gridHash: string; coverageHash: string; blockIds: ArrayLike<number> }

export function assertSampleLayoutBindingV5(surface: ForecastSurfaceV5, binding: SurfaceLayoutBindingV5): void {
  assertPackedLayoutBindingV5(surface, binding, surface.samples, CELL_BYTES, surface.layers.length);
}

export function assertProfileLayoutBindingV5(surface: ForecastSurfaceV5, binding: SurfaceLayoutBindingV5): void {
  if (!surface.profiles || surface.kind !== 'native') throw new Error('Profile layout identity mismatch');
  for (const group of surface.profiles.groups) assertPackedLayoutBindingV5(surface, binding, { ...surface.profiles, shards: group.shards, channelCount: group.frameCount }, surface.profiles.recordBytes, 1);
}

function assertPackedLayoutBindingV5(
  surface: ForecastSurfaceV5, binding: SurfaceLayoutBindingV5,
  pack: Pick<ForecastSurfaceV5['samples'], 'coverageHash' | 'blockCount' | 'storedCells' | 'shards' | 'channelCount'>, recordBytes: number, layers: number
): void {
  if (!sameGrid(surface.grid, binding.grid) || surface.gridHash !== binding.gridHash || surface.coverage.hash !== binding.coverageHash
    || pack.coverageHash !== binding.coverageHash || pack.blockCount !== binding.blockIds.length) throw new Error('Sample layout identity mismatch');
  const { width, height, wrapLongitude } = surface.grid, columns = Math.ceil(width / SAMPLE_BLOCK_SIZE), rows = Math.ceil(height / SAMPLE_BLOCK_SIZE);
  let previous = -1, nextBlock = 0, totalCells = 0, group = -1;
  for (const shard of pack.shards) {
    if ('group' in shard && shard.group !== group) {
      if (group >= 0 && (nextBlock !== binding.blockIds.length || totalCells !== pack.storedCells)) throw new Error('Incomplete sample block ranges');
      group = shard.group; previous = -1; nextBlock = 0; totalCells = 0;
    }
    let cells = 0;
    const end = shard.firstBlock + shard.blockCount;
    if (!Number.isSafeInteger(shard.firstBlock) || shard.firstBlock !== nextBlock || !Number.isSafeInteger(shard.blockCount) || shard.blockCount <= 0
      || !Number.isSafeInteger(end) || end > binding.blockIds.length) throw new Error('Sample block range mismatch');
    for (let i = shard.firstBlock; i < end; i++) {
      const id = binding.blockIds[i];
      if (!Number.isSafeInteger(id) || id <= previous || id >= columns * rows) throw new Error('Invalid sample block order');
      previous = id;
      const row = Math.floor(id / columns) * SAMPLE_BLOCK_SIZE, column = (id % columns) * SAMPLE_BLOCK_SIZE;
      const coreWidth = Math.min(SAMPLE_BLOCK_SIZE, width - column);
      const blockWidth = wrapLongitude ? coreWidth + 1 : Math.min(coreWidth + 1, width - column);
      cells += blockWidth * Math.min(SAMPLE_BLOCK_SIZE + 1, height - row);
    }
    const channels = 'frameCount' in shard ? shard.frameCount * layers : 'channelCount' in pack ? pack.channelCount : 0;
    if (!Number.isSafeInteger(cells) || cells !== shard.storedCells || !Number.isSafeInteger(cells * channels * recordBytes)
      || shard.bytes !== cells * channels * recordBytes) throw new Error('Sample block size mismatch');
    nextBlock = end; totalCells += cells;
  }
  if (nextBlock !== binding.blockIds.length || totalCells !== pack.storedCells) throw new Error('Incomplete sample block ranges');
}

export function getProvenanceReference(
  manifest: Pick<ManifestV5, 'model' | 'buildId' | 'source'>
): { key: string; sha256: string } {
  const source = manifest.source;
  const digest = sha256.safeParse(source.provenanceSha256);
  if (source.provenanceKey !== `builds/${manifest.model}/${manifest.buildId}/provenance.json` || !digest.success) {
    throw new Error('Invalid provenance reference');
  }
  return { key: source.provenanceKey, sha256: digest.data };
}

export function parseProvenance(
  raw: unknown,
  manifest: Pick<ManifestV5, 'model' | 'buildId' | 'cycle'> & Partial<Pick<ManifestV5, 'frames'>>
): z.infer<typeof provenanceSchema> {
  const provenance = provenanceSchema.parse(raw);
  if (provenance.model !== manifest.model || provenance.buildId !== manifest.buildId || provenance.cycle !== manifest.cycle) {
    throw new Error('Provenance does not match manifest');
  }
  if (provenance.version === 2) {
    if (manifest.frames && provenance.frames.length !== manifest.frames.length) throw new Error('Incomplete provenance frames');
    for (const [index, reference] of provenance.frames.entries()) {
      const frame = manifest.frames?.[index];
      if (reference.frame !== `f${String(reference.hour).padStart(3, '0')}`
          || reference.key !== `builds/${manifest.model}/${manifest.buildId}/provenance/${reference.frame}.json`
          || (index > 0 && reference.hour <= provenance.frames[index - 1]!.hour)
          || (frame && (reference.frame !== frame.id || Date.parse(frame.validTime) !== Date.parse(manifest.cycle) + reference.hour * 3_600_000))) {
        throw new Error('Invalid provenance frame reference');
      }
    }
  }
  return provenance;
}

export function parseFrameProvenance(raw: unknown, identity: Pick<ManifestV5, 'model' | 'buildId' | 'cycle'> & Partial<Pick<ManifestV5, 'layers'>>, frame: ManifestV5['frames'][number]) {
  const value = frameProvenanceSchema.parse(raw);
  const requiresPrecipitation = identity.layers?.includes('precip-rate') || (value.intervals as { precipitationWindow?: unknown } | null)?.precipitationWindow !== undefined;
  if (value.model !== identity.model || value.buildId !== identity.buildId || value.cycle !== identity.cycle
      || value.frame.id !== frame.id || value.frame.validTime !== frame.validTime || value.frame.intervalStart !== frame.intervalStart || value.frame.intervalEnd !== frame.intervalEnd
      || Date.parse(frame.validTime) !== Date.parse(identity.cycle) + value.hour * 3_600_000
      || !matchesFrameIntervals(value.intervals, frame, requiresPrecipitation)) {
    throw new Error('Provenance frame does not match manifest');
  }
  return value;
}

export function matchesFrameIntervals(intervals: unknown, frame: ManifestV5['frames'][number], requiresPrecipitation: boolean): boolean {
  if (!intervals || typeof intervals !== 'object') return false;
  const value = intervals as { profileTime?: unknown; fluxWindow?: { start?: unknown; end?: unknown }; precipitationWindow?: { start?: unknown; end?: unknown } };
  const sameInstant = (value: unknown, expected: string): boolean => typeof value === 'string' && Date.parse(value) === Date.parse(expected);
  return sameInstant(value.profileTime, frame.validTime)
    && sameInstant(value.fluxWindow?.start, frame.intervalStart) && sameInstant(value.fluxWindow?.end, frame.intervalEnd)
    && (!requiresPrecipitation || (sameInstant(value.precipitationWindow?.start, frame.intervalStart) && sameInstant(value.precipitationWindow?.end, frame.intervalEnd)));
}

export function computeFreshness(
  manifest: Pick<ManifestV5, 'createdAt' | 'cycle' | 'expiresAt' | 'frames'> & { version?: number; mapFrameCount?: number },
  nowMs = Date.now()
): Required<FreshnessSummary> {
  const validTimes = renderedFrames(manifest).map(f => Date.parse(f.validTime)).filter(Number.isFinite);
  const earliestMs = validTimes.length > 0 ? Math.min(...validTimes) : Date.parse(manifest.cycle);
  const latestMs = validTimes.length > 0 ? Math.max(...validTimes) : Date.parse(manifest.cycle);
  return {
    ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(manifest.createdAt)) / 1000)),
    expiresAt: manifest.expiresAt,
    cycle: manifest.cycle,
    cycleAgeSeconds: Math.max(0, Math.floor((nowMs - Date.parse(manifest.cycle)) / 1000)),
    earliestValidTime: new Date(earliestMs).toISOString(),
    latestValidTime: new Date(latestMs).toISOString(),
    horizonRemainingSeconds: Math.max(0, Math.floor((latestMs - nowMs) / 1000)),
    horizonExhausted: latestMs <= nowMs
  };
}

/** Raster consumers use the ordered map prefix; legacy manifests expose all frames. */
export function renderedFrames(manifest: { frames: ManifestV5['frames']; version?: number; mapFrameCount?: number }): ManifestV5['frames'] {
  return manifest.version === 5 && manifest.mapFrameCount !== undefined ? manifest.frames.slice(0, manifest.mapFrameCount) : manifest.frames;
}

export function surfaceFrameCount(manifest: ManifestV5, surface: Pick<ForecastSurfaceV5, 'kind'>): number {
  return surface.kind === 'fine' ? manifest.mapFrameCount ?? manifest.frames.length : manifest.frames.length;
}
