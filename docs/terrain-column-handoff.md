# Terrain column refinement implementation handoff

Continue the existing Armenia refinement work by correcting donor-state consistency, testing an explicit support/fallback policy, adding an optional LCL diagnostic and cap, and measuring palette compression. Evaluate solar heating separately. Preserve the existing forecast contracts and report unresolved scientific evidence explicitly.

This specification supersedes the earlier fixed 6.5 K/km ridge-temperature experiment and the proposal to change quarter-pixel scalar averaging. It is an implementation and evaluation handoff, with separately versioned numerical policies. The support confidence rule and clear-sky solar sensitivity below are modeling choices to test.

## 1 Working scope

Repository: `/Users/johndorrance/projects/flying/windy-av-layer`.

Continue on `codex/terrain-column-lift`. That branch and substantial uncommitted implementation already exist. Inspect `git status`, current HEAD and the actual callers before editing. Preserve all concurrent work. Implement local changes, tests and comparison artifacts; publish, deploy or merge only when separately requested.

Read `AGENTS.md`, `README.md`, `docs/architecture.md`, the nearest package READMEs and the public types before implementation files. Use the workspace runtime:

```sh
pnpm exec node --version
```

The runtime version owner is `package.json`. Use `pnpm exec node --import tsx` for standalone TypeScript commands.

Preserve:

- GFS and ICON-EU as the current model scope.
- Native forecast values and flags when the new options are disabled.
- Existing polygons, 1 km grids, DEM center-height recipe, coverage masks and halos.
- MSL/AGL output order, pack format, layer IDs, tile URLs and point patch selection.
- Existing raw-observation validation, daylight interval, Float32 tolerance and sink-rate behavior.
- Retained builds serving their own method/palette snapshots.
- Precipitation values, categorical colors and raster coverage.

Keep the current production clearance method until a provisionally selected candidate is integrated locally and passes its scientific, compatibility and resource checks. The requested local experiments can finish with an inconclusive promotion result.

## 2 Current implementation and evidence

Verify and reuse these existing boundaries:

- `packages/forecast/src/column-input.ts`: compact native extraction and caller-owned scratch.
- `packages/forecast/src/terrain-column.ts`: prepared donor mapping, local state, fields, metrics and probes.
- `packages/forecast/src/refinement.ts`: existing clearance path and reconstruction exports.
- `packages/soaring/src/column.ts`: native validation, optional surface environment anchor and `ReconstructedProfileWorkspace`.
- `packages/forecast/src/science.ts`: `deriveColumn` and `columnResult` publication boundary.
- `packages/thermodynamics/src/index.ts`: saturation vapor pressure and `lclHeightMetersAgl`.
- `packages/contracts/src/palette-color.ts`: shared continuous color calculation.
- `apps/batch/src/raster.ts`: quarter-pixel sampling, visibility and premultiplied color aggregation.
- `apps/batch/src/refinement/evaluate.ts`: verified replay and comparison images.
- `apps/batch/src/refinement/station-replay.ts`: cached station replay.
- `apps/batch/src/frame-build.ts`, `capacity.ts`, `build.ts`, `parallel.ts`, `identity.ts`: production wiring and accounting.

The working tree already contains per-donor ground anomalies, experimental support filtering, and clearance fallback. Check them against the policies below instead of recreating their old implementations. The previous `ridge-topographic` mode may already have been removed; retain its immutable reports as historical comparisons.

Review these local artifacts by their recorded hashes and source identities:

```text
output/experiments/terrain-column/control-isolated-3170e0a/
output/experiments/terrain-column/evaluation-native-reference-v3/
output/experiments/terrain-column/final-gates.json
output/experiments/terrain-column/summary-gates.json
output/experiments/terrain-column/armenia-support-gate-verdict.json
output/experiments/terrain-column/station-replay-report.json
output/experiments/terrain-column/comparison.html
output/hindcast-validation/observations/observations-weather.json
```

Treat each report as evidence for its recorded source and population. An aggregate summary can predate corrected individual reports. Verify the report inventory and raw-receipt bindings before reusing conclusions.

Important interpretation:

