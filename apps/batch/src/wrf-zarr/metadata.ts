import { isDeepStrictEqual } from 'node:util';
import type { ArrayMetadata } from 'zarrita';
import { parseBoundedJson, sameGrid } from '@av/contracts';
import contract from '../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json' with { type: 'json' };
import { runConcurrent } from '../concurrent.js';
import { COORDINATES, type WrfRun } from './ready.js';

/** Validate the sole supported producer layout before decoding any weather arrays. */
export async function validateMetadata(run: WrfRun): Promise<ReadonlyMap<string, ArrayMetadata<'float32'>>> {
  const { receipt } = run, grid = receipt.grid;
  if (grid.kind !== 'lambert-conformal' || grid.earthRadiusM !== contract.earthRadiusM) throw new Error('Unsupported WRF grid');
  const [iy, ix] = contract.innerSpatialChunk, ny = Math.ceil(grid.height / iy!) * iy!, nx = Math.ceil(grid.width / ix!) * ix!;
  if ((ny / iy!) * (nx / ix!) > 256) throw new Error('WRF spatial chunk budget exceeded');
  const metadata = async (name: string) => parseBoundedJson(await run.read(name, 16 * 1024)) as Record<string, unknown>;
  const group = await metadata('zarr.json'), attrs = group.attributes as Record<string, unknown> | undefined;
  if (group.zarr_format !== 3 || group.node_type !== 'group' || !attrs || attrs.schema_id !== contract.schemaId
      || attrs.schema_version !== contract.schemaVersion || attrs.vertical_coordinate !== contract.verticalCoordinate
      || attrs.moisture_source_of_truth !== contract.moistureSourceOfTruth || attrs.temperature_definition !== contract.temperatureDefinition
      || attrs.cape_parcel_definition !== contract.capeParcelDefinition || attrs.low_cloud_definition !== contract.lowCloudDefinition
      || !sameGrid(attrs.grid as typeof grid, grid) || !isDeepStrictEqual(attrs.lead_hours, receipt.lead_hours)) throw new Error('WRF group metadata differs from receipt or wire contract');
  const lengths: Record<string, number> = { time: receipt.lead_hours.length, level: receipt.exported_levels_k, y: grid.height, x: grid.width };
  const arrays = new Map<string, ArrayMetadata<'float32'>>();
  await runConcurrent(contract.fields, 4, async field => {
    const meta = await metadata(`${field.name}/zarr.json`), dims = field.dims;
    const shape = dims.map(dim => lengths[dim]);
    const outer = dims.map(dim => dim === 'time' ? 1 : dim === 'y' ? ny : dim === 'x' ? nx : lengths[dim]);
    const inner = dims.map(dim => dim === 'time' ? 1 : dim === 'y' ? iy : dim === 'x' ? ix : lengths[dim]);
    const required = { zarr_format: 3, node_type: 'array', shape, data_type: 'float32',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: outer } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } }, fill_value: 'NaN', dimension_names: dims,
      codecs: [{ name: 'sharding_indexed', configuration: { chunk_shape: inner, codecs: contract.innerCodecs, index_codecs: contract.indexCodecs, index_location: 'end' } }],
      attributes: { units: field.units, consumer_target: field.target, time_support: field.timeSupport, mantissa_keepbits: field.keepbits } };
    if (!isDeepStrictEqual(meta, required)) throw new Error(`Unsupported WRF array metadata: ${field.name}`);
    arrays.set(field.name, meta as unknown as ArrayMetadata<'float32'>);
  });
  await runConcurrent(COORDINATES, 4, async name => {
    const dim = name.endsWith('_unix_s') ? 'time' : name, count = lengths[dim]!;
    const integer64 = name.endsWith('_unix_s'), spatial = name === 'x' || name === 'y';
    const dataType = integer64 ? 'int64' : spatial ? 'float64' : 'int32', size = integer64 || spatial ? 8 : 4;
    const meta = await metadata(`${name}/zarr.json`);
    if (meta.zarr_format !== 3 || meta.node_type !== 'array' || meta.data_type !== dataType
        || !isDeepStrictEqual(meta.shape, [count]) || !isDeepStrictEqual(meta.dimension_names, [dim])
        || !isDeepStrictEqual(meta.chunk_grid, { name: 'regular', configuration: { chunk_shape: [count] } })
        || !isDeepStrictEqual(meta.chunk_key_encoding, { name: 'default', configuration: { separator: '/' } })
        || !isDeepStrictEqual(meta.codecs, [{ name: 'bytes', configuration: { endian: 'little' } }])) throw new Error(`Unsupported WRF coordinate metadata: ${name}`);
    const bytes = await run.read(`${name}/c/0`, count * size);
    if (bytes.length !== count * size) throw new Error(`WRF coordinate length mismatch: ${name}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) {
      const actual = integer64 ? Number(view.getBigInt64(i * size, true)) : spatial ? view.getFloat64(i * size, true) : view.getInt32(i * size, true);
      const expected = name === 'time' ? receipt.lead_hours[i] : name === 'level' ? i
        : name === 'x' ? grid.x0M + i * grid.dxM : name === 'y' ? grid.y0M + i * grid.dyM
        : Date.parse((name === 'valid_time_unix_s' ? receipt.valid_times_utc : name === 'window_start_unix_s' ? receipt.window_starts_utc : receipt.window_ends_utc)[i]!) / 1000;
      if (actual !== expected) throw new Error(`WRF coordinate differs from receipt: ${name}`);
    }
  });
  return arrays;
}
