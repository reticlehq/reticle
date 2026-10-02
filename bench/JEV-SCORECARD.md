# Jev scorecard — what happens when the driver cannot generate a tool call

> The harness is the loop inside the daemon that drives a connected app: it picks what to touch next and states the consequence it expects, and the ENGINE decides the verdict from evidence. This measures replacing the model in that loop with a System One model, which answers typed questions and cannot emit prose. Runner: `bench/harness/jev-vs-llm.mjs`; de-risk: `bench/harness/jev-probe.mjs`; raw: `bench/raw/jev-vs-llm.json`. **Re-run before quoting** — a benchmark nobody re-derives is a claim.

## Headline

Same app, same MCP surface, same loop, same 24-step budget. The ONLY thing that differs between the arms is which `ModelDriver` the daemon builds. Three runs each, medians.

|                         | `anthropic` (claude-sonnet-5) | `jev` (jev-latest) |
| ----------------------- | ----------------------------: | -----------------: |
| Wall clock              |                        62.7 s |         **17.5 s** |
| Cost per drive          |                       $0.2530 |      **$0.001233** |
| Flows recorded          |                       1, 1, 1 |            1, 1, 1 |
| Actions driven          |                    11, 13, 10 |         10, 10, 10 |
| **Actions PROVED**      |                       3, 6, 5 |        **8, 9, 8** |
| **Real failures found** |                       0, 0, 0 |        **1, 0, 1** |

**3.6x faster, 205x cheaper, same number of flows, and it proves roughly twice as much per drive.**

## The caveat that has to come before the victory lap

**Most of the proved-rate gap is driver DESIGN, not model quality.** The Jev driver declares a consequence before every single action, because it was built to — it asks a second typed question ("if this works, what should the app be observed to do?") and puts the answer in `until`. The Anthropic driver is told to do the same thing in its system prompt and does it inconsistently. An Anthropic driver rebuilt with the same discipline would close most of this column.

So the honest claim is **not** "Jev finds more bugs than Claude". It is:

> The decision the harness actually needs is a SELECTION, and once you enumerate the candidates deterministically, a model that cannot do anything except select does the job — at about 1/200th the cost, and with a discipline that is easier to enforce when the model cannot improvise.

The `1, 0, 1` failures column is real and worth having — those are `verified: "no"` verdicts from the engine on a live app, not the driver's opinion — but read it as evidence that _declaring consequences works_, which is a thing this repo already believed.

## Why it can be this much cheaper

Jev prices the STATE, not the questions: seven questions cost **1.029x** the input tokens of one against an identical 17k-character state, and latency is flat. So every decision the driver makes is batched into one call, and adding a decision is nearly free.

**The first published version of this table priced the Anthropic arm at $0.3795 and claimed 308x.** That was wrong, in our favour, because the price table carried $3/$15 per MTok — Sonnet 4.6's rate — while the arm actually drives claude-sonnet-5 at $2/$10. The figures above are recomputed from the same recorded token counts at the correct price. It is written down rather than quietly fixed because a competitive benchmark that gets a number wrong in its own favour is worth less than no benchmark, and the only defence is checking the provider's own pricing page rather than recalling it.

Tokens are **not** comparable across the two arms and are deliberately never summed into a single number — Anthropic bills input + output with a cache tier, Jev bills input only and gives output away, so one "tokens" column would be three units stacked. Dollars are the comparable figure and are computed from each provider's published price, recorded in the raw output so a stale price is visible rather than silent.

## What Jev cannot do, and how the driver works around it

It **cannot emit a tool call**, so every candidate is built here, deterministically, from the snapshot's own interactive refs. That is the point rather than the limitation: **a driver that cannot name an element that is not on the page cannot hallucinate one**, and a test pins exactly that.

It **cannot produce a string it was not given**. Form-fill values come from a label→value lookup table. Fine for exploration — the engine judges what the app did with the value, not the value — and a hard ceiling for anything needing a valid coupon code or a JSON body.

It **cannot write prose**, which is why `explore`'s summary is now DERIVED from the calls made and the verdicts returned rather than narrated by the driver. That is better than a narration, not a substitute for one: a model summarising its own drive is the one witness with a motive to round `unknown` up to "worked".

## Three things this benchmark got wrong first, recorded because they all looked green

