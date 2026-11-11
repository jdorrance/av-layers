import { SPLIT_PRODUCT } from '../../../../tests/model-fixtures.js';
import { splitSource } from './source.js';
const profile = splitSource({ ...SPLIT_PRODUCT, grid: { ...SPLIT_PRODUCT.grid, width: 2, height: 2 } });
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { decodeCcsdsSamples } from './codec/ccsds.js';
import { decodeSplitGribField } from './grib.js';

// Exercise packing and row normalization on a small grid without allocating a full forecast.

const ccsdsOptions = { bitsPerSample: 16, blockSize: 32, rsi: 128, flags: 14, sampleCount: 9 };
// Encoded independently with libaec 1.1.3, including a trailing partial block.
const ccsdsPayload = Buffer.from('103e80a20010022807fffff8', 'hex');

it('decodes a nonconstant libaec reference block without external fixture files', () => {
  expect([...decodeCcsdsSamples(ccsdsPayload, ccsdsOptions)]).toEqual([1000, 1002, 1001, 999, 1005, 1010, 1008, 1007, 1011]);
});

it('reads full-width unsigned samples across bytes and padded intervals', () => {
  const payload = Buffer.from('fffffffffc091a2b38fc0000000000000008', 'hex');
  const options = { bitsPerSample: 32, blockSize: 2, rsi: 1, flags: 32, sampleCount: 4 };
  expect([...decodeCcsdsSamples(payload, options)]).toEqual([0xffffffff, 0x81234567, 0x80000000, 1]);
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

function simpleField(bits: 0 | 8 | 16, scanningMode: 0 | 64, values: readonly (number | null)[], options: { drt?: 0 | 42; codedCount?: number; decimalScale?: number } = {}): Uint8Array {
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
  s5.view.setFloat32(11, 250);
  const decimalScale = options.decimalScale ?? 0;
  s5.view.setUint16(17, Math.abs(decimalScale) | (decimalScale < 0 ? 0x8000 : 0)); s5.bytes[19] = bits;
  if (options.drt === 42) { s5.bytes[21] = 14; s5.bytes[22] = 32; s5.view.setUint16(23, 128); }
  const s6 = section(6, coded.length === values.length ? 6 : 7);
  s6.bytes[5] = coded.length === values.length ? 255 : 0;
  if (s6.bytes.length > 6) values.forEach((value, index) => { if (value !== null) s6.bytes[6] |= 0x80 >> index; });
  const s7 = section(7, 5 + coded.length * bits / 8);
  coded.forEach((value, index) => {
    if (bits === 8) s7.bytes[5 + index] = value - 250;
    else if (bits === 16) s7.view.setUint16(5 + index * 2, value - 250);
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
    const decoded = decodeSplitGribField(profile, simpleField(bits, scanningMode, values), active);
    expect([...decoded.values]).toEqual(scanningMode === 64 ? [280, 281, 300, 301] : values);
    expect([...decoded.missing]).toEqual([0, 0, 0, 0]);
  }
});

it('scatters ICON values and missing flags into reusable shared views', () => {
  const active = Uint32Array.of(0, 1, 2, 3), target = {
    values: new Float32Array(new SharedArrayBuffer(16)), missing: new Uint8Array(new SharedArrayBuffer(4)).fill(1)
  };
  const bytes = simpleField(8, 64, [300, null, 280, 281]);
  const expected = decodeSplitGribField(profile, bytes, active), decoded = decodeSplitGribField(profile, bytes, active, target);
  expect(decoded.values).toBe(target.values); expect(decoded.missing).toBe(target.missing);
  expect(decoded.values).toEqual(expected.values); expect(decoded.missing).toEqual(expected.missing);
  decodeSplitGribField(profile, simpleField(8, 64, [300, 301, 280, 281]), active, target);
  expect([...target.missing]).toEqual([0, 0, 0, 0]);
});

it.each([0, 64] as const)('rejects latitude endpoints contradicting scanning mode %s', scanningMode => {
  const message = simpleField(8, scanningMode, [300, 301, 280, 281]);
  message[16 + 21 + 71] = scanningMode === 64 ? 0 : 64;
  expect(() => decodeSplitGribField(profile, message, Uint32Array.of(0))).toThrow('scanning mode disagrees with latitude endpoints');
});

it.each([0, 42] as const)('decodes zero-bit template 5.%s as the unscaled reference with empty payload and bitmap masks', drt => {
  const active = Uint32Array.of(3, 0, 2, 1);
  for (const scanningMode of [0, 64] as const) for (const decimalScale of [-1, 0, 1]) {
    // These zero-bit fixtures were cross-checked with ecCodes 2.50.0: D is ignored.
    const value = 250;
    const complete = decodeSplitGribField(profile, simpleField(0, scanningMode, [250, 250, 250, 250], { drt, decimalScale }), active);
    expect([...complete.values]).toEqual([value, value, value, value]);
    expect([...complete.missing]).toEqual([0, 0, 0, 0]);
    const masked = decodeSplitGribField(profile, simpleField(0, scanningMode, [250, null, 250, 250], { drt, decimalScale }), active);
    expect([...masked.values]).toEqual(scanningMode === 64 ? [NaN, value, value, value] : [value, value, value, NaN]);
    expect([...masked.missing]).toEqual(scanningMode === 64 ? [1, 0, 0, 0] : [0, 0, 0, 1]);
  }
  const missing = decodeSplitGribField(profile, simpleField(0, 64, [null, null, null, null], { drt }), active);
  expect([...missing.values]).toEqual([NaN, NaN, NaN, NaN]);
  expect([...missing.missing]).toEqual([1, 1, 1, 1]);
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
    expect(() => decodeSplitGribField(profile, truncated, Uint32Array.of(0))).toThrow(/Truncated GRIB2 simple-packing payload/);
  }
});

it.each([0, 64] as const)('normalizes bitmap and active-index order in scan %s, preserving a valid sentinel-like value', scanningMode => {
  const decoded = decodeSplitGribField(profile, simpleField(16, scanningMode, [null, 9999, 280, 281]), Uint32Array.of(3, 0, 2, 1));
  expect([...decoded.values]).toEqual(scanningMode === 64 ? [9999, 280, NaN, 281] : [281, NaN, 280, 9999]);
  expect([...decoded.missing]).toEqual(scanningMode === 64 ? [0, 0, 1, 0] : [0, 1, 0, 0]);
});

it('rejects huge CCSDS counts before allocating their advertised output', () => {
  const message = simpleField(8, 64, [300, 301, 280, 281], { drt: 42, codedCount: 0xffffffff });
  const source = `
    import assert from 'node:assert/strict';
    import { decodeSplitGribField } from ${JSON.stringify(new URL('./grib.ts', import.meta.url).href)};
    import { SPLIT_PRODUCT } from ${JSON.stringify(new URL('../../../../tests/model-fixtures.ts', import.meta.url).href)};
    import { splitSource } from ${JSON.stringify(new URL('./source.ts', import.meta.url).href)};
    const profile = splitSource(SPLIT_PRODUCT);
    const bytes = Buffer.from(${JSON.stringify(message.toString())}.split(',').map(Number));
    const grid = new DataView(bytes.buffer, bytes.byteOffset + 16 + 21, 72);
    grid.setUint32(6, profile.grid.width * profile.grid.height);
    grid.setUint32(30, profile.grid.width); grid.setUint32(34, profile.grid.height);
    globalThis.Float32Array = new Proxy(Float32Array, {
      construct(target, args) {
        assert.ok(typeof args[0] !== 'number' || args[0] <= profile.grid.width * profile.grid.height, 'unexpected oversized allocation');
        return Reflect.construct(target, args);
      }
    });
    assert.throws(() => decodeSplitGribField(profile, bytes, Uint32Array.of(0)), /coded value count exceeds grid point count/);
  `;
  expect(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { timeout: 5000, stdio: 'pipe' })).not.toThrow();
});

