import z from 'zod';
import { LIFT_METHOD, LIFT_METHODS_BY_VERTICAL_COORDINATE, METHODS, TERRAIN_CLEARANCE_METHOD, methodDescriptorSchema, methodIdSchema } from './methods.js';
import { LAYER_IDS, type LayerId, type ProductDefinition } from './product.js';
import { LAYERS, PALETTES, layerDescriptorSchema, layerIdSchema, paletteSchema, sampleStatusSchema } from './layers.js';
import { gridSchema, sameGrid, type GeographicBounds } from './geometry.js';
import type { CoverageDescriptor } from './coverage.js';
import { CELL_BYTES, SAMPLE_BLOCK_SIZE, MAX_SAMPLE_VALUES, MAX_RETAINED_BUILDS, MAX_NATIVE_ZOOM } from './format.js';
import { MAX_REFINEMENT_ZONES, refinementGeometrySchema, parseRefinementConfig } from './refinement.js';

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
function methodForLayer(product: Pick<ProductDefinition, 'capabilities'>, layer: LayerId) {
  const method = METHODS[LAYERS[layer].methodId];
  return method.id === LIFT_METHOD.id ? LIFT_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate] : method;
}
export function createProductMethodId(product: Pick<ProductDefinition, 'layers' | 'capabilities'>): string {
  return [...new Set(product.layers.map(id => methodForLayer(product, id).id))].join('+');
}
export function createProductDescriptors(product: ProductDefinition): z.infer<typeof descriptorSchema> {
  const layers = product.layers.map(id => ({ ...LAYERS[id], methodId: methodForLayer(product, id).id }));
  return descriptorSchema.parse({
    layers: Object.fromEntries(layers.map(layer => [layer.id, layer])),
    methods: Object.fromEntries(layers.map(layer => [layer.methodId, METHODS[layer.methodId]])),
    palettes: [...new Set(product.layers.map(id => LAYERS[id].palette))].map(id => PALETTES[id]),
    attribution: product.attribution, coverageDescription: product.coverageDescription, bounds: [...product.bounds], maxSampleValues: MAX_SAMPLE_VALUES
  });
}

export function createRefinementDescriptors(product: ProductDefinition, bounds: GeographicBounds): z.infer<typeof descriptorSchema> {
  const base = createProductDescriptors(product), layer = base.layers['usable-lift-agl'];
  if (!layer) throw new Error('Terrain clearance requires the AGL layer');
  return descriptorSchema.parse({ ...base, bounds: [...bounds],
    coverageDescription: 'Polygon-owned terrain clearance inside the model coverage, with interpolation halos excluded.',
    layers: { [layer.id]: { ...layer, label: 'Usable lift depth (terrain AGL)', verticalReference: 'terrain-AGL', methodId: TERRAIN_CLEARANCE_METHOD.id } },
    methods: { [TERRAIN_CLEARANCE_METHOD.id]: TERRAIN_CLEARANCE_METHOD },
    palettes: base.palettes.filter(palette => palette.id === layer.palette)
  });
}

