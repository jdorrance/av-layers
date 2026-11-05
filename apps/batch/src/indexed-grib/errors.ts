export type IndexedGribErrorCode =
  | 'invalid-option'
  | 'run-unavailable'
  | 'record-missing'
  | 'record-ambiguous'
  | 'source-conflict'
  | 'unsupported-grid'
  | 'unsupported-earth'
  | 'unsupported-packing'
  | 'unsupported-product'
  | 'transport'
  | 'decode';

export class IndexedGribError extends Error {
  readonly code: IndexedGribErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: IndexedGribErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'IndexedGribError';
    this.code = code;
    this.details = details;
  }
}