it.each([0, 42] as const)('requires coded counts to match grid or bitmap coverage for template %s', drt => {
  expect(() => decodeSplitGribField(profile, simpleField(8, 64, [300, 301, 280, 281], { drt, codedCount: 3 }), Uint32Array.of(0))).toThrow(/grid\/bitmap coverage/);
  for (const codedCount of [2, 4]) {
    expect(() => decodeSplitGribField(profile, simpleField(8, 64, [null, 301, 280, 281], { drt, codedCount }), Uint32Array.of(0))).toThrow(/grid\/bitmap coverage/);
  }
});

it('ignores unused bitmap padding bits when validating coverage', () => {
  const bytes = simpleField(8, 64, [null, 301, 280, 281]);
  bytes[16 + 21 + 72 + 34 + 21 + 6] |= 0x0f;
  const decoded = decodeSplitGribField(profile, bytes, Uint32Array.of(0, 1, 2, 3));
  expect([...decoded.values]).toEqual([280, 281, NaN, 301]);
  expect([...decoded.missing]).toEqual([0, 0, 1, 0]);
});

it('retains Float64 precision on statistical template 4.8 fields for late-lead window recovery', () => {
  const makeStat = (endHour: number, reference: number, delta: number): Uint8Array => {
    const base = simpleField(8, 0, [250 + delta, 250, 250, 250]);
    const s4 = new Uint8Array(58), v4 = new DataView(s4.buffer);
    v4.setUint32(0, 58); s4[4] = 4; v4.setUint16(7, 8);
    s4[11] = 2; s4[17] = 1; v4.setUint32(18, 0); s4[22] = 1; s4[28] = 255;
    const end = new Date(Date.UTC(2026, 0, 1) + endHour * 3_600_000);
    v4.setUint16(34, end.getUTCFullYear()); s4[36] = end.getUTCMonth() + 1; s4[37] = end.getUTCDate();
    s4[38] = end.getUTCHours(); s4[41] = 1; s4[46] = 0; s4[47] = 2; s4[48] = 1;
    v4.setUint32(49, endHour); s4[53] = 255;
    const out = new Uint8Array(base.length + 24);
    out.set(base.subarray(0, 16 + 21 + 72), 0);
    out.set(s4, 16 + 21 + 72);
    out.set(base.subarray(16 + 21 + 72 + 34), 16 + 21 + 72 + 58);
    const view = new DataView(out.buffer);
    view.setBigUint64(8, BigInt(out.length));
    view.setFloat32(16 + 21 + 72 + 58 + 11, reference);
    return out;
  };
  const reference = 134_217_728; // 2^27: exact in Float32, while +123 loses low bits in Float32.
  const prev = decodeSplitGribField(profile, makeStat(71, reference, 0), Uint32Array.of(0));
  const curr = decodeSplitGribField(profile, makeStat(72, reference, 123), Uint32Array.of(0));
  expect(curr.values[0]! - prev.values[0]!).not.toBe(123);
  expect(curr.preciseValues).toBeInstanceOf(Float64Array);
  expect(curr.preciseValues![0]! * 72 - prev.preciseValues![0]! * 71).toBe(reference + 72 * 123);
});