- Previous GFS 1,000 m support variants lost valid coverage inside Armenia; extending to 1,500 m reduced but did not eliminate losses. Counts differ by frame and evaluated source version.
- The older 128 × 128 pilot and the current 325 × 339 zone have different extents; the pilot excludes Aragats summit.
- The earlier 748-hour ICON statistic is unfiltered diagnostic evidence. Its eligible held-out count was 228 with no eligible high-terrain hours. It did not establish summit accuracy.
- Continuous colors increased measured archive bytes and rendering cost. Quantization benefits remain to be measured.
- A source-temperature correction, a support policy, an LCL cap and a raster compressor affect different outputs. Evaluate them separately before a combined experiment.

## 3 Execution order and output ownership

Complete these stages in order:

1. Freeze the current source/input inventory and reusable controls.
2. Verify the per-donor anomaly and implement the strict and confidence-hybrid support variants, with LCL and solar disabled.
3. Benchmark compression on exactly the same already-rendered control RGBA.
4. Add and evaluate the LCL cap on pure reconstructed columns, with hybrid and solar disabled.
5. Run a separate clear-sky solar sensitivity on pure reconstructed columns, with LCL and hybrid disabled.
6. Regenerate station/support/compression evidence and a comparison page. Provisionally select a scientific candidate, integrate it locally behind an explicit experimental choice, and measure the actual combined pipeline. Change production defaults only after all applicable gates pass and that change is requested.

Keep source hashes, model, cycle, interval, DEM identity, scientific options, support policy, render style and quantization recipe in every report. Physical variants use the same acquired inputs; render-only variants use identical numeric fields.

Write new results under a fresh run directory. Keep completed reports and old comparison images immutable. `comparison.html` may be a generated index pointing to immutable run artifacts; record the referenced report hashes.

## 4 Native extraction and profile invariants

Preserve the shared native extractor exactly:

- `NormalizedFrame` arrays are indexed by compact position in `frame.activeIndices`.
- Sampling contributors use global grid indices. Validate sorted unique source indices and resolve them to compact slots once during preparation.
- Preserve Pa-to-hPa and K-to-C conversions at the solver boundary.
- Preserve shared GFS pressures and per-column ICON pressures.
- Preserve below-ground screening: known `p >= surfacePressure` or known `height <= native terrain` excludes a level.
- A missing retained observation remains invalid; an interior missing level is not a synthetic extension.
- Preserve native height ordering, temperature bounds and `maximumProfileGapM`.
- Validate every original positive-weight donor before any support reweighting. Ignore exact zero-weight contributors.

Keep native golden outputs and flags byte-identical with new options disabled. Flat-terrain parity means one donor of weight one at its own ground, or identical donors. Flat geometry alone does not make nonlinear interpolation of different atmospheric columns equivalent to interpolation of their separately solved outputs.

Cache only distinct donor columns reached by each patch. Reuse typed-array workspaces and active profile counts. `fineLevelCount` is the populated count, not buffer capacity. Charge mapping, donor cache, profile scratch, daylight and optional normals/LUT storage in capacity accounting.

## 5 Donor environments and surface state

### Donor environment

For admitted donor `i`, let `h_i` be native ground, `z_i1,T_i1` the first retained observation and `Gamma_d` the existing dry lapse constant. Internally use K and m MSL; solver temperatures use C.

```text
Gamma_ext_i = clamp((T_i1 - T_i2) / (z_i2 - z_i1), 0, Gamma_d)
```

With one observation, use `Gamma_d`. Define `E_i(z)`:

- Between retained observations: linear interpolation in MSL height, preserving resolved inversions.
- Between native ground and the first observation: `T_i1 + Gamma_ext_i * (z_i1 - z)`.
- Between `h_i - B` and `h_i`: `E_i(h_i) + Gamma_bridge * (h_i - z)`.
- Outside the declared lower bound or above the highest observation: unsupported.

Use `B = 1000 m` and `Gamma_bridge = Gamma_d` in the primary study. Keep the existing 1,500 m and lowest-layer runs as named historical/sensitivity controls. Any extension of a bound is a separately recorded parameter choice.

### Per-donor anomaly

Cache each donor's anomaly at its own ground:

```text
delta_i = T2m_i - E_i(h_i)
```

