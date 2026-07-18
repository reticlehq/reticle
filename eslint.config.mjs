// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
      'plan/**',
      'coverage/**',
      'apps/api/**',
      'apps/next-smoke/**',
      'apps/e2e/**',
      'packages/next/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript handles undefined symbols; no-undef is noise on TS.
      'no-undef': 'off',

      // Foundation skill — non-negotiable type-safety rules
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',

      // Foundation skill — correctness rules
      eqeqeq: ['error', 'always'],
      'no-cond-assign': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // _ prefix = intentionally unused (required so _param silences the rule)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Config + plain JS files: no type-aware linting (not part of a tsconfig)
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // React surfaces: enforce rules-of-hooks (drives the useX naming rule)
    files: ['packages/react/**/*.{ts,tsx}', 'apps/demo/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Service boundary (CLAUDE.md): the browser SDK + React adapter run in the DOM and must NEVER
    // drag in Node. Enforced at the import level so a `node:*`/Node-builtin import or a reach into the
    // server package fails lint — closing the blind spot in the manifest-only check-boundaries.mjs.
    files: ['packages/browser/src/**/*.ts', 'packages/react/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'Browser/React runs in the DOM — no Node builtins (node:*).',
            },
            {
              group: ['@reticlehq/server', '@reticlehq/server/*'],
              message: 'Browser/React must not import the Node server package.',
            },
          ],
          paths: [
            'fs',
            'path',
            'os',
            'crypto',
            'http',
            'https',
            'net',
            'child_process',
            'worker_threads',
            'module',
            'zlib',
            'tls',
            'dns',
          ].map((name) => ({ name, message: 'Browser/React runs in the DOM — no Node builtins.' })),
        },
      ],
    },
  },
  {
    // Service boundary (CLAUDE.md): the Node server never touches the DOM. Forbid DOM globals and
    // importing the browser SDK, so a stray `document`/`window` use fails lint instead of only
    // breaking at runtime in the (never-run) browser bundle.
    files: ['packages/server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@reticlehq/browser', '@reticlehq/browser/*'],
              message: 'Server runs in Node — no DOM SDK import.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'Server runs in Node — no DOM globals.' },
        { name: 'window', message: 'Server runs in Node — no DOM globals.' },
        { name: 'navigator', message: 'Server runs in Node — no DOM globals.' },
        { name: 'localStorage', message: 'Server runs in Node — no DOM globals.' },
      ],
    },
  },
);
