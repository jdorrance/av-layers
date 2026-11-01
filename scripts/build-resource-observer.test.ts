import { expect, it } from 'vitest';
import { processTreeRss } from './build-resource-observer.js';
it('includes nested descendants independent of row order and excludes unrelated processes', () => {
  const snapshot = '12 11 300\n8 1 9999\n10 1 100\n11 10 200\n13 10 400\n';
  expect(processTreeRss(snapshot, 10)).toBe(1000 * 1024);
  expect(processTreeRss(snapshot, 8)).toBe(9999 * 1024);
  expect(processTreeRss(snapshot, 99)).toBe(0);
});
