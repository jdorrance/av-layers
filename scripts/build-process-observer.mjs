import { writeFileSync } from 'node:fs';
import { PerformanceObserver } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

// Identical passive preload for baseline and candidate, without editing either implementation.
if (isMainThread) {
  const output = process.env.AV_BUILD_OBSERVER_OUTPUT;
  if (!output) throw new Error('Build observer output path is required');
  const gc = { count: 0, durationMs: 0, byKind: {} };
  const collect = entries => {
    for (const entry of entries) {
      gc.count++; gc.durationMs += entry.duration;
      const kind = String(entry.detail.kind);
      const bucket = gc.byKind[kind] ??= { count: 0, durationMs: 0 };
      bucket.count++; bucket.durationMs += entry.duration;
    }
  };
  const observer = new PerformanceObserver(list => collect(list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  process.once('exit', code => {
    collect(observer.takeRecords()); observer.disconnect();
    writeFileSync(output, JSON.stringify({
      version: 1, exitCode: code, cpuMicroseconds: process.cpuUsage(), resourceUsage: process.resourceUsage(), gc,
      limitations: 'CPU/resource usage covers this Node process including worker threads, excluding child processes. GC observations cover the main V8 isolate only; no forced GC or allocated-byte inference.'
    }, null, 2));
  });
}
