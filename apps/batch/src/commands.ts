/** One executable option vocabulary for admission and the generated CLI reference. */
export const CLI_OPTIONS = {
  model: { type: 'string' }, out: { type: 'string' }, cycle: { type: 'string' },
  'cache-dir': { type: 'string' }, manifest: { type: 'string' }, frames: { type: 'string' }, layers: { type: 'string' },
  models: { type: 'string' }, 'native-zoom': { type: 'string' }, 'cadence-hours': { type: 'string' },
  'retention-days': { type: 'string' }
} as const;

export const CLI_COMMANDS: Readonly<Record<string, readonly (keyof typeof CLI_OPTIONS)[]>> = {
  build: ['model', 'out', 'cycle', 'cache-dir'],
  capacity: ['model', 'frames', 'layers', 'models', 'native-zoom', 'cadence-hours', 'retention-days'],
  'input-proof': ['cycle', 'cache-dir'],
  validate: ['manifest']
};
