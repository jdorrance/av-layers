import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { decodeCcsdsSamples } from './codec/ccsds.js';
import { decodeIconGribField } from './grib.js';

// Exercise packing and row normalization on a small grid without allocating a full forecast.
vi.mock('./constants.js', () => ({ ICON_EU_GRID: { width: 2, height: 2 }, ICON_EU_NATIVE_SCANNING_MODE: 64, MAX_ICON_OBJECT_BYTES: 8 * 1024 * 1024 }));

const ccsdsOptions = { bitsPerSample: 16, blockSize: 32, rsi: 128, flags: 14, sampleCount: 9 };
// Encoded independently with libaec 1.1.3, including a trailing partial block.
const ccsdsPayload = Buffer.from('103e80a20010022807fffff8', 'hex');

it('decodes a nonconstant libaec reference block without external fixture files', () => {
  expect([...decodeCcsdsSamples(ccsdsPayload, ccsdsOptions)]).toEqual([1000, 1002, 1001, 999, 1005, 1010, 1008, 1007, 1011]);
});

it('rejects exhausted fixed-width and unary payloads within a bounded subprocess', () => {
  // A Vitest timeout cannot interrupt a synchronous infinite loop in the decoder.
  const source = `
    import assert from 'node:assert/strict';
    import { decodeCcsdsSamples } from ${JSON.stringify(new URL('./codec/ccsds.ts', import.meta.url).href)};
    for (const payload of [[], [0], [0xf0], ${JSON.stringify([...ccsdsPayload.subarray(0, -1)])}]) {
      assert.throws(() => decodeCcsdsSamples(Uint8Array.from(payload), ${JSON.stringify(ccsdsOptions)}), /Truncated CCSDS payload/);
    }
  `;
  expect(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { timeout: 5000, stdio: 'pipe' })).not.toThrow();
});

function simpleField(bits: 8 | 16, scanningMode: 0 | 64, values: readonly (number | null)[], options: { drt?: 0 | 42; codedCount?: number } = {}): Uint8Array {
  const section = (number: number, length: number) => {
    const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
    view.setUint32(0, length); bytes[4] = number;
    return { bytes, view };
  };
  const s1 = section(1, 21);
  s1.view.setUint16(5, 78); s1.view.setUint16(12, 2026); s1.bytes[14] = 1; s1.bytes[15] = 1;
  const s3 = section(3, 72);
  s3.view.setUint32(6, 4); s3.bytes[14] = 6;
  s3.view.setUint32(30, 2); s3.view.setUint32(34, 2); s3.view.setUint32(42, 0xffffffff);
  s3.view.setUint32(46, scanningMode === 64 ? 0 : 1_000_000);
  s3.view.setUint32(55, scanningMode === 64 ? 1_000_000 : 0);
  s3.view.setUint32(59, 1_000_000); s3.view.setUint32(63, 1_000_000); s3.view.setUint32(67, 1_000_000);
  s3.bytes[71] = scanningMode;
  const s4 = section(4, 34);
  s4.bytes[11] = 2; s4.bytes[17] = 1; s4.bytes[22] = 1; s4.bytes[28] = 255;
  const coded = values.filter((value): value is number => value !== null);
  const s5 = section(5, options.drt === 42 ? 25 : 21);
  s5.view.setUint32(5, options.codedCount ?? coded.length); s5.view.setUint16(9, options.drt ?? 0);
  s5.view.setFloat32(11, 250); s5.bytes[19] = options.drt === 42 ? 0 : bits;
  const s6 = section(6, coded.length === values.length ? 6 : 7);
  s6.bytes[5] = coded.length === values.length ? 255 : 0;
  if (s6.bytes.length > 6) values.forEach((value, index) => { if (value !== null) s6.bytes[6] |= 0x80 >> index; });
  const s7 = section(7, 5 + coded.length * bits / 8);
  coded.forEach((value, index) => {
    if (bits === 8) s7.bytes[5 + index] = value - 250;
    else s7.view.setUint16(5 + index * 2, value - 250);
  });
  const sections = [s1, s3, s4, s5, s6, s7], length = 20 + sections.reduce((sum, value) => sum + value.bytes.length, 0);
  const message = new Uint8Array(length);
  message.set(Buffer.from('GRIB')); message[7] = 2; new DataView(message.buffer).setBigUint64(8, BigInt(length));
  let offset = 16;
  for (const value of sections) { message.set(value.bytes, offset); offset += value.bytes.length; }
  message.set(Buffer.from('7777'), offset);
  return message;
}

