import { STATUS_MASK, STATUS_NO_LIFT, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from '@av/contracts';
import { usableLiftDepthM } from '@av/soaring/velocity';
import { FRAME_BRANCH, type FrameDiagnostics } from './frame.js';

export function clearanceCell(diagnostics: FrameDiagnostics, sourceFlags: Uint8Array, indices: Uint32Array,
  weights: Float64Array, offset: number, count: number, elevation: number,
  result: { msl: number; agl: number; flags: number }, donorIndices?: Uint32Array): boolean {
  let support = 0, ceiling = 0, buoyancy = 0, branches = 0;
  for (let contributor = 0; contributor < count; contributor++) {
    const position = offset + contributor, slot = indices[position]!;
    const sourceIndex = donorIndices ? donorIndices[slot]! : slot;
    const flag = sourceFlags[sourceIndex]!, nextStatus = flag & STATUS_MASK;
    const value = diagnostics.ceilingMslM[sourceIndex]!, b = diagnostics.buoyancyM2S3[sourceIndex]!;
    const branch = diagnostics.branch[sourceIndex];
    const zeroDepth = branch === FRAME_BRANCH.nonConvective || branch === FRAME_BRANCH.surfaceStable;
    const convective = branch === FRAME_BRANCH.parcelCrossing || branch === FRAME_BRANCH.profileTop;
    if (nextStatus >= STATUS_UNAVAILABLE || (flag & ~(STATUS_MASK | SUPPORT_MASK)) !== 0 ||
        (!zeroDepth && !convective) || (zeroDepth && (nextStatus !== STATUS_NO_LIFT || b !== 0)) ||
        !Number.isFinite(value) || !Number.isFinite(b) || b < 0) return false;
    branches |= zeroDepth ? 1 : 2;
    support |= flag & SUPPORT_MASK;
    ceiling += value * weights[position]!;
    buoyancy += b * weights[position]!;
  }
  if (branches === 3 || branches === 0) return false;
  if (branches === 1) {
    result.msl = elevation; result.agl = 0; result.flags = STATUS_NO_LIFT | support;
    return true;
  }
  const depth = Math.max(0, ceiling - elevation);
  const velocity = Math.cbrt(buoyancy * depth);
  if (!Number.isFinite(depth) || !Number.isFinite(velocity)) return false;
  const agl = Math.fround(usableLiftDepthM(depth, velocity) ?? 0);
  const msl = Math.fround(elevation + agl);
  if (!Number.isFinite(agl) || !Number.isFinite(msl)) return false;
  result.msl = msl; result.agl = agl; result.flags = (agl > 0 ? STATUS_VALID : STATUS_NO_LIFT) | support;
  return true;
}
