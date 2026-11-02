import { validateLocalBuild } from './local-build.js';
import { parseArgs } from 'node:util';
import { getProduct, modelIdSchema } from '@av/contracts';
import { CLI_COMMANDS, CLI_OPTIONS } from './commands.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), strict: true, options: CLI_OPTIONS });
  const allowed: readonly string[] | undefined = CLI_COMMANDS[command];
  if (!command || !allowed || Object.keys(values).some(key => !allowed.includes(key))) throw new Error(`Usage: ${Object.keys(CLI_COMMANDS).join(', ')} with command-specific options`);
  if (command === 'build') {
    const { buildProduct } = await import('./build.js');
    console.log(await buildProduct(values.model ?? 'gfs', { out: values.out ?? 'output', cycle: values.cycle, cacheDir: values['cache-dir'] }));
  } else if (command === 'capacity') {
    const product = getProduct(modelIdSchema.parse(values.model ?? 'gfs'));
    if (!product) throw new Error('No admitted product for this model');
    const [{ loadCoverage }, { estimateCapacity, prepareBuild }, { getForecastProvider }] = await Promise.all([import('./coverage.js'), import('./capacity.js'), import('./providers.js')]);
    const mask = await loadCoverage(product), { layout, capacity } = prepareBuild(mask, product, getForecastProvider(product.modelId));
    const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
    const report = estimateCapacity(mask, product, layout.storedCells, { frames: number(values.frames), layers: number(values.layers), models: number(values.models), nativeZoom: number(values['native-zoom']), cadenceHours: number(values['cadence-hours']), retentionDays: number(values['retention-days']) });
    console.log(JSON.stringify({ ...report, currentProductAdmission: { model: product.modelId, frames: product.frameHours.length, layers: product.layers.length, nativeZoom: product.maxNativeZoom, rasterWorkers: capacity.rasterWorkers, workingSet: capacity.workingSet, estimatedPeakBytes: capacity.estimatedPeakBytes, budgetBytes: capacity.budgets.peakRssBytes, scope: 'Current build estimate with reserves. Scenario changes need their own memory estimate.' } }, null, 2));
    if (report.violations.length) process.exitCode = 1;
  } else if (command === 'input-proof') {
    const { proveGfsInputs } = await import('./noaa/index.js');
    console.log(JSON.stringify(await proveGfsInputs({ cycle: values.cycle, cacheDir: values['cache-dir'] }), null, 2));
  } else if (command === 'validate') {
    if (!values.manifest) throw new Error('--manifest is required');
    await validateLocalBuild(values.manifest);
    console.log('Validated');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
