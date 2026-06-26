# Integration tests

Heavy, real-environment tests that exercise Iris against a **real headless Chromium** — kept out of the fast per-package unit gate so `pnpm test:unit` stays quick.

```bash
pnpm build            # the tests import the built @syrin/iris-server
pnpm test:integration # runs test/**/*.integration.test.ts via vitest
```

## What's covered

- **`pool.integration.test.ts`** — the `BrowserPool` against real Chromium: one shared browser hands out N capped isolated contexts, an over-cap burst is genuinely blocked (cap active, rest queued), orphaned leases are reclaimed after their TTL, and heavy acquire/release churn leaks nothing. These are the multi-agent guarantees the unit tests prove with a fake launcher, re-proven here for real.

## Related suites

- **Unit tests** (`pnpm test:unit`) — fast, per-package, fake launcher/clock.
- **E2E battery** (`apps/e2e`, `pnpm --filter @syrin/iris-e2e run e2e:ci`) — boots the demo/api/next-smoke apps and drives Iris end-to-end, including the multi-agent lease path against the live demo (`specs/multi-agent-lease-test.mjs`) and the SDK/framework integration that needs a running app.
