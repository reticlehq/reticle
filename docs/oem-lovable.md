# Iris × Lovable — OEM integration brief

> For the Lovable platform team. How to add runtime verification to your generate → preview loop in
> **one step**, what it returns, and what it takes. Iris reads the running app's _program truth_ — network,
> state, console, routing — and returns a deterministic **verdict with evidence**, not a screenshot.

## The ask, in one sentence

Add one command — **`iris verify`** — to your build pod after the preview boots, and gate "your app is
ready" on its verdict. Everything below is detail on that one step.

## The problem it removes

Generated apps **look** right and **silently** don't work: a form POSTs 200 but nothing persists, one
click fires two requests, the total on screen contradicts the store, a console error is swallowed. Your
agent can't see any of it — it has terminal/compile errors, not _runtime program truth_. So users hit the
bug, lose trust, and burn regenerations. Iris is the missing "did it actually work?" check.

## The integration — three touch points

1. **SDK in the generated-app template (one time).** Add `@syrin/iris-browser` + the Vite plugin + a
   dev/preview-only `iris.connect()` to your scaffold. Gate it so it runs in the **preview** build and is
   stripped from a user's true production export. Now every generated app is verifiable.
2. **One command in the build pod.** After the preview server is up, run:
   ```bash
   iris verify "$PREVIEW_URL" --json > verdict.json   # exit 0 = pass, 1 = fail/partial
   ```
   It drives the preview, replays the app's key flows, asserts program truth, and writes the verdict. No
   MCP, no human, no LLM in the loop.
3. **Act on the verdict.** PASS → publish + attach a "verified ✓" badge. FAIL → feed
   `repair.failurePackets[]` straight back into your fixer agent and re-verify. The loop closes itself.

## What `iris verify` returns — the verdict artifact

A stable, versioned `IrisVerificationRun` (JSON):

- `verdict` — `pass | fail | partial`, `confidence`, `blockingRisks`, `reasons[]`
- `flows[]` / `checks[]` — what ran and each outcome
- `risks[]` — touched auth/payment/db surfaces
- `repair.failurePackets[]` — **what broke + where to fix it**, as a ready-to-send prompt for your agent
- `evidence` — console errors, network anomalies, state assertions, timeline
- `profile: "prod-preview"` — source `file:line`, raw bodies, and state values redacted for safe
  downstream sharing

The verdict is **mechanical** — derived only from observed outcomes — so it can't report green for
something it never ran. A severed backend reads as _fail_, never a confident pass.

## The loop in your pipeline

```
generate / edit ─► boot preview ─► iris verify "$PREVIEW_URL" ─► verdict.json
                                                                 │
                                   PASS ─► publish + "verified ✓"  │
                                   FAIL ─► repair.failurePackets[] ─► fixer agent ─► re-verify
```

## What the sandbox needs (honest requirements)

- **Node + a Chromium** available in the build pod (Iris drives via Playwright). If your pod already runs a
  headless browser for screenshots, you're set; otherwise it's one apt/npx install.
- The **SDK in the preview bundle** (touch point 1). Without it Iris still catches the Layer-1 failures by
  driving the URL; with it you also get program-state + source mapping.
- The preview reachable from the pod (a localhost or internal URL is ideal — no auth gate, no public
  exposure).

## What Lovable gets

- **Stop shipping silently-broken apps** — gate the "ready" signal on real behavior, not a screenshot.
- **Self-healing generations** — repair packets turn a failure into the agent's next fix automatically,
  cutting blind regeneration loops.
- **A trust artifact** — a user-facing "verified ✓" backed by evidence, and an audit trail per build.
- **Determinism** — 0% flake, no second LLM in the loop, a verdict you can gate a deploy on.

## Why Iris vs. building it yourselves

You _can_ bolt on a smoke test. The depth is the moat: **program-state truth** (reads the store, not
pixels), **source mapping** (failure → `file:line`), a **deterministic un-hallucinatable verdict**, and a
**stable artifact** that won't drift across your fleet. `iris verify` is the same primitive whether it's
called by a human agent (MCP), your CI, or your sandbox — so you integrate once and it serves all three.

## Security & commercials

- **No telemetry.** Verification is local to the pod; nothing about a user's app leaves your infra.
  License checks are offline. SDK is dev/preview-only, stripped from production exports.
- **OEM licensing** is per-embed; the verification engine is free, the enterprise surface (multi-org,
  policy gates, audit, support/SLA) is licensed. Terms + a design-partner arrangement: **hey@syrin.ai**.

## Get started in an afternoon

1. Drop the SDK into your generated-app template.
2. Add `iris verify "$PREVIEW_URL"` after preview boot in one pipeline.
3. Branch on the exit code; pipe `repair.failurePackets[]` to your fixer.

We'll pair with your team on the template wiring and the first green verdict. — **hey@syrin.ai**
