# How Iris verifies a vibe-coded / generated app

> What actually happens, step by step, when Iris checks an app an AI built — and exactly which
> "looks-done-but-isn't" failures it catches that a screenshot or "does it look right?" pass misses.
> Runnable counterpart: `examples/generated-app/` (a deliberately-buggy app). Proof in CI:
> `packages/server/src/runs/generated-app-bugs.test.ts`.

## The problem Iris is built for

An AI builder emits an app that **renders** — buttons, forms, a nice layout. But "renders" ≠ "works":
the Save button returns 200 yet nothing persists, Delete looks done but the row is back on refresh, one
click fires two charges, the Total lies, a console error fires while the UI looks fine. These are
invisible to a screenshot and to the model that wrote them. They're what users hit five minutes later.

## The loop

```
generate / edit  →  boot the preview  →  Iris drives the critical flows  →  asserts program-truth
                                                                              consequences (not pixels)
        ┌──────────────────────────────────────────────────────────────────────────┘
        ▼
   verdict + evidence + repair  →  PASS: ship & attach "verified ✓"
                                →  FAIL/PARTIAL: gate the deploy, feed repair packets to the fixer
```

One call replays the app's key journeys and checks what **actually happened** in the program — the
network, the store/state, emitted signals, the console — then returns a deterministic verdict.

## Step by step

1. **Boot the preview.** Iris attaches to the running app (drives a headless browser to the preview URL,
   or connects to the app's embedded SDK).
2. **Exercise the critical flows.** Add an expense, delete one, submit invalid input, check out — the
   journeys that matter, replayed deterministically (no LLM in the loop, ~175 tokens/run, 0% flake).
3. **Assert the consequence, post-settle.** Each flow has a success oracle that compiles to a real
   predicate over `signal | state | net{count} | console | state{hold}` — checked _after_ the action
   settles, so it can't pass before the effect (or the failure) lands.
4. **Classify the change set's risk** (auth/payment/db/destructive/…) and apply policy gates.
5. **Emit the verdict** — a stable `IrisVerificationRun`: pass/fail/partial, per-flow results, risks,
   `repair.failurePackets` (what's broken + where), and the evidence behind it. Render it with
   `renderRunReport()` for a legible ✓/✗ summary.

## What it catches (and how)

| The silent failure (a generated app ships it)                  | How Iris catches it                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Mock data** — POST 200, row shows, nothing persists          | persistence/`state` oracle: doesn't survive reload; store length unchanged |
| **Dead handler** — Delete/Ship looks done, store never changed | `state` desync / dead-handler oracle                                       |
| **Double-submit** — one click, two POSTs                       | `net { count: 1 }` cardinality                                             |
| **Forbidden call** — a must-never-fire endpoint fired          | `net { count: 0 }`                                                         |
| **Missing validation** — `"abc"` becomes data                  | flow oracle: error shown AND nothing created — neither holds               |
| **Silent console error** — logged, UI still renders            | `console { absent: true }`                                                 |
| **UI-vs-store desync** — the Total lies                        | reads the store, contradicts the displayed value                           |
| **Blast-radius** — an action corrupts _unrelated_ state        | `state { hold:true }` invariant (invisible to any DOM/pixel tool)          |

The first seven are demonstrated live in `examples/generated-app/` (set `BUG_MODE=…`); all are proven
against Iris's real verdict logic in CI.

## "Instrument once" — what a generated-app template adds

To unlock the _deepest_ checks (program-state, signals, source localization), the generated-app
**template** embeds Iris once — it then applies to every app the platform generates:

- `@syrin/iris-browser` (dev/preview-only, tree-shaken from production, localhost, no telemetry);
- expose the store + emit domain signals (e.g. `expense:saved`) — a few lines;
- `data-testid`s on the key controls (most templates already have them);
- an optional domain manifest (declares signals/stores/risk zones) + a couple of recorded flows with
  success oracles.

Honest coverage line: **without** instrumentation, Iris still catches network, console, double-submit,
and persistence-after-reload via the driven browser. **With** it, the program-state and source-mapped
catches (desync, dead-handler, blast-radius, "which file") light up — the bugs no out-of-page tool sees.

## Why the verdict can be trusted

It's **mechanical** — derived only from observed outcomes — so it cannot report green for something it
never observed (proven in `false-green.test.ts`). A disconnected backend or an unrun check reads as
**fail / no-evidence**, never a confident pass. That's the difference from an LLM-narrated "looks done."