Use the solver's existing ground-anchored convention consistently. Introduce no additional 2 m offset in this change. Reconstruct the target environment and anomaly with the same selected weights:

```text
E(z)   = sum(W_i * E_i(z))
delta  = sum(W_i * delta_i)
Tf     = E(hf) + delta
h0     = sum(W_i * h_i)
T0,p0,q0,H,LE = corresponding weighted native surface fields
```

`h0` remains a pressure-reference height; this closure does not evaluate `E(h0)`. Remove the old environment-at-average-ground support requirement wherever it remains.

### Pressure and humidity

Keep the existing non-iterative hydrostatic and conserved-RH closure, in Float64:

```text
r0      = q0 / (1 - q0)
TvMean  = ((T0 + Tf) / 2) * (1 + r0/epsilon) / (1 + r0)
pf      = p0 * exp(-g * (hf - h0) / (Rd * TvMean))
e0      = (p0 / PaPerHpa) * r0 / (epsilon + r0)
RH0     = e0 / es(T0 - kelvinOffset)
ef      = RH0 * es(Tf - kelvinOffset)
rf      = epsilon * ef / (pf / PaPerHpa - ef)
qf      = rf / (1 + rf)
```

`T0,Tf` are K and `p0,pf` are Pa. `es` takes C and returns hPa. Read constants from their existing owner.

Retain finite-state, saturation, humidity and solver range checks. Apply no additional flux multiplier after the selected weighted interpolation of `H` and `LE` during the donor-policy experiment. Let the shared total virtual buoyancy flux decide convection; negative sensible flux alone is not a no-lift criterion.

## 6 Exact support and fallback experiment

Implement two explicitly named policies. Preserve current behavior as a stored control; stop using a height-dependent donor set within one newly reconstructed column.

### Strict policy

Use original normalized bilinear weights for the complete column and all surface fields. Every positive-weight donor must support `hf` and all emitted profile heights. Keep the original common profile-top constraint. Unsupported cells remain unavailable with an exclusive reason.

This is the unblended thermodynamic reference. Its failure counts remain visible even when a hybrid variant fills the same locations.

### Confidence-hybrid policy

This is an experimental numerical confidence policy, not a consequence of mountain-boundary-layer theory. It uses the already declared bridge distance instead of admitting a donor at full weight at one arbitrary elevation.

First validate all original positive-weight donors and retain their original atmospheric-top constraints. Missing observations, invalid raw states, invalid DEM and missing geometric support remain unavailable. They cannot be repaired by discarding the bad donor or copying clearance.

For a target height `hf`:

```text
d_i = max(0, h_i - hf)
c_i = clamp(1 - d_i / B, 0, 1)
C   = sum(w_i * c_i)
W_i = w_i * c_i / C       when C > 0
```

Validate/normalize the original bilinear sum once, preserving ordering. Identify full support by `all(c_i === 1)` and set `C = 1` for that case; floating-point sums alone must not trigger a fallback requirement.

Use the fixed `W_i` for the entire profile AND anomaly, surface temperature, pressure, humidity, reference terrain, sensible flux and latent flux. A zero-confidence donor contributes to none of those quantities. Keep this set fixed as height increases. A donor does not enter halfway up the fine profile.

Merge retained heights and native-ground breakpoints of selected donors, sorted and exactly deduplicated, in `hf < z <= originalCommonTop`. Evaluate their environments with the same `W_i`. Preserve raw observation validation; admitted synthetic segments have their own declared bounds. Size scratch space for the actual emitted breakpoints and charge it.

Use this output rule with LCL and solar disabled:

- `C = 1`: publish the fine solve. Legacy clearance is not required.
- `C = 0`: do not divide by `C` or construct a fine thermodynamic state. Publish valid same-frame legacy clearance if available; otherwise remain unavailable.
- `0 < C < 1`: require both a valid/no-lift fine solve and valid/no-lift same-frame legacy clearance. Let no-lift usable AGL be zero. Compute `U = C * Ufine + (1 - C) * Ulegacy`.
- A failed fine solve at positive `C` remains unavailable. A missing required legacy field remains unavailable. No small-`C` cutoff is allowed.

