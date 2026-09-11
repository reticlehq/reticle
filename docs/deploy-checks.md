---
title: Deploy checks
description: 'Enforce verification at the moment code becomes a preview URL, as a Vercel or Netlify check on the PR.'
icon: circle-check
---

To gate a PR on Reticle, run `npx @reticlehq/server verify <preview-url>` in CI when the preview deploy succeeds. It exits **0** when every saved flow passes and **1** otherwise, so the job's own pass/fail becomes the check on the PR. There is no workflow-level integration to write beyond that one command.

The strongest place to enforce verification is the moment code becomes a preview URL. Every deploy already produces one, and both Vercel and Netlify let a third party attach a **check** to it: pass/fail, shown on the PR, with no workflow file to write.

That makes the non-developer story complete: the SDK is auto-injected by the build plugin, flows are minted from toolbar recordings with auto-proposed consequences, and verification runs at publish, **without anyone writing a test.**

> **Recipe A works today; Recipe B does not exist yet.** `reticle verify` exits 0/1 and persists a run artifact right now. What is _not_ built is a hosted Reticle app that registers itself as a Vercel or Netlify check provider. Until it exists, use the CI recipe.

## The shape

```
git push → preview deploy → Reticle verifies the preview URL → check passes/fails on the PR
```

`reticle verify <preview-url>` is the whole integration surface:

- exits **0** when every saved flow passes, **1** otherwise (the only contract a check needs),
- prints a legible ✓/✗ report for the PR log,
- persists a `ReticleVerificationRun` artifact (`.reticle/runs/<id>.json`) so `reticle gate` and `reticle_run_export` can consume the same verdict.

## Recipe A: CI (works today, any provider)

```yaml
# .github/workflows/verify.yml
name: reticle
on: [deployment_status]
jobs:
  verify:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      # setup-node must come AFTER pnpm/action-setup, or its pnpm cache has no pnpm to find.
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: npx playwright install --with-deps chromium
      # Reticle drives the preview and owns its own browser + daemon.
      - run: npx @reticlehq/server verify "${{ github.event.deployment_status.target_url }}" --timeout 60000
```

The job's own pass/fail becomes the PR check. Nothing else is required.

**Non-loopback previews need pairing.** For a real preview URL (not `localhost`), Reticle injects `reticle.connect()` with a one-time token and allow-lists the preview origin, so the app does not need to be rebuilt per environment. Confirm the SDK actually runs on the deployed build: a production build that tree-shakes the dev-only SDK will connect to nothing, and `verify` will (correctly) fail with _"no app connected."_

## Recipe B: the Checks API pattern (what a hosted Reticle would do)

Both providers expose the same shape, which is why this is one integration rather than two:

| Provider | Hook | Result surface |
| --- | --- | --- |
| Vercel | Deployment webhook → run the check → report back | Checks on the deployment / PR |
| Netlify | Deploy-succeeded webhook → run the check → report back | Deploy summary / PR |

The flow is: receive the deploy webhook → `reticle verify <target_url>` → post the verdict (and the `repair.failurePackets[]` from the run artifact) back as the check output. The artifact is stable and versioned precisely so a host platform can render it without parsing logs.

## Pair it with the local gate

The deploy check catches what reaches a preview. `reticle gate` catches it earlier: an agent that edits a covered file cannot "finish" without re-verifying:

```bash
npx @reticlehq/server gate --since origin/main    # exit 1 unless passing artifacts cover the affected flows
```

Use both: `gate` in the agent's Stop hook (see `agent-cheatsheet`), `verify` at the deploy. They read the same run artifacts, so a green gate locally and a green check on the PR mean the same thing.

## Honest limits

- **`verify` needs one connected session.** If several tabs of the app are open against the same daemon it refuses rather than guessing which to drive.
- **It replays flows sequentially against one tab**, so flows must not depend on each other's leftover state (a flow that logs in contaminates the next one). Author self-contained flows, or use `reticle_verify { action: "flows", parallel }`, which gives each flow an isolated context.
- **No saved flows means nothing to verify.** `verify` fails rather than reporting a vacuous pass.

## FAQ

### verify says 'no app connected' on my preview URL. Why?

Almost always because the deployed build tree-shook the dev-only SDK out, so there is nothing in the page dialling the bridge. `reticle.connect()` is meant to be dev-gated, and a production build honours that gate. Either build the preview with the dev guard satisfied, or accept that `verify` is correctly reporting that it cannot see the app. It is not a false alarm: with no SDK there is no program to read.

### Does it work on a real preview URL, or only localhost?

Both. For a non-loopback origin Reticle injects `reticle.connect()` with a one-time pairing token and allow-lists the preview origin, so you do not rebuild per environment. The bridge refuses to bind a non-loopback host without a token, which is the point.

### One of my flows logs in and the next one starts logged in. How do I stop that?

`verify` replays flows sequentially against one tab, so leftover state carries. Either author each flow to be self-contained, or use `reticle_verify { action: "flows", parallel: true }`, which gives every flow its own isolated browser context with its own cookies and storage.

### Should I run reticle gate as well as reticle verify?

If you want an agent to be unable to call a change finished without re-verifying, yes. They catch the same regression at different moments: `gate` runs locally against the files the agent just edited, `verify` runs against the deployed preview. They read the same run artifacts, so a green gate locally and a green check on the PR mean the same thing.

### verify exited 1 but I cannot see which flow failed.

The verdict is in the run artifact, not only in the log. Each run writes `.reticle/runs/<id>.json` with `repair.failurePackets[]` naming what broke and where; `reticle_run_export { format: "report" }` renders it legibly. The artifact is stable and versioned precisely so a CI surface can render it without parsing log lines.
