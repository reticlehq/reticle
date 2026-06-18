# Adversarial review

Posture: a skeptical senior engineer on r/programming wants to discredit this benchmark.
Each attack is stated as strongly as possible, then answered with what the harness already
does or what was fixed. Attacks that landed changed the run; they are marked **[FIXED]**.

### A1. "Your token numbers aren't even Anthropic tokens."

Correct, and stated everywhere. Layer A uses `tiktoken o200k_base`, an OpenAI BPE, as a
**proxy**, alongside **exact** character and byte counts. The authoritative Anthropic count
comes only from Layer B (`usage`). Treat absolute proxy tokens as ±10–20% and directional;
the exact char/byte counts back every figure (`raw/observation-results.json`).

### A2. "You didn't measure the headline — agent reasoning tokens."

True and disclosed up front. Layer B (a real Claude tool-use loop reading `usage`) is built
(`harness/agent-loop.mjs`) but **NOT MEASURED** here: no API key in the environment, and the
runner prints a NOT MEASURED notice rather than inventing numbers. Every conclusion is scoped
to Layer A (observation cost), explicitly.

### A3. "You filtered one tool's network call and not another's — rigged." **[FIXED]**

Caught in the first run: DevTools' unfiltered `list_network_requests` returned 2828 proxy
tokens; Playwright and Iris used URL/status filters. We gave DevTools its fair
`resourceTypes:['fetch','xhr']` filter (→ 65 tokens) and **report both** the default (2828)
and filtered (65) numbers. The within-tool filtered/unfiltered gap is larger than the
between-tool gap — and we say so. No tool is measured on a non-idiomatic call.

### A4. "Snapshot diffing is noise; any two snapshots differ." **[FIXED]**

Also caught in the first run: Playwright appeared to "detect" the layout-shift regression,
but the only difference between before/after was a **timestamped console-log filename**. All
tools embed volatile per-session tokens. We added `normalize()` (strips refs/uids/session
ids/timestamps/cost) before diffing. After the fix, all three correctly **miss** the pure
CLS change via their default text observation — the honest result.

### A5. "Iris's network filter was set so it could never see the timeout." **[FIXED]**

True of the first run (hardcoded `status:500`, which a pending request can't match). Fixed to
a URL filter symmetric with Playwright's. Iris _still_ misses the timeout — and we **verified
by inspection** that the hanging request appears in neither `iris_network` nor `iris_observe`,
so the miss is a real property (completion-oriented logging), not the filter.

### A6. "Latency is just `npx` cold-start; the chart is meaningless."

Largely fair, and labeled as such (BLOG §8). Each cell spawns the server fresh and Iris waits
a fixed 3.5 s for its in-page SDK to connect, so latency is cold-start-dominated and
**over-penalizes Iris specifically**. We tell readers not to cite it as steady-state. It is
included for completeness, not as a verdict; the chart subtitle names the spawn cost.

### A7. "Detection grading is keyword matching — presence of a string isn't a correct verdict."

Layer A measures a **necessary condition**: is the failure signal present in the evidence the
tool returns? If the signal isn't in the payload, no amount of reasoning recovers it (that's
the whole observability point). Whether a model then concludes correctly is Layer B's job,
and Layer B is unmeasured. We do not claim Layer A measures agent judgment.

### A8. "The 'misses' are unfair — those tools can detect those bugs with other calls."

Disclosed prominently (BLOG §5). Misses are of each tool's **default, cheapest** path.
DevTools' `lighthouse_audit`/perf traces can measure CLS; Iris's `iris_state` would see the
KPI array shrink and `iris_visual_diff` would catch the layout shift. We measured one
idiomatic path per scenario at its default cost — which is what most agents actually do — and
said so. A thorough, costlier agent could close several gaps with any tool.

### A9. "The multiple-session failure was caused by your own orphaned processes."

Partly fair. The concurrent sessions came from stray demo tabs and Iris daemons left by
repeated benchmark runs. But the _root_ is a real design property: `iris mcp` starts a
**persistent** daemon on a **shared bridge** that outlives its client and accepts multiple
sessions — a normal user hits the same ambiguity with two open tabs. Playwright/DevTools own
an isolated browser and cannot. We document the teardown (`iris stop`) and the cause; we do
not claim Iris "crashes," only that its model has a real isolation cost.

### A10. "You ran this inside the Iris repo. Of course it favors Iris."

Structural conflict of interest, acknowledged in BLOG §8. The mitigations: published raw
JSON/logs/scripts, a documented anti-rigging fairness protocol, and conclusions that are
**unkind to Iris** (worst detection accuracy 0.667, two real blind spots, highest latency,
a setup tax). If anything the result under-sells the external tools' ceiling (we didn't run
DevTools Lighthouse).

### A11. "cross-component NOT MEASURED is convenient."

It's neutral — NOT MEASURED for **all three** tools, with a stated reason: reliable detection
needs a per-tool table-row-count heuristic that would bias the comparison. Shipping a number
we'd have to caveat into meaninglessness would be worse than omitting it. Deferred to Layer B.

### A12. "The screenshots prove nothing."

Correct — the screenshots (`artifacts/screens/`) are **illustrative** captures of the app in
each failure state plus the real console/network evidence. Detection verdicts come from the
measured payloads in `raw/observation-results.json`, never from the images.

### A13. "N=10, one app — not generalizable."

Stated in BLOG §8. This is a focused study on one React dashboard. The specific findings
(e.g. Iris's snapshot omitting non-interactive nodes) generalize only as far as the UI
pattern does. The reproducible harness exists so others can run it on their own app.

## Net effect of the review

Four attacks (A3, A4, A5, plus the cross-component invalidation) changed the actual run
before the reported numbers. The rest are disclosed limitations, not hidden ones. The
benchmark's headline — _Iris is cheapest per observation but has the worst detection coverage
and real operational costs_ — survives the review precisely because it isn't the flattering
answer.
