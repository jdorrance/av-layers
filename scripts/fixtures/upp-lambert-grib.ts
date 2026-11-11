import { gridToGeographic, type ModelDefinition } from '@av/contracts';
import { cycleStamp, indexedGribCurrentSpecs, indexedGribFileUrl, indexedGribFirstFixedSurface } from '../../apps/batch/src/indexed-grib/fields.js';
import { indexedSource } from '../../apps/batch/src/indexed-grib/source.js';
import type { ObjectStorage } from '../../apps/batch/src/storage.js';
import { sha256 } from '../../apps/batch/src/validate.js';
import { UPP_PRESSURE_LEVELS } from './upp-products.js';
import type { IndexedGribFieldSpec } from '../../apps/batch/src/indexed-grib/types.js';

const values: Readonly<Record<string, number>> = {
  terrain: 100, 'surface-pressure': 100_000, 'temp-2m': 293.15, 'spfh-2m': 0.008,
  'sensible-flux': 250, 'latent-flux': 100, precipitation: 2,
  mslpPa: 101_200, u10mMps: 5, v10mMps: 3, gust10mMps: 8, pblHeightM: 1_500,
  capeJkg: 150, cloudTotalPct: 20, cloudLowPct: 10, uWindMps: 16, vWindMps: 11,
  spfhKgKg: 0.007, omegaPaS: 0.5
};

function section(number: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.writeUInt32BE(length);
  bytes[4] = number;
  return bytes;
}

function timestamp(bytes: Buffer, offset: number, time: Date): void {
  bytes.writeUInt16BE(time.getUTCFullYear(), offset);
  bytes.set([time.getUTCMonth() + 1, time.getUTCDate(), time.getUTCHours(), 0, 0], offset + 2);
}

function microdegrees(value: number): number {
  return (value < 0 ? 0x80000000 : 0) + Math.round(Math.abs(value) * 1e6);
}

function fieldValue(field: IndexedGribFieldSpec): number {
  const level = UPP_PRESSURE_LEVELS.findIndex(pressure => pressure === field.levelHpa);
  if (field.kind === 'height') return [600, 1100, 1600][level]!;
  if (field.kind === 'temperature') return [286.15, 282.15, 281.15][level]!;
  const value = values[field.auxId ?? field.kind];
  if (value === undefined) throw new Error(`No UPP fixture value for ${field.key}`);
  return value;
}

function message(model: ModelDefinition, cycle: string, hour: number, field: IndexedGribFieldSpec): Buffer {
  const grid = model.grid;
  if (grid.kind !== 'lambert-conformal') throw new Error('UPP fixture requires Lambert geometry');
  const points = grid.width * grid.height, source = indexedSource(model);
  const first = gridToGeographic(grid, 0, 0)!;
  const identification = section(1, 21);
  identification.writeUInt16BE(source.upstream.centre, 5);
  identification[9] = 2; identification[10] = 1; identification[11] = 1;
  timestamp(identification, 12, new Date(cycle));
  identification[20] = 1;

  const geometry = section(3, 81);
  geometry.writeUInt32BE(points, 6); geometry.writeUInt16BE(30, 12);
  geometry[14] = grid.earthRadiusM === 6371229 ? 6 : 1;
  if (geometry[14] === 1) geometry.writeUInt32BE(grid.earthRadiusM, 16);
  geometry.writeUInt32BE(grid.width, 30); geometry.writeUInt32BE(grid.height, 34);
  geometry.writeUInt32BE(microdegrees(first.lat), 38);
  geometry.writeUInt32BE(microdegrees(first.lon), 42);
  geometry[46] = 0x38;
  geometry.writeUInt32BE(microdegrees(grid.latitudeOfOriginDeg), 47);
  geometry.writeUInt32BE(microdegrees(grid.centralMeridianDeg), 51);
  geometry.writeUInt32BE(grid.dxM * 1_000, 55); geometry.writeUInt32BE(grid.dyM * 1_000, 59);
  geometry[63] = grid.standardParallel1Deg + grid.standardParallel2Deg < 0 ? 128 : 0;
  geometry[64] = 64;
  geometry.writeUInt32BE(microdegrees(grid.standardParallel1Deg), 65);
  geometry.writeUInt32BE(microdegrees(grid.standardParallel2Deg), 69);

  const instant = field.statistic === 'instant';
  const product = section(4, instant ? 34 : 58);
  product.writeUInt16BE(instant ? 0 : 8, 7);
  const parameter = source.upstream.parameters[field.variable]!;
  product[9] = parameter[0]; product[10] = parameter[1]; product[11] = 2; product[17] = 1;
  product.writeUInt32BE(instant ? hour : hour - 1, 18);
  const [surface, level] = field.fixedSurface ?? indexedGribFirstFixedSurface(field.level);
  product[22] = surface; product.writeUInt32BE(level ?? 0, 24);
  product[28] = 255;
  if (!instant) {
    timestamp(product, 34, new Date(Date.parse(cycle) + hour * 3_600_000));
    product[41] = 1; product[46] = field.statistic === 'mean' ? 0 : 1;
    product[47] = 2; product[48] = 1; product.writeUInt32BE(1, 49); product[53] = 255;
  }

  const representation = section(5, 21), bitmap = section(6, 6), data = section(7, 5);
  representation.writeUInt32BE(points, 5);
  representation.writeFloatBE(fieldValue(field), 11);
  bitmap[5] = 255;
  const parts = [identification, geometry, product, representation, bitmap, data];
  const indicator = Buffer.alloc(16);
  indicator.write('GRIB'); indicator[7] = 2;
  indicator.writeBigUInt64BE(BigInt(20 + parts.reduce((total, part) => total + part.length, 0)), 8);
  return Buffer.concat([indicator, ...parts, Buffer.from('7777')]);
}

