/** One executable option vocabulary for admission and the generated CLI reference. */
export const CLI_OPTIONS = {
  model: { type: 'string' }, out: { type: 'string' }, cycle: { type: 'string' },
  'cache-dir': { type: 'string' }, manifest: { type: 'string' }, frames: { type: 'string' }, layers: { type: 'string' },
  'terrain-ref': { type: 'string' }, 'terrain-catalog-ref': { type: 'string' }, 'terrain-store-dir': { type: 'string' },
  models: { type: 'string' }, 'native-zoom': { type: 'string' }, 'cadence-hours': { type: 'string' },
  'retention-days': { type: 'string' }, 'receipts-only': { type: 'boolean' }
} as const;

export const CLI_COMMANDS: Readonly<Record<string, readonly (keyof typeof CLI_OPTIONS)[]>> = {
  build: ['model', 'out', 'cycle', 'cache-dir', 'terrain-ref', 'terrain-catalog-ref', 'terrain-store-dir'],
  capacity: ['model', 'frames', 'layers', 'models', 'native-zoom', 'cadence-hours', 'retention-days'],
  'input-proof': ['model', 'cycle', 'cache-dir'],
  validate: ['manifest', 'receipts-only']
};
