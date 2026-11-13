/** Browser benchmark oracle: frame/layer identity, resolution and Web Mercator position. */
export const DETAIL_ZOOM = 8;
export const TILE_SIZE = 256;
const FRAME_GREEN_STEP = 5;
export const BACKGROUND = [213, 221, 227] as const;
export type BenchLayer = 'agl' | 'msl';
export interface PixelProbe { pixel: readonly number[]; u: number; v: number }

export function fixturePixel(layer: BenchLayer, frame: number, zoom: number, u: number, v: number, transparent: boolean): [number, number, number, number] {
  const red = (layer === 'agl' ? 40 : 200) + (zoom < DETAIL_ZOOM ? 40 : 0);
  const blue = Math.round(128 + 54 * Math.sin(16 * Math.PI * u) + 54 * Math.cos(10 * Math.PI * v));
  const clear = transparent && ((Math.floor(u * 16) + Math.floor(v * 16) + frame) % 3 + 3) % 3 === 0;
  return [red, 16 + frame * FRAME_GREEN_STEP, blue, clear ? 0 : 255];
}

export function expectedPixel(layer: BenchLayer, frame: number, zoom: number, u: number, v: number, opacity: number, transparent: boolean): number[] {
  const size = TILE_SIZE * 2 ** zoom, x = u * size - 0.5, y = v * size - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const rgba = [0, 0, 0, 0];
  for (const [dx, wx] of [[0, 1 - fx], [1, fx]]) for (const [dy, wy] of [[0, 1 - fy], [1, fy]]) {
    const sx = (((ix + dx + 0.5) / size) % 1 + 1) % 1;
    const sy = Math.min(size - 0.5, Math.max(0.5, iy + dy + 0.5)) / size;
    const pixel = fixturePixel(layer, frame, zoom, sx, sy, transparent), alpha = pixel[3] / 255;
    for (let channel = 0; channel < 3; channel++) rgba[channel] += wx * wy * alpha * pixel[channel];
    rgba[3] += wx * wy * alpha;
  }
  // Raster textures blend premultiplied samples over the fixture's opaque neutral basemap.
  return [...BACKGROUND.map((background, channel) => rgba[channel] * opacity + background * (1 - rgba[3] * opacity)), 255];
}

export function classifyViewport(probes: readonly PixelProbe[], layer: BenchLayer, frame: number, opacity: number, transparent: boolean): 'detail' | 'overview' | null {
  if (!probes.length) return null;
  const matches = (probe: PixelProbe, zoom: number) => {
    const expected = expectedPixel(layer, frame, zoom, probe.u, probe.v, opacity, transparent);
    return expected.every((value, channel) => Math.abs(value - probe.pixel[channel]) <= (channel === 1 ? 2 : 3));
  };
  if (probes.every(probe => matches(probe, DETAIL_ZOOM))) return 'detail';
  return probes.every(probe => matches(probe, DETAIL_ZOOM) || Array.from({ length: DETAIL_ZOOM }, (_, zoom) => zoom).some(zoom => matches(probe, zoom))) ? 'overview' : null;
}

export function recognizeViewport(probes: readonly PixelProbe[], layer: BenchLayer, opacity: number, transparent: boolean, frameCount: number): { index: number; quality: 'detail' | 'overview' } | null {
  const candidates = new Set<number>();
  for (const { pixel } of probes) {
    const red = layer === 'agl' ? 40 : 200;
    if (![red, red + 40].some(value => Math.abs(pixel[0] - (value * opacity + BACKGROUND[0] * (1 - opacity))) <= 3)) continue;
    const index = Math.round(((pixel[1] - BACKGROUND[1] * (1 - opacity)) / opacity - 16) / FRAME_GREEN_STEP);
    if (index >= 0 && index < frameCount) candidates.add(index);
  }
  for (const index of candidates) {
    const quality = classifyViewport(probes, layer, index, opacity, transparent);
    if (quality) return { index, quality };
  }
  return null;
}
