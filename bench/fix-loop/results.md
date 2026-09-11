# Fix-loop ablation — run log

Real cells executed via the harness (`run-fix-loop.mjs` pattern) with live Claude Code subagents as the `fixAgent` and the deterministic `verify.isFixed` oracle. Each cell: inject the bug → agent fixes → deterministic re-check (`verify.mjs`: injected marker gone) → revert (bench-app verified git-clean after every cell). The WITH-RETICLE cells drove the **live, `feat/v2.2.0`-instrumented** bench-app on `localhost:4313` (session connected to the branch daemon on 4460, separate from the operator's cloud-app session on 4320, which was never touched). The WITHOUT-RETICLE cells read source only — no app boot, no Reticle tools.

## Run — full n=8 matrix, both conditions (2026-07-21, general-purpose subagents, single model)

visible = a human/agent can see the defect in the DOM/UI; invisible = DOM/console/network look healthy.

| bug | visibility | condition | fixed | tokens | tool calls |
| --- | --- | --- | --- | --- | --- |
| silent-dom-regression (dropped KPI card) | visible | without | ✅ | 32,992 | 3 |
| silent-dom-regression | visible | **with** | ✅ | 41,531 | 13 |
| signal-contract-violation (dropped nav signal, UI fine) | **invisible** | without | ✅ | 35,028 | 6 |
| signal-contract-violation | **invisible** | **with** | ✅ | 58,329 | 42 |
| route-transition-break (compose view unreachable) | visible | without | ✅ | 36,363 | 5 |
| route-transition-break | visible | **with** | ✅ | 46,728 | 24 |
| missing-modal (new-deploy button dead) | visible | without | ✅ | 40,447 | 6 |
| missing-modal | visible | **with** | ✅ | 49,023 | 41 |
| broken-form-validation (empty service submits) | semi | without | ✅ | 34,023 | 4 |
| broken-form-validation | semi | **with** | ✅ | 48,258 | 32 |
| cross-component-regression (filter → table dead) | visible | without | ✅ | 37,159 | 4 |
| cross-component-regression | visible | **with** | ✅ | 61,134 | 31 |
| layout-shift (grid 1.6fr/1fr → 3×1fr) | visible | without | ✅ | 32,929 | 4 |
| layout-shift | visible | **with** | ✅ | 46,011 | 27 |
| network-timeout (spurious hanging fault button) | visible | without | ✅ | 32,251 | 3 |
| network-timeout | visible | **with** | ✅ | 40,623 | 15 |

**Delta (n=8, single model, capable code-reading agent):**

| condition       | fixed rate     | avg tokens | avg tool calls |
| --------------- | -------------- | ---------- | -------------- |
| without-reticle | **8/8 (100%)** | 35,149     | 4.4            |
| with-reticle    | **8/8 (100%)** | 48,955     | 28.1           |

Reticle cost more on **every single bug** — ~1.39× tokens and ~6.4× tool calls — because live-driving the app (navigate, snapshot, act, observe, re-verify after HMR) is inherently more calls than reading source.

## Honest reading (per the plan: "publish honestly either way")

- **Both conditions fixed all 8 bugs.** With a _capable code-reading agent_, WITHOUT Reticle was cheaper on every bug. The agent localized each regression — even the invisible dropped-signal one — by grep/code archaeology, while the Reticle agent additionally paid navigation + live-observation + post-HMR re-verify overhead.
- **Reticle did not win on cost even on its home turf.** `signal-contract-violation` is the one truly _invisible_ bug (DOM/console/network all healthy). WITHOUT still fixed it (35k tok) by reading the store and noticing the dropped `emit(NAV_CHANGED)`. WITH fixed it too (58k tok) and additionally _proved_ the regression live: `reticle_assert { kind:"signal", name:"nav:changed" } → pass:false` and `reticle_observe → signals:0` while every other channel read healthy. That confirmation is the product thesis in action — but a strong agent reached the same source fix without it.
- **What this ablation does NOT measure (the real edge):** these agents can read the whole ~small fixture and reason to the fix. Reticle's expected advantage is on (a) _weaker/cheaper_ agents that cannot code-archaeologize a large unfamiliar app, (b) apps too large to hold in context where "which of 40k lines broke" needs runtime narrowing, and (c) _acceptance/regression-gating in CI_ where the deterministic live assertion — not the source fix — is the deliverable. None of those are captured by "one capable model, one tiny fixture, fix-the-injected-bug."
- **Verdict for the release:** on this benchmark Reticle is a **cost regression, not a fix-rate gain**, and we publish that. The honest pitch is _deterministic proof of invisible/consequence regressions_, not _cheaper bug-fixing by a strong agent_. The number to chase next is (a) a weaker fix model and (b) a large app where source-only localization fails.

## Run — full n=8 × 2 matrix, WEAKER model (2026-07-21, haiku fix-agents)

The strong-model run above left the thesis untested: a capable agent code-archaeologized every bug, so Reticle's live-proof edge never had to carry weight. The thesis says the edge should appear on a _weaker_ agent that cannot read its way to the fix. So we re-ran the full matrix with `haiku` fix-agents.

`fixed` = the deterministic marker oracle (`verify.isFixed`). `behavior` notes where the marker passed but the fix is actually wrong/partial — the oracle's blind spot.

| bug | condition | fixed | tokens | tool calls | behavior note |
| --- | --- | --- | --- | --- | --- |
| silent-dom-regression | without | ❌ | 26,994 | 4 | claimed the fix, never applied the edit — oracle caught it |
| silent-dom-regression | **with** | ✅ | 39,511 | 17 | live re-check forced haiku to confirm the card rendered |
| signal-contract-violation | without | ✅ | 30,341 | 5 | found via the in-source `(regression)` comment |
| signal-contract-violation | **with** | ✅ | 54,291 | 63 | fixed, but 63 calls — heavy MCP thrashing |
| route-transition-break | without | ✅ | 29,990 | 6 |  |
| route-transition-break | **with** | ✅ | 42,182 | 25 |  |
| missing-modal | without | ✅ | 33,304 | 9 |  |
| missing-modal | **with** | ✅ | 51,741 | 35 |  |
| broken-form-validation | without | ✅ | 26,835 | 4 |  |
| broken-form-validation | **with** | ❌ | 43,782 | 22 | fixed the button but left the submit-handler guard removed — partial |
| cross-component-regression | without | ✅ | 30,972 | 7 |  |
| cross-component-regression | **with** | ✅ | 38,572 | 19 |  |
| layout-shift | without | ✅ | 29,715 | 8 |  |
| layout-shift | **with** | ⚠️ | 45,969 | 21 | marker passed BUT over-edited styles.css (`.grid-kpi` 4→2 cols) — a **wrong-fix** the oracle can't see |
| network-timeout | without | ✅ | 27,664 | 4 |  |
| network-timeout | **with** | ✅ | 49,235 | 38 |  |

**Weak-model delta (n=8, haiku):**

| condition       | marker-fixed | behaviorally correct  | avg tokens | avg tool calls |
| --------------- | ------------ | --------------------- | ---------- | -------------- |
| without-reticle | 7/8          | 7/8                   | 29,477     | 5.9            |
| with-reticle    | 7/8          | **6/8** (1 wrong-fix) | 45,660     | 30.0           |

## Cross-model verdict (the honest result)

**The thesis did not hold on this bench, even with a weak model.** Reticle did not lift the fix rate at either capability tier, and it cost ~5–6× the tool calls (opus 4.4→28.1; haiku 5.9→30.0). Two real observations, pointing opposite ways, net to no advantage here:

- **One point FOR Reticle:** `silent-dom` — haiku _failed_ WITHOUT (claimed a fix it never applied) but _succeeded_ WITH, because the forced live re-check made it confirm the DOM actually changed. Reticle's verification loop catches the weak model's "claim without applying" failure mode. n=1, but real.
- **One point AGAINST:** `layout-shift` — driving the live app, haiku _over-edited_ (touched `styles.css` it shouldn't have), a collateral regression the marker oracle scores as a pass. WITH-Reticle a weak model has more surface to break, and did.

**Why this bench cannot settle the thesis (the actual takeaway):**

1. **Fixture too small.** `apps/bench-app` is a handful of short files; every bug localizes by reading one store file. Source-only wins because there is barely any source. The thesis needs an app whose source does NOT fit in context, where runtime narrowing is the only way in.
2. **Self-labeling injections.** Several bugs leave a literal `/* … (regression) */` comment in the touched code — a giveaway that hands the answer to any source-reader and inflates every WITHOUT-Reticle cell. Fair injections must be behavior-only, no in-source marker on the buggy line.
3. **Marker oracle ≠ behavior oracle.** `isFixed` checks a string is gone; it cannot see partial fixes (broken-form) or wrong-fixes (layout-shift). The real number needs the app booted and asserted (with Reticle) — behavioral verification is the v2 upgrade the README already flagged.

**Next measurement (to actually test the thesis):** a large-app fixture (source > context) + comment-free injections + a behavioral pass/fail oracle. Only then does "can't read your way to it" bind, which is the one condition under which Reticle's inside-the-app proof is supposed to win. Until that exists, the honest public claim stays: _deterministic proof of invisible/consequence regressions in CI_, not _cheaper or higher-yield bug-fixing by an agent_ — the ablation does not support the latter at any tier tested.

## Reproduce

```bash
# Deterministic harness self-check (no agent, no budget):
node bench/fix-loop/run-fix-loop.mjs --selftest

# With-Reticle live setup used for this run:
#   1) daemon: feat/v2.2.0 packages/server on :4460 (the session MCP already points here)
#   2) bench-app: cd apps/bench-app && RETICLE_PORT=4460 VITE_RETICLE_TOKEN="$(cat ~/.reticle/pairing-token)" pnpm dev
#   3) open http://localhost:<vite-port>/ in a browser → SDK connects as a NEW session
#      (the session id ROTATES on every HMR reload — resolve it fresh via reticle_sessions each cell)
#   4) inject a bug, hand the running session to a fix-agent, re-check with verify.isFixed, revert.
```
