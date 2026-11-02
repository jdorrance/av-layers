# Forecast calculations

`@av/forecast` calculates usable lift and samples forecast grids. The batch
renderer and point API use the same rules for values, missing data, and coverage.
This package does not download data or read storage.

Follow the [root setup instructions](../../README.md#quick-start), then run from
the repository root:

```sh
pnpm test packages/forecast
pnpm verify
```

This package exports TypeScript directly; the apps build it with their own code.

Useful files:

- [src/science.ts](src/science.ts): lift and precipitation calculations.
- [src/inputs.ts](src/inputs.ts): normalized input arrays and their checks.
- [src/frame.ts](src/frame.ts): unit conversion and whole-frame calculations.
- [src/sampler.ts](src/sampler.ts): samples at geographic coordinates.
- [src/sample-pack.ts](src/sample-pack.ts): numeric file layout and encoding.
- [src/support.ts](src/support.ts): neighboring cells needed by calculations.

Input meanings and calculation parameters come from [contracts](../contracts/README.md).
Read [the science guide](../../docs/science.md) before changing calculations, and
[the data guide](../../docs/data.md) for the meaning of the results.
