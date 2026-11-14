import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';

const SESSION_URL = 'https://tile.googleapis.com/v1/createSession';
const TILES_URL = 'https://tile.googleapis.com/v1/2dtiles';
const VIEWPORT_URL = 'https://tile.googleapis.com/tile/v1/viewport';
const SOURCE_ID = 'google-terrain', MAX_ZOOM = 22, GOOGLE_ATTRIBUTION = 'Google Maps', STORAGE_KEY = 'av.google-terrain';

interface Session { token: string; expiresAtMs: number; tileSize: number }
const sessions = new Map<string, Session>();

export interface TerrainBasemap {
  readonly style: StyleSpecification;
  readonly attribution: string;
  attach(map: MapLibreMap): void;
  dispose(): void;
}

function keyHash(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

function readStored(id: string): Session | null {
  try {
    const parsed = JSON.parse(globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? '') as Partial<Session> & { id?: unknown };
    return parsed?.id === id && typeof parsed.token === 'string' && parsed.token && typeof parsed.expiresAtMs === 'number' && parsed.expiresAtMs > Date.now() + 30_000 && typeof parsed.tileSize === 'number' && parsed.tileSize > 0
      ? { token: parsed.token, expiresAtMs: parsed.expiresAtMs, tileSize: parsed.tileSize } : null;
  } catch { return null; }
}

async function sessionFor(key: string, signal?: AbortSignal): Promise<Session> {
  const id = keyHash(key), cached = sessions.get(key) ?? readStored(id);
  if (cached && cached.expiresAtMs > Date.now()) { sessions.set(key, cached); return cached; }
  const res = await fetch(`${SESSION_URL}?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'terrain', language: 'en-US', region: 'US', layerTypes: ['layerRoadmap'] }), signal
  });
  if (!res.ok) throw new Error(`Google Maps terrain session failed: ${res.status}`);
  const body = await res.json() as { session?: unknown; expiry?: unknown; tileWidth?: unknown; tileHeight?: unknown };
  const expiry = Number(body.expiry), w = Number(body.tileWidth), h = Number(body.tileHeight);
  if (typeof body.session !== 'string' || !body.session || !Number.isFinite(expiry) || expiry * 1000 <= Date.now()) throw new Error('Invalid session');
  const session = { token: body.session, expiresAtMs: expiry * 1000, tileSize: w > 0 ? w : h > 0 ? h : 256 };
  sessions.set(key, session);
  try { globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify({ id, ...session })); } catch { /* ignore */ }
  return session;
}

const tileUrls = (key: string, token: string) => [`${TILES_URL}/{z}/{x}/{y}?session=${encodeURIComponent(token)}&key=${encodeURIComponent(key)}`];

export async function googleTerrainStyle(key: string, signal?: AbortSignal): Promise<TerrainBasemap> {
  if (!key.trim()) throw new Error('A Google Maps API key is required');
  signal?.throwIfAborted();
  let session = await sessionFor(key, signal);
  const style: StyleSpecification = {
    version: 8,
    sources: { [SOURCE_ID]: { type: 'raster', tiles: tileUrls(key, session.token), tileSize: session.tileSize, maxzoom: MAX_ZOOM, attribution: GOOGLE_ATTRIBUTION } },
    layers: [{ id: SOURCE_ID, type: 'raster', source: SOURCE_ID }]
  };
  let attribution = GOOGLE_ATTRIBUTION, attached: MapLibreMap | null = null, disposed = false;
  let viewportReq: AbortController | null = null, renewal: AbortController | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null, warning: HTMLElement | null = null;

  const setTiles = (tiles: string[]) => (attached?.getSource(SOURCE_ID) as { setTiles(t: string[]): unknown } | undefined)?.setTiles(tiles);
  const scheduleExpiry = () => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(expire, Math.min(2_147_483_647, Math.max(0, session.expiresAtMs - Date.now())));
  };

  const updateAttribution = (): void => {
    if (!attached || disposed) return;
    if (Date.now() >= session.expiresAtMs) { expire(); return; }
    viewportReq?.abort();
    const req = new AbortController(); viewportReq = req;
    const bounds = attached.getBounds(), west = bounds.getWest(), east = bounds.getEast();
    const span = east >= west ? east - west : ((east - west) % 360 + 360) % 360;
    const start = ((west + 180) % 360 + 360) % 360 - 180;
    const intervals = span >= 360 ? [[-180, 180]] : start + span > 180 ? [[start, 180], [-180, start + span - 360]] : [[start, start + span]];
    const base = new URLSearchParams({
      session: session.token, key, zoom: String(Math.max(0, Math.min(MAX_ZOOM, Math.round(attached.getZoom())))),
      north: String(Math.min(90, Math.max(-90, bounds.getNorth()))), south: String(Math.min(90, Math.max(-90, bounds.getSouth())))
    });
    void Promise.all(intervals.map(async ([l, r]) => {
      const q = new URLSearchParams(base); q.set('west', String(l)); q.set('east', String(r));
      const res = await fetch(`${VIEWPORT_URL}?${q}`, { signal: req.signal });
      return res.ok ? res.json() as Promise<{ copyright?: unknown }> : null;
    })).then(bodies => {
      if (req.signal.aborted || !attached || disposed) return;
      const copyrights = [...new Set(bodies.map(b => typeof b?.copyright === 'string' ? b.copyright.trim() : '').filter(Boolean))];
      if (!copyrights.length) return;
      attribution = `${GOOGLE_ATTRIBUTION} · ${copyrights.join(' · ')}`;
      const source = attached.getSource(SOURCE_ID) as { attribution?: string } | undefined;
      if (source) source.attribution = attribution;
      attached.fire('sourcedata', { dataType: 'source', sourceId: SOURCE_ID, sourceDataType: 'metadata' } as never);
    }).catch(() => {}).finally(() => { if (viewportReq === req) viewportReq = null; });
  };

  const expire = (): void => {
    expiryTimer = null;
    if (disposed || !attached) return;
    if (Date.now() < session.expiresAtMs) { scheduleExpiry(); return; }
    viewportReq?.abort(); setTiles([]);
    if (renewal) return;
    if (!warning && typeof document !== 'undefined') {
      warning = document.createElement('p'); warning.className = 'toast basemap-warning'; warning.setAttribute('role', 'status');
      warning.textContent = 'Google terrain session expired. Renewing basemap.';
      document.getElementById('app')?.append(warning);
    }
    const req = new AbortController(); renewal = req;
    void sessionFor(key, AbortSignal.any([req.signal, AbortSignal.timeout(10_000)])).then(next => {
      if (req.signal.aborted || disposed || !attached) return;
      session = next; setTiles(tileUrls(key, next.token));
      warning?.remove(); warning = null; scheduleExpiry(); updateAttribution();
    }).catch(() => {
      if (!req.signal.aborted && warning) warning.textContent = 'Google terrain unavailable. Basemap session renewal failed.';
    }).finally(() => { if (renewal === req) renewal = null; });
  };

  const onLoad = (): void => { if (attached && !disposed) { if (Date.now() >= session.expiresAtMs) expire(); else { setTiles(tileUrls(key, session.token)); updateAttribution(); } } };
  const detach = (): void => { if (attached) { attached.off('load', onLoad); attached.off('moveend', updateAttribution); attached = null; } };

  return {
    style,
    get attribution() { return attribution; },
    attach(map) {
      if (disposed || attached === map) return;
      detach(); attached = map; map.on('load', onLoad); map.on('moveend', updateAttribution);
      if (Date.now() >= session.expiresAtMs) expire(); else { scheduleExpiry(); updateAttribution(); }
    },
    dispose() {
      disposed = true; viewportReq?.abort(); renewal?.abort(); viewportReq = renewal = null;
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      warning?.remove(); warning = null; detach();
    }
  };
}
