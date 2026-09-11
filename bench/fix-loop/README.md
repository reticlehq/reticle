# Fix-loop ablation

The release's before/after number: **does an agent fix bugs better with the Reticle MCP than without?**

For each injected bug in `apps/bench-app`, a Claude Code subagent fixes it **with** the Reticle MCP vs **without** it. We measure:

- **fixed-correctly rate** — deterministic re-check (`verify.mjs`: the injected marker string is gone)
- **tokens**, **tool calls**, **wall-time**, **wrong-fix rate**

Runs **first** to set the 2.1.0 baseline (and flush loop friction), **re-runs last** for the delta. Publish honestly either way.

## Pieces

- `../harness/inject.mjs` — the 8 deterministic injected regressions (+ `INJECTION_SIGNATURES`) and git-revert. Shared with the other Layer-A/B benches.
- `verify.mjs` — `isFixed(bugId)`: the deterministic, app-free re-check (marker gone ⇒ fixed).
- `run-fix-loop.mjs` — the ablation: `runCell` / `runAblation(fixAgent)`. `fixAgent(bugId, condition)` is injected — the real runner spawns a Claude Code subagent (Reticle MCP registered or not) and returns `{ tokens, toolCalls, wallMs }`. Kept injectable so the loop is testable without live agents.

## Run

```bash
# Harness self-check — proves the deterministic scaffolding (inject → unfixed → revert → fixed).
# NO agent, NO API budget:
node bench/fix-loop/run-fix-loop.mjs --selftest

# The full ablation spends real API budget (a fleet of live Claude Code subagents) against a booted
# bench app + Reticle daemon. Wire a fixAgent that spawns Claude Code per (bug, condition) and call
# runAblation(fixAgent). This is the MEASUREMENT the operator authorizes — it is not run by --selftest.
```

## Why the re-check is app-free

Every regression injects a unique marker string; fixing the bug (revert OR rewrite) necessarily removes it. So `!fileText.includes(marker)` is a sound, instant, deterministic "fixed" oracle — no app boot, no flake. Behavior-level verification (boot the app, assert with Reticle) is the v2 upgrade for bugs whose fix could leave the marker but still misbehave.
