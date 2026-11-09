import { convertQuantity, type UnitSystem } from './windgram-format.ts';

/** WxToFly's local lapse-rate scale, in °C per 1,000 ft.
 * Physical boundaries follow the published legend; colors use the normalized
 * WxToFly palette:
 * http://wxtofly.net/images/locallapserates.png
 * The −0.5 tick lies inside the single −1.2 to 0 stable-purple band.
 */
export const WINDGRAM_STABILITY = [
  { className: 'very-unstable', maxLapse: -3, color: '#ff4444' },
  { className: 'unstable', maxLapse: -2.5, color: '#ff9900' },
  { className: 'conditional-strong', maxLapse: -2, color: '#ffbbff' },
  { className: 'conditional', maxLapse: -1.5, color: '#ccbbff' },
  { className: 'near-neutral', maxLapse: -1.2, color: '#ffeeee' },
  { className: 'stable', maxLapse: 0, color: '#7777dd' },
  { className: 'inverted', maxLapse: .5, color: '#cccccc' },
  { className: 'strong-inversion', maxLapse: Infinity, color: '#999999' },
] as const;

export const WINDGRAM_STABLE_COLOR = WINDGRAM_STABILITY[5].color;

/** Display boundaries only; the source scale and classification remain physical. */
export function stabilityRange(index: number, system: UnitSystem): string {
  const value = (n: number) => Number(convertQuantity(n, 'lapseRate', system)!.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 }).replace('-', '−');
  if (index === 0) return `≤ ${value(WINDGRAM_STABILITY[0].maxLapse)}`;
  if (index === WINDGRAM_STABILITY.length - 1) return `> ${value(WINDGRAM_STABILITY[index - 1].maxLapse)}`;
  return `${value(WINDGRAM_STABILITY[index - 1].maxLapse)} to ${value(WINDGRAM_STABILITY[index].maxLapse)}`;
}
