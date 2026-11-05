/** Fixed-width native columns; model terrain and all heights use metres MSL. */
import { MAX_PROFILE_LEVELS, PROFILE_HEADER_BYTES, PROFILE_LEVEL_BYTES, PROFILE_OMEGA_UNITS_PER_PA_S, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts';

const MISSING = -32768;
const VERSION = 1;

/** Known coordinates stay ordered across null row gaps. */
export interface ProfileLevel {
  readonly pressureHpa: number | null;
  readonly heightM: number | null;
  readonly temperatureC: number | null;
  readonly dewPointC: number | null;
  readonly uWindMps: number | null;
  readonly vWindMps: number | null;
  readonly omegaPaS: number | null;
}

export interface NativeProfile {
  readonly modelTerrainM: number | null;
  readonly surfacePressureHpa: number | null;
  /** Missing ground leaves the column unavailable while independent row measurements survive. */
  readonly status: 'valid' | 'unavailable' | 'outside-domain';
  readonly levels: readonly ProfileLevel[];
}

/** Every selected row retains its independently known measurements. */
export type ProfileLevelInput = ProfileLevel;
export interface NativeProfileInput extends Omit<NativeProfile, 'levels' | 'surfacePressureHpa'> {
  readonly surfacePressureHpa?: number | null;
  readonly levels: readonly ProfileLevelInput[];
}

export function profileRecordBytes(maxLevels: number): number {
  if (!Number.isSafeInteger(maxLevels) || maxLevels < 1 || maxLevels > MAX_PROFILE_LEVELS) throw new RangeError('Invalid profile level capacity');
  return PROFILE_HEADER_BYTES + maxLevels * PROFILE_LEVEL_BYTES;
}

function viewOf(bytes: Uint8Array): { view: DataView; capacity: number } {
  const capacity = (bytes.byteLength - PROFILE_HEADER_BYTES) / PROFILE_LEVEL_BYTES;
  if (profileRecordBytes(capacity) !== bytes.byteLength) throw new RangeError('Invalid profile record bytes');
  return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), capacity };
}

function quantize(value: number, scale: number, min = -32767, max = 32767): number {
  const encoded = Math.round(value * scale);
  if (!Number.isFinite(value) || !Number.isSafeInteger(encoded) || encoded < min || encoded > max) throw new RangeError('Profile value exceeds its encoded range');
  return encoded;
}

/** Header: terrain i16, count u16, status u8, version u8, surface pressure u16 in 0.1 hPa (0 missing). */
export function writeProfileRecord(bytes: Uint8Array, profile: NativeProfileInput): void {
  const { view, capacity } = viewOf(bytes);
  if (!Array.isArray(profile.levels) || profile.levels.length > capacity) throw new RangeError('Profile exceeds level capacity');
  const status = profile.status === 'valid' ? STATUS_VALID : profile.status === 'unavailable' ? STATUS_UNAVAILABLE : profile.status === 'outside-domain' ? STATUS_OUTSIDE : -1;
  if (status < 0 || (status === STATUS_UNAVAILABLE && profile.modelTerrainM !== null && profile.levels.length > 0)
    || (status === STATUS_OUTSIDE && (profile.levels.length > 0 || profile.modelTerrainM !== null || profile.surfacePressureHpa != null))
    || (status === STATUS_VALID && profile.modelTerrainM === null)) throw new RangeError('Invalid profile status or terrain');
  const terrain = profile.modelTerrainM === null ? MISSING : quantize(profile.modelTerrainM, 1);
  bytes.fill(0);
  view.setInt16(0, terrain, true);
  view.setUint8(4, status);
  view.setUint8(5, VERSION);
  view.setUint16(6, profile.surfacePressureHpa == null ? 0 : quantize(profile.surfacePressureHpa, 10, 1, 65535), true);
  let count = 0, previousHeight = Number.NEGATIVE_INFINITY, previousPressure = Number.POSITIVE_INFINITY;
  for (const level of profile.levels) {
    const pressure = level.pressureHpa === null ? 0 : quantize(level.pressureHpa, 10, 1, 65535);
    const height = level.heightM === null ? MISSING : quantize(level.heightM, 1);
    const temperature = level.temperatureC === null ? MISSING : quantize(level.temperatureC, 100);
    if ((height !== MISSING && ((terrain !== MISSING && height < terrain) || height <= previousHeight))
      || (pressure !== 0 && pressure >= previousPressure)) throw new RangeError('Profile levels require ascending heights and descending pressures');
    const offset = PROFILE_HEADER_BYTES + count * PROFILE_LEVEL_BYTES;
    view.setUint16(offset, pressure, true);
    view.setInt16(offset + 2, height, true);
    view.setInt16(offset + 4, temperature, true);
    view.setInt16(offset + 6, level.dewPointC === null ? MISSING : quantize(level.dewPointC, 100), true);
    view.setInt16(offset + 8, level.uWindMps === null ? MISSING : quantize(level.uWindMps, 100), true);
    view.setInt16(offset + 10, level.vWindMps === null ? MISSING : quantize(level.vWindMps, 100), true);
    view.setInt16(offset + 12, level.omegaPaS === null ? MISSING : quantize(level.omegaPaS, PROFILE_OMEGA_UNITS_PER_PA_S), true);
    if (height !== MISSING) previousHeight = height;
    if (pressure !== 0) previousPressure = pressure;
    count++;
  }
  view.setUint16(2, count, true);
  if (status === STATUS_VALID && !count) view.setUint8(4, STATUS_UNAVAILABLE);
}

