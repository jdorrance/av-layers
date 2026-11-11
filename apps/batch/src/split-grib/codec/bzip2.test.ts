import { expect, it } from 'vitest';
import { decompressBzip2 } from './bzip2.js';

// Python stdlib bz2.compress(b'ICON fixture\n' * 4, compresslevel=9).
const reference = Buffer.from('425a68393141592653595da39e4b000007d5800010400008218320164020003100d0005540681a419325c820e1a367892493e2ee48a70a120bb473c960', 'hex');
const expected = Buffer.from('ICON fixture\n'.repeat(4));

it('decodes an independent bzip2 fixture within its exact byte limit', () => {
  expect(decompressBzip2(reference, expected.length)).toEqual(new Uint8Array(expected));
});

it('refuses output beyond the caller budget before growing its buffer', () => {
  expect(() => decompressBzip2(reference, expected.length - 1)).toThrow(/output exceeds byte limit/);
  expect(() => decompressBzip2(reference, 0)).toThrow(/output exceeds byte limit/);
});

it('rejects truncated or corrupt streams', () => {
  expect(() => decompressBzip2(reference.subarray(0, -1), expected.length)).toThrow(/Unexpected end/);
  const corrupt = reference.slice();
  corrupt[10] ^= 1;
  expect(() => decompressBzip2(corrupt, expected.length)).toThrow(/CRC mismatch/);
});

it('rejects a run with a CRC chosen to match bytes from a previous decode', () => {
  // bzip2 -1 of the ASCII text below, which puts nonzero bytes in the reused BWT table.
  const seed = Buffer.from('425a68313141592653596a8863f000000509007fe03f80200022134346d4c4c2869a6001ab3adaf3ac079e27f562ee48a70a120d510c7e00', 'hex');
  const seededText = 'abcdefg1234567890';
  // 32 consecutive RUNA symbols used to wrap the counter and read the seed's stale BWT bytes.
  const malformed = Buffer.from('425a6831314159265359e89a6acb00000004003800200021806000000000000000000000000069c177245385090e89a6acb0', 'hex');
  expect(Buffer.from(decompressBzip2(seed, seededText.length)).toString()).toBe(seededText);
  expect(() => decompressBzip2(malformed, 32)).toThrow('bzip2 block overflow during RLE1');
  expect(Buffer.from(decompressBzip2(seed, seededText.length)).toString()).toBe(seededText);
});
