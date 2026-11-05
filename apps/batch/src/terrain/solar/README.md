# Solar terrain

Build sunlight normals, horizons and 3D relief from bounded GLO-90 windows.

```ts
const domain = domainOf(site, options);
const coarse = await readSolarElevationGrid(reader, expandBounds(domain.bounds, 20_000));
const build = startSolarTerrain(site, { ...options, coarse, sources });
for (const block of build.blocks) {
  const fine = await readSolarElevationGrid(reader, expandBounds(block.bounds, FINE_MARGIN_M));
  for (const tile of build.addBlock(block, fine)) await publish(tile);
}
const { index, relief } = build.finish();
```

[index.ts](index.ts) owns the builder entry; [glo90.ts](glo90.ts) reads native-scale
nodes in existing terrain batches. Source IDs include the pinned catalog data
identity. [Solar contracts](../../../../../packages/contracts/src/solar-terrain.ts)
own format, asset digests and index validation. Index publication follows verified
immutable tiles and relief. HTTP serves stored gzip-file bytes.

[parity.json](parity.json) records the original Windgrams whole-domain builder's
flat, plane, ridge, missing-data and block-seam outputs. Tests compare compressed
tile and relief hashes, launch physics and legacy index fields against that
independent implementation. Irradiance lives in
[@av/solar](../../../../../packages/solar/README.md).

```sh
pnpm test apps/batch/src/terrain/solar packages/solar
```
