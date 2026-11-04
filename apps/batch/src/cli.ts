import { validateLocalBuild } from './local-build.js';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getProduct, modelIdSchema } from '@av/contracts';
import { CLI_COMMANDS, CLI_OPTIONS } from './commands.js';

export async function runBatch(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  const { values } = parseArgs({ args: args.slice(1), strict: true, options: CLI_OPTIONS });
  const allowed: readonly string[] | undefined = Object.hasOwn(CLI_COMMANDS, command) ? CLI_COMMANDS[command] : undefined;
  if (!command || !allowed || Object.keys(values).some(key => !allowed.includes(key))) throw new Error(`Usage: ${Object.keys(CLI_COMMANDS).join(', ')} with command-specific options`);
  if (command === 'build') {
    for (const option of ['terrain-catalog-ref', 'terrain-store-dir'] as const) {
      if (values[option] !== undefined && !values[option].trim()) throw new Error(`--${option} must be nonempty`);
    }
    if (values['terrain-store-dir'] && !values['terrain-catalog-ref']) throw new Error('--terrain-store-dir requires --terrain-catalog-ref');
    const { buildProduct } = await import('./build.js');
    const product = getProduct(modelIdSchema.parse(values.model ?? 'gfs'));
    if (!product) throw new Error('No admitted product for this model');
    let terrain, refinement, wholeDomain;
    if (values['terrain-ref']) {
      const [{ readLocalFile }, { parseJson }, { preparedTerrainRefSchema }] = await Promise.all([import('./local-file.js'), import('./terrain/contract.js'), import('./terrain/prepare.js')]);
      terrain = parseJson(await readLocalFile(values['terrain-ref'], 16 * 1024), preparedTerrainRefSchema, 16 * 1024);
    }
    if (values['terrain-catalog-ref']) {
      const [{ readLocalFile }, { parseJson, terrainAssetSchema }] = await Promise.all([import('./local-file.js'), import('./terrain/contract.js')]);
      const catalogRef = parseJson(await readLocalFile(values['terrain-catalog-ref'], 16 * 1024), terrainAssetSchema, 16 * 1024);
      const directory = values['terrain-store-dir'];
      const storage = directory ? (await import('./terrain/local-store.js')).localTerrainStorage(directory) : (await import('./storage.js')).r2Storage();
      refinement = { catalogRef, storage };
      wholeDomain = { catalogRef, storage };
    }
    console.log(await buildProduct(product.modelId, { out: values.out ?? 'output', cycle: values.cycle, cacheDir: values['cache-dir'], ...(terrain ? { terrain } : {}), ...(refinement ? { refinement } : {}), ...(wholeDomain ? { wholeDomain } : {}) }));
  } else if (command === 'capacity') {
    const product = getProduct(modelIdSchema.parse(values.model ?? 'gfs'));
    if (!product) throw new Error('No admitted product for this model');
    const [{ loadCoverage }, { estimateCapacity, prepareBuild }, { getForecastProvider }, { planRefinementCoverage }] = await Promise.all([import('./coverage.js'), import('./capacity.js'), import('./providers.js'), import('./refinement/coverage.js')]);
    const mask = await loadCoverage(product);
    const { wholeDomainPlan, loadBundledFineCoverage, acquisitionSupport, nativeSparseMask } = await import('./whole-domain/coverage.js');
    const plan = wholeDomainPlan(product);
    if (plan) {
      if ((['frames', 'layers', 'models', 'native-zoom', 'cadence-hours', 'retention-days'] as const).some(key => values[key] !== undefined)) {
        throw new Error('Whole-domain capacity reports the configured product; scenario overrides are unsupported');
      }
      const provider = getForecastProvider(product.modelId), fine = await loadBundledFineCoverage(product, plan);
      const { active } = acquisitionSupport(plan, fine.mask.coverage, mask);
      const { preparePackedTerrainColumns } = await import('@av/forecast/refinement');
      const { admitWholeDomain, MAX_PACKED_COLUMN_BYTES } = await import('./whole-domain/capacity.js');
      const columns = preparePackedTerrainColumns(plan, fine.mask.coverage, active, provider.maxLevels, { maxBytes: MAX_PACKED_COLUMN_BYTES, clearanceFallback: 'unsupported', expectedGridHash: fine.descriptor.gridHash });
      const native = nativeSparseMask(mask);
      const capacity = admitWholeDomain({ product, plan, nativeBlocks: native.coverage.blockIds, nativeActive: active.length, fine: fine.mask,
        nativeMaskBytes: mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength, frames: product.frameHours.length, maxLevels: provider.maxLevels, retainedGeometryFields: provider.retainedGeometryFields ?? 0,
        nativeLayers: product.layers.filter(layer => layer === 'precip-rate').length,
        fineLayers: product.layers.filter(layer => layer !== 'precip-rate').length, columns, terrainBytes: fine.mask.coverage.offsets[fine.mask.coverage.blockIds.length]! * 5 });
      const report = { mode: 'whole-domain', model: product.modelId, k: plan.k, fineGrid: plan.fine, capacity, violations: capacity.violations };
      console.log(JSON.stringify(report, null, 2));
      if (capacity.violations.length) process.exitCode = 1;
      return;
    }
    const refinements = planRefinementCoverage({ product, mask });
    const { layout, capacity } = prepareBuild(mask, product, { ...getForecastProvider(product.modelId), refinements });
    const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
    const report = estimateCapacity(mask, product, layout.storedCells, { frames: number(values.frames), layers: number(values.layers), models: number(values.models), nativeZoom: number(values['native-zoom']), cadenceHours: number(values['cadence-hours']), retentionDays: number(values['retention-days']) }, capacity.refinement);
    console.log(JSON.stringify({ ...report, currentProductAdmission: { model: product.modelId, frames: product.frameHours.length, layers: product.layers.length, nativeZoom: product.maxNativeZoom, rasterWorkers: capacity.rasterWorkers, workingSet: capacity.workingSet, estimatedPeakBytes: capacity.estimatedPeakBytes, budgetBytes: capacity.budgets.peakRssBytes, scope: 'Configured refinement grids included. Scenario changes need their own memory estimate.' } }, null, 2));
    if (report.violations.length) process.exitCode = 1;
  } else if (command === 'input-proof') {
    const product = getProduct(modelIdSchema.parse(values.model ?? 'gfs'));
    if (!product) throw new Error('No admitted product for this model');
    const { getForecastProvider } = await import('./providers.js');
    console.log(JSON.stringify(await getForecastProvider(product.modelId).proveInputs({ cycle: values.cycle, cacheDir: values['cache-dir'] }), null, 2));
  } else if (command === 'validate') {
    if (!values.manifest) throw new Error('--manifest is required');
    const remote = values['receipts-only'] ? { store: (await import('./storage.js')).r2Storage() } : undefined;
    await validateLocalBuild(values.manifest, undefined, remote);
    console.log('Validated');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBatch().catch(error => { console.error(error); process.exitCode = 1; });
}
