import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'references/**', '**/*.d.ts', 'release/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JS scripts run on Node.
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // The viewer client runs in the browser.
    files: ['packages/viewer/static/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        location: 'readonly',
        history: 'readonly',
        URLSearchParams: 'readonly',
        devicePixelRatio: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        Node: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    rules: {
      // Decoded Figma data is loosely typed by nature; `any` is allowed at those boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
