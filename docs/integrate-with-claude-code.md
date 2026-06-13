# Integrate Iris with Claude Code (copy-paste prompts)

Two prompts: **(A)** make a coding agent wire Iris into your app, and **(B)** make it _use_
Iris to verify its own work. Paste them into Claude Code (or Cursor / any MCP agent) from your
project root. They point the agent at the full docs so it figures out the specifics itself.

> Iris is **dev-only + localhost-only**. It never ships to production and no-ops outside dev.

---

## Prompt A — "Integrate Iris into this app"

> ⚙️ Replace the registry line if you're on public npm (drop the `--registry`/`.npmrc` bits).
> The version is **0.2.0+**.

```text
Integrate Iris (https://… or your local copy) into this app so you can verify your own UI work
over MCP without screenshots. Iris is dev-only + localhost-only.

Read these docs first and follow them exactly:
- docs/getting-started.md   (MCP config, SDK embed, React source mapping, verify)
- docs/usage.md             (every tool, the predicate DSL, the look→act→observe→assert loop)

Then do all of this:

1. MCP: add an "iris" server to .mcp.json:
   { "mcpServers": { "iris": { "command": "npx", "args": ["@syrin/iris"] } } }

2. Install the dev deps from the local registry (skip the registry lines if using public npm):
   echo '@syrin:registry=http://localhost:4873/' >> .npmrc
   npm i -D @syrin/iris @syrin/react        # + @syrin/next for Next.js, or @syrin/babel-plugin otherwise

3. Embed the SDK in DEV ONLY (see getting-started Step 2 for your framework):
   - call iris.connect({ session: '<app-name>', present: true }) once on startup in dev
   - (present:true shows a glow border + cursor + HUD so a human can watch — optional)

4. React source mapping (so failures point at file:line) — getting-started Step 3:
   - install the React adapter: import { install } from '@syrin/iris'; install()
   - Vite: add @syrin/babel-plugin to vite.config; Next: wrap next.config with withIris from @syrin/next

5. Make the app AGENT-LEGIBLE (this is what makes Iris fast — see getting-started Step 6 and
   docs/integration-patterns.md):
   - add stable data-testid to the key interactive elements you'll want to target
   - inject ONE emitter: export const emit = createIrisEmitter() (no-op until iris.connect())
   - emit at moments the DOM can't express (save succeeded, webhook received, edit applied,
     caption generated) via commitAndSignal(emit, () => mutate(), '<name>', {...}) at commit
     points so the mutation↔signal can't drift
   - registerStore('<name>', () => myStore.getState()) for any state worth asserting
   - self-register each domain with registerIrisDomain({ testids:[...], signals:[...],
     stores:[...] }) co-located per domain, so iris_capabilities() assembles the surface
     without a central map to forget

6. Restart so the MCP server loads, run the app in dev, then VERIFY the wiring:
   - iris_sessions  → confirm this app's session is connected
   - iris_snapshot  → confirm you see the real UI
   - pick one real interaction and prove the loop end-to-end with iris_act_and_wait
     (e.g. click a button, wait for the resulting signal/element/network), and report the
     evidence + verdict.

Do not touch production code paths. Keep all Iris calls behind a dev check. When done, summarize
what you wired, the testids/signals/stores you added, and paste the passing verification.
```

---

## Prompt B — "Use Iris to verify your work" (operating loop)

Paste this once per session (or put it in `CLAUDE.md` / a skill) so the agent self-verifies
every UI change instead of guessing.

```text
This project has Iris wired (MCP server "iris"). After ANY UI change, verify it yourself before
saying it's done — never claim a behavior works without Iris evidence.

The loop is look → act → observe → assert:
- look:    iris_snapshot (semantic tree) or iris_query (find by role/text/testid). Prefer testids.
- act:     iris_act / iris_act_sequence. READ the returned `effect`:
             targetMatched:false = your ref was stale (your fault);
             defaultPrevented:true = a handler cancelled it;
             domMutatedWithin:0 && valueChanged:false = the app didn't react (likely a real bug).
- one hop: prefer iris_act_and_wait({ ref, action, until: <predicate>, timeout_ms }) — it acts,
           waits for the predicate, and returns { effect, verdict, trace } in a single call.
- assert:  iris_assert with the predicate DSL (element/text/net/route/console/signal/animation,
           allOf/anyOf/not, since, timeout_ms). On failure, READ the near-miss — it tells you
           whose fault it is. Always assert console errors didn't grow.
- state:   iris_state({ store } | { ref }) to read React/Zustand directly instead of inferring.
- learn:   iris_capabilities() to discover the app's testids/signals/stores before guessing.
- time:    iris_clock({ freeze | advanceMs | reset }) for toasts/debounces/auto-dismiss.
- regress: iris_baseline_save once green, iris_diff later to catch silent breakage.
- narrate: iris_narrate({ text }) before a meaningful action so the watching human sees intent.

Rules: target stable testids/roles, not brittle text; scope assertions with `since` after an
action; if something is unverifiable from the DOM, add an iris.signal in the app rather than
asserting on volatile output. Report evidence, not prose.
```

---

## What "good integration" looks like (checklist the agent should hit)

- [ ] `.mcp.json` has the `iris` server; `iris_sessions` shows the app connected.
- [ ] `iris.connect()` is dev-gated; nothing Iris ships to prod.
- [ ] React adapter installed + source mapping returns `file:line` from `iris_inspect`.
- [ ] Key elements have `data-testid`; components depend on an injected `createIrisEmitter()`
      emitter and commit points use `commitAndSignal(...)` so signals can't drift.
- [ ] `registerCapabilities(...)` / per-domain `registerIrisDomain(...)` declare the surface;
      `iris_capabilities()` returns it.
- [ ] One real flow verified end-to-end with `iris_act_and_wait` (evidence + verdict pasted).

## Upgrading later

Iris is pre-1.0, so new tools land as minor bumps. Pull the latest explicitly:

```bash
npm i -D @syrin/iris@latest @syrin/react@latest @syrin/next@latest @syrin/babel-plugin@latest
```

(`npm update` alone won't cross a `0.x` minor — use `@latest`.) The full tool list lives in
[usage.md](usage.md); the loop and predicate DSL are documented there too.
