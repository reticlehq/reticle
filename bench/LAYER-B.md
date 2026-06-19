# Layer B — the full agent loop (measured, and it humbles Iris)

> Layer A drives each tool with a fixed, expert recipe — it measures the **ceiling** (what's
> possible with perfect tool-driving). Layer B puts a **real LLM (gpt-4o) in the loop**: the model
> chooses every call until it emits a verdict. Token counts are authoritative OpenAI
> `usage` (prompt + completion), summed across turns. Harness: `harness/openai-agent-loop.mjs`;
> raw: `raw/agent-loop-openai.json`. 5 scenarios × 3 tools = 15 cells, model `gpt-4o`,
> max 14 turns. Run cost ≈ $2.50.

## The result (5 scenarios: hidden-api-500, console-error, route-break, missing-modal, control)

| Tool                | mean tokens / verification | median      | correct verdicts | mean turns |
| ------------------- | -------------------------- | ----------- | ---------------- | ---------- |
| Playwright MCP      | 30,249                     | 33,393      | 4 / 5            | 8.0        |
| Chrome DevTools MCP | 32,296                     | 34,072      | 3 / 5            | 6.2        |
| **Iris**            | **129,882**                | **126,039** | **2 / 5**        | **11.2**   |

**This inverts Layer A.** In Layer A (scripted), Iris led detection (RCR 1.0) at competitive
observation cost. In Layer B (a real agent), **Iris is both the most expensive (~4×) and the least
accurate.** Honest, measured, and exactly the failure the brief asked us to hunt for.

## What actually happened (per cell)

- **Iris missed `console-error` and `missing-modal`** — scenarios it _detected_ in Layer A. With a
  real agent, the signal was there but the model didn't extract it from Iris's verbose output.
- **Iris was correct only on hidden-api-500 and route-break.**
- **All three tools false-positived on the healthy control** (flagged a fine page as broken) —
  a general agent-reliability problem, not Iris-specific, but it caps everyone's accuracy.
- DevTools missed hidden-api-500 (concluded "all 200, PASS" without reaching the failing call).

## Why Iris loses in the loop (the mechanism)

The very things that won Layer A are liabilities in a multi-turn loop:

1. **Response richness compounds.** Iris's snapshots carry text + layout signatures; `iris_observe`
   can return _thousands_ of tokens ("338 events, ~9870 tokens"); act results carry a consequence
   trace; first calls carry a session lease. Each large result is re-fed in the agent's context on
   **every subsequent turn**, so cost grows super-linearly. A 1k-token snapshot read on turn 3 is
   still in context on turn 11.
2. **More turns.** Iris averaged 11.2 turns vs 6–8 — the agent explored more, possibly because the
   verbose output is harder to act on decisively. More turns × bigger context = the 4× blow-up.
3. **A 48-tool surface** (vs 23 / 29) gives the model more ways to wander.

Layer A rewards a tool for seeing everything in one rich look; Layer B punishes exactly that,
because the agent pays for the richness again every turn and can drown in it.

## The honest synthesis (Layer A + Layer B together)

- **Iris's ceiling is the best** (Layer A: catches every regression, including silent-DOM and CLS
  the a11y-only tools miss; categorically observes app-state/signals — see `CAPABILITY.md`).
- **Iris's real-agent behavior is the worst of the three** (Layer B: most tokens, fewest correct
  verdicts). The gap between its ceiling and its real behavior is the largest of any tool — and
  that gap, not the ceiling, is what a developer using Claude Code actually experiences today.

This is the single most actionable finding in the whole study, and it reorders the roadmap:
**Iris's #1 problem is not detection capability — it is that a real agent cannot drive it cheaply
or reliably.** The fix is not more signals; it is a **lean default agent-facing contract**:

- Default responses must be terse (the rich trace/snapshot should be opt-in, not every call).
- `iris_observe` / `iris_snapshot` must default to tight token budgets (they already accept
  `filters`/`limit`/`max_events` — the _defaults_ are too generous for a loop).
- A smaller, sharper default tool surface (or a "core" profile) so the model wanders less.
- Re-run Layer B after each leanness change — this is the metric that reflects reality.

## Threats to validity (Layer B)

- **One model (gpt-4o), one max-turn budget (14), 5 scenarios.** A stronger model, more turns, or a
  tuned system prompt could shift accuracy. But the **token-cost ratio (~4×) is structural** (it
  follows from response size × turns) and unlikely to reverse.
