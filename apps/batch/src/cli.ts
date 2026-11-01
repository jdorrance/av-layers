import { readLocalManifest, validateLocalBuild } from './local-build.js';
import { parseArgs } from 'node:util';
import { workflowAuthority } from './authority.js';
import { getProduct, modelIdSchema } from '@av/contracts';
import { CLI_COMMANDS, CLI_OPTIONS } from './commands.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), strict: true, options: CLI_OPTIONS });
  const allowed: readonly string[] | undefined = CLI_COMMANDS[command];
  if (!command || !allowed || Object.keys(values).some(key => !allowed.includes(key))) throw new Error(`Usage: ${Object.keys(CLI_COMMANDS).join(', ')} with command-specific options`);
  if (command === 'build:sample') {
    if (values.model !== 'gfs') throw new Error('build:sample requires --model gfs');
    const { buildSample } = await import('./build.js');
    console.log(await buildSample({ out: values.out ?? 'output', cycle: values.cycle, cacheDir: values['cache-dir'] }));
  } else if (command === 'capacity') {
    const product = getProduct(modelIdSchema.parse(values.model ?? 'gfs'));
    if (!product) throw new Error('No admitted product for this model');
    const [{ loadCoverage }, { estimateCapacity, prepareBuild }] = await Promise.all([import('./validate.js'), import('./capacity.js')]);
    const mask = await loadCoverage(), { layout, capacity } = prepareBuild(mask, product);
    const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
    const report = estimateCapacity(mask, product, layout.storedCells, { frames: number(values.frames), layers: number(values.layers), models: number(values.models), nativeZoom: number(values['native-zoom']), cadenceHours: number(values['cadence-hours']), retentionDays: number(values['retention-days']) });
    console.log(JSON.stringify({ ...report, currentProductAdmission: { model: product.source.modelFamily, frames: product.frameHours.length, layers: product.layers.length, nativeZoom: product.maxNativeZoom, rasterWorkers: capacity.rasterWorkers, workingSet: capacity.workingSet, estimatedPeakBytes: capacity.estimatedPeakBytes, budgetBytes: capacity.budgets.peakRssBytes, scope: 'Complete current-product estimate with conservative reserves; hypothetical scenario growth above is not admitted by this memory estimate.' } }, null, 2));
    if (report.violations.length) process.exitCode = 1;
  } else if (command === 'input-proof') {
    const { proveGfsInputs } = await import('./noaa/index.js');
    console.log(JSON.stringify(await proveGfsInputs({ cycle: values.cycle, cacheDir: values['cache-dir'] }), null, 2));
  } else if (command === 'validate' || command === 'publish') {
    if (!values.manifest) throw new Error('--manifest is required');
    if (command === 'validate') {
      await validateLocalBuild(values.manifest);
      console.log('Validated');
    } else {
      const { root, manifest } = await readLocalManifest(values.manifest);
      const [{ r2Storage }, { publish }] = await Promise.all([import('./storage.js'), import('./publication.js')]);
      await publish(r2Storage(), root, manifest, { authority: workflowAuthority(), allowSameCycle: values['allow-same-cycle'] });
      console.log('Published');
    }
  } else {
    const model = modelIdSchema.parse(values.model);
    if (command === 'rollback' && !values['build-id']) throw new Error('--build-id is required');
    const [{ r2Storage }, { maintenanceWorkflow }] = await Promise.all([import('./storage.js'), import('./maintenance.js')]);
    const receipt = await maintenanceWorkflow({ action: command as 'rollback' | 'cleanup', model, buildId: values['build-id'], authority: workflowAuthority(), store: r2Storage() });
    console.log(JSON.stringify(receipt));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
