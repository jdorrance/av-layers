/** One executable option vocabulary for admission and the generated CLI reference. */
export const CLI_OPTIONS = {
  model: { type: 'string' }, out: { type: 'string' }, cycle: { type: 'string' },
  'cache-dir': { type: 'string' }, manifest: { type: 'string' },
  'source-store-dir': { type: 'string' },
  'terrain-catalog-ref': { type: 'string' }, 'terrain-store-dir': { type: 'string' }, 'cadence-hours': { type: 'string' },
  'retention-days': { type: 'string' }, 'receipts-only': { type: 'boolean' }
} as const;

export const CLI_COMMANDS: Readonly<Record<string, readonly (keyof typeof CLI_OPTIONS)[]>> = {
  build: ['model', 'out', 'cycle', 'cache-dir', 'source-store-dir', 'terrain-catalog-ref', 'terrain-store-dir'],
  capacity: ['model', 'cadence-hours', 'retention-days'],
  'input-proof': ['model', 'cycle', 'cache-dir', 'source-store-dir'],
  validate: ['manifest', 'receipts-only']
};
