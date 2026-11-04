import { LAYERS, STATUS_MASK, STATUS_NO_LIFT, paletteBinIndex, type PaletteInterpolation } from './layers.js';
import type { LayerId } from './product.js';

export type PaletteColorMode = PaletteInterpolation;

export interface PaletteColorTable {
  readonly mode: PaletteColorMode;
  readonly colorCount: number;
  readonly edges: Float64Array;
  readonly colors: Uint8Array;
  readonly noLift: Uint8Array | null;
}

export interface PaletteColorSource {
  readonly edges: readonly number[];
  readonly colors: readonly string[];
  readonly noLiftColor?: string;
}

const COLOR = /^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/;
const LINEAR_RGB_QUANT_STEPS = 8;

function parseColor(color: string, target: Uint8Array, offset: number): void {
  target[offset] = parseInt(color.slice(1, 3), 16);
  target[offset + 1] = parseInt(color.slice(3, 5), 16);
  target[offset + 2] = parseInt(color.slice(5, 7), 16);
  target[offset + 3] = color.length === 9 ? parseInt(color.slice(7, 9), 16) : 255;
}

function validateColor(color: string, field: string): void {
  if (!COLOR.test(color)) throw new RangeError(`Invalid palette ${field} color ${color}`);
}

export function compilePaletteColor(palette: PaletteColorSource, mode: PaletteColorMode = 'step'): PaletteColorTable {
  if (mode !== 'step' && mode !== 'linear-rgb') throw new RangeError(`Unsupported palette color mode ${mode}`);
  const { edges, colors } = palette, colorCount = colors.length;
  if (edges.length < 1 || edges.length > 256 || edges.some(edge => !Number.isFinite(edge))) throw new RangeError('Invalid palette edges');
  for (let i = 1; i < edges.length; i++) if (edges[i] <= edges[i - 1]) throw new RangeError('Invalid palette edges');
  if (colorCount < 1 || colorCount > 256) throw new RangeError('Invalid palette colors');
  if (edges.length < colorCount) throw new RangeError('Palette edges do not cover every color');
  const noLiftColor = palette.noLiftColor;
  if (noLiftColor !== undefined) validateColor(noLiftColor, 'no-lift');
  const knots = Float64Array.from(edges.slice(0, colorCount));
  const compiled = new Uint8Array(colorCount * 4);
  for (let i = 0; i < colorCount; i++) {
    validateColor(colors[i], 'color');
    parseColor(colors[i], compiled, i * 4);
  }
  const noLift = noLiftColor === undefined ? null : new Uint8Array(4);
  if (noLift && noLiftColor !== undefined) parseColor(noLiftColor, noLift, 0);
  return { mode, colorCount, edges: knots, colors: compiled, noLift };
}

export function samplePaletteColorInto(
  palette: PaletteColorTable,
  layer: LayerId,
  value: number | null,
  status: number,
  out: Uint8Array,
  offset = 0
): void {
  if (paletteBinIndex(layer, value, status, palette.colorCount) < 0) {
    const noLift = palette.noLift;
    if (noLift && (status & STATUS_MASK) === STATUS_NO_LIFT && LAYERS[layer].supportsNoLift) {
      out[offset] = noLift[0];
      out[offset + 1] = noLift[1];
      out[offset + 2] = noLift[2];
      out[offset + 3] = noLift[3];
    } else {
      out[offset] = 0;
      out[offset + 1] = 0;
      out[offset + 2] = 0;
      out[offset + 3] = 0;
    }
    return;
  }
  samplePaletteValueInto(palette, value as number, out, offset);
}

export function samplePaletteValueInto(palette: PaletteColorTable, value: number, out: Uint8Array, offset = 0): void {
  if (!Number.isFinite(value)) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  let bin = 0;
  for (let i = palette.colorCount - 1; i > 0; i--) {
    if (value >= palette.edges[i]) {
      bin = i;
      break;
    }
  }
  if (palette.mode === 'step' || bin === palette.colorCount - 1) {
    const color = bin * 4;
    out[offset] = palette.colors[color];
    out[offset + 1] = palette.colors[color + 1];
    out[offset + 2] = palette.colors[color + 2];
    out[offset + 3] = palette.colors[color + 3];
    return;
  }
  const from = palette.edges[bin], span = palette.edges[bin + 1] - from;
  const rawFraction = span > 0 ? Math.min(1, Math.max(0, (value - from) / span)) : 0;
  const fraction = Math.round(rawFraction * LINEAR_RGB_QUANT_STEPS) / LINEAR_RGB_QUANT_STEPS;
  const color = bin * 4, next = color + 4;
  out[offset] = Math.round(palette.colors[color] + (palette.colors[next] - palette.colors[color]) * fraction);
  out[offset + 1] = Math.round(palette.colors[color + 1] + (palette.colors[next + 1] - palette.colors[color + 1]) * fraction);
  out[offset + 2] = Math.round(palette.colors[color + 2] + (palette.colors[next + 2] - palette.colors[color + 2]) * fraction);
  out[offset + 3] = Math.round(palette.colors[color + 3] + (palette.colors[next + 3] - palette.colors[color + 3]) * fraction);
}
