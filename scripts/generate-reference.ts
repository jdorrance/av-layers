import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as contracts from '@av/contracts';
import { BUILD_BUDGETS } from '../apps/batch/src/capacity.js';
import { CLI_COMMANDS, CLI_OPTIONS } from '../apps/batch/src/commands.js';
import { MAX_RASTER_SHARED_INPUT_BYTES, MAX_RASTER_WORKERS, RASTER_WORKER_RESERVE_BYTES } from '../apps/batch/src/raster-pool.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const regenerate = 'pnpm exec node --import tsx scripts/generate-reference.ts';
const code = (value: unknown) => `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
const entries = (value: object) => Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  return value && typeof value === 'object' ? Object.fromEntries(entries(value).map(([key, child]) => [key, stable(child)])) : value;
}

async function openApiDocument(): Promise<{ openapi: string; paths: Record<string, Record<string, unknown>> }> {
  // Runtime URL import deliberately keeps Worker-only R2 types out of the Node
  // TypeScript program. This is the actual route, with no storage or network.
  const { default: worker } = await import(new URL('../apps/api/src/index.ts', import.meta.url).href) as {
    default: { fetch(request: Request, env: object, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> }
  };
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request('https://reference.invalid/openapi.json'), {}, { waitUntil: promise => { pending.push(promise); } });
  if (!response.ok) throw new Error(`OpenAPI reference route failed: ${response.status}`);
  const document = await response.json() as { openapi: string; paths: Record<string, Record<string, unknown>> };
  await Promise.all(pending);
  if (document.openapi !== '3.1.0' || !document.paths || typeof document.paths !== 'object') throw new Error('Invalid generated OpenAPI document');
  return document;
}

/** Generated only from the production registry, never the offline fixture. */
export async function referenceArtifacts(): Promise<Record<string, string>> {
  const api = await openApiDocument();
  const lines = [
    '# Generated platform reference', '',
    'This file is generated from executable definitions. Edit their owning source, then run:', '',
    '```sh', regenerate, '```', '',
    '`pnpm docs:check` rejects stale generated references. No live forecast, storage credentials or network access is required to generate them.', '',
    'This describes the current producer. Retained builds keep their own immutable descriptors; readers do not compare historical parameters or legends with this reference.', '',
    '## Batch CLI', '',
    'Invoke `pnpm exec node --import tsx apps/batch/src/cli.ts COMMAND` with the options below. String options take a value; boolean options are switches. These lists define accepted options, not whether an operational command is authorized or whether its required values are present. See [operations](operations.md) for publication authority and [getting started](getting-started.md) for working commands.', '',
    'Source: [command definitions](../apps/batch/src/commands.ts), consumed by [CLI admission](../apps/batch/src/cli.ts).', ''
  ];
  for (const [command, options] of entries(CLI_COMMANDS)) {
    lines.push(`- ${code(command)}: ${options.map((option: keyof typeof CLI_OPTIONS) => code(`--${option}${CLI_OPTIONS[option].type === 'string' ? ' <string>' : ''}`)).join(', ')}.`);
  }
  lines.push('', '## Admitted production capabilities', '', 'Source: [product registry](../packages/contracts/src/index.ts). Test-only fixtures are excluded.', '');
  for (const model of [...contracts.MODEL_IDS].sort()) {
    const product = contracts.getProduct(model);
    if (!product) throw new Error(`Model ${model} has no admitted product`);
    lines.push(`### ${product.label} (${product.id})`, '',
      `- Model family: ${code(product.source.modelFamily)}; source configuration: ${code(product.source.configurationId)}; domain: ${code(product.source.domainId)}.`,
      `- Attribution: ${product.attribution}.`,
      `- Grid: ${code(product.grid.kind)}; ${product.grid.width} columns × ${product.grid.height} rows; spherical Earth radius ${product.grid.earthRadiusM} m; periodic longitude: ${product.grid.wrapLongitude}.`,
      `- Bounds [west, south, east, north]: ${code(product.bounds)}.`,
      `- Coverage: ${code(product.coverageId)}. ${product.coverageDescription}`,
      `- Native tile zoom: 0–${product.maxNativeZoom}.`,
      `- Forecast lead hours: ${code(product.frameHours)}; interval: ${product.intervalHours} hours.`,
      `- Layers: ${product.layers.map(code).join(', ')}.`,
      `- Latest promotion: cycle age at most ${product.freshness.maxCycleAgeHours} hours; remaining horizon at least ${product.freshness.minHorizonHours} hours.`, '');
  }
  lines.push('## Scalar quantities and units', '', 'Source: [layer definitions](../packages/contracts/src/index.ts). Interpret values and absence using [the data guide](data.md).', '');
  for (const [id, layer] of entries(contracts.LAYERS)) {
    lines.push(`### ${layer.label} (${id})`, '',
      `- Kind: ${code(layer.kind)}; quantity: ${code(layer.quantity)}; units: ${code(layer.units)}.`,
      `- Vertical reference: ${code(layer.verticalReference)}; time support: ${code(layer.timeSupport)}.`,
      `- Method: ${code(layer.methodId)}; palette: ${code(layer.palette)}.`,
      `- Admits physical no-lift status: ${layer.supportsNoLift}; public no-lift value: ${code(layer.noLiftSampleValue)}; admits lift support flags: ${layer.supportsLiftFlags}.`,
      `- Zero on no-lift interpolation: ${layer.zeroOnNoLiftInterpolation}; hide nonpositive rendered values: ${layer.hideNonPositiveValues}.`, '');
  }
  lines.push('## Status and support encodings', '',
    `Public sample statuses: ${contracts.SAMPLE_STATUSES.map(code).join(', ')}.`, '',
    'The packed status and support constants below come from the same [contract exports](../packages/contracts/src/index.ts) used by derivation and sampling. Status occupies the low bits; support is a bitwise union. Layer definitions above restrict admissible combinations.', '');
  for (const [name, value] of entries(contracts).filter(([name]) => /^(STATUS_|SUPPORT_)/.test(name))) lines.push(`- ${code(name)}: ${code(value)}.`);
  lines.push('', '## Methods and normalized inputs', '',
    'Source: [method definitions](../packages/contracts/src/methods.ts). The numerical kernel consumes these exact parameter constants. The adapter boundary supplies the declared input units; the column bridge performs its explicit Celsius/hPa conversion. No vector input is currently admitted. See [science](science.md) and [extension recipes](extensions.md) for assumptions and future admission.', '');
  for (const [id, method] of entries(contracts.METHODS)) {
    lines.push(`### ${id}`, '',
      `- Outputs: ${method.outputs.map(code).join(', ')}.`,
      `- Required inputs: ${method.requiredInputs.map(code).join(', ')}.`,
      `- Spatial support: ${code(method.spatialSupport)}.`, '', 'Parameters:', '');
    for (const [name, value] of entries(method.parameters)) lines.push(`- ${code(name)}: ${code(value)}.`);
    lines.push('', 'Caveats:', '');
    for (const caveat of method.caveats) lines.push(`- ${caveat}`);
    lines.push('');
  }
  lines.push('### Normalized input vocabulary', '');
  for (const [id, input] of entries(contracts.NORMALIZED_INPUTS)) {
    lines.push(`- ${code(id)}: ${code(input.quantity)}; units ${code(input.units)}; dimensions ${code(input.dimensions)}; vertical reference ${code(input.verticalReference)}; time support ${code(input.timeSupport)}; missingness ${code(input.missingness)}.`);
  }
  lines.push('', '## Admission budgets', '',
    'These are admission limits, not measured latency or memory claims. [Capacity admission](../apps/batch/src/capacity.ts) owns complete-build checks; [serving budgets](serving-budgets.md) records the API resource model and qualification limits.', '',
    'Complete-build limits:', '');
  for (const [name, value] of entries(BUILD_BUDGETS)) lines.push(`- ${code(name)}: ${code(value)}.`);
  lines.push('', 'Shared producer/consumer contract limits and storage constants:', '');
  for (const [name, value] of entries(contracts).filter(([name, value]) => typeof value === 'number' && /^(MAX_|CELL_BYTES$|SAMPLE_BLOCK_SIZE$|RETENTION_DAYS$)/.test(name))) lines.push(`- ${code(name)}: ${code(value)}.`);
  lines.push('', 'Raster pool admission ([source](../apps/batch/src/raster-pool.ts)):', '',
    `- ${code('MAX_RASTER_WORKERS')}: ${MAX_RASTER_WORKERS}.`,
    `- ${code('MAX_RASTER_SHARED_INPUT_BYTES')}: ${MAX_RASTER_SHARED_INPUT_BYTES}.`,
    `- ${code('RASTER_WORKER_RESERVE_BYTES')}: ${RASTER_WORKER_RESERVE_BYTES}; admission estimate per worker, not an operating-system memory limit.`, '',
    '## API reference', '',
    'The checked-in [OpenAPI document](reference/openapi.json) is generated by invoking the actual Worker’s `GET /openapi.json` route without R2. The running service exposes the same schema at `/openapi.json`, with its interactive viewer at `/docs`. These route definitions describe structure; retained build descriptors supply available layers, frames, units and methods.', '');
  for (const [path, operations] of entries(api.paths)) for (const method of Object.keys(operations).sort()) {
    if (['get', 'head', 'post', 'put', 'patch', 'delete', 'options'].includes(method)) lines.push(`- ${code(`${method.toUpperCase()} ${path}`)}.`);
  }
  return { 'docs/reference.md': `${lines.join('\n')}\n`, 'docs/reference/openapi.json': `${JSON.stringify(stable(api), null, 2)}\n` };
}

export async function checkReference(): Promise<string[]> {
  const stale: string[] = [];
  for (const [path, expected] of Object.entries(await referenceArtifacts())) {
    const actual = await readFile(resolve(repository, path), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (actual !== expected) stale.push(`${path}: generated reference is stale; run ${regenerate}`);
  }
  return stale;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } }, strict: true, allowPositionals: false });
  if (values.check) {
    const stale = await checkReference();
    if (stale.length) throw new Error(stale.join('\n'));
    console.log('Generated platform and OpenAPI references verified');
  } else {
    for (const [path, contents] of Object.entries(await referenceArtifacts())) {
      await mkdir(dirname(resolve(repository, path)), { recursive: true });
      await writeFile(resolve(repository, path), contents);
      console.log(`Generated ${path}`);
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error); process.exitCode = 1; });
