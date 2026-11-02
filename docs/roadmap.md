# Roadmap

Finish the [current GFS release checks](status.md) before adding models or
forecast products. Keep the existing batch job, API, and shared calculations
simple; add another abstraction when a concrete use needs it.

Future work, in rough order:

1. **One regional weather source.** Choose its domain, required fields, update
   schedule, data rights, and resource limits before adding HRRR, ICON, or WRF.
2. **Atmospheric profiles.** Define heights, pressure, units, missing values,
   storage, and point-query limits before building profile charts or APIs.
3. **Native-grid diagnostics.** Validate wind rotation, map scale, and neighboring
   cells before adding convergence. Convergence is not a vertical climb forecast.
4. **Ridge and mountain-wave research.** Distinguish terrain exposure from climb
   rates, and validate stability, shear, and vertical motion against real cases.
5. **More detailed WRF operation.** Specify nested or moving domains, terrain
   references, vertical coordinates, and source timing explicitly.

These features are not part of the current implementation. There are no release
dates for them. The [extension guide](extensions.md) describes the input and
scientific checks needed before starting each kind of work.
