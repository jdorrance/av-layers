export * from '@av/solar';
export * from '@av/thermodynamics';
export * from '@av/soaring';

import {
  PRECIPITATION_METHOD_PARAMETERS,
  STATUS_NO_LIFT,
  STATUS_UNAVAILABLE,
  STATUS_VALID,
  SUPPORT_PARCEL_CROSSING,
  SUPPORT_PROFILE_TOP
} from '@av/contracts';
import {
  deriveLift,
  type ColumnDerivationOptions,
  type ColumnInput,
  type DepthBranch
} from '@av/soaring';

export interface ColumnResult {
  msl: { value: number | null; flags: number };
  agl: { value: number | null; flags: number };
  branch: DepthBranch;
  depthM: number | null;
  thermalVelocityMps: number | null;
}

const supportFlags: Record<DepthBranch, number> = {
  'parcel-crossing': SUPPORT_PARCEL_CROSSING,
  'profile-top': SUPPORT_PROFILE_TOP,
  'surface-stable': 0,
  'non-convective': 0,
  unavailable: 0
};

/** Convert a pure lift result to the published MSL/AGL values and support flags. */
export function deriveColumn(
  input: ColumnInput,
  levelCount: number,
  options?: ColumnDerivationOptions
): ColumnResult {
  const result = deriveLift(input, levelCount, options);
  const status = result.status === 'unavailable'
    ? STATUS_UNAVAILABLE
    : result.status === 'no-lift' ? STATUS_NO_LIFT : STATUS_VALID;
  const flags = status | supportFlags[result.branch];
  const msl = result.status === 'unavailable'
    ? null
    : result.status === 'no-lift' ? input.terrainM : input.terrainM + result.usableDepthM;
  return {
    msl: { value: msl, flags },
    agl: { value: result.usableDepthM, flags },
    branch: result.branch,
    depthM: result.depthM,
    thermalVelocityMps: result.thermalVelocityMps
  };
}

/** The adapter has normalized the trailing interval to liquid-equivalent mm/h. */
export function precipitationRateStatus(
  value: number,
  minimumRateMmPerHour: number = PRECIPITATION_METHOD_PARAMETERS.minimumRateMmPerHour
): number {
  return Number.isFinite(value) && value >= minimumRateMmPerHour
    ? STATUS_VALID
    : STATUS_UNAVAILABLE;
}
