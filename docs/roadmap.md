# Roadmap

See [deployments](status.md) for live applications and
[extensions](extensions.md) for adding models and calculations.

Next milestones, in order:

1. **Terrain-aware lift:** evaluate atmospheric columns over DEM elevations
   and validate fine MSL and AGL against observations.
2. **Atmospheric profiles:** define vertical profile schemas, storage layout,
   and point-query limits for sounding charts.
3. **Native-grid diagnostics:** validate grid-relative wind rotation, map-scale
   factors, and stencil neighbors for horizontal convergence.
4. **Ridge and mountain-wave lift:** model terrain-forced vertical motion from
   high-resolution elevation, wind shear, and stability profiles.
5. **Nested WRF domains:** support moving or nested Lambert domains, custom
   vertical coordinates, and sub-hourly output intervals.
