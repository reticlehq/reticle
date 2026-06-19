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

## Batch 2 — state/UI desync (THE CAPABILITY GAP — Iris only)

The bug a DOM tool fundamentally cannot catch: the Deployments nav badge is forced to a wrong count
(`0`) while the store keeps the real one (`200`). The UI lies about the truth. Catching it needs a
**source of truth** — the app's state — which the in-source tool reads and an outside-the-page tool
cannot. Harness: `harness/hard-bench-state.mjs`; raw: `raw/hard-bench-state.json`.

| tool                            | reads truth?                             | result                         | cost             |
| ------------------------------- | ---------------------------------------- | ------------------------------ | ---------------- |
| **Iris** (`iris_state`)         | **yes — store = 200**                    | **CAUGHT** (200 ≠ displayed 0) | 47 tok           |
| Playwright (`browser_evaluate`) | no — searched window globals, found none | **missed** (truth=null)        | 295 tok + 168 JS |
| DevTools (`evaluate_script`)    | no — searched window globals, found none | **missed** (truth=null)        | 21 tok + 168 JS  |

**Honest verdict: this is a true capability gap, not ergonomics.** Both competitors genuinely tried
to find a source of truth — their evaluate probes `window.store` / `window.useApp` /
`__REDUX_DEVTOOLS_EXTENSION__` and any `getState()` — and found nothing, because the store is
registered with Iris (`registerStore`), not exposed on a global. With no truth to compare against,
the displayed `0` looks like a valid empty state; they **cannot** know the UI is wrong. Iris reads
the registered store directly and flags the mismatch in one call, at a fraction of the cost.

This is where Iris's in-source position is decisive: **batch 1 (visual/computed-style) is parity —
any tool with an evaluate can read computed style; batch 2 (state/UI desync) is Iris-only — no amount
of DOM/JS reaches state the app never put in the DOM.** That is the honest 100×-class differentiator:
not "Iris sees pixels better," but "Iris sees the program, and the program is the source of truth."

### Still to add (batch 2 continued)

- **theme-violation** — an off-design-token color (Iris reads the app's tokens; a competitor would
  need them injected). Partially reachable via CSS custom properties, so a narrower edge — measured next.
- **dropped-field / silent data corruption**, **double-submit / timing**.

_Token figures are the `o200k` proxy used across the benchmark; "+NN JS" is the agent-authored
evaluate function the competitor must send (Iris sends only `{ref}`). All cells are genuine
observations (no missing/error) — verified in `raw/hard-bench.json`._
