# Forecast comparison

Compares archived forecast products at 50 fixed sites.

```sh
pnpm comparison plan --out output/comparison
pnpm comparison capture --out output/comparison --provider all
pnpm comparison report --out output/comparison
```

`plan` discovers retained AV builds and XC runtimes, then writes `plan.json`.
`--sites`, `--reference` and `--api` select the cohort, UTC reference time and
AV API. Start each experiment in a new output directory. `capture` resumes
existing response IDs; `--provider` selects `all`, `av-layers` or `xcskies`.
`report` replays the archive offline into `normalized.json` and `report.json`.

`report.currentPipeline` selects builds matching each model's archived latest
method, science, adapter, contracts, configuration and recipe lock hashes. `byPipeline`
separates historical implementations; the top-level totals pool all captures.
The report retains each build's signature and reference source.
`analysis` fingerprints the local comparison and dependency sources, package
configuration, lockfile and runtime in both report and normalized snapshots.

Authenticated XC captures read `XC_SKIES_COOKIE` from the process environment.
Supply it through an interactive secret prompt or secret manager. The transport
sends it only to XC Skies subdomains and rejects redirects. Archives store
response bodies and selected request metadata; credentials and headers stay
out of files and progress output.

## Inputs and ownership

- [sites.json](sites.json) owns coordinates, time zones and terrain tags;
  [sites.ts](sites.ts) validates the cohort.
- [session.ts](session.ts) owns discovery, request planning, collection and
  replay. [cli.ts](cli.ts) exposes the commands.
- [archive.ts](archive.ts) owns immutable response IDs, SHA-256 verification,
  byte budgets, deadlines and bounded retries. `writeCapture` accepts browser
  response bodies; `captureUrl` collects through an injectable transport;
  `readCapture` verifies offline inputs. Missing captures remain explicit.
- [av-layers.ts](av-layers.ts) binds point samples and native profiles to their
  manifest. Scalar inventory comes from manifest descriptors; native profile
  diagnostics retain separate names and cell coordinates.
- [xc-skies.ts](xc-skies.ts) decodes JSON/JSONP, runtime identities and verified
  fields. Raw and unmapped field inventories accompany normalized samples.
- [core.ts](core.ts) owns `ComparisonSample`, matching and differences;
  [mappings.ts](mappings.ts) owns parameter pairings and qualifications.
  [report.ts](report.ts) aggregates daylight, local site-days, status changes
  and the largest differences.

Provider adapters produce normalized snapshots before scoring. A cached replay
or later sensitivity run supplies another `ComparisonSample[]` and explicit
mappings to `buildReport`; acquisition stays outside the comparison core.

Compare supplied normalized JSON arrays offline with the same report:

```sh
pnpm comparison compare --left left.json --right right.json --sites sites.json \
  --mappings mappings.json --out output/comparison-offline
```

The input files follow `ComparisonSample[]`, `ComparisonSite[]` and
`ParameterMapping[]`; the command writes `report.json`.

## Matching

Pairs require the same site coordinates, nominal upstream product, model cycle
and UTC valid time. Exact parameter mappings also require matching units,
height references and statistical windows. Missing, outside-domain and no-lift
states retain their meanings.

Related mappings can explicitly select `timePolicy: 'valid-time'` when forcing
windows differ or remain unknown. `referencePolicy: 'provider-ground'` compares
each provider's AGL output while retaining both ground references. Reports carry
these qualifications through their summaries. XC nominal model names establish
the product association; its source regridding remains unspecified.

## XC inputs

The current planner captures `/runtimes/all/...` before and after collection
and `/profile/...?...&pro=1` for each eligible site and model. Stable runtime
records bind each forecast timestamp to its initialization. The profile URL's
date and hour select its time window. Decoded series must match the timestamp
axis; native profiles must match their height and pressure axes.

The adapter also accepts `/pointinfo/...?...&xcparam=all`. The pilot returned
`xclift225`, `xcbldepth`, `xcm0`, `xcti`, `xcstemp`, `xccdepth`, `xccbase`,
`xcliftidx`, `xcskycond` and `xccape`. Parameter-specific requests can enrich
this inventory. `/skewt/...?...&single=1` provides a single-time profile check.
These diagnostic endpoints can be ingested with `writeCapture`.

Unverified packing, unresolved time windows and unmatched parameters remain
visible in the archive and report inventory. The current comparison scores the
verified subset. [XC layer definitions](https://docs.xcskies.com/home/documentation/xc-skies-layers)
and the [PointCast guide](https://docs.xcskies.com/home/tutorials/map-pointcast)
describe the displayed products; the decoder owns the captured wire format.

## SkySight extension

```sh
pnpm comparison skysight-plan --baseline output/comparison/2026-11-13-baseline \
  --regions PATH --reference 2026-11-13T09:45:00Z \
  --out output/comparison/2026-11-13-skysight
pnpm comparison skysight-capture --out output/comparison/2026-11-13-skysight
pnpm comparison skysight-report --out output/comparison/2026-11-13-skysight
```

[skysight-session.ts](skysight-session.ts) pins the original normalized snapshot
and each archived latest AV build. [skysight-regions.ts](skysight-regions.ts)
validates region metadata and cohort assignments; the plan archives the exact
input as immutable `regions.json`. Collection uses regional point and native
windgram products over three local days. Region assignments retain uncovered
sites and both US products at overlapping sites. `SKYSIGHT_TOKEN` supplies the
in-memory `x-auth` header for `cf.skysight.io`; POST captures store request-body
hashes, and the plan owns the nonsecret forecast parameters.

[skysight.ts](skysight.ts) owns verified scalar mappings and native profile
decoding. Point and windgram retain separate product identities. Windgram
comparisons score boundary-layer top and low cloud against AV fields.
Each report group names its endpoint; XC comparisons use the point product.
Reports pair exact coordinates and UTC valid times through the explicit
`products-at-valid-time` policy. Both forecast identities survive; SkySight
initialization and lead remain unknown. XC comparisons select its latest known
cycle per product. Sampled local-noon update markers retain before/after values
for those probes. Outputs reference the original baseline without rewriting it.

```sh
pnpm test apps/batch/src/comparison
```
