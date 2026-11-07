import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'site/dist/**', 'benchmarks/results/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', Buffer: 'readonly', document: 'readonly',
        window: 'readonly', localStorage: 'readonly', performance: 'readonly', structuredClone: 'readonly',
        TextEncoder: 'readonly', URLSearchParams: 'readonly', Response: 'readonly', Request: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
