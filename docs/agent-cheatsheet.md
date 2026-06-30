# Reticle — agent cheat-sheet

One screen to get fluent. Reticle is the **proof layer for AI agents** — no screenshots, no vision model, evidence not prose. Everything below returns structured data. Full guide: [usage.md](usage.md).

## The core loop: look → act → observe → assert

| Verb | Tool | One-liner |
| --- | --- | --- |
| **look** | `reticle_snapshot` / `reticle_query` | See the page (semantic tree) / find one specific element. |
| **act** | `reticle_act` / `reticle_act_and_wait` | Click/fill a `ref` / act + wait for a predicate in one hop. |
| **observe** | `reticle_observe` / `reticle_wait_for` | Everything the app did after `since` / block until true. |
| **assert** | `reticle_assert` | Evaluate a predicate → `{ pass, evidence, failureReason? }`. The end of every loop. |

`reticle_act` returns a `since` cursor — pass it to `reticle_observe({ since })` to scope the window. Elements are addressed by stable refs (`e7`) from `snapshot`/`query`; they re-resolve across re-renders.

**`assert`/`wait_for` are auto-scoped to your last act.** By default they only count events buffered _since_ the most recent act, so a stale signal from a previous step can't fake a pass — pass an explicit `since` to override. **Clicks run the code, not pixels:** `reticle_act` click fires the full pointer sequence on the element (no coordinate gesture for the HUD to intercept), reports `occluded:true` when something covers the target, and stays synthetic even with CDP configured (use `args:{ native:true }` for a trusted native click).

**Never sleep — wait deterministically.** Fixed sleeps are the #1 cause of flaky agent tests. Instead:

- `reticle_act_and_wait({ ref, action })` with **no `until`** waits for the page to _settle_ (network + structural DOM idle; ambient count-up/spinner churn is ignored so an animated page still settles) before returning — the one-call replacement for "click then sleep 500ms".
- Need to wait without acting? `reticle_wait_for({ predicate: { kind: "settled", quietMs } })`.
- Waiting for a specific outcome? Pass that consequence as the predicate (`{ signal }` / `{ net }`), or `allOf` it with `{ kind: "settled" }` to wait for both the event _and_ the page going quiet.

**Assert a consequence, not just presence.** `{ signal }` / `{ net }` prove the feature actually did something; `{ element }` / `{ text }` only prove something is on screen — which a stale render or a locator healed to the wrong element can fake. A _passing_ presence-only `reticle_assert` returns `advice` nudging you to a consequence; heed it on anything that matters.

## The 4-layer cross-check — never trust a green the state contradicts

A claim is real only when the layers agree. Check more than the UI:

| Layer | Tool(s) | Question it answers |
| --- | --- | --- |
| **UI** | `reticle_snapshot` / `reticle_query` | Is it on screen / in the right state? |
| **signal** | `reticle_capabilities` / `reticle_observe` | Did the app emit the intent it advertised? |
| **network** | `reticle_network` | Did `POST /x` actually fire and return 200? |
| **store** | `reticle_state` | Does live framework/store state match? |

> **Rule:** a passing UI assert that the store, network, or signal contradicts is a **false green**.

**Session health is universal.** Every live-session tool result carries a `session` block (`throttled`, `focused`, `lastSeenMs`); when `throttled:true` it also adds a `warning` + `recommendation` (refocus, or `reticle drive`). A throttled/backgrounded tab can silently no-op timers/rAF/pointer gestures — if you see `session.throttled`, distrust a green and refocus first.

> Store reads (`reticle_state`) are the reliable path; the DOM can lie (optimistic UI, stale render).

**Reads never go silently empty.** A zero-result read returns a `hint`, not a bare `[]`: `reticle_query` → `{ route, presentTestids, knownEmptyState }`; `reticle_network` → `{ totalInWindow, present[] }` (what DID fire); `reticle_console` → `{ totalInWindow, byLevel }` (so "0 errors" ≠ "silent page"); `reticle_state` lists `storeNames` when a store isn't found. Read the hint before assuming "not there." Scope big stores with `reticle_state({ store, path:"a.b.0", depth })` instead of paying for the whole tree; a wrong `path` returns `{ found:false, availableKeys }` so it's self-correcting.

## Core tool set

Sessions/perception/verify — what you'll use 90% of the time:

`reticle_sessions` · `reticle_domain` (learn the app + gaps, read first) · `reticle_snapshot` · `reticle_query` · `reticle_act` · `reticle_act_and_wait` · `reticle_observe` · `reticle_wait_for` · `reticle_assert` · `reticle_state` · `reticle_diff` · `reticle_capabilities` · `reticle_narrate` (show intent on-page) · `reticle_project` (run-history).

