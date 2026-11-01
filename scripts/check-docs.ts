import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { checkReference } from './generate-reference.js';

const root = process.cwd();
const excluded = new Set(['node_modules', '.git', '.cache', '.wrangler', '.tools', '.agents', '.codex', 'dist', 'output']);
async function markdown(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.filter(entry => !excluded.has(entry.name)).map(async entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? markdown(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  }))).flat();
}
const errors: string[] = await checkReference();
for (const file of await markdown(root)) {
  const content = (await readFile(file, 'utf8')).replace(/```[\s\S]*?```/g, '');
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<([^>]+)>.*$/, '$1').split(/\s+["']/)[0];
    if (/^(?:[a-z]+:|\/|#)/i.test(target)) continue;
    const path = resolve(dirname(file), decodeURIComponent(target.split('#')[0]));
    try { if (!(await stat(path)).isFile()) throw new Error('not a file'); }
    catch { errors.push(`${relative(root, file)}: missing ${target}`); }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Generated references and repository Markdown file links verified');
