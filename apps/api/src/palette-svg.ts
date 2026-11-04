import { compilePaletteColor, paletteBinLabel, samplePaletteValueInto, type PaletteInterpolation } from '@av/contracts';

interface PaletteSvgInput {
  readonly edges: readonly number[];
  readonly colors: readonly string[];
  readonly units: string;
  readonly noLiftColor?: string;
  readonly transparentBelow?: number;
  readonly interpolation?: PaletteInterpolation;
}

const WIDTH = 220;
const ROW = 24;

function xml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

function number(value: number): string {
  return String(Number(value.toFixed(6)));
}

function row(y: number, color: string, text: string): string {
  return `<rect x="0" y="${y}" width="${ROW}" height="${ROW}" fill="${xml(color)}"/><text x="32" y="${y + 17}">${xml(text)}</text>`;
}

function noLiftLabel(color: string): string {
  return color.toLowerCase() === '#00000000' ? 'no usable lift (transparent)' : 'no usable lift';
}

export function paletteSvg(palette: PaletteSvgInput): string {
  const rows: string[] = [];
  let height: number;
  if (palette.interpolation === 'linear-rgb' && palette.colors.length > 1) {
    const compiled = compilePaletteColor(palette, 'linear-rgb'), color = new Uint8Array(4);
    const first = compiled.edges[0], last = compiled.edges[compiled.colorCount - 1], stops: string[] = [];
    for (let interval = 0; interval < compiled.colorCount - 1; interval++) {
      for (let step = 0; step < 16; step++) {
        const fraction = step / 16;
        const value = compiled.edges[interval] + fraction * (compiled.edges[interval + 1] - compiled.edges[interval]);
        samplePaletteValueInto(compiled, value, color);
        stops.push(`<stop offset="${number(100 * (value - first) / (last - first))}%" stop-color="rgb(${color[0]},${color[1]},${color[2]})" stop-opacity="${number(color[3] / 255)}"/>`);
      }
    }
    samplePaletteValueInto(compiled, last, color);
    stops.push(`<stop offset="100%" stop-color="rgb(${color[0]},${color[1]},${color[2]})" stop-opacity="${number(color[3] / 255)}"/>`);
    rows.push(`<defs><linearGradient id="palette-gradient" x1="0" y1="0" x2="1" y2="0">${stops.join('')}</linearGradient></defs>`, `<rect x="0" y="0" width="${WIDTH}" height="${ROW}" fill="url(#palette-gradient)"/>`, `<text x="0" y="40">${xml(`${first} ${palette.units}`)}</text>`, `<text x="${WIDTH}" y="40" text-anchor="end">${xml(`≥ ${last} ${palette.units}`)}</text>`);
    height = 48;
  } else {
    palette.colors.forEach((color, index) => rows.push(row(index * ROW, color, `${paletteBinLabel(palette.edges, palette.colors.length, index)} ${palette.units}`)));
    height = palette.colors.length * ROW;
  }
  if (palette.noLiftColor !== undefined) {
    rows.push(row(height, palette.noLiftColor, noLiftLabel(palette.noLiftColor)));
    height += ROW;
  }
  if (palette.transparentBelow !== undefined) {
    rows.push(row(height, 'none', `< ${palette.transparentBelow} ${palette.units} (transparent)`));
    height += ROW;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" fill="#111">${rows.join('')}</svg>`;
}
