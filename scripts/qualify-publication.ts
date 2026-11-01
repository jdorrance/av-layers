import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { encodeBoundedJson, forecastObjects, manifestSchema, MAX_MANIFEST_BYTES, MAX_POINTER_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, modelPointerSchema, parseBoundedJson, parseProvenance, type Manifest } from '@av/contracts';
import { assertAuthority, workflowAuthority, type PublicationAuthority } from '../apps/batch/src/authority.js';
import { readCoverage } from '../apps/batch/src/coverage.js';
import { readLocalFile } from '../apps/batch/src/local-file.js';
import { cleanup, publish, rollback } from '../apps/batch/src/publication.js';
import { r2Storage, type ObjectStorage } from '../apps/batch/src/storage.js';
import { localPath, runConcurrent, sha256, validateBuild } from '../apps/batch/src/validate.js';

interface Counters { gets: number; heads: number; puts: number; lists: number; deleteCalls: number; deletedKeys: number; readBytes: number; writtenBytes: number }
const counters = (): Counters => ({ gets: 0, heads: 0, puts: 0, lists: 0, deleteCalls: 0, deletedKeys: 0, readBytes: 0, writtenBytes: 0 });
function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
const buildId = (now: number) => `${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${randomUUID()}`;

/** Every operation, including listing and deletion, is confined beneath this nonce. */
export function qualificationStore(base: ObjectStorage, nonce: string, counts: Counters): ObjectStorage {
  invariant(/^[a-f0-9-]{36}$/.test(nonce), 'Invalid qualification nonce');
  const prefix = `qualification/${nonce}/`;
  const keyFor = (key: string, listing = false) => {
    invariant((listing || key.length > 0) && !key.startsWith('/') && !key.includes('\\') && !key.split('/').some(part => part === '.' || part === '..'), 'Unsafe qualification key');
    return prefix + key;
  };
  return {
    async get(key, range, maxBytes) { counts.gets++; const result = await base.get(keyFor(key), range, maxBytes); counts.readBytes += result?.bytes.byteLength ?? 0; return result; },
    async head(key) { counts.heads++; return base.head(keyFor(key)); },
    async put(key, bytes, condition, contentType, contentMd5) { counts.puts++; await base.put(keyFor(key), bytes, condition, contentType, contentMd5); counts.writtenBytes += bytes.byteLength; },
    async list(key) {
      counts.lists++;
      const requested = keyFor(key, true), objects = await base.list(requested);
      return objects.map(object => { invariant(object.key.startsWith(requested), 'Storage returned a key outside the qualification namespace'); return { ...object, key: object.key.slice(prefix.length) }; });
    },
    async delete(keys) { const mapped = keys.map(key => keyFor(key)); if (!mapped.length) return; counts.deleteCalls++; await base.delete(mapped); counts.deletedKeys += mapped.length; }
  };
}

async function cloneBuild(root: string, original: Manifest, destination: string, now: number): Promise<Manifest> {
  const id = buildId(now), oldPrefix = `builds/${original.model}/${original.buildId}/`, prefix = `builds/${original.model}/${id}/`;
  const renamed = (key: string) => { invariant(key.startsWith(oldPrefix), 'Clone payload escaped its build prefix'); return prefix + key.slice(oldPrefix.length); };
  const manifest = manifestSchema.parse({ ...structuredClone(original), buildId: id, createdAt: new Date(now).toISOString(),
    artifacts: original.artifacts.map(item => ({ ...item, tilesKey: renamed(item.tilesKey) })),
    samples: { ...original.samples, key: renamed(original.samples.key) },
    source: { ...original.source, provenanceKey: renamed(original.source.provenanceKey) },
    tool: { ...original.tool, qualificationSourceBuildId: original.buildId } });
  const payloads = forecastObjects(original).map(item => ({ from: item.key, to: renamed(item.key) }));
  const coveragePrefix = dirname(original.coverage.maskKey);
  payloads.push(...['manifest.json', 'output.bin', 'halo.bin', 'tiles.bin'].map(name => ({ from: `${coveragePrefix}/${name}`, to: `${coveragePrefix}/${name}` })));
  await runConcurrent(payloads, 4, async item => { const path = localPath(destination, item.to); await mkdir(dirname(path), { recursive: true }); await copyFile(localPath(root, item.from), path); });
  const sourceBytes = await readLocalFile(localPath(root, original.source.provenanceKey), MAX_PROVENANCE_BYTES);
  invariant(sha256(sourceBytes) === original.source.provenanceSha256, 'Clone source provenance changed after validation');
  const receipt = parseProvenance(parseBoundedJson(sourceBytes, MAX_PROVENANCE_JSON_TOKENS), original);
  receipt.buildId = id;
  const bytes = encodeBoundedJson(receipt, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS); manifest.source.provenanceSha256 = sha256(bytes);
  await writeFile(localPath(destination, manifest.source.provenanceKey), bytes, { flag: 'wx' });
  const validated = await validateBuild(destination, manifest, await readCoverage(destination, manifest.coverage.hash), manifest.coverage.hash);
  await writeFile(localPath(destination, `${prefix}manifest.json`), encodeBoundedJson(validated, MAX_MANIFEST_BYTES), { flag: 'wx' });
  return validated;
}

