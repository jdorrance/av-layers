export type NoaaErrorCode =
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

export class NoaaError extends Error {
  readonly code: NoaaErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: NoaaErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'NoaaError';
    this.code = code;
    this.details = details;
  }
}
