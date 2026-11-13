import { validateLocalBuild } from './local-build.js';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_MODEL, getProduct } from '@av/contracts/models';
import { modelIdSchema } from '@av/contracts';
import { CLI_COMMANDS, CLI_OPTIONS } from './commands.js';
import { sourceModelId } from './source.js';

export async function runBatch(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  const { values } = parseArgs({ args: args.slice(1), strict: true, options: CLI_OPTIONS });
  const allowed: readonly string[] | undefined = Object.hasOwn(CLI_COMMANDS, command) ? CLI_COMMANDS[command] : undefined;
  if (!command || !allowed || Object.keys(values).some(key => !allowed.includes(key))) throw new Error(`Usage: ${Object.keys(CLI_COMMANDS).join(', ')} with command-specific options`);
  if (command === 'build') {
    for (const option of ['terrain-catalog-ref', 'terrain-store-dir', 'source-store-dir'] as const) {
      if (values[option] !== undefined && !values[option].trim()) throw new Error(`--${option} must be nonempty`);
    }
    if (values['terrain-store-dir'] && !values['terrain-catalog-ref']) throw new Error('--terrain-store-dir requires --terrain-catalog-ref');
    const { buildProduct } = await import('./build.js');
    const product = getProduct(modelIdSchema.parse(values.model ?? DEFAULT_MODEL));
    if (!product) throw new Error('No admitted product for this model');
    const catalog = values['terrain-catalog-ref'];
    if (!catalog) throw new Error('--terrain-catalog-ref is required for configured forecasts');
    const [{ readLocalFile }, { parseJson, terrainAssetSchema }] = await Promise.all([import('./local-file.js'), import('./terrain/contract.js')]);
    const catalogRef = parseJson(await readLocalFile(catalog, 16 * 1024), terrainAssetSchema, 16 * 1024);
    const directory = values['terrain-store-dir'];
    const { getForecastProvider } = await import('./providers.js');
    const privateSource = !!getForecastProvider(product.modelId).resolveRun;
    const localSource = values['source-store-dir'];
    if (localSource && product.upstream.protocol !== 'wrf-zarr-v3') throw new Error('--source-store-dir requires a WRF Zarr model');
    const remote = !directory || (privateSource && !localSource) ? (await import('./storage.js')).r2Storage() : undefined;
    const sourceStore = localSource ? (await import('./local-source.js')).localForecastSource(localSource, sourceModelId(product)) : privateSource ? remote : undefined;
    const storage = directory ? (await import('./terrain/local-store.js')).localTerrainStorage(directory) : remote!;
    console.log(await buildProduct(product.modelId, { out: values.out ?? 'output', cycle: values.cycle,
      cacheDir: values['cache-dir'], ...(privateSource ? { sourceStore } : {}), wholeDomain: { catalogRef, storage } }));
  } else if (command === 'capacity') {
    const product = getProduct(modelIdSchema.parse(values.model ?? DEFAULT_MODEL));
    if (!product) throw new Error('No admitted product for this model');
    const [{ loadCoverage }, { estimateRetention }, { getForecastProvider }] = await Promise.all([import('./coverage.js'), import('./capacity.js'), import('./providers.js')]);
    const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
    const retentionScenario = { cadenceHours: number(values['cadence-hours']), retentionDays: number(values['retention-days']), expectedRunsPerDay: product.expectedRunsPerDay };
    const mask = await loadCoverage(product);
    const { wholeDomainPlan, loadBundledFineCoverage, acquisitionSupport, nativeSparseMask } = await import('./whole-domain/coverage.js');
    const plan = wholeDomainPlan(product);
    if (!plan) throw new Error('Model requires a configured whole-domain grid');
    const { violations: retentionViolations, ...retention } = estimateRetention(product.execution.schedule, retentionScenario);
    const provider = getForecastProvider(product.modelId), fine = await loadBundledFineCoverage(product, plan);
    const { active } = acquisitionSupport(plan, fine.mask.coverage, mask);
    const { packedTerrainColumnBudget } = await import('@av/forecast/refinement');
    const { admitWholeDomain, MAX_PACKED_COLUMN_BYTES, partitionForecastHours, wholeDomainCapacityInput } = await import('./whole-domain/capacity.js');
    const columns = packedTerrainColumnBudget(plan, fine.mask.coverage, active, provider.maxLevels, { maxBytes: MAX_PACKED_COLUMN_BYTES, clearanceFallback: 'unsupported', expectedGridHash: fine.descriptor.gridHash });
    const groups = partitionForecastHours(product.frameHours, product.execution.shards);
    const capacity = admitWholeDomain(wholeDomainCapacityInput(product, provider,
      { plan, native: { mask: nativeSparseMask(mask) }, nativeMask: mask, fine, acquisitionActive: active, columns }, groups));
    const report = { mode: 'whole-domain', model: product.modelId, k: plan.k, fineGrid: plan.fine, capacity,
      retention: { ...retention, retainedNumericBytes: retention.retainedPerModel * capacity.numericBytes },
      violations: [...capacity.violations, ...retentionViolations] };
    console.log(JSON.stringify(report, null, 2));
    if (report.violations.length) process.exitCode = 1;
  } else if (command === 'input-proof') {
    const product = getProduct(modelIdSchema.parse(values.model ?? DEFAULT_MODEL));
    if (!product) throw new Error('No admitted product for this model');
    const { getForecastProvider } = await import('./providers.js');
    const provider = getForecastProvider(product.modelId);
    const localSource = values['source-store-dir'];
    if (localSource !== undefined && (!localSource.trim() || product.upstream.protocol !== 'wrf-zarr-v3')) throw new Error('--source-store-dir requires a nonempty directory and a WRF Zarr model');
    const store = localSource ? (await import('./local-source.js')).localForecastSource(localSource, sourceModelId(product))
      : provider.resolveRun ? (await import('./storage.js')).r2Storage() : undefined;
    console.log(JSON.stringify(await provider.proveInputs({ cycle: values.cycle, cacheDir: values['cache-dir'], ...(store ? { store } : {}) }), null, 2));
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
