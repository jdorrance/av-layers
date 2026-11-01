import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workflowAuthority } from './authority.js';
import type { ObjectStorage } from './storage.js';
const fake = vi.hoisted(() => ({ rollback: vi.fn(), cleanup: vi.fn() }));
vi.mock('./publication.js', () => fake);
import { maintenanceWorkflow, type MaintenanceReceipt } from './maintenance.js';
const authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW: 'Forecast maintenance', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: 'gfs' });
let dir: string, receiptPath: string, listeners: number;
const receipt = (): MaintenanceReceipt => JSON.parse(readFileSync(receiptPath, 'utf8'));
const run = (action: 'rollback' | 'cleanup') => maintenanceWorkflow({ action, model: 'gfs', buildId: action === 'rollback' ? 'retained-build' : undefined, authority, store: {} as ObjectStorage, receiptPath });
beforeEach(() => {
  vi.resetAllMocks(); fake.rollback.mockResolvedValue(undefined); fake.cleanup.mockResolvedValue(0);
  dir = mkdtempSync(join(tmpdir(), 'av-maintenance-journal-')); receiptPath = join(dir, 'maintenance.json'); listeners = process.listenerCount('SIGTERM');
});
afterEach(() => { expect(process.listenerCount('SIGTERM')).toBe(listeners); rmSync(dir, { recursive: true, force: true }); });
it('writes an initial observation before remote work and keeps verification failures not-attempted', async () => {
  fake.rollback.mockImplementationOnce(async () => { expect(receipt()).toMatchObject({ status: 'running', rollbackOutcome: 'not-attempted' }); throw new Error('invalid receipt'); });
  await expect(run('rollback')).rejects.toThrow('invalid receipt');
  expect(receipt()).toMatchObject({ status: 'failed', rollbackOutcome: 'not-attempted', cancellationRequested: false });
});
it('durably records cancellation immediately and keeps an ambiguous CAS outcome unconfirmed', async () => {
  fake.rollback.mockImplementationOnce(async (_store, _model, _target, _authority, _now, options) => {
    options.onPointerOutcome('unconfirmed'); process.emit('SIGTERM');
    expect(options.signal.aborted).toBe(true);
    expect(receipt()).toMatchObject({ status: 'cancelled', rollbackOutcome: 'unconfirmed', cancellationRequested: true });
    throw new Error('authoritative reconciliation unavailable');
  });
  await expect(run('rollback')).rejects.toThrow('reconciliation unavailable');
  expect(receipt()).toMatchObject({ status: 'cancelled', rollbackOutcome: 'unconfirmed' });
});
it.each(['rollback', 'cleanup'] as const)('preserves completed %s outcome when cancellation races with completion', async action => {
  if (action === 'rollback') fake.rollback.mockImplementationOnce(async (_store, _model, _target, _authority, _now, options) => { options.onPointerOutcome('unconfirmed'); options.onPointerOutcome('confirmed'); process.emit('SIGTERM'); });
  else fake.cleanup.mockImplementationOnce(async () => { process.emit('SIGTERM'); return 3; });
  await expect(run(action)).rejects.toThrow('interrupted');
  expect(receipt()).toMatchObject({ status: 'complete', cancellationRequested: true, rollbackOutcome: action === 'rollback' ? 'confirmed' : 'not-applicable', ...(action === 'cleanup' ? { deletedObjects: 3 } : {}) });
});
it('bounds provider errors in the durable failure receipt', async () => {
  fake.cleanup.mockRejectedValueOnce(new Error('x'.repeat(100_000)));
  await expect(run('cleanup')).rejects.toThrow('xxx');
  expect(receipt().error).toHaveLength(2048);
  expect(readFileSync(receiptPath).length).toBeLessThan(16 * 1024);
});
