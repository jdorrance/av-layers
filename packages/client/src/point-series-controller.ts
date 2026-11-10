import type { ApiClient } from './client-api.ts';
import { pointSeriesSelection } from './client-point.ts';
import type { GeoPoint, PinnedBuild, PointHorizon, PointSeries, PointSeriesLoader } from './client-types.ts';

export interface PointSeriesContext {
  readonly build: PinnedBuild;
  readonly point: Readonly<GeoPoint>;
}

interface PointSeriesView {
  onLoading(): void;
  onProgress(series: PointSeries, totalFrames: number, loading: boolean): void;
  onError(message: string): void;
  canRender?(): boolean;
  prepare?(): Promise<void>;
}

function selectPointFrame(frames: readonly string[], preferred: string | null, fallback: string | null): string | null {
  if (preferred !== null && frames.includes(preferred)) return preferred;
  if (fallback !== null && frames.includes(fallback)) return fallback;
  return frames[0] ?? null;
}

/** Own one open point's pinned loader, horizon, and selected hour. */
export class PointSeriesController {
  private opened: { context: PointSeriesContext; loader: PointSeriesLoader } | null = null;
  private request: AbortController | null = null;
  private frames: readonly string[] = [];
  private selected: string | null = null;

  constructor(private readonly api: Pick<ApiClient, 'pointSeries'>) {}

  get current(): PointSeriesContext | null { return this.opened?.context ?? null; }
  get frameId(): string | null { return this.selected; }
  get pending(): boolean { return this.request !== null; }

  open(build: PinnedBuild, point: GeoPoint): void {
    this.close();
    const context = { build, point: { ...point } };
    this.opened = { context, loader: this.api.pointSeries(build, context.point) };
  }

  close(): void {
    const opened = this.opened, request = this.request;
    this.opened = null;
    this.request = null;
    this.frames = [];
    this.selected = null;
    request?.abort();
    opened?.loader.dispose();
  }

  followMapFrame(id: string | null): void {
    this.selected = selectPointFrame(this.frames, id, this.selected);
  }

  selectFrame(context: PointSeriesContext, id: string): boolean {
    if (this.current !== context || !this.frames.includes(id)) return false;
    this.selected = id;
    return true;
  }

  async load(horizon: PointHorizon, mapFrameId: string | null, view: PointSeriesView): Promise<void> {
    const opened = this.opened;
    if (!opened) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.frames = pointSeriesSelection(opened.context.build, horizon).frames;
    this.selected = selectPointFrame(this.frames, this.selected, mapFrameId);
    const current = () => this.request === request && !request.signal.aborted && (view.canRender?.() ?? true);
    let ready = !view.prepare;
    let buffered: Parameters<PointSeriesView['onProgress']> | undefined;
    try {
      if (!current()) return;
      view.onLoading();
      if (this.request !== request) return;
      const preparation = view.prepare ? Promise.race([
        view.prepare(),
        new Promise<never>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        })
      ]).then(() => {
        ready = true;
        if (buffered && current()) view.onProgress(...buffered);
        buffered = undefined;
      }) : undefined;
      const loading = opened.loader.load(horizon, request.signal, {
        frameId: this.selected,
        onProgress(series, totalFrames, loading) {
          if (!current()) return;
          if (ready) view.onProgress(series, totalFrames, loading);
          else buffered = [series, totalFrames, loading];
        }
      });
      if (preparation) {
        await Promise.all([preparation, loading.catch(async error => { await preparation; throw error; })]);
      } else await loading;
    } catch (error) {
      if (!current()) return;
      request.abort();
      view.onError(error instanceof Error ? error.message : String(error));
    } finally {
      buffered = undefined;
      if (this.request === request) this.request = null;
    }
  }
}
