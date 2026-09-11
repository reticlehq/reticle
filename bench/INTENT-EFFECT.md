# Intent + context — does declaring what you meant change what you call done?

Reticle's central claim is that it stops an agent calling something done when nothing proved it. `reticle_intent` (declare what a change is supposed to make true) and `reticle_context` (what this run has already established) shipped with their **cost measured and their benefit unmeasured**. This pass measures the benefit — or says, loudly, that it could not.

Everything below is produced by `bench/harness/intent-effect.mjs`. Nothing here is hand-entered.

## The two arms

Same task, same model, same fixture (`apps/bench-app`), same injected defect. One difference:

| Arm | Intent | Context |
| --- | --- | --- |
| **OFF** | none declared | `reticle_context` not offered and not mentioned |
| **ON** | one intent declared **before the loop starts**, so the arm's premise is a fact rather than something the model might have remembered to do | `reticle_context` offered as a tool and named in the system prompt |

Arm order is shuffled per run from a seeded generator (`--seed`), because the fixture is a live app and an arm that always ran second would always run against a warmer one.

## The four metrics

All four are pure functions in `harness/intent-effect-metrics.mjs`, and every one of them is unit-tested. They are mechanical by construction — none of them asks anybody's judgement.

1. **False-green rate** — the headline. Of the claims the agent made that ground truth can grade, the fraction that assert the app is fine while the injected defect is live. A claim is graded when it settles the whole task (`VERDICT: PASS` / `VERDICT: FAIL`) or when it settles the _subject_ the defect lives in. Claims about parts of the app the defect never touched are ignored, because "the Overview renders fine" is a true statement and counting it would pad both arms with noise.
2. **Re-query rate** — read-only calls that re-fetch something the run already established, over all read-only calls. "Already established" is exact: the **same tool** against the **same canonical target** (arguments with keys sorted and `sessionId` dropped) **returned successfully** at an earlier step. A call that errored established nothing, so asking again is the first real look.
3. **Steps-to-correct** — how many tool calls happened before the agent first said the true thing about the injected defect. Lower is faster.
4. **Propagation depth** — after the agent's first **ungrounded** claim, how many steps build on it before it self-corrects or the run ends. A claim is ungrounded when no read-only call happened between the most recent acting call and the claim: the agent settled something that nothing it did proved. A self-correction only counts if the reversal is itself grounded — an unproven retraction is a second ungrounded claim, not a fix.

## How ground truth is established

`bench/harness/inject.mjs` applies `route-transition-break`: a **source-level edit** to the fixture's store so that navigating to Compose silently does nothing. The view never changes, no error is thrown, nothing is logged. So the app either is or is not broken as a matter of what is in the source file, and **nothing in a transcript can move that**.

### How the grader avoids being a tautology

`network-timeout` graded on a regex the request URL itself satisfied, against an endpoint that did not exist — a free true positive for every tool, twice shipped, both times flattering us. Three properties keep that from recurring:

1. **Ground truth is source-level, never textual.** It comes from `inject.mjs` having applied an edit, not from any string the app or the agent emits.
2. **A catch requires ground truth to say the defect is LIVE.** `stepsToCorrect` scores a catch only when `injected` is true. The _identical transcript_ on a clean app scores `caught: false` and is counted as a **false alarm** instead. That is the negative control, and it is a test: `scores the SAME transcript as a false alarm when the defect was not injected`.
3. **A tautological regex would be visible in the output.** The pass runs live control runs on a clean app in both arms. If the symptom regex matched regardless of the defect, those runs would score false alarms — which is printed beside every catch number and **fails the gate**. A grader that cannot be wrong on the control is a grader nobody should believe.

## Running it

The pass does **not** boot fixtures (same as `claude-agent-loop.mjs`). Start them first:

```bash
node apps/api/server.mjs &
RETICLE_PORT=4460 pnpm --filter @reticlehq/bench-app exec vite --port 4312 --strictPort &

ANTHROPIC_API_KEY=sk-... pnpm bench:intent-effect --runs 3 --seed 1
```

