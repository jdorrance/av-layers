import z from 'zod';
import { METHODS, methodDescriptorSchema, methodIdSchema } from './methods.js';
import { GFS_PRODUCT, LAYER_IDS, type ProductDefinition } from './products.js';
import { LAYERS, PALETTES, layerDescriptorSchema, layerIdSchema, paletteSchema, sampleStatusSchema } from './layers.js';
import { gridSchema } from './geometry.js';
import { CELL_BYTES, SAMPLE_BLOCK_SIZE, MAX_SAMPLE_VALUES, MAX_RETAINED_BUILDS, MAX_NATIVE_ZOOM } from './format.js';

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
export function createRecipeIdentity(product: ProductDefinition, hash: string, sourceRevision = 'fixture', sourceDirty = false, lockHash = hash): z.infer<typeof recipeIdentitySchema> {
  return recipeIdentitySchema.parse({ id: product.id, hash, source: product.source, sourceRevision, sourceDirty, lockHash });
}
export function createProductMethodId(product: Pick<ProductDefinition, 'layers'> = GFS_PRODUCT): string {
  return [...new Set(product.layers.map(id => LAYERS[id].methodId))].join('+');
}
export function createProductDescriptors(product: ProductDefinition = GFS_PRODUCT): z.infer<typeof descriptorSchema> {
  return descriptorSchema.parse({
    layers: Object.fromEntries(product.layers.map(id => [id, LAYERS[id]])),
    methods: Object.fromEntries([...new Set(product.layers.map(id => LAYERS[id].methodId))].map(id => [id, METHODS[id]])),
    palettes: [...new Set(product.layers.map(id => LAYERS[id].palette))].map(id => PALETTES[id]),
    attribution: product.attribution, coverageDescription: product.coverageDescription, bounds: [...product.bounds], maxSampleValues: MAX_SAMPLE_VALUES
  });
}

const timestamp = z.iso.datetime();
const key = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const frameSchema = z.object({ id: key, validTime: timestamp, intervalStart: timestamp, intervalEnd: timestamp });
export const artifactSchema = z.object({ layer: layerIdSchema, frame: key, tilesKey: key, tilesSha256: sha256 });
/** Channels follow frames, then layers, in manifest order; the coverage determines block offsets. */
export const samplePackSchema = z.object({ format: z.literal('cell-major-blocks-v1'), blockSize: z.literal(SAMPLE_BLOCK_SIZE), storedCells: z.number().int().positive(), channelCount: z.number().int().positive(), bytes: z.number().int().positive(), key, sha256 });
export const manifestSchema = z.object({ version: z.literal(3), descriptors: descriptorSchema, recipe: recipeIdentitySchema, model: modelIdSchema, buildId: key, cycle: timestamp, createdAt: timestamp, expiresAt: timestamp, method: z.object({ id: key, hash: sha256 }), coverage: z.object({ id: key, hash: sha256, maskKey: key, maxZoom: z.number().int().min(0).max(MAX_NATIVE_ZOOM) }), grid: gridSchema, frames: z.array(frameSchema).min(1).max(MAX_SAMPLE_VALUES), layers: z.array(layerIdSchema).min(1).max(LAYER_IDS.length), artifacts: z.array(artifactSchema).min(1).max(MAX_SAMPLE_VALUES), samples: samplePackSchema, source: z.object({ provider: key, provenanceKey: key, provenanceSha256: sha256 }).catchall(z.unknown()), tool: z.record(z.string(), z.unknown()), palettes: z.array(key).min(1), metrics: z.record(z.string(), z.unknown()) });
export const provenanceSchema = z.object({ version: z.literal(1), model: modelIdSchema, buildId: key, cycle: timestamp, provider: z.string().min(1).max(256).optional(), temporalApproximation: z.string().max(2048).optional(), frames: z.array(z.unknown()).max(MAX_SAMPLE_VALUES) }).strict();
export const retainedBuildSchema = z.object({ buildId: key, manifestKey: key, cycle: timestamp, expiresAt: timestamp });
export const modelPointerSchema = z.object({ version: z.literal(1), model: modelIdSchema, latestBuildId: key, retained: z.array(retainedBuildSchema).min(1).max(MAX_RETAINED_BUILDS) }).refine(p => p.retained.some(b => b.buildId === p.latestBuildId), { message: 'latest build must be retained' });
export const sampleValueSchema = z.object({ value: z.number().finite().nullable(), status: sampleStatusSchema, support: z.number().int(), interpolated: z.boolean() });
export const sampleResponseSchema = z.object({ model: z.string(), buildId: z.string(), lat: z.number().finite(), lon: z.number().finite(), method: manifestSchema.shape.method, source: manifestSchema.shape.source, coverage: manifestSchema.shape.coverage, expiresAt: z.string(), frames: z.array(frameSchema.extend({ layers: z.record(z.string(), sampleValueSchema) })) });
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
export const latestSchema = z.object({ pointer: modelPointerSchema, manifest: manifestSchema.optional(), templates: z.record(z.string(), z.string()).optional(), freshness: freshnessSchema });
export type Manifest = z.infer<typeof manifestSchema>;
export type ModelPointer = z.infer<typeof modelPointerSchema>;
export type FreshnessSummary = z.infer<typeof freshnessSchema>;

