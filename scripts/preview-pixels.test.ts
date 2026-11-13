import { describe, expect, it } from 'vitest';
import { classifyViewport, expectedPixel, recognizeViewport } from './preview-pixels';

const positions = [0.209, 0.222, 0.235].flatMap(u => [0.371, 0.378, 0.385].map(v => ({ u, v })));
const probes = (zoom: number, frame = 7, opacity = 1, transparent = false) => positions.map(({ u, v }) => ({ u, v, pixel: expectedPixel('agl', frame, zoom, u, v, opacity, transparent).map(Math.round) }));

describe('preview framebuffer oracle', () => {
  it.each([0, 3, 7, 8])('recognizes selected-time geometry at zoom %s', zoom => {
    expect(recognizeViewport(probes(zoom), 'agl', 1, false, 40)).toEqual({ index: 7, quality: zoom === 8 ? 'detail' : 'overview' });
  });
  it('accepts a correct-time viewport containing coarse and detailed regions', () => {
    const mixed = [...probes(3).slice(0, 4), ...probes(8).slice(4)];
    expect(classifyViewport(mixed, 'agl', 7, 1, false)).toBe('overview');
  });
  it('rejects one stale corner even when the center has the requested frame', () => {
    const mixed = probes(3); mixed[0] = probes(3, 6)[0];
    expect(classifyViewport(mixed, 'agl', 7, 1, false)).toBeNull();
  });
  it('rejects a stretched or displaced image with the correct frame colors', () => {
    const displaced = probes(3).map(probe => ({ ...probe, pixel: expectedPixel('agl', 7, 3, probe.u + 0.03, probe.v, 1, false) }));
    expect(classifyViewport(displaced, 'agl', 7, 1, false)).toBeNull();
  });
  it.each([0, 3, 8])('retains alpha and geometry evidence at opacity 0.7 and zoom %s', zoom => {
    expect(recognizeViewport(probes(zoom, 7, 0.7, true), 'agl', 0.7, true, 40)).toEqual({ index: 7, quality: zoom === 8 ? 'detail' : 'overview' });
  });
  it.each([0, 23, 39])('bounds frame %s identity at opacity 0.7', frame => {
    expect(recognizeViewport(probes(3, frame, 0.7, true), 'agl', 0.7, true, 40)).toEqual({ index: frame, quality: 'overview' });
    expect(classifyViewport(probes(3, frame ? frame - 1 : 1, 0.7, true), 'agl', frame, 0.7, true)).toBeNull();
  });
  it('rejects old fine imagery beneath a newly transparent overview', () => {
    const current = probes(3, 7, 0.7, true), old = probes(8, 6, 0.7, true);
    const leaked = current.map((probe, index) => probe.pixel.every((value, channel) => value === [213, 221, 227, 255][channel]) ? old[index] : probe);
    expect(classifyViewport(leaked, 'agl', 7, 0.7, true)).toBeNull();
  });
});
