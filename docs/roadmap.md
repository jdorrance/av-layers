# Roadmap

See [status](status.md) for current deployment state and
[extensions](extensions.md) for implementation checklists.

Next milestones, in order:

1. **Qualify ICON-EU in production:** run `input:proof` and a full daylight-filtered
   ICON-EU build on the hosted runner, record cold/warm timings and peak RSS,
   and verify publication in both clients.
2. **Atmospheric profiles:** define vertical profile schemas, storage layout,
   and point-query limits for sounding charts.
3. **Native-grid diagnostics:** validate grid-relative wind rotation, map-scale
   factors, and stencil neighbors for horizontal convergence.
4. **Ridge and mountain-wave lift:** model terrain-forced vertical motion from
   high-resolution elevation, wind shear, and stability profiles.
5. **Nested WRF domains:** support moving or nested Lambert domains, custom
   vertical coordinates, and sub-hourly output intervals.
