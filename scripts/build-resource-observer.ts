import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export function processTreeRss(stdout: string, rootPid: number): number {
  const rows = stdout.trim().split('\n').flatMap(line => {
    const cells = line.trim().split(/\s+/).map(Number);
    return cells.length === 3 && cells.every(Number.isSafeInteger) ? [{ pid: cells[0], parent: cells[1], rss: cells[2] * 1024 }] : [];
  });
  const admitted = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (admitted.has(row.parent) && !admitted.has(row.pid)) { admitted.add(row.pid); changed = true; }
  }
  return rows.reduce((sum, row) => sum + (admitted.has(row.pid) ? row.rss : 0), 0);
}
async function diskBytes(root: string): Promise<number> {
  const items = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let bytes = 0;
  for (const item of items) {
    const path = join(root, item.name);
    if (item.isDirectory()) bytes += await diskBytes(path);
    else if (item.isFile()) {
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info) bytes += info.blocks * 512;
    }
  }
  return bytes;
}

/** Passive one-second observations; short-lived peaks can occur between samples. */
export function observeBuildResources(pid: number, root: string, temporary: string) {
  const report = { intervalMs: 1000, observations: 0, peakObservedProcessTreeRssBytes: 0, peakObservedAllocatedDiskBytes: 0, peakObservedTemporaryDiskBytes: 0, errors: [] as string[], limitations: 'Sampled process-tree RSS includes observed descendants; short-lived peaks can be missed. Disk uses allocated 512-byte blocks under the run output and its private TMPDIR. Shared input cache and dependencies are excluded.' };
  let pending: Promise<void> | undefined;
  const sample = () => {
    if (pending) return;
    pending = (async () => {
      const [processes, total, temporaryBytes] = await Promise.all([
        promisify(execFile)('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }), diskBytes(root), diskBytes(temporary)
      ]);
      report.observations++;
      report.peakObservedProcessTreeRssBytes = Math.max(report.peakObservedProcessTreeRssBytes, processTreeRss(processes.stdout, pid));
      report.peakObservedAllocatedDiskBytes = Math.max(report.peakObservedAllocatedDiskBytes, total);
      report.peakObservedTemporaryDiskBytes = Math.max(report.peakObservedTemporaryDiskBytes, temporaryBytes);
    })().catch(error => { if (report.errors.length < 8) report.errors.push(String(error)); }).finally(() => { pending = undefined; });
  };
  sample();
  const timer = setInterval(sample, report.intervalMs); timer.unref();
  return { async stop() { clearInterval(timer); await pending; return report; } };
}
