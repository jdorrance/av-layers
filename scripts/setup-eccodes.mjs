import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import recipe from '../apps/batch/eccodes.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));
const environment = join(root, '.tools/eccodes');
const python = process.env.AV_ECCODES_PYTHON || join(environment, 'bin/python');
const helper = join(root, 'apps/batch/src/split-grib/decode.py');
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 120_000 });

try {
  if (!process.argv.includes('--check') && !process.env.AV_ECCODES_PYTHON) {
    if (!existsSync(python)) run('uv', ['venv', '--python', recipe.python, environment]);
    run('uv', ['pip', 'sync', '--python', python, join(root, 'apps/batch/eccodes-requirements.txt')]);
  }
  run(python, [helper, '--check']);
} catch (error) {
  console.error(`ecCodes setup failed: ${error.message}. Run pnpm tools:eccodes with uv installed.`);
  process.exitCode = 1;
}
