---
title: Token efficiency
description: Why asking narrow questions costs a fraction of feeding the whole accessibility tree to the model every step.
icon: coins
---

A full Reticle verify loop costs about **100 tokens**, against roughly **7,300** for a full-tree accessibility snapshot on the same page: about 73x leaner, because Reticle asks a narrow question instead of returning the page. If you re-look after an action with `reticle_snapshot({ diff: true })`, the re-read costs about 99% less again.

Agent browser tools that feed the **whole accessibility tree** to the model every step get expensive fast. Playwright MCP's own ecosystem notes its snapshots _"can exceed 50,000 tokens on complex pages,"_ with a _typical task ~114,000 tokens through MCP._ Reticle is built to ask **narrow questions** instead, so the per-interaction cost stays tiny.

## Head-to-head (measured, same page, same moment)

Measured against the bench dashboard (`apps/bench-app`) **with a 1,000-item list rendered**, after login. Token estimate = characters ÷ 4. Reproduce with the benchmark harness; see `bench/README.md`.

| Payload                                                                       |     Tokens |
| ----------------------------------------------------------------------------- | ---------: |
| **Playwright MCP**, with-refs snapshot (the real payload it sends every step) | **~7,300** |
| Playwright MCP, bare accessibility tree (what we measured directly)           |     ~6,856 |
| Reticle `snapshot` `full` (whole page, incl. all 1,000 items)                 |     ~4,144 |
| Reticle `snapshot` `interactive` (actionable elements only)                   |       ~110 |
| Reticle `snapshot` `status` (route / dialogs / counters)                      |        ~31 |
| Reticle `query`, one element                                                  |        ~28 |
| Reticle `observe` (reaction after an action)                                  |        ~39 |
| Reticle `assert` verdict                                                      |        ~33 |
| **Reticle, a full verify loop** (`query` + `observe` + `assert`)              |   **~100** |

**Result on this page:** the common Reticle loop is **~73× leaner** than Playwright MCP's per-step snapshot (100 vs ~7,300 tokens). The bare a11y tree we measured directly is 6,856; Playwright MCP's actual payload adds a `[ref=…]` to every node, pushing it to ~7,300. On the complex pages Playwright's ecosystem cites (50k+), the gap widens to **~100× to 500×**.

## Diffed snapshots: pay once, then only for changes

After the first snapshot, pass `reticle_snapshot({ diff: true })` to get back **only what changed** since your last look of the same scope/mode (`mode:delta` with added/removed lines, or `mode:unchanged`). A route change auto-resets to a full snapshot, so you never read a misleading cross-page diff.

Measured on a representative 150-row dashboard (the shipped regression benchmark `packages/server/src/tools/snapshot-cost.test.ts`, char/4 proxy):

| Payload                            |    Tokens |
| ---------------------------------- | --------: |
| Full re-snapshot (150-row table)   | **4,246** |
| `diff:true` after a one-row change |    **65** |
| `diff:true` when nothing changed   |    **17** |

**~99% fewer tokens** to re-look after an action, and because a `delta` carries no stale full tree, it also removes the 60K to 80K-token stale-context buildup that makes long-running agents start hallucinating selectors that no longer exist.

Every `reticle_snapshot`/`reticle_query` result also carries `cost:{ bytes, tokens }` (estimated) so you can **re-scope before reading** a large body (`mode:interactive`/`status`, a tighter `scope`, or a narrower `query`) instead of paying for it first.

## The other tax: tool schemas, paid on every request

Per-payload leanness is only half the token story. Before an agent reads a single result, it pays for the tool SCHEMAS injected into its context on every request, and this is the metric the field now organises around. A filed issue measures Playwright MCP's default tool list at 14.4k tokens = 7.2% of a Claude Code context window, and Microsoft's own README steers coding agents to the CLI over its MCP on exactly these grounds.

Measured live, all servers in one run, same tokenizer (`bench/harness/schema-tax.mjs`):

| MCP server                               | tools | schema tokens |
| ---------------------------------------- | ----: | ------------: |
| **Reticle, the tool surface**            |    18 |    **~4,930** |
| Playwright MCP                           |    23 |         3,725 |
| Chrome DevTools MCP                      |    29 |         5,116 |
| Reticle, `RETICLE_ADVERTISE_ALL_TOOLS=1` |    48 |       ~30,200 |

_Measured 2026-08-12 (`bench/raw/schema-tax.json`). Reticle's default surface has gained a tool since, so treat the first row as a floor._

There is one tool surface: the verify loop advertised directly, plus two meta-tools (`reticle_tools`, `reticle_run`) that reach every other tool on demand. Nothing is unreachable; the cold tail simply is not re-sent every turn.

`RETICLE_ADVERTISE_ALL_TOOLS=1` advertises everything WITH output schemas. It is a verification switch for suites that call by name, not a mode to run agents in. It is roughly 7x the per-turn cost, which is why it is opt-in.

**Every absolute number in this section is a dated reading, not a current value.** The table above was measured on 2026-08-12; a later `tools/list` read on 2026-08-14 put the default surface at 21,468 bytes and the full one at 134,368. The surface has grown a tool since, so both readings are already low. The _shape_ of the gap is the durable claim; the counts themselves are asserted by `surface-sizes.test.ts`, which reads them off the live surface, and that is the only place to trust them.

The typed result object still travels as `structuredContent` either way; the default surface simply does not advertise the output schema, which an agent reading the `text` block never consumed.

## The honest version

- **Full-tree vs full-tree, the gap is modest (~1.8×):** Reticle `full` (4,144) vs Playwright's with-refs snapshot (~7,300). Reticle collapses generic wrapper nodes, but both include every list item. If you force Reticle to dump the whole page each step, you don't save much.
- **The savings come from _not needing_ the full tree.** Playwright MCP's primary perception primitive is "return the accessibility tree"; Reticle's is "answer a specific question" (`query`/`assert`/`observe`/scoped or interactive `snapshot`). The win is architectural, not a cleverer serializer.
- **Cost scales with interactive elements + what you look at, not total DOM.** The 1,000 list items cost ~0 in `interactive` mode because they aren't interactive.
- **This is tool-output tokens only.** The agent's own reasoning tokens dominate either way, which is the point: keep observation cheap so the budget goes to thinking.

## Why it matters in practice

A 20-step verification flow:

- **Full-tree approach:** ~7,300 tokens × 20 ≈ **~146,000 tokens** (and more on complex pages), plus a vision model if it also screenshots.
- **Reticle:** ~100 tokens × 20 ≈ **~2,000 tokens**, any model, deterministic.

At scale (long flows, large dashboards, frequent re-runs for regression) that difference is the difference between "too expensive to run every change" and "run it on every edit."

## Method & caveats

- One page, one tool, char/4 token proxy: directional, not a benchmark suite. Absolute numbers vary by page; the _ratio_ is the point.
- `_snapshotForAI()` (Playwright MCP's exact with-refs payload) was unavailable in the installed Playwright build, so we measured `body.ariaSnapshot()`, the same accessibility tree it serializes; the real MCP payload is equal or slightly larger (it adds `[ref=…]`).
- Playwright MCP is excellent and Microsoft-backed; this is not a knock on it. It optimizes for cross-browser _driving_; Reticle optimizes for cheap, in-app _verification_. They can coexist (drive with one, assert with the other).

Run it yourself: the benchmark harness in `bench/` (see `bench/README.md`), with the demo + api running.
