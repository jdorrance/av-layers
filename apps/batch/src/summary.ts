import { getBit, LAYER_IDS, STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_PARCEL_CROSSING, SUPPORT_PBL_CLOSURE, SUPPORT_PROFILE_TOP, type CoverageMask, type LayerId } from '@av/contracts';
import type { GridField } from '@av/forecast';

export function summarizeFields(fields: Record<LayerId, GridField>, mask: CoverageMask) {
  return Object.fromEntries(LAYER_IDS.map(layer => {
    const field = fields[layer];
    const counts = { valid: 0, noLift: 0, unavailable: 0, outside: 0, parcelCrossing: 0, profileTop: 0, pblClosure: 0 };
    let min = Infinity, max = -Infinity, total = 0;
    for (let i = 0; i < mask.grid.width * mask.grid.height; i++) {
      if (!getBit(mask.output, i)) continue;
      const flags = field.flags[i], status = flags & STATUS_MASK;
      if (status === STATUS_VALID) {
        const value = field.values[i];
        if (!Number.isFinite(value)) throw new Error(`Non-finite valid sample in ${layer}`);
        counts.valid++; min = Math.min(min, value); max = Math.max(max, value); total += value;
      } else if (status === STATUS_NO_LIFT) counts.noLift++;
      else if (status === STATUS_UNAVAILABLE) counts.unavailable++;
      else if (status === STATUS_OUTSIDE) counts.outside++;
      if (flags & SUPPORT_PARCEL_CROSSING) counts.parcelCrossing++;
      if (flags & SUPPORT_PROFILE_TOP) counts.profileTop++;
      if (flags & SUPPORT_PBL_CLOSURE) counts.pblClosure++;
    }
    return [layer, { ...counts, min: counts.valid ? min : null, max: counts.valid ? max : null, mean: counts.valid ? total / counts.valid : null }];
  }));
}