Store AGL as Float32 `U`, then MSL as `Math.fround(hf + storedAGL)`. Positive `U` is valid; zero is no-lift. Keep MSL no-lift storage at DEM, public null MSL, AGL zero and transparent tiles. Combine source support bits conservatively, and record hybrid provenance separately from the fine solver branch.

Publish/report provenance `column`, `clearance` or `blend`, with `C`, selected weights and the original strict-policy failure. Fine depth/velocity/temperature/LCL diagnostics describe only an actual fine solve; they do not describe blended or legacy heights. A blend can retain positive legacy lift when the fine solve has no lift; make that consequence visible.

### Same-frame clearance contract

The evaluator can use immutable stored clearance only after verifying model, cycle, valid time, flux interval, source-object hashes, grid and terrain bindings against the acquired candidate frame. A matching valid time alone is insufficient.

A future production hybrid must calculate both paths from the SAME acquired `NormalizedFrame`, with its own declared method and memory cost. It cannot fetch an arbitrary older control pack. Keep the legacy kernel/diagnostics while that hybrid is an actual caller.

### Transition checks

Test donor distances immediately below, at and above zero and `B`. Test `C` approaching zero and one, equal/sparse weights and no supported donors. Use high enough forcing to keep the existing lift threshold away from the tested transition.

The previously reproduced no-lift-to-1,289 m AGL jump across 1 mm at a donor threshold is a regression case. Check environmental temperature and local state as well as final usable height. Distinguish an artificial support-entry jump from legitimate changes in the solver's first crossing or usable-lift threshold; universal output continuity is not a valid assertion.

Report strict failures, hybrid fills, fallback/blend area fractions and state errors separately. Zero lost availability is an operational metric, not proof that the new thermodynamics are accurate.

## 7 Optional LCL diagnostic and cap

Implement and evaluate this on pure reconstructed columns first. `capAtLcl` defaults to `false`. Keep the support hybrid and solar stage disabled for this study.

Add to every `LiftResult` branch:

```ts
lclMetersAgl: number | null;
usableLiftReachesLcl: boolean;
```

This is a parcel/usability diagnostic, not observed cumulus. Keep a `cuFormed` field out of this contract.

### Calculation and edge cases

After physical and humidity validation, calculate surface vapor pressure from the actual parcel humidity. Use the existing saturation constants to invert its formula directly for dewpoint; the RH convenience helper clamps low RH and is unsuitable for preserving very dry inputs.

- Unavailable input: `lclMetersAgl = null`, reachability false.
- Valid zero specific humidity: no finite LCL; return null/false and leave the cap inactive. Never evaluate `log(0)`.
- Positive humidity: compute finite dewpoint and call the existing `lclHeightMetersAgl(parcelTemperatureC, dewpointC)`.
- The existing `125 * spread` helper is an approximation. Reuse its owner rather than duplicate the coefficient or describe it as an exact Bolton LCL solution.
- Calculate the diagnostic before the non-convective early return. Valid non-convective columns can have a finite estimated LCL, but reachability is false.

Keep dry convective depth, physical branch and `w*` unchanged. Calculate dry usable depth through the existing function:

```text
if usableDry is null:
    usableEffective = null
    usableLiftReachesLcl = false
else:
    usableLiftReachesLcl = finiteLcl && usableDry >= lclMetersAgl
    usableEffective = capAtLcl && finiteLcl
        ? min(usableDry, lclMetersAgl)
        : usableDry
```

Derive status from the effective result: positive is valid; zero or null is no-lift. At saturated-surface LCL zero, a positive dry result caps to zero and publishes no-lift/AGL zero/MSL terrain. Preserve unavailable separately.

### Wiring and tests

Forward the explicit cap choice through both ordinary `deriveColumn` calls and `ReconstructedProfileWorkspace.solve`. Its current internal solve must not silently discard solver options. Keep the native-ground fast path consistent with that choice.

Carry diagnostics through `columnResult`, selected probes and reports. Add no new weather layer or pack channel for these diagnostics.

Test dry air, tiny positive humidity, saturation, non-convective state, null dry usable result, LCL below/at/above the usable top, invalid input, ground-anchor behavior and each return branch. With cap disabled, existing native values and flags remain byte-identical. With cap enabled, compare native and reconstructed calls using the SAME option; historical uncapped parity is not expected.

