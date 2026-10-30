export type Cleanup = () => void;

export class Lifecycle {
  private readonly controller = new AbortController();
  private readonly cleanups = new Set<Cleanup>();
  private disposed = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  add(cleanup: Cleanup): void {
    if (this.disposed) {
      cleanup();
      return;
    }
    this.cleanups.add(cleanup);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const cleanup of [...this.cleanups].reverse()) {
      this.cleanups.delete(cleanup);
      cleanup();
    }
    this.controller.abort();
  }
}
