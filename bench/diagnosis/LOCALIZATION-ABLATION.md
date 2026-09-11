# Does the `file:line` change what an agent actually does?

Every other number in this suite measures what Reticle _emits_. This one measures what an agent _does with it_ — the question the whole source-pointer effort is a bet on, and the one that was still unmeasured after that effort shipped.

## Method

Four regressions from `bench/harness/inject.mjs` were injected into `apps/bench-app`. For each, a fresh general-purpose agent was given a user-visible bug report and told to find and fix it, under two conditions differing in **one line of text**:

- **A — symptom only.** The bug report as a user would write it.
- **B — symptom + pointer.** The identical report, plus the source location — and specifically the location Reticle **actually emits**, which is where the acted ELEMENT is rendered, not where the bug is caused. Those are the same file for two of these bugs and different for the third, and getting that distinction wrong is the single easiest way to inflate this experiment (see below).

Both conditions had the same repo, the same tools, and the same instructions. Agents were forbidden from using `git` in any form (`diff`, `log`, `show`, `stash`, `checkout`), because the injected change is visible in the working tree and would have handed over the answer. Correctness is the deterministic oracle in `bench/fix-loop/verify.mjs` — the injected signature is gone — not the agent's own claim. Tool-call counts are the harness's own `tool_uses`, not the agents' self-reports.

## Result (3 bugs x 2 conditions x 2 runs = 12 agent runs)

Tool calls are the harness's own count, not the agents' self-reports.

| bug | A: symptom only | B: + `file:line` | change | element file = cause file? |
| --- | --: | --: | --: | --- |
| silent-dom-regression | 4, 3 (mean 3.5) | 2, 3 (mean 2.5) | −29% | yes |
| signal-contract-violation | 13, 11 (mean 12.0) | 6, 7 (mean 6.5) | −46% | **no** — element in a view, cause in the store |
| broken-form-validation | 6, 7 (mean 6.5) | 3, 3 (mean 3.0) | −54% | yes |
| **total per run** | 23, 21 (mean **22.0**) | 11, 13 (mean **12.0**) | **−45%** |  |
| **fixed correctly** | **6 / 6** | **6 / 6** | no change |  |

Run-to-run spread is small — condition A totalled 23 then 21, condition B 11 then 13 — so the gap is not an artifact of a single lucky run. Every agent in every cell landed on the correct file and line.

### The correction that produced these numbers

An earlier run of this table reported **−61%**, because condition B for `signal-contract-violation` was handed `store.ts:99` — the line that actually needed changing. **Reticle cannot produce that.** It reports where the acted control is rendered (`Deployments.tsx:74`); the cause is a store method one hop away. Giving the agent the fix site measured a tool we do not have.

Re-run with the pointer Reticle genuinely emits: **6 tool calls instead of 4**, and the agent still traced correctly from the control to the store. The honest total is **−52%**, not −61%.

**This is a real property of the artifact, not a benchmarking detail.** For a bug whose symptom and cause live in the same component, the pointer lands on the fix. For a signal, state or network bug, it lands on the control that should have produced the effect — a starting point, not the answer, and the agent still pays one hop. The measurement above includes that hop, which is why one of the three cells improves less than the others.

## What this does and does not say

**It replicates the published shape, on this codebase.** The localization literature reports that better fault localization leaves resolve rate roughly unchanged while cutting an agent's total work (SHERLOC: +5.95pp resolve, −23.1% tokens; agents spend 18.5 turns, 48% of interaction, localizing before their first patch). Here: fix rate identical, work down 61%. **The pointer does not make the agent smarter. It removes the search.**

**It is a small result and should be quoted as one.**

- **n = 3, and the fourth cell was never valid — I found out by re-running it.** This file has now given two wrong explanations for that exclusion, and the third is the real one, so the sequence is worth keeping as a caution about guessing at causes:
  1. First draft: "the bug report was ambiguous." A guess.
  2. Second draft: "operator error — I reverted while its agents ran." True, but not the cause.
  3. Actual cause, found by re-running it cleanly: **`network-timeout` is not a regression.** Its injection ADDS a fault-trigger button to `Diagnostics.tsx`; the oracle is satisfied when that line is REMOVED. My bug report told the agent the timeout trigger had stopped working — the exact opposite of what the injection does. **No agent could have passed that cell.**

  The clean re-run makes it unmistakable: condition A spent 44 tool calls and condition B 23, and _both_ edited `reticle-dev.ts` — a different file from the one condition B was explicitly told to open. Agents given a wrong problem statement do not find the right answer faster; they find a different wrong answer faster. The cell is dropped for being invalid, not for being unlucky, and the −68% direction reported in an earlier draft is **withdrawn**: it was measuring nothing.

  This is also the one place in the suite where a bug report was authored by hand rather than derived from the injection, which is exactly where this class of error gets in. A bug report should be generated from what `apply()` does, not written from memory of what it was supposed to do.

