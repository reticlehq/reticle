# Token efficiency: Iris vs. a full-tree snapshot (Playwright MCP)

Agent browser tools that feed the **whole accessibility tree** to the model every step get
expensive fast. Playwright MCP's own ecosystem notes its snapshots _"can exceed 50,000
tokens on complex pages,"_ with a _typical task ~114,000 tokens through MCP._ Iris is built
to ask **narrow questions** instead, so the per-interaction cost stays tiny.

## Head-to-head (measured, same page, same moment)

Measured against the demo dashboard (`apps/demo`) **with a 1,000-item list rendered**, after
login. Token estimate = characters ÷ 4. Reproduce with `node plan/vs-playwright.mjs`.

| Payload                                                                        |     Tokens |
| ------------------------------------------------------------------------------ | ---------: |
| **Playwright MCP** — with-refs snapshot (the real payload it sends every step) | **~7,300** |
| Playwright MCP — bare accessibility tree (what we measured directly)           |     ~6,856 |
| Iris — `snapshot` `full` (whole page, incl. all 1,000 items)                   |     ~4,144 |
| Iris — `snapshot` `interactive` (actionable elements only)                     |       ~110 |
| Iris — `snapshot` `status` (route / dialogs / counters)                        |        ~31 |
| Iris — `query` one element                                                     |        ~28 |
| Iris — `observe` (reaction after an action)                                    |        ~39 |
| Iris — `assert` verdict                                                        |        ~33 |
| **Iris — a full verify loop** (`query` + `observe` + `assert`)                 |   **~100** |

**Result on this page:** the common Iris loop is **~73× leaner** than Playwright MCP's
per-step snapshot (100 vs ~7,300 tokens). The bare a11y tree we measured directly is 6,856;
Playwright MCP's actual payload adds a `[ref=…]` to every node, pushing it to ~7,300. On the
complex pages Playwright's ecosystem cites (50k+), the gap widens to **~100–500×**.

## The honest version

- **Full-tree vs full-tree, the gap is modest (~1.8×):** Iris `full` (4,144) vs Playwright's
  with-refs snapshot (~7,300). Iris collapses generic wrapper nodes, but both include every list
  item. If you force Iris to dump the whole page each step, you don't save much.
- **The savings come from _not needing_ the full tree.** Playwright MCP's primary perception
  primitive is "return the accessibility tree"; Iris's is "answer a specific question"
  (`query`/`assert`/`observe`/scoped or interactive `snapshot`). The win is architectural,
  not a cleverer serializer.
- **Cost scales with interactive elements + what you look at, not total DOM.** The 1,000
  list items cost ~0 in `interactive` mode because they aren't interactive.
- **This is tool-output tokens only.** The agent's own reasoning tokens dominate either way —
  which is the point: keep the eyes cheap so the budget goes to thinking.

## Why it matters in practice

A 20-step verification flow:

- **Full-tree approach:** ~7,300 tokens × 20 ≈ **~146,000 tokens** (and more on complex
  pages), plus a vision model if it also screenshots.
- **Iris:** ~100 tokens × 20 ≈ **~2,000 tokens**, any model, deterministic.

At scale (long flows, large dashboards, frequent re-runs for regression) that difference is
the difference between "too expensive to run every change" and "run it on every edit."

## Method & caveats

- One page, one tool, char/4 token proxy — directional, not a benchmark suite. Absolute
  numbers vary by page; the _ratio_ is the point.
- `_snapshotForAI()` (Playwright MCP's exact with-refs payload) was unavailable in the
  installed Playwright build, so we measured `body.ariaSnapshot()` — the same accessibility
  tree it serializes; the real MCP payload is equal or slightly larger (it adds `[ref=…]`).
- Playwright MCP is excellent and Microsoft-backed; this is not a knock on it. It optimizes
  for cross-browser _driving_; Iris optimizes for cheap, in-app _verification_. They can
  coexist (drive with one, assert with the other).

Run it yourself: `node plan/vs-playwright.mjs` (with the demo + api running).
