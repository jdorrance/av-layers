/** Archive bounded forecast responses for checksum-verified offline comparison. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_CAPTURE_REQUEST_BYTES = 64 * 1024;
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_CAPTURE_FILE_BYTES = 6 * MAX_CAPTURE_BYTES + 128 * 1024;
const CAPTURE_TIMEOUT_MS = 20_000;
const WRITER_WAIT_MS = 2000;

export interface Capture {
  method: 'GET' | 'POST'; url: string; status: number; bytes: number; sha256: string; capturedAt: string; body: string;
  requestBodySha256?: string; requestBodyBytes?: number;
}
type CaptureRequest = { method?: 'GET'; requestBody?: never } | { method: 'POST'; requestBody: string };
type CaptureInput = Pick<Capture, 'url' | 'status' | 'body' | 'capturedAt'> & CaptureRequest;

export class MissingCaptureError extends Error {
  constructor(id: string) { super(`Missing captured response: ${id}`); this.name = 'MissingCaptureError'; }
}

function capturePath(dir: string, id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id)) throw new Error('Capture ID must be a short filename');
  return join(dir, `${id}.json`);
}

function validateUrl(value: string): void {
  if (Buffer.byteLength(value) > 16 * 1024) throw new Error('Capture URL exceeds byte budget');
  const url = new URL(value);
  if (url.username || url.password || [...url.searchParams.keys()].some(key => /auth|cookie|credential|token|secret|session|api[-_]?key/i.test(key))) {
    throw new Error('Capture URLs must omit credentials');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Capture URLs require HTTPS or loopback HTTP');
  }
}

const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function requestIdentity(input: CaptureRequest) {
  if (input.method === undefined || input.method === 'GET') {
    if (input.requestBody !== undefined) throw new Error('GET capture cannot include a request body');
    return { method: 'GET' as const };
  }
  if (input.method !== 'POST' || typeof input.requestBody !== 'string') throw new Error('POST capture requires a request body');
  const requestBodyBytes = Buffer.byteLength(input.requestBody);
  if (requestBodyBytes > MAX_CAPTURE_REQUEST_BYTES) throw new Error('Capture exceeds request byte budget');
  return { method: 'POST' as const, requestBodyBytes, requestBodySha256: digest(input.requestBody) };
}

export async function readCapture(dir: string, id: string,
  expected: { url?: string; method?: 'GET' | 'POST'; requestBody?: string } = {}): Promise<Capture> {
  const path = capturePath(dir, id);
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if (missing(error)) throw new MissingCaptureError(id); throw error; }
  let capture: Capture;
  try {
    if ((await file.stat()).size > MAX_CAPTURE_FILE_BYTES) throw new Error(`Capture file exceeds byte budget: ${id}`);
    capture = JSON.parse(await file.readFile('utf8')) as Capture;
  } finally { await file.close(); }
  const fields = capture?.method === 'POST' ? 'body,bytes,capturedAt,method,requestBodyBytes,requestBodySha256,sha256,status,url'
    : 'body,bytes,capturedAt,method,sha256,status,url';
  if (!capture || typeof capture !== 'object' || Object.keys(capture).sort().join(',') !== fields
    || !['GET', 'POST'].includes(capture.method) || typeof capture.body !== 'string' || typeof capture.url !== 'string'
    || !Number.isInteger(capture.status) || capture.status < 100 || capture.status > 599
    || !Number.isSafeInteger(capture.bytes) || capture.bytes < 0 || capture.bytes > MAX_CAPTURE_BYTES
    || typeof capture.capturedAt !== 'string' || !Number.isFinite(Date.parse(capture.capturedAt))
    || typeof capture.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(capture.sha256)) throw new Error(`Invalid captured response: ${id}`);
  if (capture.method === 'POST' && (!Number.isSafeInteger(capture.requestBodyBytes) || capture.requestBodyBytes! < 0
    || capture.requestBodyBytes! > MAX_CAPTURE_REQUEST_BYTES || typeof capture.requestBodySha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(capture.requestBodySha256))) throw new Error(`Invalid captured request: ${id}`);
  validateUrl(capture.url);
  if (Buffer.byteLength(capture.body) !== capture.bytes || digest(capture.body) !== capture.sha256) throw new Error(`Capture checksum or length mismatch: ${id}`);
  if (expected.url !== undefined && capture.url !== expected.url) throw new Error(`Capture URL differs: ${id}`);
  if (expected.method !== undefined || expected.requestBody !== undefined) {
    const request = requestIdentity(expected as CaptureRequest);
    if (capture.method !== request.method) throw new Error(`Capture method differs: ${id}`);
    if (capture.requestBodySha256 !== request.requestBodySha256 || capture.requestBodyBytes !== request.requestBodyBytes) {
      throw new Error(`Capture request body differs: ${id}`);
    }
  }
  return capture;
}

let writes: Promise<unknown> = Promise.resolve();

export function writeCapture(dir: string, id: string, input: CaptureInput): Promise<Capture> {
  const write = () => commitCapture(dir, id, input);
  const result = writes.then(write, write);
  writes = result.catch(() => undefined);
  return result;
}

async function commitCapture(dir: string, id: string, input: CaptureInput): Promise<Capture> {
  const path = capturePath(dir, id);
  validateUrl(input.url);
  const request = requestIdentity(input);
  if (typeof input.body !== 'string' || !Number.isInteger(input.status) || input.status < 100 || input.status > 599
    || !Number.isFinite(Date.parse(input.capturedAt))) throw new Error('Invalid capture body, status or timestamp');
  const bytes = Buffer.byteLength(input.body);
  if (bytes > MAX_CAPTURE_BYTES) throw new Error('Capture exceeds response byte budget');
  const capture: Capture = { ...request, url: input.url, status: input.status, bytes, sha256: digest(input.body), capturedAt: input.capturedAt, body: input.body };
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, '.capture-lock');
  const lock = await acquireWriterLock(lockPath);
  const temporary = join(dir, `.capture-${randomUUID()}.tmp`);
  try {
    try {
      const existing = await readCapture(dir, id, { url: input.url, method: request.method, requestBody: input.requestBody });
      if (existing.sha256 !== capture.sha256 || existing.bytes !== bytes || existing.status !== input.status) throw new Error(`Capture is immutable: ${id}`);
      return existing;
    } catch (error) { if (!(error instanceof MissingCaptureError)) throw error; }
    const encoded = JSON.stringify(capture);
    await reserveArchiveBytes(dir, Buffer.byteLength(encoded));
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(encoded); } finally { await file.close(); }
    await rename(temporary, path);
    return capture;
  } finally {
    await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}

async function acquireWriterLock(path: string) {
  const deadline = Date.now() + WRITER_WAIT_MS;
  let wait = 25;
  for (;;) {
    try { return await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Capture archive writer lock timed out');
      await delay(Math.min(wait, remaining));
      wait = Math.min(wait * 2, 100);
    }
  }
}

async function reserveArchiveBytes(dir: string, bytes: number): Promise<void> {
  const path = join(dir, '.capture-budget.json');
  let used: number;
  try {
    const budget = JSON.parse(await readFile(path, 'utf8')) as { bytes: number };
    used = budget.bytes;
    if (!Number.isSafeInteger(used) || used < 0) throw new Error('Invalid archive byte budget');
  } catch (error) {
    if (!missing(error)) throw error;
    used = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      used += (await stat(join(dir, entry.name))).size;
    }
  }
  if (used + bytes > MAX_ARCHIVE_BYTES) throw new Error('Capture archive exceeds total byte budget');
  // Reserve before publication so an interrupted commit cannot undercount stored bytes.
  const temporary = join(dir, '.capture-budget.tmp');
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify({ bytes: used + bytes })); } finally { await file.close(); }
  await rename(temporary, path);
}

export async function captureUrl(
  dir: string, id: string, url: string, options: { fetch?: typeof fetch; signal?: AbortSignal } & CaptureRequest = {}
): Promise<Capture> {
  validateUrl(url);
  const request = requestIdentity(options);
  try { return await readCapture(dir, id, { url, method: request.method, requestBody: options.requestBody }); }
  catch (error) { if (!(error instanceof MissingCaptureError)) throw error; }
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)]) : AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(url, { method: request.method, body: options.requestBody, redirect: 'error', signal });
    if ((response.status === 429 || response.status === 503) && attempt < 2) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after'), seconds = retry === null ? NaN : Number(retry);
      const requested = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 250 * (attempt + 1);
      await delay(Math.min(2000, Math.max(0, Number.isFinite(requested) ? requested : 250)), undefined, { signal });
      continue;
    }
    const body = await readBody(response, signal);
    return writeCapture(dir, id, { url, status: response.status, body, capturedAt: new Date().toISOString(),
      ...(options.method === 'POST' ? { method: 'POST', requestBody: options.requestBody } : { method: 'GET' }) });
  }
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CAPTURE_BYTES) throw new Error('Capture exceeds response byte budget');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
