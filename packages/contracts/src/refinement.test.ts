import { describe, expect, it } from 'vitest';
import configuredZones from '../config/refinement.json';
import { GFS_GRID, ICON_EU_GRID } from './products.js';
import { prepareGridGeometry, type GeographicBounds } from './geometry.js';
import { containsRefinement, parseRefinementConfig, planRefinements, REFINEMENT_SPACING_M } from './refinement.js';

const rectangle = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const feature = (id: string, coordinates = [rectangle(10, 39, 12, 41)]) => ({ type: 'Feature', id, properties: {}, geometry: { type: 'Polygon', coordinates } });
const config = (...features: ReturnType<typeof feature>[]) => parseRefinementConfig({ type: 'FeatureCollection', features });
const options = { sourceGrid: GFS_GRID, bounds: [-180, -55, 180, 65] as GeographicBounds, haloCells: 1 };

describe('configured refinement geometry', () => {
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
