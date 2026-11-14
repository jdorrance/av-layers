import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';

const SESSION_URL = 'https://tile.googleapis.com/v1/createSession';
const TILES_URL = 'https://tile.googleapis.com/v1/2dtiles';
const VIEWPORT_URL = 'https://tile.googleapis.com/tile/v1/viewport';
const SOURCE_ID = 'google-terrain';
const MAX_ZOOM = 22;
const DEFAULT_TILE_SIZE = 256;
const GOOGLE_ATTRIBUTION = 'Google Maps';

interface Session {
  token: string;
  expiresAtMs: number;
  tileSize: number;
}

interface SessionResponse {
  session?: unknown;
  expiry?: unknown;
  tileWidth?: unknown;
  tileHeight?: unknown;
}

interface ViewportResponse {
  copyright?: unknown;
}

const sessions = new Map<string, Session>();

export interface TerrainBasemap {
  readonly style: StyleSpecification;
  readonly attribution: string;
  attach(map: MapLibreMap): void;
  dispose(): void;
}

async function sessionFor(key: string, signal?: AbortSignal): Promise<Session> {
  const cached = sessions.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached;
  const response = await fetch(`${SESSION_URL}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'terrain', language: 'en-US', region: 'US', layerTypes: ['layerRoadmap'] }),
    signal
  });
  if (!response.ok) throw new Error(`Google Maps terrain session failed: ${response.status}`);
  const body = await response.json() as SessionResponse;
  const expiry = Number(body.expiry);
  const width = Number(body.tileWidth);
  const height = Number(body.tileHeight);
  if (typeof body.session !== 'string' || body.session === '' || !Number.isFinite(expiry) || expiry * 1000 <= Date.now()) {
    throw new Error('Google Maps terrain session response is invalid');
  }
  const tileSize = Number.isFinite(width) && width > 0 ? width : Number.isFinite(height) && height > 0 ? height : DEFAULT_TILE_SIZE;
  const session = { token: body.session, expiresAtMs: expiry * 1000, tileSize };
  sessions.set(key, session);
  return session;
}

function styleFor(key: string, session: Session): StyleSpecification {
  return {
    version: 8,
    sources: {
      [SOURCE_ID]: {
        type: 'raster',
        tiles: [`${TILES_URL}/{z}/{x}/{y}?session=${encodeURIComponent(session.token)}&key=${encodeURIComponent(key)}`],
        tileSize: session.tileSize,
        maxzoom: MAX_ZOOM,
        attribution: GOOGLE_ATTRIBUTION
      }
    },
    layers: [{ id: SOURCE_ID, type: 'raster', source: SOURCE_ID }]
  };
}

export async function googleTerrainStyle(key: string, signal?: AbortSignal): Promise<TerrainBasemap> {
  if (key.trim() === '') throw new Error('A Google Maps API key is required');
  signal?.throwIfAborted();
  let session = await sessionFor(key, signal);
  const style = styleFor(key, session);
  let attribution = GOOGLE_ATTRIBUTION;
  let attached: MapLibreMap | null = null;
  let viewportRequest: AbortController | null = null;
  let renewal: AbortController | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let warning: HTMLElement | null = null;
  let disposed = false;

  const updateAttribution = (): void => {
    if (!attached || disposed) return;
    if (Date.now() >= session.expiresAtMs) { expire(); return; }
    viewportRequest?.abort();
    const request = new AbortController();
    viewportRequest = request;
    const bounds = attached.getBounds();
    const west = bounds.getWest(), east = bounds.getEast();
    const span = east >= west ? east - west : ((east - west) % 360 + 360) % 360;
    const start = ((west + 180) % 360 + 360) % 360 - 180;
    const intervals = span >= 360 ? [[-180, 180]] : start + span > 180 ? [[start, 180], [-180, start + span - 360]] : [[start, start + span]];
    const params = new URLSearchParams({
      session: session.token,
      key,
      zoom: String(Math.max(0, Math.min(MAX_ZOOM, Math.round(attached.getZoom())))),
      north: String(Math.min(90, Math.max(-90, bounds.getNorth()))),
      south: String(Math.min(90, Math.max(-90, bounds.getSouth())))
    });
    void Promise.all(intervals.map(async ([left, right]) => {
      const query = new URLSearchParams(params);
      query.set('west', String(left)); query.set('east', String(right));
      const response = await fetch(`${VIEWPORT_URL}?${query}`, { signal: request.signal });
      return response.ok ? response.json() as Promise<ViewportResponse> : null;
    }))
      .then(bodies => {
        if (request.signal.aborted || !attached || disposed) return;
        const copyrights = [...new Set(bodies.map(body => typeof body?.copyright === 'string' ? body.copyright.trim() : '').filter(Boolean))];
        if (!copyrights.length) return;
        attribution = `${GOOGLE_ATTRIBUTION} · ${copyrights.join(' · ')}`;
        const source = attached.getSource(SOURCE_ID) as { attribution?: string } | undefined;
        if (source) source.attribution = attribution;
        attached.fire('sourcedata', { dataType: 'source', sourceId: SOURCE_ID, sourceDataType: 'metadata' } as never);
      })
      .catch(() => {})
      .finally(() => { if (viewportRequest === request) viewportRequest = null; });
  };

  const scheduleExpiry = (): void => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(expire, Math.min(2_147_483_647, Math.max(0, session.expiresAtMs - Date.now())));
  };

  const expire = (): void => {
    expiryTimer = null;
    if (disposed || !attached) return;
    if (Date.now() < session.expiresAtMs) { scheduleExpiry(); return; }
    viewportRequest?.abort();
    const source = attached.getSource(SOURCE_ID) as { setTiles(tiles: string[]): unknown } | undefined;
    source?.setTiles([]);
    if (renewal) return;
    if (!warning && typeof document !== 'undefined') {
      warning = document.createElement('p');
      warning.className = 'toast basemap-warning';
      warning.setAttribute('role', 'status');
      warning.textContent = 'Google terrain session expired. Renewing basemap.';
      document.getElementById('app')?.append(warning);
    }
    const request = new AbortController();
    renewal = request;
    void sessionFor(key, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]))
      .then(next => {
        if (request.signal.aborted || disposed || !attached) return;
        session = next;
        const tiles = (styleFor(key, next).sources![SOURCE_ID] as { tiles: string[] }).tiles;
        (attached.getSource(SOURCE_ID) as { setTiles(tiles: string[]): unknown } | undefined)?.setTiles(tiles);
        warning?.remove(); warning = null;
        scheduleExpiry();
        updateAttribution();
      })
      .catch(() => {
        if (!request.signal.aborted && warning) warning.textContent = 'Google terrain unavailable. Basemap session renewal failed.';
      })
      .finally(() => { if (renewal === request) renewal = null; });
  };

  const onLoad = (): void => {
    if (!attached || disposed) return;
    if (Date.now() >= session.expiresAtMs) { expire(); return; }
    const source = attached.getSource(SOURCE_ID) as { setTiles(tiles: string[]): unknown } | undefined;
    const tiles = (styleFor(key, session).sources![SOURCE_ID] as { tiles: string[] }).tiles;
    source?.setTiles(tiles);
    updateAttribution();
  };

  const detach = (): void => {
    if (!attached) return;
    attached.off('load', onLoad);
    attached.off('moveend', updateAttribution);
    attached = null;
  };

  return {
    style,
    get attribution() { return attribution; },
    attach(map) {
      if (disposed || attached === map) return;
      detach();
      attached = map;
      map.on('load', onLoad);
      map.on('moveend', updateAttribution);
      if (Date.now() >= session.expiresAtMs) expire();
      else { scheduleExpiry(); updateAttribution(); }
    },
    dispose() {
      disposed = true;
      viewportRequest?.abort();
      viewportRequest = null;
      renewal?.abort(); renewal = null;
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      warning?.remove(); warning = null;
      detach();
    }
  };
}
