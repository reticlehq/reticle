# Integrating Reticle

> The one guide for adopting Reticle — for a team using a coding agent on its own app, and for an AI app-builder platform (Lovable / Emergent / Bolt) embedding Reticle in its generation pipeline. Reticle reads the program from _inside_ a running app and returns a **verdict with evidence** ("did it actually work?"), not a screenshot. Enterprise/premium access lives in [`enterprise.md`](./enterprise.md).

## The loop

```
generate / edit  →  boot the preview  →  Reticle verifies the critical flows  →  verdict + evidence + repair
                                                                                │
                                         PASS → ship & attach "verified ✓"      │
                                         FAIL → gate the deploy, feed repair packets to the fixer agent
```

One call replays the app's key journeys and asserts **program truth** — network cardinality, store/state, emitted signals, console — then returns a deterministic, un-hallucinatable verdict.

---

## Quickstart

### A. A team, agent on your own app (~10 min)

```bash
npx @reticlehq/server init   # auto-detects your framework, installs the kit + build plugin
```

Paste to your agent (Claude Code / Cursor / any MCP agent): `Follow https://raw.githubusercontent.com/reticlehq/reticle/main/SKILL.md` It runs the wizard once (Vite/Next plugin + SDK init + MCP config), then verifies on every change. Run your dev server, then ask the agent to _"verify it with Reticle."_

### B. A platform / CI, driven from your pipeline (no MCP, no human)

```bash
reticle serve --http --http-token "$TOKEN" --drive "$PREVIEW_URL"   # localhost:7331
```

```js
const { run } = await (
  await fetch('http://127.0.0.1:7331/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-reticle-token': process.env.TOKEN },
    body: JSON.stringify({
      project: { name, framework, previewUrl },
      trigger: { kind: 'oem', diffRef },
    }),
  })
).json();

if (run.verdict.status !== 'pass') {
  for (const p of run.repair?.failurePackets ?? []) fixerAgent.send(p.suggestedPrompt); // self-heal
  blockDeploy(run);
} else attachToDeploy(run); // "verified ✓"; set profile:"prod-preview" to redact internals downstream
```

Or skip the HTTP server entirely with the one-shot CLI — `reticle verify <preview-url>` drives the preview, replays the saved flows, prints the verdict, and exits non-zero on fail (ideal for a CI step).

---

## In-app SDK integration — the effort, by layer

Reticle embeds a **dev/preview-only** SDK (`@reticlehq/browser`, Apache-2.0, tree-shaken from production). For a platform you add this **once to your generated-app template** → every generated app is verifiable.

| Layer | What you add | Unlocks | Effort |
| --- | --- | --- | --- |
| **1 — drive + DOM/network/console** | 1 build-plugin line + ~10-line dev-only `reticle.connect({…})` file (`npx @reticlehq/server init` does it) | broken routes, network status/cardinality (double-submit), console errors, persistence-after-reload | **Easy** (~15 min) |
| **2 — program-state truth** | `registerStore('app', () => store.getState())` (1/store) + `reticle.signal('order:saved', …)` (1/consequence) + `data-testid`s | UI-vs-store desync, dead handlers, blast-radius, source mapping | **Easy–Medium** (an afternoon, once) |
| **3 — governance (optional)** | `registerCapabilities(...)` (signals/stores/risk zones) + recorded flows with success oracles | risk policy + sharper verdicts | **Medium**, optional |

Copyable patterns: `apps/demo/src/reticle-dev.ts`, `apps/next-smoke/app/reticle-dev.tsx`. Without instrumentation, Layer-1 checks still work via the driven browser; Layers 2–3 are what no out-of-page tool can see.

---

## What it catches that a screenshot can't

