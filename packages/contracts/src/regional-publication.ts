import z from 'zod';
import { gridSchema, sameGrid } from './grid-schema.js';
import { CELL_BYTES, SAMPLE_BLOCK_SIZE } from './format.js';
import { layerIdSchema } from './layer-schemas.js';
import { LAYER_IDS } from './layers.js';
import type { CoverageDescriptor } from './coverage.js';
import { MAX_REFINEMENT_ZONES, refinementGeometrySchema, parseRefinementConfig } from './refinement.js';
import { coverageReferenceSchema, descriptorSchema, manifestV5Schema, methodIdentitySchema,
  modelIdSchema, publicationShape } from './publication.js';

const key = publicationShape.buildId, sha256 = methodIdentitySchema.shape.hash;

/** Channels follow frames, then layers, in manifest order; the coverage determines block offsets. */
export const samplePackSchema = z.object({ format: z.literal('cell-major-blocks-v1'), blockSize: z.literal(SAMPLE_BLOCK_SIZE), storedCells: z.number().int().positive(), channelCount: z.number().int().positive(), bytes: z.number().int().positive(), key, sha256 });
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
  version: z.union([z.literal(3), z.literal(4)]), descriptors: descriptorSchema, recipe: publicationShape.recipe, model: modelIdSchema,
  buildId: publicationShape.buildId, cycle: publicationShape.cycle, createdAt: publicationShape.createdAt, expiresAt: publicationShape.expiresAt, method: methodIdentitySchema,
  coverage: coverageReferenceSchema, grid: gridSchema,
  frames: publicationShape.frames, layers: publicationShape.layers,
  artifacts: publicationShape.artifacts, samples: samplePackSchema,
  patches: z.array(refinementPatchSchema).min(1).max(MAX_REFINEMENT_ZONES).optional(),
  source: publicationShape.source, tool: publicationShape.tool, palettes: publicationShape.palettes, metrics: publicationShape.metrics
}).superRefine((manifest, ctx) => {
  if ((manifest.version === 4) !== (manifest.patches !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only version 4 publishes refinement patches' });
});
export type Manifest = z.infer<typeof manifestSchema>;

export const publishedManifestSchema = z.union([manifestSchema, manifestV5Schema]);
export type PublishedManifest = z.infer<typeof publishedManifestSchema>;
export type ForecastGrid = Pick<Manifest, 'grid' | 'coverage' | 'samples' | 'layers' | 'descriptors' | 'method'>;
export function forecastGrids(manifest: Manifest): ForecastGrid[] { return [manifest, ...(manifest.patches ?? [])]; }

/** A coverage hash binds its geometry and public extent to one numeric surface. */
export function assertCoverageBinding(descriptor: CoverageDescriptor, surface: Pick<ForecastGrid, 'grid' | 'coverage'> & { descriptors: Pick<ForecastGrid['descriptors'], 'bounds'> }): void {
  if (descriptor.id !== surface.coverage.id || !Number.isSafeInteger(surface.coverage.maxZoom)
    || surface.coverage.maxZoom < 0 || descriptor.maxZoom < surface.coverage.maxZoom
    || !sameGrid(descriptor.grid, surface.grid) || JSON.stringify(descriptor.bounds) !== JSON.stringify(surface.descriptors.bounds)
    || surface.coverage.maskKey !== `coverage/${surface.coverage.hash}/manifest.json`) throw new Error('Coverage descriptor binding mismatch');
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
    if (patch.method.id !== [...selectedMethods].join('+') || patch.method.hash !== manifest.method.hash) throw new Error('Refinement method identity mismatch');
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