**Reach past core when…** you need to record/replay a journey (`reticle_record_start/stop`, `reticle_replay`), persist a self-healing golden flow (`reticle_flow_save*` / `reticle_flow_replay` / `reticle_flow_heal`), compile annotations (`reticle_annotate`), explore autonomously (`reticle_explore` lists controls; `reticle_crawl` clicks them all and reports anomalies — **destructive**), reveal a virtualized off-screen row (`reticle_scroll_to` — when `reticle_query` finds nothing because a windowed list hasn't rendered it yet), visual-check (`reticle_screenshot` / `reticle_visual_diff`, pinned with `reticle_viewport` for reproducible baselines), test error/edge states by stubbing the network (`reticle_network_mock` — 500 / offline / delay, driven mode), or work with a human (`reticle_end_session` / `reticle_resume` / `reticle_messages`, and **`reticle_review`** to drain + fix the bugs the human flagged from the panel).

## flows vs baselines vs project.json (the persistence layers)

| Artifact | Tool(s) | What it is |
| --- | --- | --- |
| **flows** | `reticle_flow_save*` / `reticle_flow_replay` / `reticle_flow_heal` | Replayable **golden journeys**, anchored to testids/signals — drift is legible and self-heals. |
| **baselines** | `reticle_baseline_save` / `reticle_diff` | Structural **"before" snapshots**; `reticle_diff` flags regressions against them. |
| **project.json** | `reticle_project` | Cross-run **run-history** — "did it behave like last run?" read via `reticle_project`. |

> `reticle_project` / `reticle_run_record` / `project.json` are the **run-history layer**. flows answer "does the journey still work?"; baselines answer "did the structure change?"; project.json answers "is this run consistent with prior runs?".

**Visual layer (opt-in, M11).** `reticle_screenshot` saves a PNG baseline to `.reticle/visual/<name>.png`; `reticle_visual_diff` perceptually compares the live page to it (`{ masks }` to ignore volatile regions, `{ maxRatio }` tolerance) → `{ matched, changedPixels, ratio, region, diffPath }`. It answers "does it **look** right" — complementary to the behavioral layers, never a replacement. Both need a **driven browser** (`reticle drive <url>` / `RETICLE_CDP_URL`); without one they return `{ ok:false, reason:"no-visual-provider" }` (the always-on SDK ships no screenshotter).

## Start here

0. Just ran `reticle init` / started the dev server? `reticle_wait_ready` — blocks until the app connects (instant if it already has) so your first call doesn't lose the race; its reply also carries a one-line `loop` guide.
1. `reticle_sessions` — find the connected tab (omit `sessionId` if there's only one).
2. `reticle_domain` — learn the app BEFORE testing: the saved flows, what each asserts, and the **gaps** (declared signals/testids that no flow verifies — untested intent). Tells you what to test and where the real risk is without crawling the whole app. Falls back to `reticle_capabilities` for the raw testable surface (`testids`, `signals`, `stores`, `flows`).
3. Run the loop: **look → act → observe → assert**, cross-checking the 4 layers on anything that matters.

## Token note

- **Keep observation cheap.** Prefer `reticle_query` / scoped or `interactive` `reticle_snapshot` / `reticle_assert` over dumping the full tree. A full verify loop is ~100 tokens; see [token-efficiency.md](token-efficiency.md) (~73× leaner than full-tree snapshots).
- **Re-look with `reticle_snapshot({ diff:true })`** after an action — it returns only what changed (`mode:delta`/`unchanged`), ~99% fewer tokens than a full re-snapshot and no stale tree to mis-read. Every snapshot/query result carries `cost:{ bytes, tokens }` — re-scope before reading if it's large.
- **Cap broad reads.** `reticle_query` takes `limit` (caps descriptors; reports `total`/`truncated`) and `count_only` (just the match count). `reticle_network` / `reticle_console` take `limit` (most-recent-N, reports `droppedOldest`) and carry the same `cost` hint — so a busy page or wide window never floods your context unnoticed.
- **A saved flow tells you if it's a real test.** `reticle_flow_save` returns `assertions.grade` (`asserted` / `presence-only` / `assertion-free`); if it's not `asserted`, add a consequence (`reticle_annotate` assert-signal/assert-net or a success-state) so it can't pass while broken. On replay, an ambiguous heal (two testids tie) is surfaced, never auto-applied — and an `apply` heal re-replays the rebound flow and **refuses to write** if the success consequence no longer fires (`status:consequence_broken`): it heals the locator, never the intent.
- **Predicate schema is not bloated.** The recursive predicate DSL used by `reticle_assert` / `reticle_wait_for` / `reticle_act_and_wait` is **factored, not inlined**: when converted to the JSON Schema MCP sends, the predicate body is emitted **once** (~2.7k chars ≈ **~685 tokens** per tool) and recursion is handled by self-`$ref` (`#/properties/predicate`) — no per-recursion duplication. No action needed.
- **Tool profile (default `hybrid`).** By default Reticle advertises the ~12 core verify+oracle tools directly (navigate/act/observe/assert/state/network/console — the whole detect loop) PLUS two meta-tools that keep every other tool one call away at ~64% less tool-schema tax: `reticle_tools` (discover — no args lists every tool name + summary; `names:[…]` loads full params on demand) and `reticle_run({ tool, args })` (invoke any tool by name). So to record/replay/verify a flow under the default, call `reticle_run({ tool:"reticle_flow_verify", args:{…} })` (or `reticle_tools` first to see params). Want every tool advertised directly (no `reticle_run` indirection)? set `RETICLE_TOOL_PROFILE=standard` (flows + common extras direct) or `=full` (all 57). `=core` trims to just the core loop; `=dynamic` advertises only the 2 meta-tools.
