# Iris — agent cheat-sheet

One screen to get fluent. Iris gives you **eyes into a running app** — no screenshots, no
vision model, evidence not prose. Everything below returns structured data. Full guide:
[usage.md](usage.md).

## The core loop: look → act → observe → assert

| Verb        | Tool                             | One-liner                                                                           |
| ----------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| **look**    | `iris_snapshot` / `iris_query`   | See the page (semantic tree) / find one specific element.                           |
| **act**     | `iris_act` / `iris_act_and_wait` | Click/fill a `ref` / act + wait for a predicate in one hop.                         |
| **observe** | `iris_observe` / `iris_wait_for` | Everything the app did after `since` / block until true.                            |
| **assert**  | `iris_assert`                    | Evaluate a predicate → `{ pass, evidence, failureReason? }`. The end of every loop. |

`iris_act` returns a `since` cursor — pass it to `iris_observe({ since })` to scope the window.
Elements are addressed by stable refs (`e7`) from `snapshot`/`query`; they re-resolve across re-renders.

**`assert`/`wait_for` are auto-scoped to your last act.** By default they only count events buffered
_since_ the most recent act, so a stale signal from a previous step can't fake a pass — pass an
explicit `since` to override. **Clicks run the code, not pixels:** `iris_act` click fires the full
pointer sequence on the element (no coordinate gesture for the HUD to intercept), reports
`occluded:true` when something covers the target, and stays synthetic even with CDP configured
(use `args:{ native:true }` for a trusted native click).

## The 4-layer cross-check — never trust a green the state contradicts

A claim is real only when the layers agree. Check more than the UI:

| Layer       | Tool(s)                              | Question it answers                         |
| ----------- | ------------------------------------ | ------------------------------------------- |
| **UI**      | `iris_snapshot` / `iris_query`       | Is it on screen / in the right state?       |
| **signal**  | `iris_capabilities` / `iris_observe` | Did the app emit the intent it advertised?  |
| **network** | `iris_network`                       | Did `POST /x` actually fire and return 200? |
| **store**   | `iris_state`                         | Does live framework/store state match?      |

> **Rule:** a passing UI assert that the store, network, or signal contradicts is a **false green**.

**Session health is universal.** Every live-session tool result carries a `session` block
(`throttled`, `focused`, `lastSeenMs`); when `throttled:true` it also adds a `warning` +
`recommendation` (refocus, or `iris drive`). A throttled/backgrounded tab can silently no-op
timers/rAF/pointer gestures — if you see `session.throttled`, distrust a green and refocus first.

> Store reads (`iris_state`) are the reliable path; the DOM can lie (optimistic UI, stale render).

**Reads never go silently empty.** A zero-result read returns a `hint`, not a bare `[]`:
`iris_query` → `{ route, presentTestids, knownEmptyState }`; `iris_network` → `{ totalInWindow, present[] }`
(what DID fire); `iris_console` → `{ totalInWindow, byLevel }` (so "0 errors" ≠ "silent page");
`iris_state` lists `storeNames` when a store isn't found. Read the hint before assuming "not there."
Scope big stores with `iris_state({ store, path:"a.b.0", depth })` instead of paying for the whole
tree; a wrong `path` returns `{ found:false, availableKeys }` so it's self-correcting.

## Core tool set

Sessions/perception/verify — what you'll use 90% of the time:

`iris_sessions` · `iris_snapshot` · `iris_query` · `iris_act` · `iris_act_and_wait` ·
`iris_observe` · `iris_wait_for` · `iris_assert` · `iris_state` · `iris_diff` ·
`iris_capabilities` · `iris_narrate` (show intent on-page) · `iris_project` (run-history, see below).

**Reach past core when…** you need to record/replay a journey (`iris_record_start/stop`,
`iris_replay`), persist a self-healing golden flow (`iris_flow_save*` / `iris_flow_replay` /
`iris_flow_heal`), compile annotations (`iris_annotate`), explore autonomously
(`iris_explore` lists controls; `iris_crawl` clicks them all and reports anomalies — **destructive**),
reveal a virtualized off-screen row (`iris_scroll_to` — when `iris_query` finds nothing because a
windowed list hasn't rendered it yet),
visual-check (`iris_screenshot` / `iris_visual_diff`), or hand control to a human
(`iris_end_session` / `iris_resume` / `iris_messages`).

## flows vs baselines vs project.json (the persistence layers)

| Artifact         | Tool(s)                                                   | What it is                                                                                     |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **flows**        | `iris_flow_save*` / `iris_flow_replay` / `iris_flow_heal` | Replayable **golden journeys**, anchored to testids/signals — drift is legible and self-heals. |
| **baselines**    | `iris_baseline_save` / `iris_diff`                        | Structural **"before" snapshots**; `iris_diff` flags regressions against them.                 |
| **project.json** | `iris_project` _(0.3.7)_                                  | Cross-run **run-history** — "did it behave like last run?" read via `iris_project`.            |

> `iris_project` / `iris_run_record` / `project.json` are the **run-history layer**, landing in
> **0.3.7**. flows answer "does the journey still work?"; baselines answer "did the structure
> change?"; project.json answers "is this run consistent with prior runs?".

**Visual layer (opt-in, M11).** `iris_screenshot` saves a PNG baseline to `.iris/visual/<name>.png`;
`iris_visual_diff` perceptually compares the live page to it (`{ masks }` to ignore volatile
regions, `{ maxRatio }` tolerance) → `{ matched, changedPixels, ratio, region, diffPath }`. It
answers "does it **look** right" — complementary to the behavioral layers, never a replacement.
Both need a **driven browser** (`iris drive <url>` / `IRIS_CDP_URL`); without one they return
`{ ok:false, reason:"no-visual-provider" }` (the always-on SDK ships no screenshotter).

## Start here

1. `iris_sessions` — find the connected tab (omit `sessionId` if there's only one).
2. `iris_capabilities` — learn the app's testable surface (`testids`, `signals`, `stores`, `flows`)
   so you assert on facts without reading source. (`iris_sessions` flags `hasCapabilities`.)
3. Run the loop: **look → act → observe → assert**, cross-checking the 4 layers on anything that matters.

## Token note

- **Keep the eyes cheap.** Prefer `iris_query` / scoped or `interactive` `iris_snapshot` /
  `iris_assert` over dumping the full tree. A full verify loop is ~100 tokens; see
  [token-efficiency.md](token-efficiency.md) (~73× leaner than full-tree snapshots).
- **Predicate schema is not bloated.** The recursive predicate DSL used by `iris_assert` /
  `iris_wait_for` / `iris_act_and_wait` is **factored, not inlined**: when converted to the
  JSON Schema MCP sends, the predicate body is emitted **once** (~2.7k chars ≈ **~685 tokens**
  per tool) and recursion is handled by self-`$ref` (`#/properties/predicate`) — no per-recursion
  duplication. No action needed. (Measured via `plan/predicate-measure.mjs`.)
- **Lean clients:** set `IRIS_TOOL_PROFILE=core` to expose only the core tool set above and trim
  tool-definition tokens for context-tight agents.