- **Two runs per cell, not more.** Enough to show the spread is small (±2 on a total of ~22), not enough for a confidence interval. Per-bug numbers move by 1–2 calls between runs.
- **The fixture was assumed to flatter condition A. I tried to prove that and could not.**

  The reasoning was: `apps/bench-app` is 34 files, so a symptom greps to the right file in 4 calls; on a real codebase the baseline would be far higher and the gap would widen. Two attempts to build that harder case, both in `packages/server/src` — **337 files, 42k lines, ten times the fixture**:

  | attempt | condition A tool calls |
  | --- | --: |
  | subtle behavioural bug, symptom shares the code's vocabulary | 5 |
  | same bug, symptom deliberately vocabulary-disjoint (user's words, no "event"/"limit"/"oldest") | 9 |

  A ten-fold larger search space did not make localization harder, and neither did stripping the shared vocabulary. Agents localized in 4–13 calls across every cell in this repo regardless.

  **So the honest conclusion is not "this understates the effect" — it is that this repo cannot produce the hard case.** It is well-named and well-partitioned; `output-budget.ts` is findable from a description of a budgeting bug however the description is phrased. The settings where the literature measures very large localization effects are unfamiliar OSS repositories with weaker naming, and that is a property of the codebase, not something a bigger fixture here can simulate.

  What this measurement therefore supports: **−52% on a well-structured codebase the agent can navigate.** Whether the effect is larger on a badly-organised one is unmeasured, and cannot be measured here. Anyone quoting the number should quote that scope with it.

- **Fix rate did not move**, and no one should claim it did. At this scale every agent found every bug eventually; the pointer bought the path, not the outcome.

## Third condition: does adding the CAUSE help, or is it padding?

The remaining piece of the product vision is "why it's not working", and I had been deferring it on the strength of FeedbackEval — where rich natural-language feedback finished LAST, 10.5pp behind structured test output and 6.4pp behind a bare "the code is wrong, fix it". That is a real result, but it is a result about NARRATIVE feedback, and the same paper has structured feedback winning. Deferring on it was reading the finding backwards.

So the ablation got a third arm, using the structured shape Reticle already produces — `observed` / `expected` / `assertion`, no prose:

| condition              |    tool calls |     vs A | vs B |
| ---------------------- | ------------: | -------: | ---: |
| A — symptom only       | 22.0 (23, 21) |        — |      |
| B — + `file:line`      | 12.0 (11, 13) | **−45%** |    — |
| C — + structured cause |      10 (n=1) | **−55%** | −17% |

**What this supports: adding the cause does not hurt.** That is the claim worth having, because the fear was that it would — and it is the fear that was keeping the surface unbuilt.

**What it does not support: that −17% is real.** n=1, and condition B's own spread was 11–13, so a 10 sits barely outside it. Anyone quoting a further improvement from causal detail is over-reading this.

**Design consequence, which is the actionable part:** if the "why" surface gets built, it must be `observed` / `expected` / `assertion` — the shape measured here and the shape that wins in the literature — and explicitly NOT a prose explanation, which is the shape that loses. Reticle already emits exactly this on `act_and_wait`; the gap is that plain `reticle_assert` does not.

## Fourth condition: does telling the agent HOW to fix it help?

The vision's last part is "how to make it work", and I had been refusing to build it by citing the literature — which is the one move that failed repeatedly this session. So it got measured too. Same three bugs, condition C plus a `nextStep` keyed to the ASSERTION KIND (not to the specific bug, since that is all Reticle could ever produce): "a rendered count below the state count means the render expression is filtering or slicing the collection", and so on.

| condition                |    tool calls |     vs A |
| ------------------------ | ------------: | -------: |
| A — symptom only         | 22.0 (23, 21) |        — |
| B — + `file:line`        | 12.0 (11, 13) | **−45%** |
| C — + structured cause   |      10 (n=1) |     −55% |
| D — + next-step fix hint |      11 (n=1) |     −50% |

**D is not better than C.** Adding prescriptive guidance on top of the structured cause bought nothing measurable — it did not hurt either, but 11 versus 10 is noise, and both sit inside condition B's own 11–13 spread.

**The honest reading of the whole table: the pointer is the effect.** B vs A is a resolved, repeated result (two runs each, −45%, spread ±2). Everything after the pointer — the cause, the fix hint — is at or below what this experiment can resolve. Anyone quoting C or D as separate wins is over-reading n=1.

**So the fourth part of the vision is answered by measurement rather than deferred: do not build a suggested-fix surface.** It is the most speculative thing to build, it is the shape the literature says loses, and here it earns nothing. The structured cause is worth having for a different reason — the assertion KIND lets an agent branch on the failure class, which is a capability rather than a token saving — but the fix hint is neither.

## Why this was worth running rather than asserting

The three prior measurements established that the pointer is _present_ (83/85), that its presence is _caused by the stamp_ (control: 0/22), and that it is _unrecoverable by any other Reticle route_ (0/5). All three describe the artifact. None of them showed that an agent behaves differently when it has one — which is the only reason any of it matters.
