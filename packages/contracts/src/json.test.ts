import { expect, it } from 'vitest';
import { encodeBoundedJson, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseBoundedJson, ResourceLimitError, sameJsonValue } from './json.js';

it('compares JSON structures independently of object key order', () => {
  expect(sameJsonValue({ b: [1, { y: true, x: null }], a: 'ok' }, { a: 'ok', b: [1, { x: null, y: true }] })).toBe(true);
  expect(sameJsonValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  expect(sameJsonValue({ a: 1, b: null }, { a: 1 })).toBe(false);
  expect(sameJsonValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
});

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

it('admits a bounded producer inventory without changing serving container limits', () => {
  const value = Array(1046).fill(['field/c/0', 'a'.repeat(64)]);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  expect(encodeBoundedJson(value, 128 * 1024, 16_384, 1046)).toEqual(bytes);
  expect(() => encodeBoundedJson(value, 128 * 1024, 16_384, 1045)).toThrow('property budget');
  expect(() => parseBoundedJson(bytes)).toThrow('property budget');
  expect(parseBoundedJson(bytes, 16_384, 1046)).toHaveLength(1046);
  expect(() => parseBoundedJson(bytes, 16_384, 1045)).toThrow('property budget');
});

it('preserves UTF-8 keys and values with escaped quotes, backslashes and structural punctuation', () => {
  const value = { '雪🌦️': ['Ā\\\"[]{}:,', '\\', '"', '\ud800', { unicode: 'é🪂', escaped: '\\"{[,:]}' }] };
  expect(parseBoundedJson(encodeBoundedJson(value, 1024))).toEqual(value);
});
