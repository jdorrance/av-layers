import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**', '**/output/**', '**/.cache/**', '**/.tools/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['packages/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/apps/**', '**/scripts/**'] }]
    }
  },
  {
    files: ['packages/{client,windgram}/src/**/*.ts', 'apps/{preview,windy-plugin}/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['@av/contracts', '@av/contracts/models', '@av/contracts/refinement', '@av/forecast', '@av/forecast/frame', '@av/forecast/refinement'],
        patterns: ['**/apps/batch/**', '**/apps/api/**', '**/models.json']
      }]
    }
  }
);
