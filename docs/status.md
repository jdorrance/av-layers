# Deployments

Open the [production map](https://windy-av-preview.pages.dev/),
[Windy plugin](https://www.windy.com/dev/windy-av-preview.pages.dev/windy-plugin/plugin.min.js),
or [API documentation](https://windy-av-api-production.jdorrance.workers.dev/docs).

The API's model catalog lists available models. A model's expanded latest-build
response supplies its build ID, cycle, frame times, coverage and method
descriptors. Use those immutable records to identify what the map is displaying;
the deployed code revision and a forecast's producer revision can differ.

The [Actions history](https://github.com/jdorrance/av-layers/actions) records
code verification, deployments, forecasts and terrain imports. Forecast jobs
retain run summaries and failure diagnostics; completed forecast manifests
record elapsed time, peak memory and capacity accounting. The
[operations guide](operations.md) covers retrying failed jobs, resuming complete
artifacts, rollback and publication checks.

Terrain has its own immutable catalog and preparation cache. The environment's
`TERRAIN_CATALOG_REF` pins the catalog used for configured refinement polygons.
Changing that reference affects future builds; retained forecasts keep their
recorded terrain and method identities. Follow the
[terrain guide](../apps/batch/src/terrain/README.md) for import and preparation.

The software is in alpha. Automated checks establish format, calculation and
operational behavior; forecast accuracy needs comparison with observations.
The [science guide](science.md) describes the implemented calculations and their
limits, and the [roadmap](roadmap.md) describes other products.
