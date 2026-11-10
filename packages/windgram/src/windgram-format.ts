// Unit conversions and formatting shared by the charts and readouts.

export type { UnitSystem } from '@av/contracts/client';
import type { UnitSystem } from '@av/contracts/client';
import { FEET_PER_MINUTE_TO_MPS, KNOTS_PER_MPS } from '@av/soaring';

const METRES_PER_FOOT = 0.3048;
const FEET_PER_METRE = 1 / METRES_PER_FOOT;
export const METRES_PER_THOUSAND_FEET = 1000 * METRES_PER_FOOT;
const FPM_PER_MPS = 1 / FEET_PER_MINUTE_TO_MPS;

export const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
export const svgNumber = (value: number) => Number(value.toFixed(2));

export const knotsToMps = (knots: number): number => knots / KNOTS_PER_MPS;
export const mpsToKnots = (mps: number): number => mps * KNOTS_PER_MPS;
export const celsiusToFahrenheit = (celsius: number): number => (celsius * 9) / 5 + 32;
export const fahrenheitToCelsius = (fahrenheit: number): number => (fahrenheit - 32) / 1.8;

export function finiteScalar(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const quantityDefinitions = {
  // Inputs remain physical values: metres, kilometres, Celsius, m/s, mm, hPa,
  // and the source windgram lapse gradient in Celsius per 1,000 feet.
  elevation: { imperial: [FEET_PER_METRE, 0, 'ft', 0], metric: [1, 0, 'm', 0] },
  temperature: { imperial: [1.8, 32, '°F', 0], metric: [1, 0, '°C', 0] },
  wind: { imperial: [KNOTS_PER_MPS, 0, 'kt', 1], metric: [1, 0, 'm/s', 1] },
  lift: { imperial: [FPM_PER_MPS, 0, 'ft/min', 0], metric: [1, 0, 'm/s', 2] },
  rainRate: { imperial: [1 / 25.4, 0, 'in/h', 2], metric: [1, 0, 'mm/h', 1] },
  pressure: { imperial: [1 / 33.8638866667, 0, 'inHg', 2], metric: [1, 0, 'hPa', 0] },
  lapseRate: { imperial: [1.8, 0, '°F/1,000 ft', 1], metric: [1000 / METRES_PER_THOUSAND_FEET, 0, '°C/km', 1] },
} as const;

type QuantityKind = keyof typeof quantityDefinitions;
export const unitLabel = (kind: QuantityKind, system: UnitSystem): string => quantityDefinitions[kind][system][2];
const defaultQuantityDigits = (kind: QuantityKind, system: UnitSystem): number => quantityDefinitions[kind][system][3];

export function convertQuantity(value: number | null | undefined, kind: QuantityKind, system: UnitSystem): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const [scale, offset] = quantityDefinitions[kind][system];
  return value * scale + offset;
}

export function formatQuantity(value: number | null | undefined, kind: QuantityKind, digits: number | undefined, system: UnitSystem): string {
  const converted = convertQuantity(value, kind, system);
  if (converted === null) return '—';
  const precision = digits ?? defaultQuantityDigits(kind, system);
  const label = converted.toLocaleString('en-US', { maximumFractionDigits: precision, minimumFractionDigits: precision });
  return `${label} ${unitLabel(kind, system)}`;
}

/** The gust class a forecast document declares (`semantics.gust`); absence means the document predates the tag. */
export type GustSemantics = 'hourMax' | 'instant';

/** Noun for a surface gust reading from the document's declaration; defaults to "gust". */
export function gustNoun(semantics: GustSemantics | null | undefined): string {
  if (semantics === 'hourMax') return 'hour-max gust';
  if (semantics === 'instant') return 'gust sample';
  return 'gust';
}
