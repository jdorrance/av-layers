import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getProduct, modelIdSchema } from '@av/contracts';

async function main(): Promise<void> {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), strict: true, options: {
    model: { type: 'string' }, out: { type: 'string' }, cycle: { type: 'string' }, 'cache-dir': { type: 'string' }, manifest: { type: 'string' }, 'build-id': { type: 'string' }, 'allow-same-cycle': { type: 'boolean' }, 'publishers-paused': { type: 'boolean' }, frames: { type: 'string' }, layers: { type: 'string' }, models: { type: 'string' }, 'native-zoom': { type: 'string' }, 'cadence-hours': { type: 'string' }, 'retention-days': { type: 'string' }
  } });
  const allowed: Record<string, string[]> = {
    'build:sample': ['model', 'out', 'cycle', 'cache-dir'], capacity: ['model', 'frames', 'layers', 'models', 'native-zoom', 'cadence-hours', 'retention-days'], 'input-proof': ['cycle', 'cache-dir'], validate: ['manifest'], publish: ['manifest', 'allow-same-cycle'], rollback: ['model', 'build-id', 'publishers-paused'], cleanup: ['model', 'publishers-paused']
  };
  if (!command || !allowed[command] || Object.keys(values).some(key => !allowed[command].includes(key))) throw new Error('Usage: build:sample, capacity, input-proof, validate, publish, rollback, or cleanup with command-specific options');
  if (command === 'build:sample') {
    if (values.model !== 'gfs') throw new Error('build:sample requires --model gfs');
    const { buildSample } = await import('./build.js');
    console.log(await buildSample({ out: values.out ?? 'output', cycle: values.cycle, cacheDir: values['cache-dir'] }));
  } else if (command === 'capacity') {
    const product = getProduct(modelIdSchema.parse(values.model ?? 'gfs'));
    if (!product) throw new Error('No admitted product for this model');
    const [{ loadCoverage }, { estimateCapacity, prepareBuild }] = await Promise.all([import('./validate.js'), import('./capacity.js')]);
    const mask = await loadCoverage(), { layout } = prepareBuild(mask, product);
    const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
    const report = estimateCapacity(mask, product, layout.storedCells, { frames: number(values.frames), layers: number(values.layers), models: number(values.models), nativeZoom: number(values['native-zoom']), cadenceHours: number(values['cadence-hours']), retentionDays: number(values['retention-days']) });
    console.log(JSON.stringify(report, null, 2));
    if (report.violations.length) process.exitCode = 1;
  } else if (command === 'input-proof') {
    const { proveGfsInputs } = await import('./noaa/index.js');
    console.log(JSON.stringify(await proveGfsInputs({ cycle: values.cycle, cacheDir: values['cache-dir'] }), null, 2));
  } else if (command === 'validate' || command === 'publish') {
    if (!values.manifest) throw new Error('--manifest is required');
    const path = resolve(values.manifest), root = resolve(dirname(path), '../../..');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (command === 'validate') {
      const { loadCoverage, validateBuild } = await import('./validate.js');
      await validateBuild(root, manifest, await loadCoverage());
      console.log('Validated');
    } else {
      const [{ r2Storage }, { publish }] = await Promise.all([import('./storage.js'), import('./publication.js')]);
      await publish(r2Storage(), root, manifest, { allowSameCycle: values['allow-same-cycle'] });
      console.log('Published');
    }
  } else {
    const model = modelIdSchema.parse(values.model);
    const [{ r2Storage }, { rollback, cleanup }] = await Promise.all([import('./storage.js'), import('./publication.js')]);
    if (command === 'rollback') {
      if (!values['build-id']) throw new Error('--build-id is required');
      await rollback(r2Storage(), model, values['build-id'], !!values['publishers-paused']);
      console.log('Rolled back');
    } else console.log(`Deleted ${await cleanup(r2Storage(), model, !!values['publishers-paused'])} objects`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