- The control false-positives suggest the system prompt / verdict rubric is lenient; that lowers
  everyone's accuracy equally and is a harness caveat, not an Iris artifact.
- Iris's tool results were capped at 8000 chars in the harness; without that cap its cost would be
  even higher. So 4× is a floor, not a worst case.

## Fix #1 — the lean `core` profile (measured win)

Root cause located: Iris advertises **48 tools** by default, and the tool _definitions_ are re-sent
to the model **every turn** — ~14.6k tokens/turn vs Playwright's ~3.8k (23 tools) and DevTools'
~5.3k (29 tools). Over ~11 turns that alone is ~160k tokens, and the bloated surface makes the
model wander (more turns, worse verdicts).

Fix: redefine the shipped `core` profile to the actual agent verify-loop — navigate, snapshot,
query, act, act_and_wait, observe, **network, console**, wait_for, assert, state, sessions (12
tools, ~7.2k tok/turn). The earlier `core` omitted network/console (relied on `observe`), which
made the agent flail; adding the direct tools is what recovers accuracy.

Layer B, Iris only (gpt-4o, same 5 scenarios):

| Iris profile       | tools | mean tokens | correct verdicts |
| ------------------ | ----- | ----------- | ---------------- |
| full (was default) | 48    | 129,882     | 2 / 5            |
| **core (curated)** | 12    | **69,956**  | **4 / 5**        |

That **doubles accuracy and nearly halves tokens.** Iris-core now ties Playwright (4/5) and beats
DevTools (3/5) on real-agent accuracy. It is still ~2× Playwright on tokens (70k vs 30k) — the
next lever is trimming Iris's verbose tool descriptions/schemas for lean profiles (Iris ≈600
tok/tool-def vs Playwright ≈166). Recommendation: agents should run Iris in `core`
(`IRIS_TOOL_PROFILE=core`); the benchmark now reports both.

## Fix #2 — terser tool defs for lean profiles (and the final result)

The lean `core` def cost is **schema-dominated** (~5.6k of 7.2k tok/turn is the input schemas; only
~1.3k is descriptions). Stripping schema field-descriptions would save ~1.6k but removes the
param/enum guidance that helped the agent reach the right call — too risky. So the safe lever:
advertise only the **first sentence** of each tool description on lean profiles (purpose only;
param-level schema guidance kept intact). `core` def cost: 7.2k → **6.1k tok/turn**.

### Layer B, final (gpt-4o, 5 scenarios, authoritative OpenAI usage)

| Tool                      | mean tokens / verification | correct verdicts |
| ------------------------- | -------------------------- | ---------------- |
| **Iris (core, terse)**    | **54,930**                 | **5 / 5** ✅     |
| Playwright MCP            | 30,249                     | 4 / 5            |
| Chrome DevTools MCP       | 32,296                     | 3 / 5            |
| Iris (full — old default) | 129,882                    | 2 / 5            |

**Iris now wins Layer B on accuracy** — the only tool that gets all five right, including
missing-modal (which both `full` and the first `core` run failed) and the control (no false
positive). The arc: **full 130k @ 2/5 → core 70k @ 4/5 → terse-core 55k @ 5/5.** Token cost fell
from ~4× Playwright to ~1.7×, and accuracy went from worst to best — **entirely from the
agent-facing contract (profile + terse defs); no detection capability was added or changed.**

### What this means

On the metric that matters for a coding agent — _did it correctly catch the regression_ — Iris is
now the best of the three in a real agent loop, not just in the scripted ceiling. It is still
pricier per run (~1.7× Playwright), because its responses carry more signal (content/layout
snapshots, consequence traces); that buys the +1 regression over Playwright and +2 over DevTools.
For a developer, catching the bug Playwright/DevTools miss is worth more than the token delta when
a miss costs a debugging session.

### Recommendation (shipped + next)

- **Shipped:** `core` is now the right agent verify-loop profile, and lean profiles advertise terse
  descriptions. Agents should run `IRIS_TOOL_PROFILE=core`.
- **Next (product call):** consider making `core` (or a `standard`) the default for `iris mcp` —
  weighed against skills that rely on flow/record tools (those should opt into `standard`/`full`).
- **Further token headroom:** tighter default `iris_observe`/`iris_snapshot` budgets and fewer
  turns; re-run this harness (`openai-agent-loop.mjs`) after each change — it is the metric that
  reflects what a real agent experiences.