**A stale daemon answered three runs with one configuration.** `reticle mcp --port N` attaches to whatever daemon already holds N, and a daemon reads its driver and step budget from the environment once, at startup. Three consecutive runs reported `steps: 24` — including one whose budget was set to 8 — because all three were answered by the first run's daemon. Nothing errored; every row said MEASURED. The runner now clears the listener first, and the result carries the budget it was given and the driver the daemon says drove, so a mislabelled arm fails loudly.

**The first version of the Jev driver proved nothing at all.** It emitted `act_and_wait` with no `until`, so every verdict was `no-fault` — "nothing was declared to prove — this is not verification" — and the flow it recorded would pass even with the feature broken. Six actions, zero proved, reported as a fast cheap drive. It was caught the moment the derived summary existed, which is the argument for the derived summary.

**Then it declared consequences that could not fail.** A bare `{kind:'state', path:''}` and a bare `{kind:'route'}` are unconditionally true — there is always a current route — so two more runs came back `already_true`. Only `signal` and `net` are safe to declare bare, because they are event-based and floored at the act's own cursor. `engine/src/evidence/already-true.ts` already said so, in those words.

## The whole path, driven

Every performance number above comes from a daemon holding a direct `JEV_API_KEY`. The path a USER takes is different and longer, and it is checked separately by the platform repository's **harness-sync-check** script, which drives it with nothing mocked: a real API process, a real account through the ordinary signup and email-code login, a real `rk_live_` key from `POST /v1/keys`, the config endpoint answering `provider: jev, harnessEnabled: true`, each provider proxy reaching its upstream with the PLATFORM's key rather than the caller's, a revoked key going dead, and finally a daemon whose environment contains no model key of any kind driving a real app and reporting `driver: "jev"`.

**An earlier version of this section claimed that last step already passed. It did not.** The daemon in that run also had a direct `JEV_API_KEY` exported, so it took the direct branch and never went near the platform — the "only a platform key" run was not only a platform key. When the check finally blanked every provider key, the drive died on `jev 404: Route POST:/v1/systemone not found`: TypeSafe serves `/v1/systemone`, Reticle's platform serves the same wire shape at `/v1/model/systemone`, and the driver only ever knew the first. The sibling OpenAI driver had always routed on that distinction. This one did not, and nothing noticed, because both halves' own tests were green — the API's tests assert what the API returns, the daemon's assert what the daemon sends, and nothing asserted they were the same thing.

That is the entire reason the check exists, and it is why a claim about two systems meeting should never be written from a run where one of them was not actually involved.

## Standing limits

- **One app** (`apps/bench-app`), n=3 per arm. This is not a claim about applications in general.
- **Both arms end on `budget`**, so neither "finished"; this measures 24 steps of driving, not completion.
- **Evidence grade is `presence`**, the weakest tier that still counts. The engine says so on every passing action. Naming a real signal name or endpoint path — which needs one `reticle_observe` early in the drive to learn the app's vocabulary — would move it to consequence grade, and that is the next piece of work rather than a thing this scorecard is quietly assuming.
- **Bare `net` is pollutable in principle**: a page polling inside the action's window could answer for a button that did nothing. The window is the action's own rather than "ever", so the exposure is small, but it is real and it is the same fix as the line above.
- **A third arm exists and is unpriced.** `openai` is a real driver and the runner will drive it, but no published price is hard-coded for it, so its `usd` comes back `null` with a note rather than a guessed figure. Set `BENCH_OPENAI_PRICE="in,out,cacheRead"` to price that arm.
- The Jev driver keeps **one long recording** for the whole drive; the Anthropic driver segments into separately-named journeys, which are better flows. The flow COUNT ties; the flow quality does not, and nothing here measures that.

## Reproducing

```bash
node apps/api/server.mjs &
RETICLE_PORT=4460 pnpm --filter @reticlehq/bench-app exec vite --port 4312 --strictPort &

JEV_API_KEY=... node bench/harness/jev-probe.mjs                      # de-risk, no browser
ANTHROPIC_API_KEY=... JEV_API_KEY=... BENCH_REPEATS=3 \
  node bench/harness/jev-vs-llm.mjs                                   # the measurement

node bench/harness/jev-vs-llm.mjs --only openai                       # the third arm
```

A missing key makes that arm report `NOT MEASURED` and the run continues; no number here is ever fabricated from a missing key.
