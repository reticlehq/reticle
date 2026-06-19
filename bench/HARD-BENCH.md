# Hard UI-bug benchmark (stress dataset) — brutally honest

> Harder bugs than the Layer-A suite: each leaves the element PRESENT with the correct role + name,
> so a DOM/a11y snapshot reports "fine." Fair 3-tool comparison — each tool observes its NATIVE way.
> Reported with no flattering: where a competitor matches Iris, it is said plainly.
> Harness: `harness/hard-bench.mjs`; injector: `apps/demo/src/iris-hard-bugs.ts`; raw: `raw/hard-bench.json`.

## Batch 1 — visually-broken-but-DOM-present (DETECTION PARITY)

Five bugs where the element renders with the right role/name but a user can't use it:
`cursor-missing` (dead pointer), `invisible` (opacity:0), `zero-size` (0×0), `occluded` (a
transparent z-index overlay), `color-regression` (silent recolor vs a baseline).

| bug              | Iris (`iris_inspect`) | Playwright (`browser_evaluate`) | DevTools (`evaluate_script`) |
| ---------------- | --------------------- | ------------------------------- | ---------------------------- |
| cursor-missing   | ✓ 225 tok             | ✓ 272 tok (+117 JS)             | ✓ 49 tok (+117 JS)           |
| invisible        | ✓ 233                 | ✓ 272 (+118)                    | ✓ 49 (+118)                  |
| zero-size        | ✓ 229                 | ✓ 275 (+118)                    | ✓ 49 (+118)                  |
| occluded         | ✓ 233                 | ✓ 275 (+118)                    | ✓ 49 (+118)                  |
| color-regression | ✓ 230                 | ✓ 272 (+118)                    | ✓ 46 (+118)                  |
| **detection**    | **5/5**               | **5/5**                         | **5/5**                      |

**Honest verdict: this class does NOT differentiate Iris on capability.** Any tool with a JS-evaluate
escape hatch can read `getComputedStyle` / `getBoundingClientRect` / `elementFromPoint` and catch all
five, at comparable cost (DevTools is the cheapest on output). The earlier-looking "Iris wins" was an
apparatus artifact (a competitor MCP init timeout, and a DevTools accessible-name nav that missed the
`Deployments500` badge) — fixed; the corrected result is a clean tie.

Iris's only real edge here is **ergonomic**: one native `inspect` returns cursor/opacity/box/
occlusion/color with no JS authoring and surfaces them in the tool's _default_ element observation,
whereas a competitor agent must (1) suspect the bug, (2) know which property to check, and (3) author
a correct probe. That matters in a real agent loop (an agent reading only an a11y snapshot has no
prompt to write the probe) — but it is an ergonomics/Layer-B argument, not a capability gap, and is
reported as such.

## Batch 2 — the capability gap (in progress)

The bugs that need information **outside the rendered DOM**, which a competitor cannot reach even with
an arbitrary-JS evaluate:

- **theme-violation** — a color that renders fine but is off the app's design-token palette. Catching
  it requires knowing the theme; Iris reads the app's tokens/store, a competitor would need them injected.
- **state/UI desync** — UI shows success while the store/server says failure (optimistic update not
  rolled back). Requires reading framework state; Iris has `iris_state`, competitors would need bespoke
  fiber-walking.
- **dropped-field / silent data corruption**, **double-submit / timing**.

This is where the honest data is expected to separate the tools. Built and measured next.

_Token figures are the `o200k` proxy used across the benchmark; "+NN JS" is the agent-authored
evaluate function the competitor must send (Iris sends only `{ref}`). All cells are genuine
observations (no missing/error) — verified in `raw/hard-bench.json`._
