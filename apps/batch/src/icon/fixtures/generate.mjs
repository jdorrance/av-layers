import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const levels = Array.from({ length: 30 }, (_, i) => 45 + i);
const halfLevels = [...levels, 75];
const cells = [
  { index: 100, id: 'icon-eu-78-100', latitude: 40, longitude: 44.5, terrainM: 1000 },
  { index: 101, id: 'icon-eu-78-101', latitude: 39.5, longitude: 45, terrainM: 1200 },
  { index: 102, id: 'icon-eu-78-102', latitude: 40.5, longitude: 45.5, terrainM: 900 },
];
const source = (field, hour, level) => ({
  sourceKind: 'fixture',
  url: `fixture://icon/${field}/${hour}/${level === null ? 'surface' : level}`,
  sha256: null,
  bytes: null,
  range: null,
  lastModified: null,
});
const names = { CLAT: 'CLAT', CLON: 'CLON', HSURF: 'HSURF', HHL: 'HHL', T_2M: '2t', TD_2M: '2d', PS: 'sp', MH: 'mld', ASHFL_S: 'avg_ishf', ALHFL_S: 'avg_slhtf', TOT_PREC: 'tp', P: 'pres', T: 't' };
const record = (field, hour, level, metadata, values) => ({
  field,
  hour,
  level,
  metadata: { shortName: names[field], units: '', stepType: 'instant', startHour: hour, endHour: hour, packingError: 0.01,
    gridType: 'unstructured_grid', numberOfDataPoints: 1000, numberOfGridUsed: 78, uuidOfHGrid: 'abcdef0123456789abcdef0123456789',
    dataDate: 20261030, dataTime: 0, validityDate: 20261030, validityTime: hour * 100,
    ...(level === null ? {} : { typeOfFirstFixedSurface: 150, scaleFactorOfFirstFixedSurface: 0, scaledValueOfFirstFixedSurface: level }), ...metadata },
  values,
  source: source(field, hour, level),
});
const records = {};
const add = (field, hour, level, metadata, values) => {
  records[`${field}:${hour}:${level === null ? 'None' : level}`] = record(field, hour, level, metadata, values);
};
add('CLAT', 0, null, { units: 'degrees_north', startHour: 0, endHour: 0 }, cells.map((c) => c.latitude));
add('CLON', 0, null, { units: 'degrees_east', startHour: 0, endHour: 0 }, cells.map((c) => c.longitude));
add('HSURF', 0, null, { units: 'm', startHour: 0, endHour: 0 }, cells.map((c) => c.terrainM));
for (const level of halfLevels) {
  add('HHL', 0, level, { units: 'm', startHour: 0, endHour: 0 }, cells.map((c) => c.terrainM + (75 - level) * 500));
}
for (const [hour, temperature, dewPoint, pressure, pbl, sensible, latent, precipitation] of [
  [3, 293.15, 283.15, 90000, 1200, 300, 200, 1.5],
  [6, 294.15, 284.15, 89900, 1300, 200, 100, 4.0],
]) {
  add('T_2M', hour, null, { units: 'K', startHour: hour, endHour: hour }, cells.map(() => temperature));
  add('TD_2M', hour, null, { units: 'K', startHour: hour, endHour: hour }, cells.map(() => dewPoint));
  add('PS', hour, null, { units: 'Pa', startHour: hour, endHour: hour }, cells.map(() => pressure));
  add('MH', hour, null, { units: 'm', startHour: hour, endHour: hour }, cells.map(() => pbl));
  add('ASHFL_S', hour, null, { units: 'W m**-2', stepType: 'avg', startHour: 0, endHour: hour }, cells.map(() => sensible));
  add('ALHFL_S', hour, null, { units: 'W m**-2', stepType: 'avg', startHour: 0, endHour: hour }, cells.map(() => latent));
  add('TOT_PREC', hour, null, { units: 'kg m**-2', stepType: 'accum', startHour: 0, endHour: hour }, cells.map(() => precipitation));
  for (const level of levels) {
    const above = (75 - level - 0.5) * 500;
    const pressureLevel = 100000 * Math.exp(-above / 8000);
    add('P', hour, level, { units: 'Pa', startHour: hour, endHour: hour }, cells.map((c) => Math.round(pressureLevel + (1200 - c.terrainM) * 0.5)));
    add('T', hour, level, { units: 'K', startHour: hour, endHour: hour }, cells.map(() => 288.15 - 0.0065 * above + (hour === 6 ? 1 : 0)));
  }
}
const fixture = {
  model: 'icon-eu',
  referenceTime: '2026-10-30T00:00:00Z',
  levels,
  forecastHours: [3, 6],
  intervalHours: 3,
  bbox: { west: 43.25, south: 38.5, east: 46.75, north: 41.5 },
  grid: { type: 'icon-native-triangular', uuid: 'abcdef0123456789abcdef0123456789', number: 78, pointCount: 1000 },
  cells,
  records,
  provenance: {
    provider: 'synthetic fixture',
    accessProduct: 'fixture://icon/',
    attribution: 'Synthetic test data',
    sourceSynthetic: true,
    publicationReady: false,
    capturedAt: '2026-10-30T01:30:00Z',
  },
};
writeFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'icon-armenia-extract.json'), `${JSON.stringify(fixture, null, 2)}\n`);
