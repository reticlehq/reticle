# UI-bug benchmark (visual + state) — brutally honest

> Tougher bugs than the Layer-A suite: each leaves the element PRESENT with the correct role + name,
> so a DOM/a11y snapshot reports "fine." Fair 3-tool comparison — each tool observes its NATIVE way.
> Reported with no flattering: where a competitor matches Iris, it is said plainly.
> Harness: `harness/visual-bug-bench.mjs`; injector: `apps/demo/src/iris-bug-injector.ts`; raw: `raw/visual-bug-bench.json`.

## Batch 1 — visually-broken / off-theme but DOM-present (DETECTION PARITY, ergonomic gap)

Six bugs where the element renders with the right role/name but is broken: `cursor-missing` (dead
pointer), `invisible` (opacity:0), `zero-size` (0×0), `occluded` (transparent z-index overlay),
`color-regression` (silent recolor), `theme-violation` (off-design-token color). The `+NN JS` is the
evaluate function the competitor agent must author and send; Iris sends only `{ref}` (~5 tok).

| bug              | Iris (`iris_inspect`)     | Playwright (`browser_evaluate`) | DevTools (`evaluate_script`) |
| ---------------- | ------------------------- | ------------------------------- | ---------------------------- |
| cursor-missing   | ✓ 225 tok                 | ✓ 272 tok (+117 JS)             | ✓ 49 tok (+117 JS)           |
| invisible        | ✓ 233                     | ✓ 272 (+118)                    | ✓ 49 (+118)                  |
| zero-size        | ✓ 229                     | ✓ 275 (+118)                    | ✓ 49 (+118)                  |
| occluded         | ✓ 233                     | ✓ 275 (+118)                    | ✓ 49 (+118)                  |
| color-regression | ✓ 230                     | ✓ 272 (+118)                    | ✓ 46 (+118)                  |
| theme-violation  | ✓ 280 (native `offTheme`) | ✓ 399 (**+259 JS**)             | ✓ 35 (**+259 JS**)           |
| **detection**    | **6/6**                   | **6/6**                         | **6/6**                      |

**Honest verdict: this class does NOT differentiate Iris on capability — it's a clean tie.** Any tool
with a JS-evaluate escape hatch can read `getComputedStyle`/geometry/`elementFromPoint`, and (for
theme) enumerate `:root` tokens, and catch all six. The earlier-looking "Iris wins" was apparatus
artifacts (a competitor MCP init timeout; a DevTools accessible-name nav missing the `Deployments500`
badge) — fixed; corrected result is a tie.

Iris's edge here is **ergonomic, and it grows with bug complexity** — one native `inspect` returns
cursor/opacity/box/occlusion/color/`offTheme` with **no JS authoring**, surfaced in the default
element observation, whereas the competitor must (1) suspect the bug, (2) know what to check, and
(3) author a correct probe. For a simple computed-style read that probe is ~118 JS tokens; for
**theme compliance it is 259 JS tokens** (enumerate every `:root` token, resolve each to rgb, test
membership) that an agent is unlikely to write unprompted. Real, but an ergonomics/Layer-B argument,
not a capability gap — and reported as such.

## Batch 2 — state/UI desync (THE CAPABILITY GAP — Iris only), now a CLASS of 2

The bugs a DOM tool fundamentally cannot catch: the UI renders a plausible, self-consistent value
that **contradicts the app's state**. Catching either needs a **source of truth** — the store — which
the in-source tool reads and an outside-the-page tool cannot. Two distinct instances, so this is a
class of Iris-only catches, not one case. Harness: `harness/state-desync-bench.mjs`; raw:
`raw/state-desync-bench.json`.

- **`state-desync` (a COUNT lies)** — the Deployments nav badge is forced to `0` while the store keeps
  the real count (`200`). A number on screen looks like a valid empty state.
- **`status-stale` (a STATUS lies)** — the top deployment row renders status `live` (correct green
  tone + dot, fully self-consistent) while the store holds `queued`. A screenshot/a11y tool sees a
  healthy, shipped deploy; only the store reveals the deploy never shipped.

| instance      | Iris (`iris_state` + read displayed)               | Playwright (`browser_evaluate`)          | DevTools (`evaluate_script`)            |
| ------------- | -------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| state-desync  | **CAUGHT** — store 200 ≠ shown 0, 47 tok           | **missed** — truth=null, 278 tok +152 JS | **missed** — truth=null, 21 tok +152 JS |
| status-stale  | **CAUGHT** — store `queued` ≠ shown `live`, 67 tok | **missed** — truth=null, 325 tok +187 JS | **missed** — truth=null, 21 tok +187 JS |
| **detection** | **2/2**                                            | **0/2**                                  | **0/2**                                 |

**Honest verdict: this is a true capability gap, not ergonomics.** Both competitors genuinely tried
to find a source of truth — their evaluate probes `window.store` / `window.useApp` /
`__REDUX_DEVTOOLS_EXTENSION__` and any `getState()` — and found nothing, because the store is
registered with Iris (`registerStore`), not exposed on a global. They read the displayed value
correctly (`0`, `live`) but have **nothing to compare it against**, so a lying UI looks valid. Iris
reads the registered store directly and flags each mismatch in one call, at a fraction of the cost.

> Apparatus note (brutal-honest): the first `status-stale` run scored Iris a _miss_ — the harness read
> `iris_inspect.name` (empty for a table row, which has no aggregated accessible name) instead of
> `iris_inspect.text` (the visible text Iris already returns). The capability was present; the
> measurement read the wrong field. Corrected, then re-run. No Iris code changed to make it pass.

This is where Iris's in-source position is decisive: **batch 1 (visual/computed-style) is parity —
any tool with an evaluate can read computed style; batch 2 (state/UI desync) is Iris-only — no amount
of DOM/JS reaches state the app never put in the DOM.** That is the honest 100×-class differentiator:
not "Iris sees pixels better," but "Iris sees the program, and the program is the source of truth."

### Still to add (batch 2 continued) — with honest expectations

Analysis of the remaining classes shows most are **parity or competitor-reachable**, because their
truth lives in the DOM / network / CSS variables that any `evaluate` can read. Only truth that lives
in app **state** (the store) is Iris-only. Stated up front so the data isn't oversold:

- **theme-violation** — DONE and measured (now in the batch-1 table above): parity detection, but the
  competitor probe costs **259 JS tokens** vs Iris's native `offTheme` flag — the suite's largest
  ergonomic gap.
- **status-stale** — DONE and measured (now in the batch-2 table above): a per-entity STATUS lies
  while the row stays visually consistent. Iris-only (2/2 in the class); both competitors read the
  displayed `live` but have no store truth to contradict it.
- **double-submit / timing** — observable in the network panel by all three tools → expected parity.
- **dropped-field** — Iris-only ONLY when the UI hides the corruption (i.e. it reduces to state/UI
  desync, already proven); if the wrong value is rendered, it's parity.

The honest meta-finding: **Iris's unique capability is detecting UI-vs-state desync.** Everything a
user can see (DOM, computed style, network) is parity with any evaluate-capable tool. That precise
boundary — not an inflated "Iris wins everything" — is the value of this dataset.

_Token figures are the `o200k` proxy used across the benchmark; "+NN JS" is the agent-authored
evaluate function the competitor must send (Iris sends only `{ref}`). All cells are genuine
observations (no missing/error) — verified in `raw/visual-bug-bench.json`._
