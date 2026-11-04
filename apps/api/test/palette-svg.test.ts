import { describe, expect, it } from 'vitest';
import { compilePaletteColor, LIFT_COLORS, PALETTES, samplePaletteValueInto } from '@av/contracts';
import { paletteSvg } from '../src/palette-svg';

function sampled(palette: typeof PALETTES.lift, value: number): string {
  const table = compilePaletteColor(palette, 'linear-rgb'), color = new Uint8Array(4);
  samplePaletteValueInto(table, value, color);
  return `stop-color="rgb(${color[0]},${color[1]},${color[2]})" stop-opacity="1"`;
}

describe('palette SVG legends', () => {
  it('renders the current lift palette as an encoded channel gradient sampled through shared palette knots', () => {
    const svg = paletteSvg(PALETTES.lift);
    expect(svg).toContain('<linearGradient id="palette-gradient"');
    expect(svg).toContain(`offset="0%" ${sampled(PALETTES.lift, 0)}`);
    expect(svg).toContain(`offset="2.34375%" ${sampled(PALETTES.lift, 150)}`);
    expect(svg).toContain(`offset="4.6875%" ${sampled(PALETTES.lift, 300)}`);
    expect(svg).toContain(`offset="100%" ${sampled(PALETTES.lift, 6400)}`);
    expect(svg).toContain('stop-color="rgb(135,42,107)"');
    expect(svg).toContain('>0 m</text>');
    expect(svg).toContain('>≥ 6400 m</text>');
    expect(svg).toContain('no usable lift (transparent)');
    expect((svg.match(/<rect /g) ?? []).length).toBe(2);
    expect(svg).not.toContain(LIFT_COLORS[0]!);
  });

  it('keeps palettes without interpolation in the legacy step legend', () => {
    const legacy = { edges: PALETTES.lift.edges, colors: PALETTES.lift.colors, units: PALETTES.lift.units, noLiftColor: PALETTES.lift.noLiftColor };
    const svg = paletteSvg(legacy);
    expect(svg).not.toContain('<linearGradient');
    expect((svg.match(/<rect /g) ?? []).length).toBe(23);
    expect(svg).toContain(`fill="${LIFT_COLORS[0]}"/><text x="32" y="17">0–300 m</text>`);
    expect(svg).toContain('fill="#00000000"/><text x="32" y="545">no usable lift (transparent)</text>');
  });

  it('keeps the precipitation step legend and transparent threshold unchanged', () => {
    const svg = paletteSvg(PALETTES.rain);
    expect(svg).not.toContain('<linearGradient');
    expect((svg.match(/<rect /g) ?? []).length).toBe(9);
    expect(svg).toContain('fill="#b9e5ff"/><text x="32" y="17">0.1–0.5 mm/h</text>');
    expect(svg).toContain('&lt; 0.1 mm/h (transparent)');
    expect(svg).not.toContain('linearGradient');
  });
});
