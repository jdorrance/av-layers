# Project status

The project is in alpha. GFS is the only supported live model. It provides usable
lift above sea level, usable lift above model ground, and precipitation rate
through the API, standalone map, and Windy plugin.

Generated test data covers local development and additional grid shapes.
Those tests do not make another weather model or forecast product available.

## Release work still open

Deployment is not considered complete. The current release still needs checks
of the matching forecast data, API, map, and Windy plugin, including:

- Tile loading, time selection, point results, errors, and expiry in the actual clients.
- Upload retries, rollback, and cleanup against remote storage.
- Response times and storage reads under a representative workload.
- Two consecutive scheduled production forecasts, plus monitor failure and recovery.

Physical-device testing is deferred. Mobile layout tests do not replace it.

See [development](development.md) for local use, [operations](operations.md) for
running the service, and [the roadmap](roadmap.md) for future work.
