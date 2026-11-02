# Extending the project

Start with [development](development.md). GFS and the three existing scalar
layers are the current scope. Use synthetic data to test an extension before
connecting a new weather source.

## Change settings

- Edit [GFS settings](../packages/contracts/config/gfs.json) for forecast hours,
  pressure levels, grid, coverage, and freshness rules.
- Edit [methods](../packages/contracts/src/methods.ts) for calculation parameters
  and input definitions. Keep formulas in [forecast](../packages/forecast/README.md).
- Edit [capacity](../apps/batch/src/capacity.ts) for build limits, with measured
  evidence for any increase. Run `pnpm capacity` before a larger build.
- Edit [Wrangler settings](../apps/api/wrangler.json) for deployment bindings.
  Workflow setup reads the Node and pnpm versions from the root package.

After a grid or coverage change, run `pnpm masks:build` and build a new forecast.
Changes to calculations, layers, or timing also require fresh forecast files.
Run `pnpm verify` before deployment.

## Add a source adapter

[ForecastProvider](../apps/batch/src/providers.ts) is the source boundary. Its
session opens with the required native cell indices, acquires one frame, and
closes even after failure. Keep source discovery, downloads, file decoding, and
source-specific conversions inside the adapter.

Return a [NormalizedFrame](../packages/forecast/src/inputs.ts) with the requested
indices in exactly the same order. Inputs declare their units and missing-value
arrays. In particular, surface pressure is Pa, temperatures are K, humidity is
kg/kg, heights are metres, fluxes are upward W/m², and precipitation is mm/h.
Pressure levels are descending hPa. Do not turn missing inputs into zero.

Record how source times, interval averages, accumulated rain, height references,
and signs become those normalized inputs. Validate the conversions against an
independent decoder and representative real files before enabling the adapter.

Add its product definition to [products.ts](../packages/contracts/src/products.ts)
and its provider binding to [providers.ts](../apps/batch/src/providers.ts).
`modelId` identifies the public catalog and URLs; `source` separately identifies
the upstream family, configuration, and domain. Two domains can share a family.
Each product declares its own grid, frames, layers, and coverage.

The [synthetic provider](../scripts/fixtures/normalized-provider.ts) and
[native build test](../apps/batch/src/native-build.integration.test.ts) are working
examples. They run the actual calculations, packing, rendering, and validation
with different grids and frame/layer selections:

```sh
pnpm test apps/batch/src/native-build.integration.test.ts
pnpm dev --generate-only
```

Cover missing data, invalid intervals, wrong array dimensions, cancellation,
cleanup, and the maximum working set. Check source rights and attribution before
adding a live source. Keep test-only products outside the production registry.

## Add a scalar calculation

Define its layer, units, height reference, time interval, missing-value behavior,
palette, and interpolation rules in [layers.ts](../packages/contracts/src/layers.ts).
Declare required inputs and numeric parameters in
[methods.ts](../packages/contracts/src/methods.ts). Give a changed scientific
method its own identifier.

Implement the pure calculation in [forecast](../packages/forecast/README.md)
and connect it once in [frame.ts](../packages/forecast/src/frame.ts). Products
choose their layer subset. Shared calculations should produce related outputs
together, as the existing MSL and AGL lift layers do.

Test independent expected values and flags, then point results and legends.
Account for added input arrays, output channels, tile count, and point-read size.
The stored build includes its method and display definitions, so a later code
change cannot silently relabel its values.

## Add a grid or neighboring-cell calculation

[geometry.ts](../packages/contracts/src/geometry.ts) supports regular
latitude/longitude and spherical Lambert grids. The
[Lambert fixture](../packages/contracts/src/fixtures/lambert.json) supplies
independent PROJ control points. Extend geometry with independent fixtures for
its Earth model, projection, signed axes, and longitude wrapping.

Use [support.ts](../packages/forecast/src/support.ts) to plan the cells each
input needs. Interpolation and a derivative may need different neighbors.
Offsets are grid cells; a physical derivative also needs local distances and
the correct vector basis. Missing off-domain support makes the result unavailable.

Keep public coverage, calculation support, stored sample blocks, and tile
coverage distinct. Write masks through [coverage.ts](../apps/batch/src/coverage.ts).
Test boundaries, seams, padding, hash checks, and agreement between tile and
point sampling. Recheck capacity before acquiring data.

## Deferred work

Profiles need explicit vertical coordinates, pressure, missing-value encoding,
error tolerances, storage layout, and point-query limits. The current scalar
format is not a profile format.

WRF needs independent fixtures for staggered grids, pressure and temperature
conversion, geopotential height, flux signs, accumulated-rain resets, and wind
rotation. Its native pressure can vary by column; extend the input contract for
that case. Define nested or moving domains and terrain references explicitly.
Use [NCAR's field definitions](https://www2.mmm.ucar.edu/wrf/site/documentation/users_guide/output_variables.html)
when implementing those conversions. See [roadmap](roadmap.md) for the deferred
models and products.

## Alpha deployments

There is no compatibility layer for discarded alpha formats. For a format
change, rebuild data and deploy the matching publisher, API, and clients.
Rollback must restore a compatible code-and-data set. Follow
[operations](operations.md), then check metadata, point results, and rendered
tiles in both clients.
