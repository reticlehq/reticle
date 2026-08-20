// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reticleLint from '@reticlehq/eslint-plugin';

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
      // Plain CommonJS, like packages/next: an Electron preload must be CJS (a sandboxed one cannot
      // load ESM at all), so the TypeScript rules — no-require-imports above all — do not apply.
      'packages/electron/**',
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
    plugins: { reticle: reticleLint },
    rules: {
      // TypeScript handles undefined symbols; no-undef is noise on TS.
      'no-undef': 'off',

      // An audit found every LINT-ENFORCED rule at ~100% compliance and every PROSE-ONLY rule violated
      // systematically. The gap was enforcement, not intent, so the two mechanically checkable house
      // rules are now errors rather than paragraphs.
      'reticle/no-internal-tags': 'error',

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
      /**
       * Literal on the LEFT of an equality test, so a typo'd `=` is a syntax error instead of a
       * silent assignment that always passes.
       *
       * `onlyEquality` on purpose: the assignment hazard exists only for `==`/`===`/`!=`/`!==`.
       * Applying it to relational operators as well would rewrite every `count > 0` into
       * `0 < count`, which costs readability everywhere to defend against nothing.
       */
      yoda: ['error', 'always', { onlyEquality: true }],
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
    // This suite proves the runner survives a non-Error throw, so it has to perform one. The rule is
    // asking the test not to create the condition it exists to verify. Scoped here for the same
    // reason as the console files below: declared once, where the rule is governed.
    files: ['packages/test/src/runner.test.ts'],
    rules: {
      '@typescript-eslint/only-throw-error': 'off',
    },
  },
  {
    // The console observer and its test exist to WRAP console.*, so `no-console` cannot be satisfied
    // there by refactoring — the rule is asking them not to do the one thing they are for. Scoped
    // here rather than as an inline disable so the exception is declared once, in the place that
    // governs the rule, instead of being re-argued in a comment at each use.
    files: [
      'packages/browser/src/observers/console.ts',
      'packages/browser/src/observers/console.test.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // React surfaces: enforce rules-of-hooks (drives the useX naming rule)
    files: ['packages/react/**/*.{ts,tsx}', 'apps/bench-app/**/*.{ts,tsx}'],
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
    // Meta-tests that scan the package's own sources (settings-are-wired) need node:fs to read them.
    // The rule above is about SHIPPED code — a .test.ts is never bundled — so the DOM-only half is
    // lifted here. The server-package half is not: that boundary is just as real inside a test.
    files: ['packages/browser/src/**/*.test.ts', 'packages/react/src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@reticlehq/server', '@reticlehq/server/*'],
              message: 'Browser/React must not import the Node server package.',
            },
          ],
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
  {
    // The file-size cap, enforced on SHIPPING code rather than merely asked for. It was prose-only, and
    // the prose-only rules are precisely the ones that drifted. Scoped to packages/ because the rule's
    // rationale is cohesion in code we ship; the bench fixtures are catalogues, where length is not the
    // same smell. apps/bench-app's bug injector (1036 lines) is known debt and wants splitting by
    // category — deliberately not done in the same pass that is verifying those fixtures' behaviour.
    files: ['packages/*/src/**'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { 'max-lines': ['error', { max: 1000, skipBlankLines: false, skipComments: false }] },
  },
  {
    // The rule that BANS these tokens has to name them — in its own doc comment explaining the ban, and
    // in fixtures asserting it fires. Exempting only this package keeps the rule enforceable everywhere
    // else while letting it document itself.
    files: ['packages/eslint-plugin/src/**'],
    rules: { 'reticle/no-internal-tags': 'off' },
  },
);
