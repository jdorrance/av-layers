# Project status

[Home](../README.md) · [Roadmap](roadmap.md)

The GFS pipeline has completed real builds, exact output comparisons, local
Worker checks, and desktop/mobile-emulated preview checks. Cloudflare publication,
physical devices and live consumer hosts remain release work.

## Current evidence

The complete packed build (`cell-major-blocks-v1`, 43.84 MB numeric pack and
2,280-byte all-frame point range) and prepared renderer match the baseline
implementation (87.2 s vs 648.1 s on cached local GFS inputs). Resource
admission and CI budget checks are implemented in
[`apps/batch/src/capacity.ts`](../apps/batch/src/capacity.ts).

On 2026-11-01, [production deployment](https://github.com/jdorrance/av-layers/actions/runs/41326596966)
passed CI and deployed the Worker with the expected revision marker. Its smoke
check correctly rejected the empty forecast catalog. The earlier
[forecast publication](https://github.com/jdorrance/av-layers/actions/runs/41303666341)
failed because the SDK sent conflicting upload checksums. The current client
configuration removes the extra checksum; a test exercises the SDK's generated
requests. A fresh successful R2 publication and full deployment smoke check
remain unverified.

Local preview checks cover frame/layer switching, legend identity, forecast
requests and point tables. Emulation establishes those observed behaviors, not
physical-device speed or deployed cache performance.

<details>
<summary>Earlier local checkpoints</summary>

## Local GFS validation

On 2026-10-30, the 00Z GFS cycle completed acquisition, derivation, tile and
sample generation, build validation, and archive smoke checks. The build was
then loaded into Wrangler's local R2 emulator and served through workerd.

The [validation receipt](evidence/gfs-local-2026-10-30.json) preserves the build
identity, tool versions, artifact counts, validation results, and observed
measurements. It was copied from the local evidence record; the forecast
archives and emulator state are generated outputs and are not included in the
repository.

Local API checks covered full-day samples at Torrey Pines, Armenia, and New
Zealand; excluded Russian coverage; PNG delivery; CORS; conditional requests;
HEAD requests; and unknown-build errors. The Armenia sample used GFS, not the
regional ICON adapter.

The receipt's request timings are individual local observations. They do not
establish production latency, cache performance, operating cost, or an SLA.
Its test results describe that checkpoint; use the
[development checks](../README.md#development-checks) for the current checkout.

## Transparent no-lift tiles

A fresh build, `20261030T093641Z-44e759df-18bf-4795-9678-87598bdd91e4`,
validated all 24 archives and 24 numeric arrays with rendering style
`transparent-no-lift-v2`. Local API PNG checks confirmed alpha zero in both lift
layers at a no-usable-lift location in Armenia, while positive lift at Torrey
Pines remained colored. Each PNG check was matched against the four actual
quarter-pixel numeric samples. Point values remain MSL `null` and AGL `0` for
physical no-lift.

The local receipt is `output/evidence/no-lift-transparency-proof.json` (generated,
not checked in). These PNG and flat-array artifacts are historical evidence.
Current production serving uses the packed contract and lossless WebP.

</details>

## Release boundaries

Successful R2 publication and its integrity checks against Cloudflare remain
unverified. The production Worker is reachable, but the complete forecast-serving
path still needs a published build. Plugin loader tests use fixtures; actual
host behavior for external consumers still needs validation.

HRRR and ICON-Armenia products are deferred. The current build path supports GFS;
the clients expose the reserved regional model IDs as unavailable.

Adapted private-source code also has unresolved distribution rights, recorded
in [third-party notices](../THIRD_PARTY_NOTICES.txt). The
[roadmap](roadmap.md) describes the next milestones.
