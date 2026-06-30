import { defineConfig } from 'tsup';

// Bundle the internal @reticlehq/* packages INTO this one published package.
// Third-party deps stay external (declared in package.json); only our own code is inlined.
export default defineConfig({
  entry: {
    index: 'src/index.ts', // '.'        — browser SDK + React adapter
    server: 'src/server.ts', // './server' — bridge + MCP server (Node)
    test: 'src/test.ts', // './test'   — declarative spec runner
    next: 'src/next.ts', // './next'   — Next.js source mapping
    babel: 'src/babel.ts', // './babel'  — React 19 babel plugin
    vite: 'src/vite.ts', // './vite'   — Vite plugin (source mapping + connect injection)
    eslint: 'src/eslint.ts', // './eslint' — require-signal-on-mutation rule
    cli: 'src/cli.ts', // bin         — the `reticle` CLI
  },
  format: ['esm'],
  // dts inherits incremental/composite from the base tsconfig otherwise (TS5074).
  dts: {
    resolve: [/^@reticle\//],
    compilerOptions: { incremental: false, composite: false, tsBuildInfoFile: null },
  },
  noExternal: [/^@reticle\//], // inline our workspace packages
  // optionalDependencies are not auto-externalized by tsup — keep them out of the bundle.
  external: ['playwright', 'playwright-core', 'pixelmatch', 'pngjs'],
  platform: 'node',
  target: 'es2022',
  splitting: false,
  clean: true,
  shims: false,
  // The Next webpack pre-loader must ship as a real CJS file webpack can require at runtime. It is
  // hand-authored (loader.cjs) and copied into dist/ next to next.js + babel.js (which it imports).
  async onSuccess() {
    const { copyFile } = await import('node:fs/promises');
    await copyFile('loader.cjs', 'dist/loader.cjs');
  },
});