it.each([0, 64] as const)('normalizes equivalent 8/16-bit fields using scanning mode %s', scanningMode => {
  const active = Uint32Array.of(0, 1, 2, 3), values = [300, 301, 280, 281];
  for (const bits of [8, 16] as const) {
    const decoded = decodeIconGribField(simpleField(bits, scanningMode, values), active);
    expect([...decoded.values]).toEqual(scanningMode === 64 ? [280, 281, 300, 301] : values);
    expect([...decoded.missing]).toEqual([0, 0, 0, 0]);
  }
});

it.each([0, 64] as const)('rejects truncated 8-bit payloads with valid message framing in scanning mode %s', scanningMode => {
  const complete = simpleField(8, scanningMode, [300, 301, 280, 281]);
  const section7Offset = complete.length - 4 - (5 + 4);
  for (const payloadBytes of [0, 1, 3]) {
    const truncated = complete.slice(0, complete.length - (4 - payloadBytes));
    const view = new DataView(truncated.buffer);
    view.setBigUint64(8, BigInt(truncated.length));
    view.setUint32(section7Offset, 5 + payloadBytes);
    truncated.set(Buffer.from('7777'), truncated.length - 4);
    expect(() => decodeIconGribField(truncated, Uint32Array.of(0))).toThrow(/Truncated GRIB2 simple-packing payload/);
  }
});

it('normalizes bitmap missingness while preserving a valid value equal to the library default sentinel', () => {
  const decoded = decodeIconGribField(simpleField(16, 64, [null, 9999, 280, 281]), Uint32Array.of(0, 1, 2, 3));
  expect([...decoded.values]).toEqual([280, 281, NaN, 9999]);
  expect([...decoded.missing]).toEqual([0, 0, 1, 0]);
});

it('rejects huge CCSDS counts before allocating their advertised output', () => {
  const message = simpleField(8, 64, [300, 301, 280, 281], { drt: 42, codedCount: 0xffffffff });
  const source = `
    import assert from 'node:assert/strict';
    import { decodeIconGribField } from ${JSON.stringify(new URL('./grib.ts', import.meta.url).href)};
    import { ICON_EU_GRID } from ${JSON.stringify(new URL('./constants.ts', import.meta.url).href)};
    const bytes = Buffer.from(${JSON.stringify(message.toString())}.split(',').map(Number));
    const grid = new DataView(bytes.buffer, bytes.byteOffset + 16 + 21, 72);
    grid.setUint32(6, ICON_EU_GRID.width * ICON_EU_GRID.height);
    grid.setUint32(30, ICON_EU_GRID.width); grid.setUint32(34, ICON_EU_GRID.height);
    globalThis.Float32Array = new Proxy(Float32Array, {
      construct(target, args) {
        assert.ok(typeof args[0] !== 'number' || args[0] <= ICON_EU_GRID.width * ICON_EU_GRID.height, 'unexpected oversized allocation');
        return Reflect.construct(target, args);
      }
    });
    assert.throws(() => decodeIconGribField(bytes, Uint32Array.of(0)), /coded value count exceeds grid point count/);
  `;
  expect(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { timeout: 5000, stdio: 'pipe' })).not.toThrow();
});

it.each([0, 42] as const)('requires coded counts to match grid or bitmap coverage for template %s', drt => {
  expect(() => decodeIconGribField(simpleField(8, 64, [300, 301, 280, 281], { drt, codedCount: 3 }), Uint32Array.of(0))).toThrow(/grid\/bitmap coverage/);
  for (const codedCount of [2, 4]) {
    expect(() => decodeIconGribField(simpleField(8, 64, [null, 301, 280, 281], { drt, codedCount }), Uint32Array.of(0))).toThrow(/grid\/bitmap coverage/);
  }
});

it('ignores unused bitmap padding bits when validating coverage', () => {
  const bytes = simpleField(8, 64, [null, 301, 280, 281]);
  bytes[16 + 21 + 72 + 34 + 21 + 6] |= 0x0f;
  const decoded = decodeIconGribField(bytes, Uint32Array.of(0, 1, 2, 3));
  expect([...decoded.values]).toEqual([280, 281, NaN, 301]);
  expect([...decoded.missing]).toEqual([0, 0, 1, 0]);
});
