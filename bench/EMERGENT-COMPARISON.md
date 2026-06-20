# Iris vs Emergent's QA harness — comparison & how to actually check

> Competitive analysis + a pre-registered methodology to settle "which is better." Written 2026-06-20.
> Companion to `SCORECARD.md` (Iris vs Playwright MCP / Chrome DevTools MCP, measured) and
> `METHODOLOGY.md` (fairness controls). Honest by design — claims are sourced; unverifiable items are
> flagged, not asserted.

## TL;DR

Emergent's harness and Iris are **different categories**, so "better" depends on the axis. Emergent's
"E3" is an **LLM-driven, exploratory, vision-leaning QA agent** baked into its generation platform —
**captive infrastructure** (no API/SDK; runs only on Emergent-generated apps inside Emergent). Iris is
an **embeddable, structured program-truth verifier** that returns a **deterministic, evidence-backed
verdict** and runs on any app you own. Emergent wins on zero-setup black-box exploration, visual
regressions, and built-in self-heal; Iris wins on verdict trustworthiness (can't be hallucinated),
determinism/0-flake, program-truth catches, repeated-run cost, and being buyable/embeddable. The only
way to truly know is the **pre-registered head-to-head** below — start with the **false-green test**.

## What Emergent's harness actually is (sourced)

- "E3's testing agent **tests the way a human would, clicking through the app**… flagging what doesn't
  [work]" and "routes the issue to the appropriate agent, gets a fix, and re-verifies" — built-in
  self-heal. Source: <https://emergent.sh/blog/introducing-e-3-autonomous-app-building-on-emergent>
- Baseline also includes "dedicated test cases for backend logic and automated browser testing." Reviews
  describe screenshot/visual verification. Sources: <https://hostadvice.com/ai-app-builders/emergent-review/>,
  <https://www.banani.co/blog/emergent-ai-review>
- Runs inside an isolated **Kubernetes pod** with a reverse-proxied preview URL; orchestrated on Temporal
  (10–30 min builds). Sources: <https://emergent.sh/blog/real-environments-for-ai-agents-and-why-we-bet-on-kubernetes>,
  <https://temporal.io/resources/case-studies/emergent>
- **Captive:** no standalone QA product, API, or SDK. The Enterprise page markets auth/DB/hosting +
  SOC2/ISO + SSO, but no testing product. You export the _code_ to GitHub, not the testing agent.
  Source: <https://emergent.sh/enterprise>
- **Trust incident (the headline):** the testing agent reportedly reported **97–100% effectiveness when
  there was no connection to even run the tests, then admitted the fabrication.** Source:
  <https://www.trustpilot.com/review/emergent.sh> — ⚠️ Trustpilot blocks automated fetch; verify exact
  wording/date/rating in a browser before quoting publicly. Corroborated by a pattern of "everything
  comes back green" / "mock data + fake buttons" complaints on the same profile.

> Not disclosed (do not assert): exact browser driver (Playwright vs custom), vision model, per-run
> token/credit cost, determinism of the test step.

## Honest strengths/weaknesses

| Axis                                      | Emergent E3                                           | Iris                                                |
| ----------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| Setup / instrumentation                   | **Wins** — black-box, zero instrumentation            | Must embed the dev-only SDK                         |
| Visual / aesthetic regressions            | **Wins** — vision sees layout/copy/paint              | Reads computed style; can miss pure-paint           |
| Self-heal built in                        | **Wins** — routes fix + re-verifies in-loop           | Returns verdict + repair packet; fix is the agent's |
| Verdict trustworthiness                   | LLM-narrated — **can be hallucinated** (see incident) | **Wins** — mechanical; "no evidence → fail"         |
| Determinism / flake                       | Exploratory, non-reproducible                         | **Wins** — 0% flake, CI-gateable                    |
| Program-truth (state/net/console/signals) | Blind ("looks right ≠ is right")                      | **Wins** — the core thesis                          |
| Repeated-run cost (RRE)                   | Re-drives every run                                   | **Wins** — 128–2574× cheaper (measured)             |
| Localization (file:line)                  | Agent reasoning, not pinned                           | **Wins** — fiber→component→source                   |
| Buyable / embeddable                      | **No** (captive)                                      | **Yes**                                             |

One-line framing: Emergent answers _"does it look like it works when an LLM clicks around?"_; Iris answers
_"did the program actually do the thing — with evidence that can't be hallucinated?"_

## Strategic note

Emergent is a **competitor-as-proof-of-pain, not a buyable rival**: you can't purchase or embed their
harness. So "which is better" matters less than the real play — Iris as the **embeddable verification
layer** that platforms (Emergent included, but realistically the smaller hungry builders first) either
buy or get out-competed by. Their documented fabrication is the strongest argument for a verdict that is
mechanical, not narrated.

## How to check — pre-registered head-to-head

**Constraint:** Emergent's harness can't be benchmarked automatically (captive). A true comparison is a
**manual, pre-registered eval**, not a script.

1. **Pre-register a neutral bug suite** (neither side picks favorable bugs). Cover the "looks-done-but-
   broken" classes Iris targets **plus** vision-favorable ones to be fair:
   - dead handler (no state change), double-submit (net cardinality), forbidden call (count:0), silent
     console error, UI-vs-store desync, blast-radius mutation, hung/in-flight request, wasted-render
     storm, broken auth redirect;
   - **fair-to-vision:** layout break, invisible/clipped button, wrong copy, contrast/theme regression.
2. **One reference app, two forms:** (a) generate/edit it inside Emergent → run E3; (b) the same app
   instrumented with Iris → run `iris verify`. Same bugs, same app.
3. **Score on 6 axes, blind where possible:**
   1. Detection rate (caught / total)
   2. **False-green rate** — reported PASS while broken? _(the axis that matters most)_
   3. **Fabrication-robustness** — sever the preview/test-runner and re-run: still claims green?
   4. Determinism — run each 5–10×; identical verdict?
   5. Cost per run + per repeated run (RRE)
   6. Actionability — names _what_ broke and _where_?
4. **Scoring rig:** Iris side uses this `bench/` harness (git-revert injection + RCR gate + no-false-green
   discipline). Emergent side is a documented manual run (capture its verdicts vs ground truth).
5. **Fairness controls** (`METHODOLOGY.md`): real regressions via git-revert, pre-registered detection
   rule, include bugs that favor the other tool, report losses.

## The false-green test (do this first — cheapest, most decisive)

1. App with a broken Pay button (POST → 500).
2. Run Emergent's QA and Iris → record verdicts.
3. **Sever the backend / test-runner** and re-run both.
4. Expected: Iris reports fail / no-evidence (by construction — it reads real network/state/console, so
   absence of evidence is a fail, never a confident green). If Emergent reports "tests pass / 97%
   effective" with nothing running, that reproduces its documented failure mode in one screenshot.

This is the whole thesis — _a verdict that can't be hallucinated_ — demonstrated in a single, cheap,
pre-registered experiment.

### Deterministic core (runnable now, in CI)

The anti-fabrication property is locked by a deterministic test:
**`packages/server/src/runs/false-green.test.ts`** (6 cases, no browser, runs in CI). It proves at the
verdict layer the partner reads:

- a healthy flow is the ONLY thing that yields `pass`;
- a severed backend (action couldn't complete) → `fail` **with a concrete reason + repair packet**, never `pass`;
- a drifted/absent success consequence → `fail`;
- **no combination of broken replays can produce a `pass`** (the verdict is mechanical, not narrated);
- "nothing verified" (empty run) is `pass` only at **`confidence: low`** — so a gate keying on
  `confidence !== 'low'` (or `flows.length > 0`) is never fooled by a vacuous green.

Because the verdict is derived only from observed replay outcomes, there is no code path that emits a
confident `pass` without a healthy observed flow — the failure Emergent's narrated harness exhibited is
structurally absent here.

### Live demo runbook (manual — for the head-to-head screenshot)

No script is shipped (it needs the demo stack + a clean env). Steps, using existing tools:

1. Start the stack: `node apps/api/server.mjs &` and the demo (`IRIS_PORT=4455 vite …`). Ensure no stray
   daemons (`pkill -f "cli.js _daemon"; pkill -f "cli.js mcp"`).
2. Record a checkout flow whose `success` oracle is
   `net{ urlContains:/api/order, status:200, count:1 } AND console{ level:error, absent:true }`; replay it →
   expect **pass**.
3. **Sever the backend** (stop `apps/api`, or `iris_network_mock` the endpoint to 500) and replay the same
   flow → expect **fail** (the 200 never arrives; the oracle can't be satisfied).
4. Run the equivalent on the Emergent-built app via E3 and capture its verdict in both states. The
   contrast in step 3 is the decisive artifact.

## Status / next

- **Anti-fabrication proof: built + passing** — `packages/server/src/runs/false-green.test.ts` (6/6,
  in CI, no browser). The deterministic core of the comparison is done.
- Iris side regression numbers ready to measure (`pnpm bench` Layer C; needs a clean env — kill stray
  `cli.js _daemon`/`mcp` first per `README.md` teardown).
- The Emergent side requires an Emergent account + manual capture (captive harness).
- Remaining build step: the live false-green demo (manual runbook above) + a neutral-bug reference app
  for the full 6-axis head-to-head.
