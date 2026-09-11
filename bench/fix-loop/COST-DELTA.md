# v2.1.0 → v2.2.0 cost delta (WITH-Reticle)

The fix-loop ablation ran WITH-Reticle against **published v2.1.0** (`@reticlehq/server@latest`), NOT v2.2.0 (84 unpublished branch commits). So the published numbers (opus ~28 calls / 49k tok; haiku ~30 calls / 46k tok) are the **v2.1.0 baseline**. The question this file answers: does v2.2.0's richer output make the loop more expensive?

## Measured: per-act result-shape cost (direct, deterministic)

v2.2.0 adds a bounded causal summary + honesty block to **every** `act_and_wait` result (green path; the divergence capsule is red-only and excluded here). Measured on a real captured act window (o200k proxy tokens):

|                                            | tokens/act | chars |
| ------------------------------------------ | ---------- | ----- |
| v2.1.0 result (effect + verdict + trace)   | ~34        | 111   |
| **v2.2.0 added block** (summary + honesty) | **~128**   | 449   |
| v2.2.0 full result                         | ~162       | —     |

So each green act costs **~128 more output tokens** under v2.2.0. Over a ~14-act fix that is ~1.8k added tokens — roughly **+4% of the per-act response**, modest in absolute terms.

## What this does NOT capture (needs a live agent run)

The full agent-loop cost has two countervailing terms this direct measurement can't resolve:

- **(−) Surface shrink**: v2.2.0 retired 3 MCP tools; tool _definitions_ are re-sent every turn, so a smaller surface is a per-turn saving that compounds across the loop — pulls total cost DOWN.
- **(−/+) Call count**: a richer per-act result (diffs, honesty, coverage in one call) may let the agent conclude in FEWER calls (less polling) — or the extra detail may cost re-reading. Only a live run's `usage.input_tokens` + tool-call count settles the net direction.

## MEASURED: full agent-loop delta (2026-07-21)

Run against the **local v2.2.0 daemon** (verified: `packages/server/dist/cli.js _daemon` on the MCP port, and `reticle_tools` showed the retired `version_info`/`apply_update`/`rollback` absent; `act_and_wait` returned the v2.2.0 `summary.stateDiffs`/`storageDiffs` + `honesty.coverage`/`integrity` fields). Same model and prompts as the v2.1.0 baseline. **All 4 cells fixed correctly in both versions.**

Only the **4 injections that were NOT de-confounded after the baseline run** are compared — `signal-contract`, `cross-component`, and `broken-form` had their injections rewritten (comment-free) after the v2.1.0 cells ran, so they are not apples-to-apples and are excluded.

| bug | v2.1.0 tok | calls | v2.2.0 tok | calls | Δtok | Δcalls |
| --- | --- | --- | --- | --- | --- | --- |
| silent-dom-regression | 41,531 | 13 | 39,027 | 11 | −2,504 | −2 |
| missing-modal | 49,023 | 41 | 53,182 | 28 | +4,159 | −13 |
| layout-shift | 46,011 | 27 | 48,961 | 22 | +2,950 | −5 |
| route-transition-break | 46,728 | 24 | 47,001 | 18 | +273 | −6 |
| **AVG** | **45,823** | **26.25** | **47,043** | **19.75** | **+2.7%** | **−24.8%** |

### Verdict: v2.2.0 is NOT a loop cost regression — it trades tokens for round-trips

**+2.7% tokens, −24.8% tool calls.** The mechanism matches the direct measurement: each act result is ~128 tok richer (summary + honesty), but the agent needs ~25% FEWER round-trips because a single act now answers what previously took extra `observe`/`state`/`query` calls. The token premium is small and flat; the call reduction is large and consistent (−2, −13, −5, −6 across all four).

That matters beyond tokens: fewer round-trips means lower wall-clock latency and fewer opportunities for the model to wander mid-loop — the failure mode the Layer-B profile work already flagged.

**Caveat:** n=4, one model, one fixture. The direction is consistent across all four cells (calls down in every one), but this is a cost measurement, not a capability one — it says nothing about whether Reticle helps an agent fix bugs (the ablation says it doesn't, on this fixture), only that v2.2.0 made the WITH loop cheaper in round-trips than v2.1.0.

## Reproduce

The trap: a Reticle MCP proxy CONNECTS to whatever daemon already owns its port and only spawns a new one if the port is free — so a stale published daemon on the port silently substitutes the wrong build. Always start from a clean, dedicated port so the local proxy spawns the local daemon.

1. Build: `pnpm -r --filter "@reticlehq/*" build` (dist must be the branch build).
2. Point `.mcp.json` → `mcpServers.reticle` at a dedicated port no other daemon uses: `{ "command": "node", "args": ["packages/server/dist/cli.js", "mcp"], "env": { "RETICLE_PORT": "4480" } }`
3. `bash bench/fix-loop/setup-daemon.sh 4480` — frees the port + boots the bench-app against it.
4. Restart Claude Code (or reconnect the MCP) so the proxy re-reads `.mcp.json` and spawns the fresh local daemon on the clean port.
5. Verify the daemon identity before spending agent budget: `reticle_tools` must NOT list the retired `reticle_version_info`/`reticle_apply_update`/`reticle_rollback`; `reticle_sessions` shows the bench-app; one `act_and_wait` returns `summary` + `honesty` fields.
6. Run the cells, same protocol as `results.md` (WITH-Reticle only, same model/prompts as the baseline): per bug, `inject(id)` → fix-agent drives the live app via the reticle MCP → record `{fixed, tokens, toolCalls}` from usage → `revert(id)`. Helpers live in `bench/harness/inject.mjs` (see `run-fix-loop.mjs`).
7. Teardown: `bash bench/fix-loop/setup-daemon.sh --teardown 4480`, restore `.mcp.json`, restart Claude Code, and confirm `git status --short apps/bench-app` is clean (every injection reverted).
