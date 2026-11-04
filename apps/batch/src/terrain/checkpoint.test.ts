import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { restoreTerrainCheckpoint, writeTerrainCheckpoint, TERRAIN_CHECKPOINT_CELLS } from './checkpoint.js';
import { TerrainTestStorage } from './test-fixtures.js';

const identity = 'a'.repeat(64), window = { identity, firstCell: 0, count: 3 };
const key = `terrain/checkpoints/${identity}/w0.bin`;
function arrays() {
  const heights = Buffer.alloc(12), valid = Uint8Array.of(1, 0, 1);
  heights.writeFloatLE(4.125, 0); heights.writeFloatLE(-999, 8);
  return { heights, valid };
}

it('restores bounded windows with the original Float32 bytes and validity', async () => {
  const storage = new TerrainTestStorage(), source = arrays(), heights = new Uint8Array(12), valid = new Uint8Array(3);
  await expect(restoreTerrainCheckpoint(storage, window, heights, valid)).resolves.toBe(false);
  await writeTerrainCheckpoint(storage, window, source.heights, source.valid);
  expect(storage.objects.get(key)?.byteLength).toBe(95);
  expect(await restoreTerrainCheckpoint(storage, window, heights, valid)).toBe(true);
  expect(heights).toEqual(new Uint8Array(source.heights)); expect(valid).toEqual(source.valid);
});

it.each(['version', 'identity', 'firstCell', 'count', 'payload', 'truncated'] as const)('rejects %s corruption before hydrating target arrays', async defect => {
  const storage = new TerrainTestStorage(), source = arrays();
  await writeTerrainCheckpoint(storage, window, source.heights, source.valid);
  const bytes = Buffer.from(storage.objects.get(key)!);
  if (defect === 'version') bytes.writeUInt32LE(2, 4);
  else if (defect === 'identity') bytes[8] ^= 1;
  else if (defect === 'firstCell') bytes.writeUInt32LE(TERRAIN_CHECKPOINT_CELLS, 40);
  else if (defect === 'count') bytes.writeUInt32LE(2, 44);
  else bytes[80] ^= 1;
  storage.objects.set(key, defect === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes);
  const heights = new Uint8Array(12).fill(7), valid = new Uint8Array(3).fill(7);
  await expect(restoreTerrainCheckpoint(storage, window, heights, valid)).rejects.toThrow(/checkpoint/);
  expect([...heights]).toEqual(Array(12).fill(7)); expect([...valid]).toEqual(Array(3).fill(7));
});

it.each(['nonfinite', 'mask', 'invalid-value'] as const)('rejects a valid payload digest containing %s cells', async defect => {
  const storage = new TerrainTestStorage(), source = arrays();
  await writeTerrainCheckpoint(storage, window, source.heights, source.valid);
  const bytes = Buffer.from(storage.objects.get(key)!);
  if (defect === 'nonfinite') bytes.writeFloatLE(Infinity, 80);
  else if (defect === 'mask') bytes[92] = 2;
  else bytes[92] = 0;
  createHash('sha256').update(bytes.subarray(80)).digest().copy(bytes, 48);
  storage.objects.set(key, bytes);
  await expect(restoreTerrainCheckpoint(storage, window, new Uint8Array(12), new Uint8Array(3))).rejects.toThrow('Invalid terrain checkpoint cell');
});

it('requires the single-PUT content digest and canonical window bounds', async () => {
  const storage = new TerrainTestStorage(), source = arrays();
  await writeTerrainCheckpoint(storage, window, source.heights, source.valid);
  vi.spyOn(storage, 'get').mockResolvedValue({ bytes: storage.objects.get(key)!, etag: 'unverified' });
  await expect(restoreTerrainCheckpoint(storage, window, new Uint8Array(12), new Uint8Array(3))).rejects.toThrow('content digest');
  for (const value of [{ ...window, identity: 'wrong' }, { ...window, firstCell: 1 }, { ...window, count: TERRAIN_CHECKPOINT_CELLS + 1 }]) {
    await expect(writeTerrainCheckpoint(storage, value, source.heights, source.valid)).rejects.toThrow('Invalid terrain checkpoint window');
  }
  await expect(writeTerrainCheckpoint(storage, { ...window, count: 4 }, source.heights, source.valid)).rejects.toThrow('exceeds target arrays');
});
