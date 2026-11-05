import { expect, it } from 'vitest';
import { terrainArguments } from './cli';

it('requires command-specific inputs and rejects unsupported commands and options', () => {
  for (const command of ['unknown', 'constructor', '__proto__']) expect(() => terrainArguments([command, '--out', 'output'])).toThrow(/Usage/);
  expect(() => terrainArguments(['prepare', '--out', 'output', '--catalog-ref', 'catalog.json'])).toThrow(/grid is required/);
  expect(() => terrainArguments(['prepare-model', '--out', 'output', '--catalog-ref', 'catalog.json'])).toThrow(/model is required/);
  expect(() => terrainArguments(['solar', '--out', 'output', '--catalog-ref', 'catalog.json', '--site', 'launch'])).toThrow(/sites is required/);
  expect(() => terrainArguments(['solar', '--out', 'output', '--catalog-ref', 'catalog.json', '--sites', 'sites.json'])).toThrow(/site is required/);
  expect(() => terrainArguments(['solar', '--out', 'output', '--catalog-ref', 'catalog.json', '--sites', 'sites.json', '--site', '../escape'])).toThrow();
  expect(terrainArguments(['solar', '--out', 'output', '--catalog-ref', 'catalog.json', '--sites', 'sites.json', '--site', 'am-hatis-500']).values.site).toBe('am-hatis-500');
  expect(() => terrainArguments(['inventory', '--out', 'output', '--concurrency', '2'])).toThrow(/Unknown option/);
  expect(() => terrainArguments(['inventory', '--out', 'output', 'extra'])).toThrow();
});

it('never treats an explicitly empty local store as a remote storage request', () => {
  for (const directory of ['', '  ']) expect(() => terrainArguments(['inventory', '--store-dir', directory, '--out', 'output'])).toThrow(/nonempty directory/);
  expect(terrainArguments(['inventory', '--store-dir', '/tmp/terrain', '--out', 'output']).values['store-dir']).toBe('/tmp/terrain');
  expect(() => terrainArguments(['prepare-model', '--model', 'gfs', '--catalog-ref', 'catalog.json', '--source-cache-dir', '', '--out', 'ref.json'])).toThrow(/nonempty directory/);
});
