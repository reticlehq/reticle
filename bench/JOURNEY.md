# The evidence report: intent + journey + outcome (measured)

> A test suite's output should answer three questions for a developer or agent: **why** does this
> flow exist, **what** did it do, and **did the business goal hold**. Iris emits all three as one
> deterministic artifact from a single replay — no LLM, no screenshots. This is the narrative half
> of the regression story (the cost/detection halves are in `LAYER-B.md`, the metric in `METRIC.md`).

## The artifact (measured, `harness/journey-report.mjs`)

A flow is recorded once with a declared business **intent** and the consequence that defines
**success**, then replayed. The replay returns the journey — per step, the page it ran on, the action,
and the observable consequence (domain signal / network call / route change) — plus the verdict:

```text
intent: inject a 500 server fault from diagnostics and observe it fire
status: ok   intentVerified: true
journey:
  login-submit     ok  =>  signal auth:granted; POST /api/login 200
  nav-diagnostics  ok  =>  signal nav:changed
  fault-500        ok  =>  signal fault:injected; GET /api/broken/500 500
  fault:injected   ok   (the success-state — the business outcome held)
```

**Cost: 280 tokens for the whole evidence report — 108× under Playwright's ~30,249-token LLM
re-drive per run.** Deterministic, so the report is byte-stable run to run.

## Why this is more than a pass/fail

- **WHY** — `intent` states the business goal in one line. A flow without an asserted outcome that
  declares an intent is flagged (`intentVerified: false`), so a test can't claim a goal it can't check.
- **WHAT** — the journey shows the actual path the test drove: which control, on which page, and the
  consequence each action produced. The consequences are real observable events (signals/network),
  not inferred — `fault:injected; GET /api/broken/500 500` is proof the fault fired, not a guess.
- **DID-IT-WORK** — `intentVerified: true` means the flow both declared a goal AND asserted an
  observable outcome (the `fault:injected` success-state) that actually fired. A locator healed to
  the wrong element cannot fake a real signal, so green here means the business intent was met.

## Honesty / limits

- The `page` column is best-effort: it reads the latest route change. When the driven browser reloads
  already on a sub-path (the deep-link guard then skips a redundant `pushState`), a step shows `-`
  and the navigation surfaces instead as its domain signal (`nav:changed`) in the consequence — the
  journey stays complete either way.
- Consequence capture reflects what had landed when the action settled; a very-late async effect may
  not appear. The asserted `success-state` (waited on) remains the authoritative pass/fail.
- Token figure is the `o200k` proxy used across the benchmark; the 108× compares to the measured
  Playwright agent-loop cost in `LAYER-B.md`. Raw: `bench/raw/journey-report.json`.
