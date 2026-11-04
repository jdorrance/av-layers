import { describe, expect, it } from 'vitest';
import { LIFT_COLORS, LIFT_EDGES, PALETTES, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from './layers.js';
import { compilePaletteColor, samplePaletteColorInto, samplePaletteValueInto, type PaletteColorMode, type PaletteColorSource } from './palette-color.js';

const TRANSPARENT = [0, 0, 0, 0];
const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

function sample(mode: PaletteColorMode, layer: Parameters<typeof samplePaletteColorInto>[1], value: number | null, status = STATUS_VALID, palette: PaletteColorSource = PALETTES.lift): number[] {
  const out = new Uint8Array(4);
  samplePaletteColorInto(compilePaletteColor(palette, mode), layer, value, status, out);
  return [...out];
}

function hex(color: readonly number[]): string {
  const value = color.map(channel => channel.toString(16).padStart(2, '0')).join('');
  return `#${value.endsWith('ff') ? value.slice(0, 6) : value}`;
}

describe('continuous palette colors', () => {
  it('defaults to step and returns exact anchors, first color below range and last color at overflow', () => {
    expect(compilePaletteColor(PALETTES.lift).mode).toBe('step');
    for (const mode of ['step', 'linear-rgb'] as const) {
      expect(hex(sample(mode, 'usable-lift-msl', -100))).toBe(LIFT_COLORS[0]);
      expect(hex(sample(mode, 'usable-lift-msl', 0))).toBe(LIFT_COLORS[0]);
      expect(hex(sample(mode, 'usable-lift-msl', 300))).toBe(LIFT_COLORS[1]);
      expect(hex(sample(mode, 'usable-lift-msl', 6400))).toBe(LIFT_COLORS[21]);
      expect(hex(sample(mode, 'usable-lift-msl', 7000))).toBe(LIFT_COLORS[21]);
    }
  });

  it('uses palette edges as knots and holds the last color past the final color knot', () => {
    const table = compilePaletteColor(PALETTES.lift, 'linear-rgb');
    expect(table.colorCount).toBe(22);
    expect(table.edges.length).toBe(22);
    expect([...table.edges]).toEqual(LIFT_EDGES.slice(0, 22));
    expect(hex(sample('step', 'usable-lift-msl', 6399))).toBe(LIFT_COLORS[20]);
    expect(hex(sample('step', 'usable-lift-msl', 6400))).toBe(LIFT_COLORS[21]);
    expect(hex(sample('linear-rgb', 'usable-lift-msl', 6700))).toBe(LIFT_COLORS[21]);
  });

  it('interpolates encoded sRGB channels and clamps the endpoints', () => {
    const table = compilePaletteColor({ edges: [0, 100], colors: ['#000000', '#ffffff'] }, 'linear-rgb');
    const out = new Uint8Array(8).fill(255);
    samplePaletteColorInto(table, 'usable-lift-msl', 50, STATUS_VALID, out, 2);
    expect(out[2]).toBe(128);
    expect(out[3]).toBe(128);
    expect(out[4]).toBe(128);
    expect(out[5]).toBe(255);
    expect([...out]).toEqual([255, 255, 128, 128, 128, 255, 255, 255]);
    expect(sample('linear-rgb', 'usable-lift-msl', -10, STATUS_VALID, { edges: [0, 100], colors: ['#000000', '#ffffff'] })).toEqual(BLACK);
    expect(sample('linear-rgb', 'usable-lift-msl', 150, STATUS_VALID, { edges: [0, 100], colors: ['#000000', '#ffffff'] })).toEqual(WHITE);
  });

  it('writes the custom no-lift color only for layers that support no lift', () => {
    const gray = { ...PALETTES.lift, noLiftColor: '#808080ff' };
    const clearGray = { ...PALETTES.lift, noLiftColor: '#80808000' };
    for (const mode of ['step', 'linear-rgb'] as const) {
      for (const value of [null, 0, 1200, 7000]) {
        expect(sample(mode, 'usable-lift-msl', value, STATUS_NO_LIFT | SUPPORT_MASK, gray)).toEqual([128, 128, 128, 255]);
        expect(sample(mode, 'usable-lift-agl', value, STATUS_NO_LIFT | SUPPORT_MASK, gray)).toEqual([128, 128, 128, 255]);
      }
      expect(sample(mode, 'usable-lift-msl', 1200, STATUS_NO_LIFT, clearGray)).toEqual([128, 128, 128, 0]);
      expect(sample(mode, 'usable-lift-msl', 1200, STATUS_NO_LIFT)).toEqual(TRANSPARENT);
    }
  });

  it('keeps unavailable, outside and non-finite values transparent and ignores support bits', () => {
    for (const mode of ['step', 'linear-rgb'] as const) {
      for (const status of [STATUS_UNAVAILABLE, STATUS_OUTSIDE]) {
        expect(sample(mode, 'usable-lift-msl', 1200, status | SUPPORT_MASK)).toEqual(TRANSPARENT);
      }
      expect(sample(mode, 'usable-lift-msl', Number.NaN)).toEqual(TRANSPARENT);
      expect(sample(mode, 'usable-lift-msl', Number.POSITIVE_INFINITY)).toEqual(TRANSPARENT);
      expect(sample(mode, 'usable-lift-msl', null)).toEqual(TRANSPARENT);
      expect(sample(mode, 'usable-lift-msl', 1200, STATUS_VALID | SUPPORT_MASK)).toEqual(sample(mode, 'usable-lift-msl', 1200));
    }
  });

  it('keeps the current precipitation threshold, colors and quantity rules unchanged', () => {
    for (const mode of ['step', 'linear-rgb'] as const) {
      expect(sample(mode, 'precip-rate', 0.099, STATUS_VALID, PALETTES.rain)).toEqual(TRANSPARENT);
      expect(hex(sample(mode, 'precip-rate', 0.1, STATUS_VALID, PALETTES.rain))).toBe(PALETTES.rain.colors[0]);
      expect(hex(sample(mode, 'precip-rate', 50, STATUS_VALID, PALETTES.rain))).toBe(PALETTES.rain.colors[7]);
      expect(hex(sample(mode, 'precip-rate', 500, STATUS_VALID, PALETTES.rain))).toBe(PALETTES.rain.colors[7]);
      expect(sample(mode, 'usable-lift-agl', 0)).toEqual(TRANSPARENT);
      expect(sample(mode, 'usable-lift-agl', -1)).toEqual(TRANSPARENT);
      expect(hex(sample(mode, 'usable-lift-agl', 0.01))).toBe(LIFT_COLORS[0]);
      expect(hex(sample(mode, 'usable-lift-msl', -20))).toBe(LIFT_COLORS[0]);
    }
  });

  it('validates generic edges, colors, no-lift colors and mode', () => {
    expect(() => compilePaletteColor({ edges: [0], colors: [] })).toThrow(RangeError);
    expect(() => compilePaletteColor({ edges: [], colors: ['#000000'] })).toThrow(RangeError);
    expect(() => compilePaletteColor({ edges: [0, 1, 2], colors: ['#000000', '#ffffff'] }, 'linear' as PaletteColorMode)).toThrow(RangeError);
    expect(() => compilePaletteColor({ edges: [0, Number.NaN], colors: ['#000000'] })).toThrow(RangeError);
    expect(() => compilePaletteColor({ edges: [0], colors: ['#000000', '#ffffff'] })).toThrow(RangeError);
    expect(() => compilePaletteColor({ edges: [0], colors: ['red'] })).toThrow(RangeError);
    expect(() => compilePaletteColor({ edges: [0], colors: ['#000000'], noLiftColor: '#fff' })).toThrow(RangeError);
    expect(() => compilePaletteColor({ edges: [0, 0], colors: ['#000000', '#ffffff'] })).toThrow(RangeError);
    expect(() => compilePaletteColor({ edges: [0, 2, 1], colors: ['#000000', '#ffffff'] })).toThrow(RangeError);
    expect(hex(sample('step', 'usable-lift-msl', 0, STATUS_VALID, { edges: [0], colors: ['#11223380'], noLiftColor: '#445566cc' }))).toBe('#11223380');
  });

  it('keeps direct value sampling transparent for non-finite values', () => {
    const table = compilePaletteColor({ edges: [0, 100], colors: ['#000000', '#ffffff'] }, 'linear-rgb');
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = new Uint8Array(4);
      samplePaletteValueInto(table, value, out);
      expect([...out]).toEqual(TRANSPARENT);
    }
    const out = new Uint8Array(4);
    samplePaletteValueInto(table, -1, out);
    expect([...out]).toEqual(BLACK);
  });
});
