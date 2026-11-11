// Local workerd harness for real R2 bodies, request cancellation and Cache API.
import { MaterializedReads, readObjectBytes } from '../src/resources';
import { cached, json, response } from '../src/http';

const reads = new MaterializedReads<Uint8Array>(1);
const state = { loads: 0, waiters: 0, aborted: 0, queuedLoads: 0, cacheReady: false, discoveryReady: false };
let released = false, cancelWaiters = false;
let discoveryLoads = 0, discoveryUntil = 0;

export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket }, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/seed') {
      await env.BUCKET.put('value', Uint8Array.of(7, 8, 9));
      discoveryUntil = Date.now() + 15_000;
      return new Response('ok');
    }
    if (path === '/stats') return Response.json(state);
    if (path === '/cancel') { cancelWaiters = true; return new Response('ok'); }
    if (path === '/release') { released = true; return new Response('ok'); }
    if (path === '/cached' || path === '/discovery') {
      const discovery = path === '/discovery';
      const observed = { waitUntil(promise: Promise<unknown>) {
        ctx.waitUntil(promise.then(() => { state[discovery ? 'discoveryReady' : 'cacheReady'] = true; }));
      } };
      if (discovery) return cached(request, undefined, observed,
        async () => json({ loads: ++discoveryLoads }), 'discovery-test-v1', discoveryUntil);
      return cached(request, new Date(Date.now() + 600_000).toISOString(), observed,
        async () => response(new Uint8Array(20 * 1024), 'application/octet-stream'));
    }
    const queued = path === '/queued';
    const cancel = queued || path === '/owner' ? new AbortController() : undefined;
    const signal = cancel ? AbortSignal.any([request.signal, cancel.signal]) : request.signal;
    if (cancel) ctx.waitUntil((async () => {
      while (!released && !cancelWaiters) await scheduler.wait(5);
      if (cancelWaiters) cancel.abort();
    })());
    const read = reads.run(queued ? 'queued' : 'value', async ownerSignal => {
      if (queued) state.queuedLoads++;
      else state.loads++;
      const object = await env.BUCKET.get('value');
      if (!object) throw new Error('Missing test value');
      while (!released) await scheduler.wait(5, { signal: ownerSignal });
      return readObjectBytes(object, 1024, false, undefined, ownerSignal);
    }, ctx, signal);
    state.waiters++;
    const result = read.then(bytes => Response.json({ bytes: Array.from(bytes), loads: state.loads }), error => {
      if (!signal.aborted) throw error;
      state.aborted++;
      return new Response(null, { status: 499 });
    });
    if (cancel) ctx.waitUntil(result.then(() => {}));
    return result;
  }
};
