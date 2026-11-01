import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelId } from '@av/contracts';
import type { PublicationAuthority } from './authority.js';
import { cleanup, rollback, type CleanupSummary } from './publication.js';
import type { ObjectStorage } from './storage.js';

export interface MaintenanceReceipt {
  version: 1; action: 'rollback' | 'cleanup'; model: ModelId; targetBuildId?: string;
  authority: PublicationAuthority; startedAt: string; updatedAt: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled'; cancellationRequested: boolean;
  rollbackOutcome: 'not-applicable' | 'not-attempted' | 'unconfirmed' | 'confirmed';
  summary: CleanupSummary | null; deletedObjects?: number; error?: string;
}

/** One small atomic journal, including during signal handling; no queued asynchronous writes. */
export async function maintenanceWorkflow(options: {
  action: 'rollback' | 'cleanup'; model: ModelId; buildId?: string;
  authority: PublicationAuthority; store: ObjectStorage; receiptPath?: string; now?: number;
}): Promise<MaintenanceReceipt> {
  const path = options.receiptPath ?? 'output/maintenance.json', controller = new AbortController();
  const receipt: MaintenanceReceipt = {
    version: 1, action: options.action, model: options.model, targetBuildId: options.buildId,
    authority: options.authority, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'running', cancellationRequested: false,
    rollbackOutcome: options.action === 'rollback' ? 'not-attempted' : 'not-applicable', summary: null
  };
  const persist = (): void => {
    receipt.updatedAt = new Date().toISOString();
    const bytes = Buffer.from(JSON.stringify(receipt, null, 2));
    if (bytes.length > 16 * 1024) throw new Error('Maintenance receipt exceeds its byte budget');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, bytes, { flush: true }); renameSync(`${path}.tmp`, path);
  };
  const abort = (): void => {
    controller.abort(new Error('Maintenance interrupted'));
    receipt.cancellationRequested = true;
    if (receipt.status !== 'complete') receipt.status = 'cancelled';
    try { persist(); } catch (error) { console.error('Could not persist maintenance cancellation:', String(error).slice(0, 2048)); }
  };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let completed = false;
  try {
    persist(); // A stopped process leaves an explicit running/not-attempted observation.
    if (options.action === 'rollback') {
      if (!options.buildId) throw new Error('Rollback requires a build ID');
      await rollback(options.store, options.model, options.buildId, options.authority, options.now, {
        signal: controller.signal,
        onPointerOutcome(outcome) { receipt.rollbackOutcome = outcome; persist(); }
      });
    } else {
      receipt.deletedObjects = await cleanup(options.store, options.model, options.authority, options.now, summary => { receipt.summary = summary; }, controller.signal);
    }
    completed = true; receipt.status = 'complete'; persist();
    controller.signal.throwIfAborted();
    return receipt;
  } catch (error) {
    if (!completed) {
      receipt.status = controller.signal.aborted ? 'cancelled' : 'failed';
      receipt.error = String(error).slice(0, 2048);
    }
    persist();
    throw error;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}