`--runs N` runs N injected runs per arm (plus one clean control run per arm). Per-run values and the spread are reported and written to `bench/raw/intent-effect.json`.

Record a row into `bench/history.jsonl` with `node bench/harness/record.mjs "<label>" "<note>"`. The row is stamped with `harness_revision`, so `baseline-provenance.mjs` refuses to compare it against a run measured by a different instrument. A pass that did **not** measure records **no row at all** — a baseline of absent arms would hand every later run a comparison against nothing that reads exactly like a comparison against something.

### With no API key

`pnpm bench:intent-effect` still runs. It checks the one thing it can — that ground truth still injects into the fixture — writes the artifact recording exactly which arms are absent, prints what it could not measure and why, and **exits non-zero**. A pass that measured nothing must never look like a green.

## The gate

`intentEffectVerdict({ off, on, runs })` (own module, unit-tested, wired into `gate.mjs` beside `coverageVerdict` and `parityVerdict`) has four outcomes:

| Outcome | Gate | Meaning |
| --- | --- | --- |
| `regressed` | **FAIL** | The false-green rate is HIGHER with intent+context on, by more than the observed run-to-run noise. The feature makes verification worse. This is the one result that must never pass quietly. |
| `not-measured` | **FAIL** | An arm did not run, or ran and produced no gradeable claim. Worded as its own thing so nobody reads "we did not measure this" as "this regressed". |
| `inconclusive` | pass | Both arms ran and the difference is inside the noise. Nothing has been shown. |
| `improved` | pass | The rate fell by more than the noise. |

The noise floor is the **observed spread across runs within an arm**, not a constant typed into the file — a constant would be a claim about how variable a real LLM loop is, made by somebody who has not run one. With fewer than two runs per arm the spread is unobservable, so the pass reports `inconclusive` and says to re-run with more.

The gate additionally fails outright if any **control** run scored a catch, which would mean the symptom regex is satisfied whether or not the defect is live.

---

## What these numbers do NOT prove

Read this before quoting anything above. Every number this project has published without its caveat has come back to bite.

- **They do not prove intent+context makes agents better at verification in general.** They measure one model, on one task, against one defect, in one fixture. `apps/bench-app` is a small, well-instrumented app the harness authors control; false greens on a real production app cluster differently, and the ones we found on a real merchant app were not reproducible in any fixture here.
- **`inconclusive` is not a quiet win.** It means the difference was inside the run-to-run noise. It is not "slightly better", it is _nothing shown_. Reporting it as an effect is how a benchmark stops being worth reading.
- **A single run per arm proves nothing at all**, and the gate refuses to conclude on one. Two runs give you a spread of two points, which is barely a spread. Do not present a `--runs 1` or `--runs 2` result as a finding.
- **The metrics are proxies, not the thing.** "The agent said the true words about the defect" is not the same as "the agent understood the defect", and the symptom regex can be satisfied by a lucky guess. The control runs bound how often that happens; they do not eliminate it.
- **Steps-to-correct is only defined for runs that caught the defect.** A run that never caught it contributes nothing to the mean, so an arm that catches rarely but fast can post a _better_ steps-to-correct than an arm that catches almost always. Always read it beside `caught_runs`.
- **Propagation depth is bounded by the turn limit**, not by the agent's behaviour. A run that hits `MAX_TURNS` has its depth truncated, so the metric systematically understates long propagations.
- **The re-query rate does not say re-querying is bad.** Re-reading something after an action that might have changed it is correct behaviour. The metric counts repetition; whether a given repetition was waste is not something it decides, and a lower number is not automatically better.
- **The arms differ in more than one thing.** The ON arm gets a declared intent _and_ two extra tools _and_ two extra sentences of system prompt. Any effect measured is the effect of that bundle. This pass cannot attribute it to intent alone or to context alone.
- **These are not cost numbers.** Token usage is recorded so the artifact can be shown to have measured something; the +0.7% cost figure for these features came from a different pass and is not re-derived here.
