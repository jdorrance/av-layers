import { describe, expect, it } from 'vitest';
import { STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, type CoverageMask, type LayerId } from '@av/contracts';
import type { GridField } from '@av/forecast';
import { summarizeFields } from './summary.js';

describe('per-frame scientific summaries', () => {
  it('counts output statuses and support and summarizes valid values only', () => {
    const mask: CoverageMask = { grid: { width: 5, height: 1, lon0: 0, lat0: 0, dx: 1, dy: -1, wrapLongitude: false }, output: new Uint8Array([15]), halo: new Uint8Array([16]), tiles: new Uint8Array(1), maxZoom: 0 };
    const lift: GridField = { values: new Float32Array([100, 300, 999, NaN, 5000]), flags: new Uint8Array([STATUS_VALID | SUPPORT_PARCEL_CROSSING, STATUS_VALID | SUPPORT_PROFILE_TOP, STATUS_NO_LIFT, STATUS_UNAVAILABLE, STATUS_OUTSIDE]) };
    const rain: GridField = { values: new Float32Array([0, 2, NaN, NaN, 99]), flags: new Uint8Array([STATUS_VALID, STATUS_VALID, STATUS_UNAVAILABLE, STATUS_UNAVAILABLE, STATUS_OUTSIDE]) };
    const fields: Record<LayerId, GridField> = { 'usable-lift-msl': lift, 'usable-lift-agl': lift, 'precip-rate': rain };
    const result = summarizeFields(fields, mask);
    expect(result['usable-lift-msl']).toEqual({ valid: 2, noLift: 1, unavailable: 1, outside: 0, parcelCrossing: 1, profileTop: 1, pblClosure: 0, min: 100, max: 300, mean: 200 });
    expect(result['precip-rate']).toEqual({ valid: 2, noLift: 0, unavailable: 2, outside: 0, parcelCrossing: 0, profileTop: 0, pblClosure: 0, min: 0, max: 2, mean: 1 });
    rain.flags.fill(STATUS_UNAVAILABLE);
    expect(summarizeFields(fields, mask)['precip-rate']).toMatchObject({ valid: 0, unavailable: 4, min: null, max: null, mean: null });
  });
});
