# Project status

[Home](../README.md) · [Roadmap](roadmap.md)

The GFS pipeline has been verified with a real forecast in a local runtime.
Cloudflare publication and live client host integrations (including the optional
Windy consumer) remain release work.

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
not checked in). Earlier immutable archives and their historical receipts remain
unchanged; their legends retain their original rendering style.

## Release boundaries

Remote R2 uploads, publication integrity checks against Cloudflare, and a
deployed Worker have not yet been demonstrated by this evidence. The preview
server was opened, but the record does not include automated visual assertions.
Plugin loader tests use fixtures; actual host behavior for external consumers
still needs validation.

HRRR and ICON-Armenia products are deferred. The current build path supports GFS;
the clients expose the reserved regional model IDs as unavailable.

Adapted private-source code also has unresolved distribution rights, recorded
in [third-party notices](../THIRD_PARTY_NOTICES.txt). The
[roadmap](roadmap.md) describes the next milestones.