| Silent failure (a generated app ships it) | How Reticle catches it |
| --- | --- |
| Mock data — POST 200, row shows, nothing persists | persistence/`state` oracle (doesn't survive reload) |
| Dead handler — looks done, store never changed | `state` desync |
| Double-submit — one click, two POSTs | `net { count: 1 }` |
| Forbidden call — a must-never-fire endpoint fired | `net { count: 0 }` |
| Missing validation — `"abc"` becomes data | flow oracle (error shown AND nothing created) |
| Silent console error — logged, UI still renders | `console { absent: true }` |
| UI-vs-store desync — the total lies | reads the store, contradicts the display |
| Blast-radius — an action corrupts unrelated state | `state { hold:true }` invariant |

Live, clickable demo of each: `apps/generated-app/` (set `BUG_MODE=…`). Proven in CI: `packages/server/src/runs/generated-app-bugs.test.ts`.

---

## Exact steps per platform

The shape is identical (in-app SDK in the template → verify in the sandbox → act on the verdict); the specifics differ by where each platform runs the preview.

### Emergent (Kubernetes pod per build, reverse-proxied preview URL)

1. Add `@reticlehq/browser` + `registerStore`/`reticle.signal` to the generated-app **scaffold** (one time).
2. In the build pod, alongside the preview: `reticle serve --http --http-token "$POD_TOKEN" --drive "$PREVIEW_URL"` (or import `ReticleRunner` in-process).
3. In the orchestrator's generate→test→iterate loop, `POST /verify` after the preview boots.
4. FAIL → route `repair.failurePackets[].suggestedPrompt` to the fixer subagent → re-verify (closes the loop). PASS → publish + attach the `prod-preview` run as the user-facing "verified ✓".

### Lovable (Vite/React generated apps, hosted preview)

1. Add the Reticle Vite plugin + dev-only `reticle.connect` to the project template (Lovable already templates Vite/React — it's one plugin line + the connect file).
2. Run `reticle serve --http --drive <preview-url>` against the preview build in the generation worker.
3. Call `/verify` after each generate/edit; gate the "your app is ready" signal on `verdict.status === 'pass'`; feed repair packets back into the edit agent.

### Bolt.new / StackBlitz (WebContainer, in-browser runtime)

1. Add the SDK to the WebContainer app template; the app + Reticle bridge run in the WebContainer.
2. Since the runtime is in-browser, drive via the connected session (the SDK dials the bridge) rather than `--drive`; call verify from the Bolt agent after a build.
3. Same act-on-verdict: gate + self-heal with the repair packets. (Bolt already detects terminal/compile errors; Reticle adds the _runtime program-truth_ layer it's blind to.)

> Honest note: a platform can build a verification step itself. Reticle's case is the depth (program-state and source mapping), the determinism (0% flake, no LLM in the loop), the un-hallucinatable verdict, and a stable drop-in artifact. The reproducible benchmark in [`bench/`](../bench/README.md) measures the observation-cost and detection differences against other browser-automation MCPs.

---

## The verdict artifact

`POST /verify` (and `reticle_run_export`) return a stable, versioned `ReticleVerificationRun` (defined in `@reticlehq/protocol`): `verdict` (pass/fail/partial, confidence, blockingRisks), `flows[]`, `checks[]`, `risks[]` (auth/payment/db/…), `repair.failurePackets[]` (what + where to fix), `evidence`. Render a legible report with `renderRunReport()` or `reticle_run_export { format: "report" }`. Profiles: `dev` (full) vs `prod-preview` (source + state redacted for downstream sharing).

**Why trust it:** the verdict is mechanical — derived only from observed outcomes — so it can't report green for something it never ran (a severed backend reads as _fail_, never a confident pass). Proof: `packages/server/src/runs/false-green.test.ts`.

## Licensing for embedding

The embeddable SDK is **Apache-2.0** (ship it in your customers' apps). The server/CLI is **FSL** (free, no competing resale). Enterprise features + the premium-access flow: [`enterprise.md`](./enterprise.md). OEM terms: **[hey@reticle.sh](mailto:hey@reticle.sh)**.
