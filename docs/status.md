# Deployments

Live applications: [production map](https://windy-av-preview.pages.dev/),
[Windy plugin](https://www.windy.com/dev/windy-av-preview.pages.dev/windy-plugin/plugin.min.js),
and [API documentation](https://windy-av-api-production.jdorrance.workers.dev/docs).

The API model catalog lists published models. Each expanded latest-build response
supplies its build ID, cycle, frame times, coverage and calculation methods.
These records identify the forecast displayed by the clients.

The [Actions history](https://github.com/jdorrance/av-layers/actions) records
verification, deployments, forecasts and terrain imports. Forecast manifests
record elapsed time, peak memory and capacity accounting. Follow
[operations](operations.md) for retry, resume, rollback and publication checks.

The environment's `TERRAIN_CATALOG_REF` pins the DEM catalog for configured
refinement polygons. Retained builds preserve their original terrain and
method references. The [terrain guide](../apps/batch/src/terrain/README.md)
covers import and preparation; [science](science.md) describes the calculations.
