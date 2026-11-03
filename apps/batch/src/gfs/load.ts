import { inspectGfsField, type InspectedGfsField } from './admission.ts';
import { cycleStamp, gfsFileUrl, gfsProductName } from './fields.ts';
import { NoaaTransport, selectGfsRecord, type IndexResult } from './transport.ts';
import type { DecodedFieldReceipt, GfsFieldSpec } from './types.ts';

export interface AdmittedGfsField {
  inspected?: InspectedGfsField;
  grid: InspectedGfsField['grid'];
  packingError: number;
  receipt: DecodedFieldReceipt;
  indexSha256: string;
}

/** Shared build/diagnostic admission; only callers choose whether to continue after a failure. */
export async function loadAndInspectGfsField(transport: NoaaTransport, options: {
  cycle: string; spec: GfsFieldSpec; sourceHour: number; startHour: number; endHour: number;
  expectedGridKey?: string; index?: IndexResult; timings?: { loadMs: number; admitMs: number };
}): Promise<AdmittedGfsField> {
  transport.abort();
  const { cycle, spec, startHour, endHour } = options;
  const productFile = gfsProductName(spec.product), url = gfsFileUrl(cycle, options.sourceHour, productFile);
  const index = options.index ?? await transport.index(`${url}.idx`, cycleStamp(cycle));
  const started = performance.now();
  const selection = await selectGfsRecord(transport, url, index, spec), selected = selection.selected;
  const bytes = selection.bytes ?? await transport.field(url, selected.record);
  if (options.timings) options.timings.loadMs += performance.now() - started;
  const admittedAt = performance.now();
  const inspected = inspectGfsField(bytes.bytes, { cycle, spec, expectedStartHour: startHour, expectedEndHour: endHour, expectedGridKey: options.expectedGridKey });
  if (options.timings) options.timings.admitMs += performance.now() - admittedAt;
  const receipt: DecodedFieldReceipt = {
    ...inspected.receipt, product: spec.product, productFile, url,
    idxLine: selected.line, idxLineNumber: selected.indexLine, asset: bytes.asset,
    ...(selection.duplicates ? { duplicates: selection.duplicates } : {})
  };
  return { inspected, grid: inspected.grid, packingError: inspected.packingError, receipt, indexSha256: index.asset.sha256 };
}