### Hybrid interaction

Reject the combination of `confidence-hybrid` and `capAtLcl: true` in the first implementation. Blending a capped fine result with uncapped legacy clearance can exceed the local LCL. A pure fallback also has no reconstructed local cloud-base state. Keep those diagnostics unknown and keep the hybrid out of a cloud-capped product until a separate combined-method contract is specified and tested.

## 8 Separate solar-incidence sensitivity

Run this only after the donor-state and LCL studies are independently understood. Initial variant: pure column, LCL disabled, unchanged anomaly and latent flux, positive sensible-flux modifier only.

Current inputs lack a direct/diffuse radiation partition and a high-resolution surface-energy model. The following is explicitly a clear-sky geometry experiment. It does not claim that TopoSCALE derives a sensible-heat/temperature-excess multiplier.

### Normals and coordinate conversion

Compute normals once per loaded DEM patch in memory. `prepareTerrainColumns` currently receives DEM arrays only during derivation; pass an explicit static terrain object at a suitable preparation boundary or cache by verified terrain identity. Avoid caching silently against a mutable array reference.

Require a valid center and four valid neighbors. Use the existing halo. Missing/edge normals produce factor one and a counter; they do not make valid forecast data unavailable. Keep a single boundary policy initially rather than adding unvalidated one-sided derivatives.

```text
gx = (z[col+1,row] - z[col-1,row]) / (2 * dxM)
gy = (z[col,row+1] - z[col,row-1]) / (2 * dyM)
```

Keep signed `dyM`. Obtain `metrics = geometry.rotationAndMetrics(lat, lon)`, then convert `gx * metrics.mapScale, gy * metrics.mapScale` through `gridVectorToEarth`. Map scale is projected distance divided by ground distance. Define `normalENU = normalize(-gradientEast, -gradientNorth, 1)`.

If normals are persisted later, key their recipe by DEM array hash, grid, derivative method and missing-neighbor policy. Preserve existing prepared terrain cache keys. Charge all new arrays.

### Interval integration

`solarPosition` already supplies elevation and azimuth. Azimuth is clockwise from north. Convert degrees to radians:

```text
sunENU = (cos(alpha)*sin(A), cos(alpha)*cos(A), sin(alpha))
flat   = max(0, sunENU.up)
slope  = sunENU.up > 0 ? max(0, dot(normalENU, sunENU)) : 0
```

Evaluate interval start, midpoint and end with Simpson weights `1,4,1` for BOTH integrals. If mean flat incidence is below `0.01`, or the normal is unsupported, use factor one. Otherwise:

```text
factor = clamp(slopeIntegral / flatIntegral, 0.5, 1.5)
Hlocal = H > 0 ? factor * H : H
```

Record the guard and bounds as experimental parameters. The common integral preserves flat-normal identity. Use no fixed 30/70 diffuse/direct split in this experiment, and no independent low-sun denominator that attenuates flat terrain.

Keep `Tf = E(hf) + delta`, its humidity closure, and `LE` unchanged. Apply no second multiplier to positive surface excess. This isolates the flux mechanism. When `LE=0`, `H>0`, control convective depth and `w*` are positive, and all state/profile quantities are held fixed, expect `w*local / w*control = cbrt(factor)` and unchanged dry TI=0 depth. For zero-depth columns, assert both velocities remain zero instead of dividing them.

Test flat identity, projection rotation, planar east/west slopes, morning/afternoon reversal, below-horizon sun, weak illumination, missing neighbors and negative/zero `H`. Inspect the interval quadrature against a more densely sampled reference on representative dawn/dusk cases.

Measure area-weighted positive heat before/after over represented native footprints, identifying partial footprints. A bounded factor does not conserve heat. Keep this sensitivity unpromoted until an actual radiation partition, cloud/diffuse treatment, surface-energy closure and held-out evidence support production. Do not force summit lift or lake suppression as expected outputs.

## 9 Lift compression experiment with unchanged sampling

