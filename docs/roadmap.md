# Roadmap

The builder supports GFS and ICON-EU. Keep the shared pipeline and math packages
small; another model should use their existing contracts before introducing a
new abstraction. [Status](status.md) records what has actually been deployed.

Next work, in order:

1. **Qualify ICON-EU end to end.** Run input proof and a full daylight-selected
   forecast on the intended runner. Measure cold/warm acquisition, peak RSS,
   shard transfer and total elapsed time; compare sample values with the serial
   path. Validate publication and both clients before enabling its schedule.
   Resource admission is an estimate, not evidence of a completed real run.
2. **Atmospheric profiles.** Define heights, pressure, units, missing values,
   storage, and point-query limits before building profile charts or APIs.
3. **Native-grid diagnostics.** Validate wind rotation, map scale, and neighboring
   cells before adding convergence. Convergence is not a vertical climb forecast.
4. **Ridge and mountain-wave research.** Distinguish terrain exposure from climb
   rates, and validate stability, shear, and vertical motion against real cases.
5. **More detailed WRF operation.** Specify nested or moving domains, terrain
   references, vertical coordinates, and source timing explicitly.

The diagnostic and profile features above are not implemented. There are no
release dates for them. A third or fourth source using the existing layers can
follow the model checklist without waiting for those separate products. The [extension guide](extensions.md) describes the input and
scientific checks needed before starting each kind of work.
