import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Resolve `@reticlehq/core` from SOURCE, so a stale build cannot turn a test into a tautology.
 *
 * The failure this prevents, hit for real: a test asserting on a constant newly added to
 * `packages/core` passed *without* the production fix it was written to prove. `core/dist` was
 * stale, so `InputModeReason.NOT_CONFIGURED` resolved to `undefined` — and the unfixed code path
 * also returned `undefined`, so the assertion degenerated into `expect(undefined).toBe(undefined)`.
 * The RED step of the cycle was green.
 *
 * It is biased in the worst direction: a missing enum member is `undefined`, and `undefined` is
 * exactly what an unimplemented branch returns, so the stale build AGREES with the bug. And
 * "add a constant to core, assert on it from server" is the normal shape of a change here — rule 3
 * of CLAUDE.md requires every wire and domain string to live in core.
 *
 * `pnpm test:unit` was never at risk: `turbo.json` declares `test:unit` dependsOn `^build`. The hole
 * is the inner loop — `npx vitest run <file>` bypasses turbo entirely, which is precisely what the
 * RED step of a TDD cycle is, and CLAUDE.md positions the full gate as a PRE-COMMIT step.
 *
 * Exact-match on purpose. A plain string alias in Vite is a PREFIX replacement, which would also
 * capture `@reticlehq/core/schema/*.json` and `@reticlehq/core/desktop-contract` — real export
 * paths that only exist as build artifacts and have no source equivalent.
 *
 * The tradeoff, stated: unit tests now exercise core's source rather than its emitted JS. That is
 * acceptable because the build is `tsc -b` (a faithful transpile) plus two generators whose outputs
 * are separate export paths the main entry never imports — and `typecheck` and `build` still run
 * against the real artifact on every gate.
 */
const CORE_SRC = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@reticlehq\/core$/, replacement: CORE_SRC }],
  },
});