const timestamp = z.iso.datetime();
const key = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const frameSchema = z.object({ id: key, validTime: timestamp, intervalStart: timestamp, intervalEnd: timestamp });
export const artifactSchema = z.object({ layer: layerIdSchema, frame: key, tilesKey: key, tilesSha256: sha256 });
/** Channels follow frames, then layers, in manifest order; the coverage determines block offsets. */
export const samplePackSchema = z.object({ format: z.literal('cell-major-blocks-v1'), blockSize: z.literal(SAMPLE_BLOCK_SIZE), storedCells: z.number().int().positive(), channelCount: z.number().int().positive(), bytes: z.number().int().positive(), key, sha256 });
const methodIdentitySchema = z.object({ id: key, hash: sha256 });
const coverageReferenceSchema = z.object({ id: key, hash: sha256, maskKey: key, maxZoom: z.number().int().min(0).max(MAX_NATIVE_ZOOM) });
export const refinementPatchSchema = z.strictObject({
  id: modelIdSchema,
  grid: gridSchema,
  coverage: coverageReferenceSchema,
  geometry: refinementGeometrySchema,
  descriptors: descriptorSchema,
  layers: z.array(layerIdSchema).min(1).max(LAYER_IDS.length),
  samples: samplePackSchema,
  method: methodIdentitySchema,
  terrain: z.strictObject({
    dataId: sha256,
    key: z.string().regex(/^terrain\/prepared\/[a-f0-9]{64}\/manifest\.json$/),
    sha256,
    verticalDatum: z.string().min(1).max(80),
    surface: z.string().min(1).max(80)
  })
});
export type RefinementPatch = z.infer<typeof refinementPatchSchema>;
export const manifestSchema = z.object({
  version: z.union([z.literal(3), z.literal(4)]), descriptors: descriptorSchema, recipe: recipeIdentitySchema, model: modelIdSchema,
  buildId: key, cycle: timestamp, createdAt: timestamp, expiresAt: timestamp, method: methodIdentitySchema,
  coverage: coverageReferenceSchema, grid: gridSchema,
  frames: z.array(frameSchema).min(1).max(MAX_SAMPLE_VALUES), layers: z.array(layerIdSchema).min(1).max(LAYER_IDS.length),
  artifacts: z.array(artifactSchema).min(1).max(MAX_SAMPLE_VALUES), samples: samplePackSchema,
  patches: z.array(refinementPatchSchema).min(1).max(MAX_REFINEMENT_ZONES).optional(),
  source: z.object({ provider: key, provenanceKey: key, provenanceSha256: sha256 }).catchall(z.unknown()),
  tool: z.record(z.string(), z.unknown()), palettes: z.array(key).min(1), metrics: z.record(z.string(), z.unknown())
}).superRefine((manifest, ctx) => {
  if ((manifest.version === 4) !== (manifest.patches !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only version 4 publishes refinement patches' });
});
export const provenanceSchema = z.object({ version: z.literal(1), model: modelIdSchema, buildId: key, cycle: timestamp, provider: z.string().min(1).max(256).optional(), temporalApproximation: z.string().max(2048).optional(), frames: z.array(z.unknown()).max(MAX_SAMPLE_VALUES) }).strict();
export const retainedBuildSchema = z.object({ buildId: key, manifestKey: key, cycle: timestamp, expiresAt: timestamp });
export const modelPointerSchema = z.object({ version: z.literal(1), model: modelIdSchema, latestBuildId: key, retained: z.array(retainedBuildSchema).min(1).max(MAX_RETAINED_BUILDS) }).refine(p => p.retained.some(b => b.buildId === p.latestBuildId), { message: 'latest build must be retained' });
export const sampleValueSchema = z.object({ value: z.number().finite().nullable(), status: sampleStatusSchema, support: z.number().int(), interpolated: z.boolean(), patchId: modelIdSchema.optional() });
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

/** One numerical surface; every surface inherits the parent model's frame axis. */
export type ForecastGrid = Pick<Manifest, 'grid' | 'coverage' | 'samples' | 'layers' | 'descriptors' | 'method'>;
export function forecastGrids(manifest: Manifest): ForecastGrid[] { return [manifest, ...(manifest.patches ?? [])]; }

/** A coverage hash binds its geometry and public extent to one numeric surface. */
export function assertCoverageBinding(descriptor: CoverageDescriptor, surface: Pick<ForecastGrid, 'grid' | 'coverage'> & { descriptors: Pick<ForecastGrid['descriptors'], 'bounds'> }): void {
  if (descriptor.id !== surface.coverage.id || descriptor.maxZoom !== surface.coverage.maxZoom
    || !sameGrid(descriptor.grid, surface.grid) || JSON.stringify(descriptor.bounds) !== JSON.stringify(surface.descriptors.bounds)
    || surface.coverage.maskKey !== `coverage/${surface.coverage.hash}/manifest.json`) throw new Error('Coverage descriptor binding mismatch');
}

/** The immutable forecast payloads; manifest and provenance are published separately. */
export function forecastObjects(manifest: Manifest): { key: string; sha256: string; contentType: string }[] {
  return [
    ...forecastGrids(manifest).map(grid => ({ key: grid.samples.key, sha256: grid.samples.sha256, contentType: 'application/octet-stream' })),
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
  const methods = new Set<string>();
  for (const layer of manifest.layers) {
    const descriptor = manifest.descriptors.layers[layer];
    if (!descriptor || descriptor.id !== layer || !manifest.descriptors.palettes.some(p => p.id === descriptor.palette)) throw new Error('Incomplete product descriptors');
    methods.add(descriptor.methodId);
  }
  if (manifest.method.id !== [...methods].join('+')) throw new Error('Method identity does not match published descriptor snapshots');
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
  const patches = manifest.patches ?? [];
  if ((manifest.version === 4) !== (patches.length > 0)) throw new Error('Refinement manifest version mismatch');
  parseRefinementConfig({ type: 'FeatureCollection', features: patches.map(patch => ({ type: 'Feature', id: patch.id, properties: {}, geometry: patch.geometry })) });
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i], channels = manifest.frames.length * patch.layers.length;
    if ((i > 0 && patches[i - 1].id >= patch.id) || new Set(patch.layers).size !== patch.layers.length
      || channels > patch.descriptors.maxSampleValues
      || patch.layers.some(layer => !layers.has(layer)) || patch.coverage.maxZoom !== manifest.coverage.maxZoom
      || patch.coverage.maskKey !== `coverage/${patch.coverage.hash}/manifest.json`
      || patch.samples.key !== `${prefix}/refinements/${patch.id}/samples.bin`
      || patch.samples.channelCount !== channels || !Number.isSafeInteger(patch.samples.bytes)
      || patch.samples.bytes !== patch.samples.storedCells * channels * CELL_BYTES) {
      throw new Error('Invalid refinement grid or sample pack metadata');
    }
    const selectedMethods = new Set<string>();
    for (const layer of patch.layers) {
      const spec = patch.descriptors.layers[layer];
      if (!spec || spec.id !== layer || !patch.descriptors.palettes.some(p => p.id === spec.palette)) throw new Error('Incomplete refinement descriptors');
      selectedMethods.add(spec.methodId);
    }
    if (patch.method.id !== [...selectedMethods].join('+')) throw new Error('Refinement method identity mismatch');
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