function uppFixtureFiles(model: ModelDefinition, cycle: string) {
  const source = indexedSource(model);
  return model.forecast.hours.flatMap(hour => Object.entries(source.upstream.products).map(([product, name]) => {
    const specs = indexedGribCurrentSpecs(source, hour).filter(field => field.product === product);
    const records = specs.map(field => message(model, cycle, hour, field));
    let offset = 0;
    const index = specs.map((field, i) => {
      const line = `${i + 1}:${offset}:d=${cycleStamp(cycle)}:${field.variable}:${field.level}:${field.forecast}:`;
      offset += records[i]!.length;
      return line;
    });
    return { url: indexedGribFileUrl(source, cycle, hour, name), hour, grib: Buffer.concat(records), index: Buffer.from(index.join('\n') + '\n') };
  }));
}

export async function publishUppFixture(store: ObjectStorage, model: ModelDefinition, cycle: string): Promise<void> {
  const files = [];
  for (const { url, grib, index } of uppFixtureFiles(model, cycle)) {
    const key = url.slice('r2://'.length), idxKey = key + '.idx';
    const sha = sha256(grib), idxSha = sha256(index);
    await store.put(key, grib, { ifNoneMatch: '*' }, 'application/x-grib2', undefined, { sha256: sha });
    await store.put(idxKey, index, { ifNoneMatch: '*' }, 'text/plain', undefined, { sha256: idxSha });
    const [gribHead, idxHead] = await Promise.all([store.head(key), store.head(idxKey)]);
    if (!gribHead || !idxHead) throw new Error('Fixture source object is missing');
    files.push({ key, bytes: grib.length, sha256: sha, etag: gribHead.etag,
      idxKey, idxBytes: index.length, idxSha256: idxSha, idxEtag: idxHead.etag });
  }
  const prefix = `upstream/${model.modelId}`;
  const readyKey = `${prefix}/${cycleStamp(cycle).slice(0, 8)}/${cycle.slice(11, 13)}/_ready.json`;
  const ready = Buffer.from(JSON.stringify({ version: 1, model: model.modelId, cycle,
    createdAt: new Date(cycle).toISOString(), hours: model.forecast.hours, files }));
  const digest = sha256(ready);
  await store.put(readyKey, ready, { ifNoneMatch: '*' }, 'application/json', undefined, { sha256: digest });
  const latest = Buffer.from(JSON.stringify({ version: 1, model: model.modelId, cycle, readyKey, readySha256: digest }));
  await store.put(`${prefix}/latest.json`, latest, { ifNoneMatch: '*' }, 'application/json');
}
