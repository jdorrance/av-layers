import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { readProducerSourceState } from './identity.js';

it('records producer configuration edits while allowing unrelated client edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-source-state-'));
  const git = async (...args: string[]) => await promisify(execFile)('git', args, { cwd: root });
  try {
    await git('init', '--quiet');
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    await git('add', 'tsconfig.json');
    await git('-c', 'user.name=Source test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const clean = await readProducerSourceState(root);
    expect(clean).toEqual({ revision: (await git('rev-parse', 'HEAD')).stdout.trim(), dirty: false });

    await mkdir(join(root, 'apps/preview'), { recursive: true });
    await writeFile(join(root, 'apps/preview/local.ts'), 'export const label = "local UI";\n');
    expect(await readProducerSourceState(root)).toEqual(clean);

    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@av/forecast":["./local-science.ts"]}}}\n');
    expect(await readProducerSourceState(root)).toEqual({ ...clean, dirty: true });
    await git('add', 'tsconfig.json');
    expect(await readProducerSourceState(root)).toEqual({ ...clean, dirty: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