/** The immutable forecast payloads; manifest and provenance are published separately. */
export function forecastObjects(manifest: Manifest): { key: string; sha256: string; contentType: string }[] {
  return [
    { key: manifest.samples.key, sha256: manifest.samples.sha256, contentType: 'application/octet-stream' },
    ...manifest.artifacts.map(a => ({ key: a.tilesKey, sha256: a.tilesSha256, contentType: 'application/vnd.pmtiles' }))
  ];
}

/** Every admitted alpha build has one immutable provenance sidecar. */
export function getProvenanceReference(
  manifest: Pick<Manifest, 'model' | 'buildId' | 'source'>
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
  manifest: Pick<Manifest, 'model' | 'buildId' | 'cycle'>
): z.infer<typeof provenanceSchema> {
  const provenance = provenanceSchema.parse(raw);
  if (provenance.model !== manifest.model || provenance.buildId !== manifest.buildId || provenance.cycle !== manifest.cycle) {
    throw new Error('Provenance does not match manifest');
  }
  return provenance;
}

export function computeFreshness(
  manifest: Pick<Manifest, 'createdAt' | 'cycle' | 'expiresAt' | 'frames'>,
  nowMs = Date.now()
): Required<FreshnessSummary> {
  const validTimes = manifest.frames.map(f => Date.parse(f.validTime)).filter(Number.isFinite);
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

export function validateArtifactRecords(manifest: Manifest): void {
  const frames = new Set(manifest.frames.map(frame => frame.id));
  if (manifest.layers.length * manifest.frames.length > manifest.descriptors.maxSampleValues) throw new Error('Sample value budget exceeded');
  for (const layer of manifest.layers) {
    const descriptor = manifest.descriptors.layers[layer];
    if (!descriptor || descriptor.id !== layer || !manifest.descriptors.palettes.some(p => p.id === descriptor.palette)) throw new Error('Incomplete product descriptors');
  }
  for (const frame of manifest.frames) {
    if (Date.parse(frame.intervalStart) > Date.parse(frame.intervalEnd) || Date.parse(frame.validTime) !== Date.parse(frame.intervalEnd)) throw new Error('Invalid frame time support');
  }
  const layers = new Set(manifest.layers);
  if (frames.size === 0 || frames.size !== manifest.frames.length) throw new Error(`expected distinct frames, found ${manifest.frames.length}`);
  if (layers.size === 0 || layers.size !== manifest.layers.length) throw new Error(`expected distinct layers, found ${manifest.layers.length}`);
  const expectedRecords = frames.size * layers.size;
  if (manifest.artifacts.length !== expectedRecords) {
    throw new Error(`expected ${expectedRecords} artifact records, found ${manifest.artifacts.length}`);
  }
  const combinations = new Set<string>();
  const prefix = `builds/${manifest.model}/${manifest.buildId}`;
  if (manifest.samples.key !== `${prefix}/samples.bin` || manifest.samples.channelCount !== expectedRecords || !Number.isSafeInteger(manifest.samples.bytes) || manifest.samples.bytes !== manifest.samples.storedCells * expectedRecords * CELL_BYTES) {
    throw new Error('Invalid sample pack metadata');
  }
  for (const artifact of manifest.artifacts) {
    if (!frames.has(artifact.frame)) throw new Error(`unknown artifact frame ${artifact.frame}`);
    if (!layers.has(artifact.layer)) throw new Error(`unknown artifact layer ${artifact.layer}`);
    const combination = `${artifact.layer}/${artifact.frame}`;
    if (combinations.has(combination)) throw new Error(`duplicate artifact record ${combination}`);
    combinations.add(combination);
    if (artifact.tilesKey !== `${prefix}/${artifact.layer}/${artifact.frame}.pmtiles`) throw new Error(`unexpected tilesKey ${artifact.tilesKey}`);
  }
}

