import { build } from 'vite';
import { expect, it } from 'vitest';

it.each([
  ['@av/thermodynamics', 'saturationVaporPressureHpa', ['thermodynamics']],
  ['@av/soaring', 'deriveLift', ['soaring', 'thermodynamics']],
  ['@av/soaring/velocity', 'usableLiftDepthM', ['soaring']],
  ['@av/solar/grid', 'createGridDaylightTester', ['solar']],
  ['@av/forecast/intervals', 'recoverTrailingWindow', ['forecast']],
  ['@av/forecast/sampler', 'planSample, sampleCells', ['forecast', 'contracts']],
  ['@av/forecast/sample-pack', 'planShardedPackedSample, packedCellsFromRange', ['forecast', 'contracts']]
] as const)('bundles %s with only its required math modules', async (entry, symbol, packages) => {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'weather-math-entry',
      resolveId(id) { if (id === 'weather-math-entry') return '\0weather-math-entry'; },
      load(id) {
        if (id === '\0weather-math-entry') return `export { ${symbol} } from '${entry}';`;
      }
    }],
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: 'weather-math-entry',
        preserveEntrySignatures: 'strict',
        output: { format: 'es' }
      }
    }
  });
  if (Array.isArray(built) || !('output' in built)) throw new Error('Expected one in-memory bundle');
  const chunks = built.output.filter(output => output.type === 'chunk');
  expect(chunks).toHaveLength(1);
  const chunk = chunks[0]!;
  expect([...chunk.exports].sort()).toEqual(symbol.split(', ').sort());
  const modules = Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0).map(([id]) => id);
  expect(modules.length).toBeGreaterThan(0);
  for (const id of modules) {
    expect(packages.some(name => id.includes(`/packages/${name}/src/`))).toBe(true);
  }
  if (entry === '@av/soaring/velocity') {
    expect(modules.some(id => id.endsWith('/column.ts'))).toBe(false);
  }
  if (entry === '@av/forecast/intervals') {
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatch(/\/forecast\/src\/intervals\.ts$/);
  }
});