Reuse the existing four quarter-pixel numeric samples, per-quarter visibility, palette evaluation, premultiplied color averaging and final alpha. Quantize only the resulting final LIFT RGB. Keep precipitation RGBA byte-identical.

Changing from mean colors to the color of mean values is outside this experiment. For example, rain samples `[0,0,1,1]` currently give half coverage; averaging valid scalars first can make the full pixel opaque. Preserve current masks, status handling, patch ownership and anti-aliasing.

Use identical already-rendered unquantized RGBA buffers as inputs to all compression variants. This removes physical and resampling differences from the benchmark.

### Candidate palettes

Use the existing 22 lift color anchors at `LIFT_EDGES.slice(0, 22)`, from 0 through 6,400 m. The 6,700 m edge remains an overflow-label sentinel. Preserve the current encoded-sRGB interpolation definition.

Construct each palette by visiting every adjacent anchor pair. Emit `round(a + (b-a) * k/s)` independently per channel for `k = 0 ... s-1`; append the final anchor once.

- `q8`: `s=8`, giving 169 RGB entries before duplicate elimination.
- `q2`: `s=2`, giving 43 RGB entries before duplicate elimination.
- `control`: current unquantized final RGBA.

Copy alpha exactly and leave alpha-zero pixels unchanged. For the current opaque lift palette and four coverage samples, alpha belongs to `{0,64,128,191,255}`. Thus q8 allows at most 677 ARGB values including transparent black; q2 allows at most 173. Count actual decoded ARGB values per tile. Different palette alpha rules require recalculating these bounds.

Q2 is eligible for the WebP <=256-entry indexing transform; neither candidate guarantees that the encoder chooses it or achieves a prescribed byte/time ratio.

### Bounded lookup

Compile a `32 x 32 x 32` RGB lookup table once per candidate per render worker, stored as 32 KiB of Uint8 palette indices. Each 5-bit RGB cell center selects the palette color minimizing squared encoded-sRGB distance; ties choose the lower palette index. The center coordinates are `8*index + 3.5`.

Pixel lookup uses the three high-five-bit channel indices; copy the selected RGB and original alpha. Disable dithering. Include lookup compilation in cold-start timing. This is an approximate nearest-color quantizer, so measure its error rather than claiming exact nearest-color selection.

Keep variant choice explicit and immutable through renderer/worker inputs. Avoid changing global palettes between benchmark passes.

### Quality and performance report

For each tile and aggregate, report:

- Numeric-field, status, ownership and sample-pack hash equality.
- Alpha-byte equality for every pixel; unchanged transparent pixels.
- Precipitation RGBA byte equality.
- Unique decoded ARGB count, encoded bytes, quantization time, encode time, archive time and peak RSS.
- RGB and alpha-weighted RGB error at p50/p95/max, split into opaque interiors, partial coverage and patch/coverage boundaries.
- Worst-error tiles and matched screenshots/contact sheets.

Final composite colors can be far from this nonconvex ramp; nominal 37.5 m palette spacing is not a bound on final image error. Inspect those mixtures explicitly.

Use the same tile IDs, zooms, immutable inputs, WebP options, concurrency and machine conditions. Repeat warmed measurements and report cold setup separately. Start with representative real tiles before rendering entire archives.

Select the finest palette that meets a predeclared visual/error budget and produces a measured resource benefit. Freeze that budget before inspecting candidate scores; record it in the run manifest. If no visual budget has been selected, deliver the images/error report as unselected evidence. Keep the unquantized renderer if both candidates fail. Treat the earlier 3–5x size and 30–40% time reductions as hypotheses, not return criteria.

## 10 Evaluation artifacts and station evidence

Extend the existing command rather than add another parallel CLI:

```sh
pnpm refinement:evaluate \
  --control-manifest PATH_TO_VERIFIED_CONTROL \
  --cache-dir .cache/icon-eu \
  --out output/experiments/terrain-column-next \
  --frames f021,f024
```

Those flags already exist. Run separately for GFS with its cache/control. Verify existing model/patch selection and actual CLI arguments before adding options.

Record variants explicitly:

- Stored clearance control and the pre-edit current reconstruction snapshot.
- Strict per-donor anomaly column, LCL/solar disabled.
- Confidence hybrid, LCL/solar disabled.
- Pure strict column with LCL enabled.
- Pure strict column with solar sensitivity, LCL disabled.
- Render-only control/q8/q2 for a fixed numeric field.