function readRecord(bytes: Uint8Array, decode: boolean): NativeProfile | undefined {
  const { view, capacity } = viewOf(bytes);
  const terrain = view.getInt16(0, true), count = view.getUint16(2, true), status = view.getUint8(4), pressure = view.getUint16(6, true);
  if (view.getUint8(5) !== VERSION || count > capacity
    || (status !== STATUS_VALID && status !== STATUS_UNAVAILABLE && status !== STATUS_OUTSIDE)
    || (status === STATUS_VALID && (count === 0 || terrain === MISSING))
    || (status === STATUS_UNAVAILABLE && terrain !== MISSING && count > 0)
    || (status === STATUS_OUTSIDE && (count > 0 || terrain !== MISSING || pressure !== 0))) throw new RangeError('Invalid profile header');
  const levels: ProfileLevel[] | undefined = decode ? [] : undefined;
  let previousHeight = Number.NEGATIVE_INFINITY, previousPressure = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const offset = PROFILE_HEADER_BYTES + i * PROFILE_LEVEL_BYTES;
    const pressure = view.getUint16(offset, true), height = view.getInt16(offset + 2, true), temperature = view.getInt16(offset + 4, true);
    if ((height !== MISSING && ((terrain !== MISSING && height < terrain) || height <= previousHeight))
      || (pressure !== 0 && pressure >= previousPressure)) throw new RangeError('Invalid profile level');
    if (levels) {
      const optional = (position: number, scale: number): number | null => {
        const value = view.getInt16(offset + position, true);
        return value === MISSING ? null : value / scale;
      };
      levels.push({ pressureHpa: pressure ? pressure / 10 : null, heightM: height === MISSING ? null : height, temperatureC: temperature === MISSING ? null : temperature / 100,
        dewPointC: optional(6, 100), uWindMps: optional(8, 100), vWindMps: optional(10, 100), omegaPaS: optional(12, PROFILE_OMEGA_UNITS_PER_PA_S) });
    }
    if (height !== MISSING) previousHeight = height;
    if (pressure !== 0) previousPressure = pressure;
  }
  for (let offset = PROFILE_HEADER_BYTES + count * PROFILE_LEVEL_BYTES; offset < bytes.byteLength; offset++) {
    if (bytes[offset] !== 0) throw new RangeError('Invalid profile padding');
  }
  if (levels) return { modelTerrainM: terrain === MISSING ? null : terrain, surfacePressureHpa: pressure ? pressure / 10 : null,
    status: status === STATUS_VALID ? 'valid' : status === STATUS_UNAVAILABLE ? 'unavailable' : 'outside-domain', levels };
}

/** Validate without allocating decoded levels. */
export function validateProfileRecord(bytes: Uint8Array): void { readRecord(bytes, false); }

export function readProfileRecord(bytes: Uint8Array): NativeProfile { return readRecord(bytes, true)!; }
