import type { IndexedSource } from './source.js';
import { inspectIndexedGribField, type InspectedIndexedGribField } from './admission.ts';
import { cycleStamp, indexedGribFileUrl, indexedGribProductName } from './fields.ts';
import { IndexedGribTransport, selectIndexedGribRecord, type IndexResult } from './transport.ts';
import type { DecodedFieldReceipt, IndexedGribFieldSpec } from './types.ts';

export interface AdmittedIndexedGribField {
  inspected?: InspectedIndexedGribField;
  grid: InspectedIndexedGribField['grid'];
  packingError: number;
  receipt: DecodedFieldReceipt;
  indexSha256: string;
}

/** Load one selected range and verify its decoded source metadata. */
export async function loadAndInspectIndexedGribField(source: IndexedSource, transport: IndexedGribTransport, options: {
  cycle: string; spec: IndexedGribFieldSpec; sourceHour: number; startHour: number; endHour: number;
  expectedGridKey?: string; index?: IndexResult; timings?: { loadMs: number; admitMs: number };
}): Promise<AdmittedIndexedGribField> {
  transport.abort();
  const { cycle, spec, startHour, endHour } = options;
  const productFile = indexedGribProductName(source, spec.product), url = indexedGribFileUrl(source, cycle, options.sourceHour, productFile);
  const index = options.index ?? await transport.index(`${url}.idx`, cycleStamp(cycle));
  const started = performance.now();
  const selection = await selectIndexedGribRecord(transport, url, index, spec), selected = selection.selected;
  const bytes = selection.bytes ?? await transport.field(url, selected.record);
  if (options.timings) options.timings.loadMs += performance.now() - started;
  const admittedAt = performance.now();
  const inspected = inspectIndexedGribField(source, bytes.bytes, { cycle, spec, expectedStartHour: startHour, expectedEndHour: endHour, expectedGridKey: options.expectedGridKey });
  if (options.timings) options.timings.admitMs += performance.now() - admittedAt;
  const receipt: DecodedFieldReceipt = {
    ...inspected.receipt, product: spec.product, productFile, url,
    idxLine: selected.line, idxLineNumber: selected.indexLine, asset: bytes.asset,
    ...(selection.duplicates ? { duplicates: selection.duplicates } : {})
  };
  return { inspected, grid: inspected.grid, packingError: inspected.packingError, receipt, indexSha256: index.asset.sha256 };
}