Keep the unsupported combined hybrid/LCL option rejected. Add combined physics only after the isolated methods have explicit compatibility and validation results.

Write immutable `report.json`, field hashes/packs, probe traces and image names containing model, frame, physical variant, render variant, layer and view. Required views are tile `8/159/96` and whole zone; include Armenia polygon and 15 km Aragats populations. Record exact Yerevan, Aparan, Aragats and Sevan probe coordinates.

Regenerate `comparison.html`, `summary-gates.json`, `final-gates.json` and the Armenia support verdict from the same named run inventory. Eliminate stale source identities and incorrect receipt/inventory hash labels. Verify each recorded hash against its named file.

### Support evidence

Report raw strict failures and exclusive reasons independently of hybrid output. Include fallback/blend fractions, confidence distribution and each provenance category inside Armenia. Zero known-to-unavailable hybrid cells is an availability goal where a verified legacy result exists; it is not a reconstruction-accuracy gate. Inject missing/invalid weather in tests and require unavailable outputs even if clearance is present.

### Station evidence

Freeze QC, station identities, observation times, model cycles and hold-out membership before tuning. Use the same fixed paired station/hour population for candidate-versus-control MAE and bias. Keep missing candidate predictions in that frozen population's coverage accounting; never silently remove their station/hours. A reduced-common-subset MAE is diagnostic, and its primary gate remains inconclusive unless a predeclared coverage policy permits the loss. Score newly recovered predictions as an additional population.

The already inspected ten-day replay is development evidence. Repeated tuning on it does not create independent held-out validation. Preserve existing holdouts or use an untouched test population. Report elevation-offset, local-time and weather-regime groups and unique station/day counts.

Keep the prior 1.40C ICON and 1.70C GFS MAE targets as descriptive benchmarks only. A complete gate requires paired baseline performance, coverage, uncertainty and eligible-group counts. Zero eligible elevated-station observations leaves the ridge gate inconclusive regardless of overall MAE.

Surface station temperatures do not establish thermal tops or cloud-base accuracy. Use independent sounding, cloud-base or flight evidence when available, with source and time alignment. XC images require their model, cycle, valid time, layer and units; they are a comparison product rather than observational truth.

If observations or visual review are missing, finish the reproducible local implementation and report the corresponding gate as inconclusive. Preserve unpromoted methods rather than inventing pass results.

## 11 Tests required before selection

Retain existing native goldens and add independent analytic cases:

1. Per-donor anomaly identity, equal-height donors and an elevated donor/valley-inversion case. Verify that `E_i(h0)` is not evaluated to define the anomaly.
2. Global-to-compact indexing, sorted/unique indices, zero weights and poisoned positive-weight raw donors.
3. One donor at its native ground, both coordinate representations, and options forwarded through every fast path.
4. Confidence/weight sums; the same fixed weights for profiles and ALL scalar fields; zero-confidence donors contribute nothing to surface excess or flux.
5. Threshold neighborhoods at `d=0`, `d=B` and `C=0/1`, including the old 1 mm donor-entry regression and bounded output convergence to legacy as `C` approaches zero.
6. Missing/invalid input, unsupported atmospheric top, missing baseline, no-lift baseline, fine no-lift with positive legacy height and frame/terrain mismatch rejection.
7. MSL = DEM + stored AGL, correct post-blend status, conservative support flags and truthful provenance.
8. Every LCL return branch and the cap/uncapped parity tests in section 7. A cap can reduce lift; it must not turn no-lift into positive lift.
9. Explicit rejection of hybrid plus LCL until a combined rule exists.
10. Solar geometry, cube-root velocity scaling and unchanged anomaly/latent forcing.
11. Compression exact alpha, rain, masks, numeric hashes, deterministic lookup ties, palette endpoints and decoded ARGB bounds.
12. Frame workspace reset, alias protection, pack/tile sampling, polygon halos and retained-build compatibility.

Use existing Float32-aware tolerances near physical branch boundaries. Do not assert universal continuity through the original usable-lift threshold or first-crossing changes.

