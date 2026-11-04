import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: true,
    maxWorkers: Math.min(8, Math.max(4, availableParallelism()))
  }
});
