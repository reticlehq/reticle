import { defineConfig } from 'tsup';

// Bundle the internal @syrin/* packages INTO this one published package.
// Third-party deps stay external (declared in package.json); only our own code is inlined.
export default defineConfig({
  entry: {
    index: 'src/index.ts', // '.'        — browser SDK + React adapter
    server: 'src/server.ts', // './server' — bridge + MCP server (Node)
    test: 'src/test.ts', // './test'   — declarative spec runner
    next: 'src/next.ts', // './next'   — Next.js source mapping
    babel: 'src/babel.ts', // './babel'  — React 19 babel plugin
    eslint: 'src/eslint.ts', // './eslint' — require-signal-on-mutation rule
    cli: 'src/cli.ts', // bin         — the `iris` CLI
  },
  format: ['esm'],
  // dts inherits incremental/composite from the base tsconfig otherwise (TS5074).
  dts: {
    resolve: [/^@syrin\//],
    compilerOptions: { incremental: false, composite: false, tsBuildInfoFile: null },
  },
  noExternal: [/^@syrin\//], // inline our workspace packages
  // optionalDependencies are not auto-externalized by tsup — keep them out of the bundle.
  external: ['playwright', 'playwright-core', 'pixelmatch', 'pngjs'],
  platform: 'node',
  target: 'es2022',
  splitting: false,
  clean: true,
  shims: false,
});
