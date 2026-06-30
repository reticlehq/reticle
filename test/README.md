# Integration tests

Heavy, real-environment tests that exercise Reticle against a **real headless Chromium** — kept out of the fast per-package unit gate so `pnpm test:unit` stays quick.

```bash
pnpm build            # the tests import the built @reticle/server
pnpm test:integration # runs test/**/*.integration.test.ts via vitest
```

## What's covered

- **`pool.integration.test.ts`** — the `BrowserPool` against real Chromium: one shared browser hands out N capped isolated contexts, an over-cap burst is genuinely blocked (cap active, rest queued), orphaned leases are reclaimed after their TTL, and heavy acquire/release churn leaks nothing. These are the multi-agent guarantees the unit tests prove with a fake launcher, re-proven here for real.
- **`crash-isolation.integration.test.ts`** — proves the real-Chromium behavior the pool's per-page fault handling depends on: when one context's renderer crashes, the crash event fires, the shared browser stays connected, and a sibling context keeps working. (The pool's reclaim-only-that-lease logic is unit-tested with a fake; this proves the assumption underneath it.)

## Related suites

- **Unit tests** (`pnpm test:unit`) — fast, per-package, fake launcher/clock.
- **E2E battery** (`apps/e2e`, `pnpm --filter @reticle/e2e run e2e:ci`) — boots the demo/api/next-smoke apps and drives Reticle end-to-end, including the multi-agent lease path against the live demo (`specs/multi-agent-lease-test.mjs`) and the SDK/framework integration that needs a running app.
