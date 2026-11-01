// Dedicated local workerd harness. Never used by the production entrypoint.
import { MaterializedReads, readObjectBytes } from '../src/resources';
const reads = new MaterializedReads<Uint8Array>();
let loads = 0;
export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket }, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/seed') { await env.BUCKET.put('value', Uint8Array.of(7, 8, 9)); loads = 0; return new Response('ok'); }
    if (path === '/stats') return Response.json({ loads });
    const bytes = await reads.run('value', async () => {
      loads++;
      const object = await env.BUCKET.get('value');
      if (!object) throw new Error('Missing test value');
      // Keep a real R2 body owned by the initiating request while another request joins.
      await new Promise(resolve => setTimeout(resolve, 200));
      return readObjectBytes(object, 1024);
    }, ctx);
    return Response.json({ bytes: Array.from(bytes), loads });
  }
};
