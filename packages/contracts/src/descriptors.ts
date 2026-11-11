import z from 'zod';
import { LIFT_METHOD, LIFT_METHODS_BY_VERTICAL_COORDINATE, METHODS, terrainColumnMethodForProduct, nativeMethodForLayer } from './methods.js';
import { LAYERS, PALETTES, renderedLayers, layerPalette, type LayerId } from './layers.js';
import type { ProductDefinition } from './product.js';
import type { GeographicBounds } from './geometry.js';
import { descriptorSchema, recipeIdentitySchema } from './publication.js';
import { methodDescriptorSchema } from './method-schemas.js';
import { MAX_SAMPLE_VALUES } from './format.js';

export function createRecipeIdentity(product: ProductDefinition, hash: string, sourceRevision = 'fixture', sourceDirty = false, lockHash = hash): z.infer<typeof recipeIdentitySchema> {
  return recipeIdentitySchema.parse({ id: product.id, hash, source: product.source, sourceRevision, sourceDirty, lockHash });
}
function methodForLayer(product: Pick<ProductDefinition, 'capabilities'>, layer: LayerId) {
  const native = nativeMethodForLayer(layer, product.capabilities.verticalCoordinate);
  if (native) return native;
  const method = METHODS[LAYERS[layer].methodId as keyof typeof METHODS];
  if (!method) throw new Error(`Unknown method for ${layer}`);
  return method.id === LIFT_METHOD.id ? LIFT_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate] : method;
}
export function createProductMethodId(product: Pick<ProductDefinition, 'layers' | 'capabilities'>): string {
  return [...new Set(product.layers.map(id => methodForLayer(product, id).id))].join('+');
}
export function createProductDescriptors(product: ProductDefinition): z.infer<typeof descriptorSchema> {
  const layers = product.layers.map(id => ({ ...LAYERS[id], methodId: methodForLayer(product, id).id }));
  const methods: Record<string, unknown> = Object.fromEntries(layers.map(layer => [layer.methodId, METHODS[layer.methodId as keyof typeof METHODS]]));
  const maximumGust = z.object({ upstream: z.object({ auxSurface: z.object({ gust10mMps: z.object({ statistic: z.literal(2) }) }) }) }).safeParse(product).success;
  const gust = layers.find(layer => layer.id === 'wind-gust-10m');
  if (maximumGust && gust) {
    gust.timeSupport = 'interval-maximum';
    const method = methodDescriptorSchema.parse(methods[gust.methodId]);
    methods[gust.methodId] = { ...method, inputs: { ...method.inputs, gust10mMps: { ...method.inputs.gust10mMps!, timeSupport: 'interval-maximum' } } };
  }
  return descriptorSchema.parse({
    layers: Object.fromEntries(layers.map(layer => [layer.id, layer])),
    methods,
    palettes: [...new Set(renderedLayers(product.layers).map(layerPalette))].map(id => PALETTES[id]),
    attribution: product.attribution, coverageDescription: product.coverageDescription, bounds: [...product.bounds], maxSampleValues: MAX_SAMPLE_VALUES
  });
}

export function createRefinementDescriptors(product: ProductDefinition, bounds: GeographicBounds): z.infer<typeof descriptorSchema> {
  const base = createProductDescriptors(product);
  const msl = base.layers['usable-lift-msl'], agl = base.layers['usable-lift-agl'];
  if (!msl || !agl) throw new Error('Terrain refinement requires native MSL and AGL layers');
  const method = terrainColumnMethodForProduct(product);
  return descriptorSchema.parse({ ...base, bounds: [...bounds],
    coverageDescription: 'Polygon-owned terrain-column refinement inside the model coverage, with interpolation halos excluded.',
    layers: {
      [msl.id]: { ...msl, verticalReference: 'MSL', methodId: method.id },
      [agl.id]: { ...agl, label: 'Usable lift depth (terrain AGL)', verticalReference: 'terrain-AGL', methodId: method.id }
    },
    methods: { [method.id]: method },
    palettes: base.palettes.filter(palette => palette.id === agl.palette)
  });
}

export function createWholeDomainDescriptors(product: ProductDefinition): z.infer<typeof descriptorSchema> {
  const base = createProductDescriptors(product), fine = createRefinementDescriptors(product, product.bounds);
  const layers = product.layers.map(id => fine.layers[id] ?? base.layers[id]);
  return descriptorSchema.parse({ ...base,
    layers: Object.fromEntries(layers.map(layer => [layer.id, layer])),
    methods: Object.fromEntries(layers.map(layer => [layer.methodId, fine.methods[layer.methodId] ?? base.methods[layer.methodId]]))
  });
}