## 12 Method identity, integration and resource ownership

Keep the initial changes evaluation-only. After provisional scientific selection, integrate the candidate locally behind an explicit experimental choice and measure that actual pipeline. Production defaults remain on their declared current method until compatibility, science and resource gates pass and promotion is requested.

For any selected production method:

- Publish a new descriptor/recipe identity for its actual donor support, hybrid, LCL and solar rules. Preserve old descriptors and serialized snapshots.
- Default LCL off. If metadata uses numeric parameters, serialize the actual cap choice as `capAtLcl: 0 | 1`; derive runtime options and metadata from one owner.
- Keep stable fallback method ID and support/fallback policy in the composite descriptor. Retain both kernels and their allocations while both are callers.
- Keep actual model, cycle, valid time, flux interval, raw-object/receipt identity, native grid and DEM binding in frame-owned runtime proof and report provenance. Verify that proof before fallback. Build identity is calculated before acquisition; changing frame receipts cannot be static method parameters or inputs to the static method `scienceHash`.
- Keep fine physical diagnostics distinct from hybrid heights. Store probe/report provenance without adding sample-pack channels or undocumented status bits.
- Version quantized rendering separately from unquantized `linear-rgb`; include subdivision count, lookup resolution, color space and alpha policy. Preserve numeric packs. New build legends and API palette assets describe the selected render recipe; retained builds use their old palette snapshots.
- Preserve precipitation and old palette behavior. Update shared preview/Windy legend and API SVG through their actual owners.
- Respect the current method-parameter schema cap. Any required expansion needs measured serialized size, bounded tests and a justified change; do not omit parameters to hide them.

For local candidate integration, update the real callers together: `methods.ts`, `publication.ts`, `frame-build.ts`, `build.ts`, `parallel.ts`, `identity.ts`, `capacity.ts`, their tests and generated references. Preserve the existing default while the experimental path is measured.

Admission must include mapping, donor cache, union scratch, daylight, optional normals, palette lookups, both legacy/fine fields and native diagnostics when fallback remains live. Apply the [build](../apps/batch/src/capacity.ts) and [serving](serving-budgets.md) budgets. Charge actual per-zone donor counts and all concurrent render workers. Run full-timeline builds through the locally integrated candidate before production-default promotion; kernel-only or old-physics builds do not prove a new combined pipeline fits.

## 13 Commands and final handoff

During implementation:

```sh
pnpm test packages/forecast packages/soaring packages/thermodynamics packages/contracts
pnpm test apps/batch/src/refinement apps/batch/src/render.test.ts apps/batch/src/raster-refinement.test.ts apps/batch/src/raster-pool.test.ts
pnpm test apps/batch/src/parallel.test.ts apps/batch/src/identity.test.ts apps/batch/src/validate.test.ts scripts/sample-preview.test.ts apps/api/test
```

Before completion:

```sh
pnpm docs:generate
pnpm capacity --model gfs
pnpm capacity --model icon-eu
pnpm verify
git diff --check
```

The forecast build CLI does not accept `--frames`, `--hours` or `--zones`; the evaluation CLI has its own verified flags. Use existing isolated controls or an explicit custom-product build for a subset of forecast hours. Immutable offline reports can analyze expired builds; live preview expiry remains enforced.

Deliver a concise status for each stage: implemented, checked, unselected or blocked by specified evidence. Include exact commands, test counts, source/input hashes, immutable report/image paths, changed files and measured costs. State whether any production method or rendering default changed. Leave the final comparison ready for review without sending, deploying or publishing it.

## References and interpretation

- [TopoSCALE, Fiddes and Gruber 2014](https://gmd.copernicus.org/articles/7/387/2014/): profile/elevation meteorological downscaling and radiation corrections. It does not derive simultaneous sensible-flux and temperature-excess multipliers for this project.
- [De Wekker and Kossmann 2015](https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2015.00077/full): mountain boundary layers involve regime-dependent transport. It does not prescribe a binary donor cutoff or validate this confidence hybrid.
- [WebP lossless specification](https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification#color-indexing-transform): indexing counts complete ARGB values; an eligible palette does not guarantee a particular encoder choice or speed/size gain.
