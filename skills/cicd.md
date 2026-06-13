# skills/cicd.md — CI/CD & Build

**Open when:** working on the build pipeline, CI, or releases.

## Local build graph

`turbo` orchestrates per-package tasks with caching:

```bash
pnpm build        # turbo run build  (tsc -b per package, respects references)
pnpm typecheck    # turbo run typecheck
pnpm lint         # turbo run lint   (eslint per package)
pnpm test:unit    # turbo run test:unit (vitest)
pnpm format       # prettier --write .
```

Build order is enforced by tsconfig project references: `protocol` → `browser`/`server`/
`react` → `demo`.

## Pre-commit gate

`pre-commit.sh` (symlinked into `.git/hooks/pre-commit`) runs, in order:

1. **Safety** — no secrets, no staged `plan/`, no `any`, no `console.log`, no file > 500 lines,
   no `new-` prefixed component files, eslint-disable comments must have a reason.
2. **Format** — `prettier --check`.
3. **Lint** — `eslint`.
4. **Types** — `tsc -b` (incremental; `--noEmit` conflicts with composite project references).
5. **Tests** — `vitest run` (fast unit only).

Exit non-zero on any failure. Integration/E2E (the bridge round-trip, the demo dogfood
suite) run in CI, not pre-commit.

## CI (to add)

GitHub Actions: install (pnpm, frozen lockfile) → `pnpm build` → `pnpm lint` →
`pnpm typecheck` → `pnpm test:unit` → E2E dogfood against `apps/demo`. Cache the pnpm store
and turbo cache. Publishing the `@iris/*` packages is a later, tagged-release concern.

## Releasing to npm

The four packages publish as a set (`@iris/protocol`, `@iris/browser`, `@iris/server`,
`@iris/react`); `@iris/demo` is `private` and never publishes.

```bash
# bump versions together (keep them in lockstep for the workspace deps)
pnpm -r --filter '@iris/*' exec npm version <patch|minor|major>
# publish (prepack builds + strips test artifacts; workspace:* -> real versions automatically)
pnpm -r --filter '@iris/*' publish --access public
```

Each package's `prepack` runs `tsc -b && find dist -name '*.test.*' -delete`, so tarballs
contain only `dist` (compiled JS + d.ts + maps) and the README. Verify before publishing:

```bash
cd packages/server && npm pack --dry-run   # inspect the file list
```

First-time publish needs `npm login` and the `@iris` scope to exist/be owned. This is a
human-gated step — CI does not publish automatically.

## esbuild note

pnpm 10 blocks postinstall scripts by default; `esbuild` is allowlisted in root
`package.json` → `pnpm.onlyBuiltDependencies`. If Vite breaks after a fresh install with an
esbuild error, run `pnpm rebuild esbuild`.
