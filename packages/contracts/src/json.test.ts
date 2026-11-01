import { expect, it } from 'vitest';
import { encodeBoundedJson, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseBoundedJson, ResourceLimitError } from './json.js';

it('admits an exact byte boundary and rejects the next byte before metadata can be committed', () => {
  const exact = { s: 'x'.repeat(MAX_PROVENANCE_BYTES - 8) };
  expect(encodeBoundedJson(exact, MAX_PROVENANCE_BYTES).length).toBe(MAX_PROVENANCE_BYTES);
  expect(() => encodeBoundedJson({ s: exact.s + 'x' }, MAX_PROVENANCE_BYTES)).toThrow(ResourceLimitError);
});
it('uses a larger bounded structure allowance for source receipts than manifests', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ frames: Array.from({ length: 200 }, () => Array(64).fill(0)) }));
  expect(() => parseBoundedJson(bytes)).toThrow('object budget');
  expect(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS)).toHaveProperty('frames.length', 200);
});
it('rejects shallow wide containers and deeply nested graphs even below the byte allowance', () => {
  expect(() => encodeBoundedJson(Array(257).fill(0), MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS)).toThrow('property budget');
  expect(() => parseBoundedJson(new TextEncoder().encode('['.repeat(33) + '0' + ']'.repeat(33)))).toThrow('nesting');
  const escaped = { text: '\\"[]{}:,' };
  expect(parseBoundedJson(encodeBoundedJson(escaped, 128))).toEqual(escaped);
});
