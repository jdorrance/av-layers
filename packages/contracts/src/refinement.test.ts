import { describe, expect, it } from 'vitest';
import configuredZones from '../config/refinement.json';
import { GFS_GRID, ICON_EU_GRID } from './products.js';
import { prepareGridGeometry, type GeographicBounds } from './geometry.js';
import { containsRefinement, parseRefinementConfig, planRefinements, refinementCandidate, refinementGeometrySchema, REFINEMENT_SPACING_M } from './refinement.js';

const rectangle = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const feature = (id: string, coordinates = [rectangle(10, 39, 12, 41)]) => ({ type: 'Feature', id, properties: {}, geometry: { type: 'Polygon', coordinates } });
const config = (...features: ReturnType<typeof feature>[]) => parseRefinementConfig({ type: 'FeatureCollection', features });
const options = { sourceGrid: GFS_GRID, bounds: [-180, -55, 180, 65] as GeographicBounds, haloCells: 1 };

describe('configured refinement geometry', () => {
  it('validates standalone patch geometry and selects by exact polygon and supported layer', () => {
    const geometry = refinementGeometrySchema.parse(feature('zone-001').geometry);
    const patch = { geometry, descriptors: { bounds: [10, 39, 12, 41] as GeographicBounds }, layers: ['usable-lift-agl'] as const };
    expect(refinementCandidate([patch], 'usable-lift-agl', 40, 11)).toBe(patch);
    expect(refinementCandidate([patch], 'usable-lift-msl', 40, 11)).toBeUndefined();
    expect(refinementCandidate([patch], undefined, 40, 11)).toBe(patch);
    expect(refinementCandidate([patch], 'usable-lift-agl', 40, 13)).toBeUndefined();
    expect(() => refinementGeometrySchema.parse({ type: 'Polygon', coordinates: [[[10, 39], [12, 41], [10, 41], [12, 39], [10, 39]]] })).toThrow('self-intersect');
  });

  it('aliases both dateline endpoints and rejects physically touching zones on opposite sides', () => {
    for (const [west, east] of [[179, 180], [-180, -179]]) {
      const [plan] = planRefinements(config(feature('zone-001', [rectangle(west, 39, east, 41)])), options);
      expect(containsRefinement(plan, 40, 180)).toBe(true);
      expect(containsRefinement(plan, 40, -180)).toBe(true);
    }
    expect(() => config(feature('zone-001', [rectangle(179, 39, 180, 41)]), feature('zone-002', [rectangle(-180, 39, -179, 41)]))).toThrow('overlap or touch');
  });
  it('plans the configured polygon using each existing source without changing source geometry', () => {
    const configured = parseRefinementConfig(configuredZones);
    expect(configured.features).toHaveLength(1);
    for (const sourceGrid of [GFS_GRID, ICON_EU_GRID]) {
      const [plan] = planRefinements(configured, { ...options, sourceGrid });
      expect(plan.id).toBe('zone-001');
      expect(plan.bounds).toEqual([43.2, 38.6, 46.9, 41.6]);
      expect(plan.grid.dxM).toBe(REFINEMENT_SPACING_M);
      expect(plan.grid.dyM).toBe(-REFINEMENT_SPACING_M);
      expect(plan.grid.width * plan.grid.height).toBeLessThan(150_000);
      expect(containsRefinement(plan, 40, 45)).toBe(true);
      expect(containsRefinement(plan, 40, 47)).toBe(false);
    }
  });

  it('owns polygon interiors and outer edges while excluding holes and their edges', () => {
    const [plan] = planRefinements(config(feature('zone-001', [rectangle(10, 39, 12, 41), rectangle(10.5, 39.5, 11.5, 40.5)])), options);
    expect(containsRefinement(plan, 39.1, 10.1)).toBe(true);
    expect(containsRefinement(plan, 39, 10)).toBe(true);
    expect(containsRefinement(plan, 40, 11)).toBe(false);
    expect(containsRefinement(plan, 39.5, 11)).toBe(false);
    expect(containsRefinement(plan, NaN, 11)).toBe(false);
    expect(containsRefinement(plan, 40, Infinity)).toBe(false);
  });

  it('handles disjoint MultiPolygon components and leaves their intervening space unowned', () => {
    const raw = { ...feature('zone-001'), geometry: { type: 'MultiPolygon', coordinates: [[rectangle(10, 39, 11, 40)], [rectangle(12, 40, 13, 41)]] } };
    const [plan] = planRefinements(parseRefinementConfig({ type: 'FeatureCollection', features: [raw] }), options);
    expect(containsRefinement(plan, 39.5, 10.5)).toBe(true);
    expect(containsRefinement(plan, 40.5, 12.5)).toBe(true);
    expect(containsRefinement(plan, 40, 11.5)).toBe(false);
  });

  it('clips ownership to product and native center bounds without altering the polygon', () => {
    const input = config(feature('zone-001'));
    const sourceGrid = { ...GFS_GRID, width: 5, height: 5, lon0: 10, lat0: 41, dx: 0.25, dy: -0.25, wrapLongitude: false };
    const [plan] = planRefinements(input, { ...options, sourceGrid, bounds: [9, 39, 12, 40.75] });
    expect(plan.bounds).toEqual([10, 40, 11, 40.75]);
    expect(plan.sourceBounds).toEqual([10, 40, 11, 41]);
    expect(plan.geometry).toEqual(input.features[0].geometry);
    expect(containsRefinement(plan, 40.5, 10.5)).toBe(true);
    expect(containsRefinement(plan, 40.9, 10.5)).toBe(false);
    expect(containsRefinement(plan, 40.5, 11.1)).toBe(false);
  });

  it('omits disjoint source intersections and intersections wholly inside a hole', () => {
    expect(planRefinements(config(feature('zone-001')), { ...options, bounds: [20, 30, 25, 35] })).toEqual([]);
    const input = config(feature('zone-001', [rectangle(10, 39, 14, 43), rectangle(11, 40, 13, 42)]));
    expect(planRefinements(input, { ...options, bounds: [11.1, 40.1, 12.9, 41.9] })).toEqual([]);
    expect(planRefinements(input, { ...options, bounds: [11, 40, 13, 42] })).toEqual([]);
    expect(planRefinements(input, { ...options, bounds: [11, 40, 13, 42.1] })).toHaveLength(1);
    const diagonal = config(feature('zone-001', [[[10, 39], [12, 41], [10, 41], [10, 39]]]));
    expect(planRefinements(diagonal, { ...options, bounds: [11, 39, 12, 40] })).toEqual([]);
    expect(planRefinements(diagonal, { ...options, bounds: [11, 39, 12, 40.1] })).toHaveLength(1);
    expect(planRefinements(config(), options)).toEqual([]);
  });

  it.each([
    { name: 'concave arm', geometry: { type: 'Polygon', coordinates: [[[10, 39], [10.4, 39], [10.4, 40.5], [14, 40.5], [14, 41], [10, 41], [10, 39]]] },
      admitted: [10.2, 39, 14, 40], expected: [10.2, 39, 10.4, 40], maxCells: 3000 },
    { name: 'one multipart component', geometry: { type: 'MultiPolygon', coordinates: [[rectangle(10, 39, 10.2, 39.2)], [rectangle(14, 42, 14.2, 42.2)]] },
      admitted: [9, 38, 15, 40], expected: [10, 39, 10.2, 39.2], maxCells: 600 },
    { name: 'diagonal corner', geometry: { type: 'Polygon', coordinates: [[[10, 39], [14, 43], [10, 43], [10, 39]]] },
      admitted: [12, 39, 14, 41.5], expected: [12, 41, 12.5, 41.5], maxCells: 3000 }
  ] as const)('sizes the grid from the clipped $name within its cell budget', ({ geometry, admitted, expected, maxCells }) => {
    const input = parseRefinementConfig({ type: 'FeatureCollection', features: [{ ...feature('zone-001'), geometry }] });
    const [plan] = planRefinements(input, { ...options, bounds: admitted, maxCells });
    expect(plan.bounds).toEqual(expected);
    expect(plan.grid.width * plan.grid.height).toBeLessThanOrEqual(maxCells);
    expect(plan.geometry).toEqual(input.features[0].geometry);
    const projected = prepareGridGeometry(plan.grid);
    for (const lat of [expected[1], expected[3]]) for (const lon of [expected[0], expected[2]]) {
      const point = projected.geographicToGrid(lat, lon)!;
      expect(point.x).toBeGreaterThanOrEqual(1 - 1e-8);
      expect(point.y).toBeGreaterThanOrEqual(1 - 1e-8);
      expect(point.x).toBeLessThanOrEqual(plan.grid.width - 2 + 1e-8);
      expect(point.y).toBeLessThanOrEqual(plan.grid.height - 2 + 1e-8);
    }
  });

  it('preserves the positive-area intersection when hole edges coincide with source boundaries', () => {
    const input = config(feature('zone-001', [rectangle(-1, -1, 11, 11), rectangle(0, 0, 7, 10)]));
    const [plan] = planRefinements(input, { ...options, bounds: [0, 0, 10, 10] });
    const geometry = prepareGridGeometry(plan.grid);
    for (const lat of [0, 5, 10]) {
      expect(containsRefinement(plan, lat, 0)).toBe(false);
      expect(containsRefinement(plan, lat, 7)).toBe(false);
      expect(containsRefinement(plan, lat, 7.1)).toBe(true);
      const point = geometry.geographicToGrid(lat, 7.1)!;
      expect(point.x).toBeGreaterThanOrEqual(1);
      expect(point.x).toBeLessThanOrEqual(plan.grid.width - 2);
      expect(point.y).toBeGreaterThanOrEqual(1);
      expect(point.y).toBeLessThanOrEqual(plan.grid.height - 2);
    }
  });

  it.each([[10, 39, 12, 41], [130, -42, 133, -39], [20, -1, 22, 1]])('bounds the full curved rectangle and adds halo: %j', (w, s, e, n) => {
    const [plan] = planRefinements(config(feature('zone-001', [rectangle(w, s, e, n)])), { ...options, haloCells: 2 });
    const geometry = prepareGridGeometry(plan.grid);
    for (let j = 0; j <= 20; j++) for (let i = 0; i <= 20; i++) {
      const point = geometry.geographicToGrid(s + (n - s) * j / 20, w + (e - w) * i / 20)!;
      expect(point.x).toBeGreaterThanOrEqual(2 - 1e-8);
      expect(point.x).toBeLessThanOrEqual(plan.grid.width - 3 + 1e-8);
      expect(point.y).toBeGreaterThanOrEqual(2 - 1e-8);
      expect(point.y).toBeLessThanOrEqual(plan.grid.height - 3 + 1e-8);
    }
  });

  it('produces stable plans independent of feature ordering and accounts all target cells', () => {
    const a = feature('zone-001'), b = feature('zone-002', [rectangle(15, 39, 17, 41)]);
    const plans = planRefinements(config(a, b), options);
    expect(planRefinements(config(b, a), options)).toEqual(plans);
    const cells = plans.reduce((sum, plan) => sum + plan.grid.width * plan.grid.height, 0);
    expect(planRefinements(config(a, b), { ...options, maxCells: cells })).toEqual(plans);
    expect(() => planRefinements(config(a, b), { ...options, maxCells: cells - 1 })).toThrow('cell budget');
    for (const haloCells of [0, 65, NaN, 1.5]) expect(() => planRefinements(config(a), { ...options, haloCells })).toThrow('halo');
    expect(() => planRefinements(config(a), { ...options, maxCells: 4_000_001 })).toThrow('cell budget');
  });

  it('rejects invalid topology instead of repairing or silently losing holes', () => {
    const bad = [
      [rectangle(10, 39, 12, 41).slice(0, -1)],
      [[[10, 39], [12, 41], [10, 41], [12, 39], [10, 39]]],
      [[[10, 39], [11, 39], [12, 39], [10, 39]]],
      [[[10, 39], [10, 39], [12, 41], [10, 41], [10, 39]]],
      [rectangle(10, 39, 12, 41), rectangle(11, 40, 13, 42)],
      [rectangle(10, 39, 12, 41), rectangle(10.1, 39.1, 11.5, 40.5), rectangle(11, 40, 11.9, 40.9)]
    ];
    for (const coordinates of bad) expect(() => config(feature('zone-001', coordinates))).toThrow();
    expect(() => config(feature('zone-001'), feature('zone-001', [rectangle(15, 39, 17, 41)]))).toThrow('unique');
    expect(() => config(feature('zone-001'), feature('zone-002', [rectangle(11, 40, 13, 42)]))).toThrow('overlap or touch');
    expect(() => config(feature('zone-001'), feature('zone-002', [rectangle(12, 39, 13, 40)]))).toThrow('overlap or touch');
    expect(() => config(feature('zone-001'), feature('zone-002', [rectangle(10.1, 39.1, 11.9, 40.9)]))).toThrow('overlap or touch');
  });

  it.each(['features', 'components'])('admits disjoint nested annuli and an island inside their holes as %s', representation => {
    const parts = [
      [rectangle(10, 38, 18, 46), rectangle(11, 39, 17, 45)],
      [rectangle(12, 40, 16, 44), rectangle(13, 41, 15, 43)],
      [rectangle(13.5, 41.5, 14.5, 42.5)]
    ];
    const features = representation === 'features' ? parts.map((part, index) => feature(`zone-${index}`, part))
      : [{ ...feature('zone-001'), geometry: { type: 'MultiPolygon', coordinates: parts } }];
    expect(() => parseRefinementConfig({ type: 'FeatureCollection', features })).not.toThrow();
  });

  it.each(['features', 'components'])('rejects overlapping concentric annuli as %s without boundary crossings', representation => {
    const parts = [
      [rectangle(10, 38, 16, 44), rectangle(12, 40, 14, 42)],
      [rectangle(11, 39, 15, 43), rectangle(12.5, 40.5, 13.5, 41.5)]
    ];
    const features = representation === 'features' ? parts.map((part, index) => feature(`zone-${index}`, part))
      : [{ ...feature('zone-001'), geometry: { type: 'MultiPolygon', coordinates: parts } }];
    expect(() => parseRefinementConfig({ type: 'FeatureCollection', features })).toThrow('overlap or touch');
  });

  it('rejects an outer ring that starts inside another hole then crosses or touches its boundary', () => {
    const annulus = feature('zone-001', [rectangle(10, 38, 16, 44), rectangle(12, 40, 14, 42)]);
    for (const outer of [[[13, 41], [15, 41], [15, 43], [13, 41]], rectangle(12, 40, 13, 41)]) {
      expect(() => config(annulus, feature('zone-002', [outer]))).toThrow('overlap or touch');
    }
  });

  it('rejects unsupported geometry and resource growth before target allocation', () => {
    for (const coordinates of [[rectangle(179, 39, -179, 41)], [rectangle(10, 79, 11, 81)], [rectangle(-15, 30, 15, 40)], [[[10, 39], [NaN, 40], [11, 41], [10, 39]]]]) {
      expect(() => config(feature('zone-001', coordinates))).toThrow();
    }
    expect(() => config(...Array.from({ length: 17 }, (_, i) => feature(`zone-${i}`)))).toThrow();
    const coordinates = Array.from({ length: 205 }, (_, i) => [10 + Math.cos(i / 204 * 2 * Math.PI), 40 + Math.sin(i / 204 * 2 * Math.PI)]);
    coordinates[204] = coordinates[0];
    expect(() => config(...Array.from({ length: 5 }, (_, i) => feature(`zone-${i}`, [coordinates])))).toThrow('coordinate budget');
    expect(() => config(feature('zone-001', [Array.from({ length: 257 }, () => [10, 40])]))).toThrow();
    expect(() => planRefinements(config(feature('zone-001')), { ...options, bounds: [170, -55, -170, 65] })).toThrow('nonwrapping');
    for (const sourceGrid of [{ ...GFS_GRID, lat0: 91 }, { ...GFS_GRID, width: 100 }, { ...GFS_GRID, lon0: 170, width: 100, wrapLongitude: false }]) {
      expect(() => planRefinements(config(feature('zone-001')), { ...options, sourceGrid })).toThrow();
    }
    const excessive = config(feature('zone-001', [rectangle(-10, 20, 10, 40)]));
    expect(() => planRefinements(excessive, options)).toThrow('cell budget');
  });
});
