# Roadmap

The current milestone is the [foundation plan](foundation-plan.md), executed in
[the foundation record](foundation-execution.md). [Status](status.md) separates
implemented behavior from qualification still awaiting evidence. No new live
forecast product or model is included in this milestone.

## Deferred expansion

Keep one monorepo, one batch CLI, one private R2 bucket per environment and one
read-only Worker. Expand only after the foundation qualification closes, using
the [extension recipes](extensions.md).

1. **One regional provider and its native coverage.** Choose the actual domain,
   required fields, source rights, update cadence and operational envelope before
   adding HRRR, ICON-Armenia or a WRF configuration. The synthetic Lambert proof
   demonstrates geometry, not an operational adapter or forecast skill.
2. **Atmospheric point profiles.** Define vertical coordinates, units,
   staggering/rotation, missingness, time selection and an admitted response
   shape. Measure native-cell bundles and frame grouping before choosing a
   `profiles.bin` format, profile API, Skew-T or windgram UI. Do not force large
   profiles into the scalar pack's all-channel point query.
3. **Native-grid convergence.** Establish independent vector/metric tests,
   stencil support and saved meteorological cases before admission. Horizontal
   convergence in inverse seconds is not a vertical climb-rate forecast.
4. **Ridge exposure and mountain wave research.** Separate DEM/wind exposure
   from claimed climb rates. Wave strength and position require validated
   stability, shear, critical-level and resolved/solved vertical-motion evidence.
5. **Enhanced WRF operation.** Treat nesting, hybrid coordinates, source wind
   rotation, terrain references and moving domains as explicit future contracts.
   A model family is not a complete configuration/domain identity.

No dates or benefits are promised for these features. First-party adaptation
provenance and genuine dependency/data notices are maintained in
[THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt); no new public license grant
is implied by the foundation work.