interface Options {
  store: ObjectStorage; secondStore: ObjectStorage; root: string; manifestPath: string; authority: PublicationAuthority;
  backend: 'r2' | 'memory'; receiptPath: string; now?: () => number; signal?: AbortSignal;
  sourceRevision?: string;
}
export async function qualifyPublication(options: Options) {
  assertAuthority(options.authority, 'gfs');
  invariant(options.authority.environment === 'staging', 'Publication qualification is staging-only');
  const now = options.now ?? Date.now, nonce = randomUUID(), counts = counters(), store = qualificationStore(options.store, nonce, counts), second = qualificationStore(options.secondStore, nonce, counts);
  const namespace = `qualification/${nonce}/`, started = Date.now(), temporary = await mkdtemp(join(tmpdir(), 'av-publication-drill-'));
  let ownsNamespace = false;
  const receipt: { version: number; kind: string; backend: string; namespace: string; startedAt: string; authority: { environment: string; group: string; runId: string }; passed: boolean; stages: { name: string; elapsedMs: number; outcome: unknown }[]; counters: Counters; cleanup: Record<string, unknown>; error?: string; elapsedMs?: number; input?: unknown } = {
    version: 1, kind: 'isolated-publication-protocol', backend: options.backend, namespace, startedAt: new Date(started).toISOString(), authority: { environment: options.authority.environment, group: options.authority.group, runId: options.authority.runId }, passed: false, stages: [], counters: counts, cleanup: { attempted: false }
  };
  const save = async () => { await mkdir(dirname(resolve(options.receiptPath)), { recursive: true }); await writeFile(`${options.receiptPath}.tmp`, JSON.stringify(receipt, null, 2)); await rename(`${options.receiptPath}.tmp`, options.receiptPath); };
  const stage = async (name: string, run: () => Promise<unknown>) => {
    options.signal?.throwIfAborted(); const begin = performance.now(), outcome = await run();
    receipt.stages.push({ name, elapsedMs: performance.now() - begin, outcome }); await save();
    console.log(JSON.stringify({ event: 'qualification-stage-complete', name, elapsedMs: receipt.stages.at(-1)!.elapsedMs }));
  };
  const expectFailure = async (run: () => Promise<unknown>, pattern: RegExp) => {
    let failure: unknown;
    try { await run(); } catch (error) { failure = error; }
    invariant(failure && pattern.test(text(failure)), `Expected ${pattern}, received ${failure ? text(failure) : 'success'}`);
    return text(failure);
  };
  const pointerKey = 'catalog/gfs/latest.json';
  const pointer = async () => { const object = await store.get(pointerKey, undefined, MAX_POINTER_BYTES); return object ? { ...object, value: modelPointerSchema.parse(parseBoundedJson(object.bytes)) } : null; };
  const unchangedPointer = async (before: Awaited<ReturnType<typeof pointer>>) => { const after = await pointer(); invariant(before && after && before.etag === after.etag && Buffer.from(before.bytes).equals(after.bytes), 'Failed operation changed the pointer'); };
  try {
    console.log(JSON.stringify({ event: 'qualification-started', namespace, backend: options.backend })); await save();
    options.signal?.throwIfAborted();
    invariant((await store.list('')).length === 0, 'Qualification namespace already exists');
    ownsNamespace = true;
    const bytes = await readLocalFile(options.manifestPath, MAX_MANIFEST_BYTES), raw = manifestSchema.parse(parseBoundedJson(bytes));
    if (options.sourceRevision !== undefined) invariant(/^[a-f0-9]{40}$/.test(options.sourceRevision) && raw.recipe.sourceRevision === options.sourceRevision && !raw.recipe.sourceDirty, 'Qualification source does not match the verified workflow artifact');
    if (options.backend === 'r2') invariant(raw.source.provider === 'NOAA' && !raw.tool.fixture, 'Remote drill requires a real NOAA build');
    const original = await validateBuild(options.root, raw, await readCoverage(options.root, raw.coverage.hash), raw.coverage.hash);
    invariant(Date.parse(original.expiresAt) > Math.max(now(), Date.now()) + 26 * 3600000, 'Qualification requires at least 26 hours of remaining retention for its advanced-clock cleanup drill');
    receipt.input = { manifestSha256: sha256(bytes), buildId: original.buildId, cycle: original.cycle, recipeHash: original.recipe.hash, samplesSha256: original.samples.sha256 };
    const clones: Manifest[] = [];
    for (const name of ['a', 'b']) { options.signal?.throwIfAborted(); console.log(JSON.stringify({ event: 'qualification-validating-successor', name })); clones.push(await cloneBuild(options.root, original, join(temporary, name), now())); }
    const files = forecastObjects(original), failedKey = files[1].key;
    await stage('interrupted-artifact-upload', async () => {
      let uploaded!: () => void; const first = new Promise<void>(resolve => { uploaded = resolve; });
      const interrupted: ObjectStorage = { ...store, async put(key, ...args) {
        if (key === failedKey) { await first; throw new Error('Injected interruption before artifact PUT'); }
        if (key === files[0].key) { try { await store.put(key, ...args); } finally { uploaded(); } }
        else await store.put(key, ...args);
      } };
      const error = await expectFailure(() => publish(interrupted, options.root, original, { authority: options.authority, now, signal: options.signal }), /Injected interruption/);
      invariant(await pointer() === null, 'Interrupted upload promoted a pointer');
      const partial = (await store.list(`builds/gfs/${original.buildId}/`)).length;
      invariant(partial > 0 && partial < files.length, 'Interruption did not leave a partial upload');
      return { injected: true, partialObjects: partial, pointerAbsent: true, error };
    });
    await stage('resume-ambiguous-put-and-pointer', async () => {
      let put = false, cas = false;
      const ambiguous: ObjectStorage = { ...store, async put(key, ...args) {
        await store.put(key, ...args);
        if (key === failedKey && !put) { put = true; throw new Error('Injected lost successful PUT response'); }
        if (key === pointerKey && !cas) { cas = true; throw new Error('Injected lost successful CAS response'); }
      } };
      await publish(ambiguous, options.root, original, { authority: options.authority, now, signal: options.signal });
      invariant(put && cas && (await pointer())?.value.latestBuildId === original.buildId, 'Ambiguous success was not reconciled');
      return { lostPutResponse: put, lostCasResponse: cas, resumed: true };
    });
    await stage('same-build-idempotency', async () => {
      const before = await pointer(), puts = counts.puts;
      await publish(store, options.root, original, { authority: options.authority, now, signal: options.signal });
      await unchangedPointer(before); invariant(counts.puts === puts, 'Idempotent replay rewrote an object');
      return { immutableObjectsProved: files.length + 6, writes: 0, pointerUnchanged: true };
    });
    await stage('same-cycle-requires-intent', async () => {
      const before = await pointer(), puts = counts.puts;
      const error = await expectFailure(() => publish(store, join(temporary, 'a'), clones[0], { authority: options.authority, now }), /Same-cycle replacement/);
      await unchangedPointer(before); invariant(counts.puts === puts, 'Unapproved same-cycle attempt wrote objects');
      return { rejected: true, writes: 0, error };
    });
    let winner = 0;
    await stage('independent-writers-cas-conflict', async () => {
      let arrivals = 0, release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const initialEtags: string[] = [], attempts = [0, 0];
      const writers = [store, second].map((client, index): ObjectStorage => {
        let captured = false;
        return { ...client, async get(key, ...args) {
          const object = await client.get(key, ...args);
          if (key === pointerKey && !captured) { captured = true; invariant(object, 'Initial race pointer missing'); initialEtags.push(object.etag); if (++arrivals === 2) release(); await barrier; }
          return object;
        }, async put(key, ...args) { if (key === pointerKey) attempts[index]++; return client.put(key, ...args); } };
      });
      const timeout = setTimeout(release, 120_000);
      let results: PromiseSettledResult<void>[];
      try { results = await Promise.allSettled(writers.map((writer, i) => publish(writer, join(temporary, i ? 'b' : 'a'), clones[i], { authority: options.authority, now, signal: options.signal, allowSameCycle: true }))); }
      finally { clearTimeout(timeout); }
      invariant(arrivals === 2 && initialEtags[0] === initialEtags[1] && attempts.every(value => value === 1), 'Race did not use two independent CAS attempts against one ETag');
      invariant(results.filter(result => result.status === 'fulfilled').length === 1, 'CAS race did not produce exactly one winner');
      winner = results.findIndex(result => result.status === 'fulfilled');
      const conflict = (results[1 - winner] as PromiseRejectedResult).reason as { $metadata?: { httpStatusCode?: number } };
      const conflictStatus = conflict?.$metadata?.httpStatusCode;
      invariant(conflictStatus === 409 || conflictStatus === 412 || (options.backend === 'memory' && /precondition|conflict/i.test(text(conflict))), 'Losing writer did not report a conditional-write conflict');
      const current = await pointer();
      invariant(current?.value.latestBuildId === clones[winner].buildId && current.value.retained.some(item => item.buildId === original.buildId) && !current.value.retained.some(item => item.buildId === clones[1 - winner].buildId), 'CAS conflict lost or invented a retained build');
      return { initialEtags, attempts, conflictStatus, winner: clones[winner].buildId, loser: clones[1 - winner].buildId, loserError: text((results[1 - winner] as PromiseRejectedResult).reason), originalRetained: true, intentionalSameCycleSuccessor: true };
    });
    await stage('rollback-verifies-complete-build', async () => {
      const readKeys = new Set<string>();
      const observed: ObjectStorage = { ...store, async get(key, range, maxBytes) { if (range) readKeys.add(key); return store.get(key, range, maxBytes); } };
      await rollback(observed, 'gfs', original.buildId, options.authority, now());
      const expected = [...files.map(file => file.key), ...['output', 'halo', 'tiles'].map(name => `coverage/${original.coverage.hash}/${name}.bin`)];
      invariant(expected.every(key => readKeys.has(key)), 'Rollback did not verify every artifact and coverage bitset');
      invariant((await pointer())?.value.latestBuildId === original.buildId, 'Rollback did not restore the original');
      return { verifiedPayloads: expected.length, allArtifactAndCoverageRangesObserved: true, latest: original.buildId };
    });
    const restore = async (key: string, bytes: Uint8Array) => {
      const head = await store.head(key);
      await store.put(key, bytes, head ? { ifMatch: head.etag } : { ifNoneMatch: '*' }, 'application/octet-stream', createHash('md5').update(bytes).digest('base64'));
    };
    const chosen = clones[winner];
    for (const defect of ['corrupt provenance', 'missing provenance', 'corrupt coverage', 'corrupt artifact']) await stage(`reject-${defect.replaceAll(' ', '-')}`, async () => {
      const key = defect.includes('provenance') ? chosen.source.provenanceKey : defect.includes('coverage') ? `coverage/${chosen.coverage.hash}/output.bin` : chosen.artifacts.at(-1)!.tilesKey;
      const saved = await store.get(key, undefined, defect.includes('artifact') ? 256 * 1024 * 1024 : defect.includes('provenance') ? MAX_PROVENANCE_BYTES : 512 * 1024); invariant(saved, 'Defect target missing');
      const before = await pointer();
      try {
        if (defect.startsWith('missing')) await store.delete([key]);
        else { const bytes = Uint8Array.from(saved.bytes); bytes[Math.floor(bytes.length / 2)] ^= 1; await restore(key, bytes); }
        const error = await expectFailure(() => rollback(store, 'gfs', chosen.buildId, options.authority, now()), /provenance|Rollback object/);
        await unchangedPointer(before);
        return { injected: defect, rejected: true, pointerUnchanged: true, error };
      } finally { await restore(key, saved.bytes); }
    });
    await stage('maintenance-grace-and-retained-protection', async () => {
      const wallClock = Date.now(), logicalClock = Math.max(now(), wallClock) + 25 * 3600000;
      const stale = `builds/gfs/${buildId(wallClock - 48 * 3600000)}/stale.marker`, fresh = `builds/gfs/${buildId(logicalClock - 3600000)}/fresh.marker`;
      await store.put(stale, Uint8Array.of(1), { ifNoneMatch: '*' }); await store.put(fresh, Uint8Array.of(2), { ifNoneMatch: '*' });
      const before = await pointer(); invariant(before, 'Maintenance pointer missing');
      const protectedKeys = (await store.list('builds/gfs/')).filter(item => before.value.retained.some(retained => item.key.startsWith(`builds/gfs/${retained.buildId}/`))).map(item => item.key);
      const deleted = await cleanup(store, 'gfs', options.authority, logicalClock), after = new Set((await store.list('builds/gfs/')).map(item => item.key));
      invariant(deleted > 0 && !after.has(stale) && after.has(fresh) && protectedKeys.every(key => after.has(key)) && ![...after].some(key => key.startsWith(`builds/gfs/${clones[1 - winner].buildId}/`)), 'Cleanup grace or retained protection failed');
      await unchangedPointer(before);
      return { wallClock: new Date(wallClock).toISOString(), advancedLogicalClock: new Date(logicalClock).toISOString(), clockAdvanceHours: (logicalClock - wallClock) / 3600000, wallTimeAgedObjectProof: false, deletedObjects: deleted, protectedRetainedObjects: protectedKeys.length, freshObjectProtected: true, losingUnretainedBuildDeleted: true };
    });
    receipt.passed = true;
  } catch (error) { receipt.error = text(error); }
  finally {
    receipt.cleanup = { attempted: false, scope: namespace, reason: 'namespace-not-claimed', emptyProved: false };
    if (ownsNamespace) {
      try {
        const remaining = await store.list(''); await store.delete(remaining.map(item => item.key));
        const final = await store.list(''); invariant(final.length === 0, 'Qualification namespace cleanup is incomplete');
        receipt.cleanup = { attempted: true, scope: namespace, deletedObjects: remaining.length, remainingObjects: 0, emptyProved: true };
      } catch (error) { receipt.passed = false; receipt.cleanup = { attempted: true, scope: namespace, error: text(error), emptyProved: false }; }
    }
    await rm(temporary, { recursive: true, force: true }); receipt.elapsedMs = Date.now() - started; await save();
  }
  return receipt;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, manifest: { type: 'string' }, root: { type: 'string' }, receipt: { type: 'string', default: 'output/publication-qualification.json' } } });
  const usage = 'Usage: --manifest FILE [--root OUTPUT_ROOT] [--receipt FILE]\nStaging Forecast maintenance workflow only. Uses qualification/<random-uuid>/, then deletes only that namespace and proves it empty.';
  if (values.help) { console.log(usage); return; }
  invariant(values.manifest, usage);
  invariant(process.env.GITHUB_WORKFLOW === 'Forecast maintenance' && process.env.TARGET_ENV === 'staging' && process.env.R2_BUCKET === 'windy-av-layer-staging', 'Qualification requires the staging maintenance workflow and staging bucket');
  const sourceRevision = process.env.SOURCE_BUILD_REVISION;
  invariant(/^[a-f0-9]{40}$/.test(sourceRevision ?? ''), 'Qualification requires a verified forecast artifact source revision');
  const authority = workflowAuthority(), manifestPath = resolve(values.manifest), root = values.root ? resolve(values.root) : resolve(dirname(manifestPath), '../../..'), controller = new AbortController();
  const abort = () => controller.abort(new Error('Publication qualification interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const receipt = await qualifyPublication({ store: r2Storage(), secondStore: r2Storage(), root, manifestPath, authority, backend: 'r2', sourceRevision, receiptPath: resolve(values.receipt!), signal: controller.signal });
    console.log(JSON.stringify({ passed: receipt.passed, namespace: receipt.namespace, cleanup: receipt.cleanup, receipt: resolve(values.receipt!) }));
    if (!receipt.passed) process.exitCode = 1;
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
