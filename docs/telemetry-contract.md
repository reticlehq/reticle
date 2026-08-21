---
title: Telemetry contract
description: 'Read this before adding a tool, an event, a finding kind, or a failure path. Telemetry fails silently.'
icon: file-contract
---

> For anyone (human or agent) adding a tool, an event, a finding kind, or a failure path to Reticle.
>
> The rules here are enforced by `packages/server/src/telemetry/telemetry-contract.test.ts`. If you break one, that test tells you which and where. This page is why.

## Why this has its own contract

**Telemetry fails silently.** Nothing throws when an event is missed. No test goes red. No user complains. The data is simply, permanently absent, and you find out months later when someone asks a question the data cannot answer, about a period you can never re-collect.

That has already happened here twice, and both times the code looked correct:

- `daemon_stopped` was emitted fire-and-forget microseconds before `process.exit(0)`. The POST was killed every single time. The event **never once arrived**, and nothing anywhere indicated a problem.
- `bug_found` hand-copied the twelve contradiction kinds into a local `Set`. Correct on the day it was written; the thirteenth kind would have been silently miscounted, quietly deflating the one number we intend to publish.

So the rule is not "remember to add telemetry". The rule is that the guard lives in a test.

## The five rules

### 1. Everything routes through a chokepoint

Tool usage, timing, errors, verifications and bugs are all recorded in **one place**: `runTool` in `tools/invoke-tool.ts`. Adding a tool to `TOOLS` is all it takes to be instrumented.

Do **not** add telemetry inside a tool handler. If you find yourself wanting to, the metric probably belongs at the chokepoint, read off the result.

> The one exception is a path that genuinely does not go through `runTool`. Today that is only the verification runner (`reticle verify`, the HTTP verify surface), which has its own reporter in `telemetry/run-telemetry.ts`. **If you add a second dispatch path, it needs the same treatment**, and until it has one it is invisible. That gap existed for real: CI-found bugs were uncounted.

### 2. Names say what happened

`<noun>_<verbed>`, lowercase, no abbreviations: `verification_completed`, `bug_found`, `runtime_crashed`.

## Counting defects: instances vs distinct

`bug_found` fires once per OCCURRENCE. A defect hit five times in a session is five events, which is the right raw signal; frequency is what says which classes of defect actually cost anybody anything. But it means a naive count answers "how often were defects hit", not "how many defects were found", while looking like it answers the second.

So every `bug_found` carries **`repeat`**: false the first time a KIND is seen in a session, true after. Count `repeat: false` for **distinct defects**; count everything for **instances**. Measured on a real app, the instance count was more than double the defect count. Publishing instances as defects inflates the claim accordingly.

The denominator is **`verification_completed`**, which fires per verdict with `via`, `verified`, `passed` and `falseGreenCaught`. Defects per verification is the honest rate; raw defect counts grow with usage and say nothing on their own.

**And `repeat` only means anything if the session remembers.** `SessionMetrics.reset()` runs at every periodic flush and used to clear the seen-kinds set with the window counters, so the same defect, re-found after a flush, reported `repeat: false` again. Sessions in the data run to 11.5 hours. Window counters zero on a flush; session-lifetime memory does not. (`session-window.test.ts`)

Two rules follow, and both are gated:

- **`repeat` is set at the EMISSION site, never by the classifier.** `bugsInResult` is a pure function over one tool result and cannot know what a session has already seen; if it ever grows a `repeat` field it will be guessing, and the guess becomes the published number. (`telemetry-contract.test.ts`)
- **Session-scoped, and it cannot be otherwise.** The payload carries no selector, URL or app detail by design, so the same defect in two sessions is unrecognisable as one, and making it recognisable would require collecting exactly what this event refuses to collect.

The old set failed this so badly it confused its own authors: `invoke` meant "the CLI ran" while `tool` meant "a tool was called", which is the opposite of how both read. A name that has to be looked up is a name that gets misread on a dashboard a year from now.

### 3. Names, never values

| Send                                 | Never send              |
| ------------------------------------ | ----------------------- |
| Parameter and flag **names**         | What they were set to   |
| Error **shape** (variables stripped) | The message             |
| **Our** stack frames                 | The user's stack frames |
| The **kind** of a defect             | What it was found in    |
| A hash of the git origin             | The origin              |

`--http-token` holds a secret. `reticle_act`'s `args` holds the text being typed into the app, which on a login form is a password. Assume every value is the worst thing it could be.

There is one narrow exception, and it is explicit rather than heuristic: parameters whose values are enums **we** defined are allow-listed in `telemetry/argument-shape.ts`, and anything unrecognised reports as `other` so a schema change cannot start forwarding free text.

### 4. Never derive a vocabulary by copying it

If a set of kinds already exists in `@reticlehq/core`, **import it**. Do not re-list it.

```ts
// ✗ correct today, wrong the moment core gains a member, and silent about it
const KINDS = new Set(['ui-advanced-request-failed', 'signal-contradicted' /* …10 more */]);

// ✓ cannot drift
const KINDS = new Set(Object.values(ContradictionKind));
```

A copied enum is a drift hazard anywhere. It is a **correctness** hazard when the thing that drifts is a number you publish.

### 5. A metric may never change behaviour

Every send is wrapped and best-effort. A telemetry failure must not fail a tool call, a verification, a daemon start, or `reticle init`.

The single exception is `daemon_stopped`, which is **awaited**, because the process exits immediately after and the send would otherwise be killed. Even then a failure resolves rather than throws.

## The event kinds, all of them

`TelemetryEventKind` in `@reticlehq/core` is the closed list. Seven of these went undocumented here for months (the doc described only the session-lifecycle half), so anyone building a dashboard from this page could not know that the transport and install events existed at all. A kind nobody documents is a kind nobody queries, and telemetry that nobody queries is telemetry nobody notices has stopped arriving. `telemetry-contract.test.ts` now fails when a kind is missing from this table.

| Kind | When | What it answers |
| --- | --- | --- |
| `reticle_installed` | first-ever run on a machine | install count, and the new-user curve |
| `cli_command_run` | a human ran a `reticle` subcommand | human intent: `verify`/`gate` mean something very different from `status`. Never emitted for the internal `_daemon` spawn |
| `daemon_started` | the daemon came up | active sessions, DAU/WAU/MAU |
| `daemon_stopped` | clean exit | the rich session roll-up. **Count sessions with this one**; see below |
| `session_progress` | periodic flush from a LIVE daemon | same payload, `final: false`. Sum work across both |
| `verification_completed` | a verdict was produced | the product's reason to exist: was an app actually verified |
| `project_profiled` | once per daemon start | stack, size, and how deeply the feature surface is used (activation vs retention) |
| `version_changed` | the running version differs from last seen | upgrade adoption, and whether a nudge caused it |
| `runtime_crashed` | an unhandled failure in the daemon | stability |
| `feedback_submitted` | `reticle feedback`, or an agent's report | the qualitative channel |
| `identified` | `reticle identify` | joins anonymous machine ids to a person who volunteered one |
| `mcp_client_connected` | an MCP client attached | how many sessions are agent-driven at all |
| `app_instrumented` | the first app carrying the SDK reached this daemon | **the funnel step everything turns on**; see below |
| `instrumentation_stalled` | the daemon waited and no app ever arrived | the same funnel step, seen from the failure side; see below |
| `mcp_connection_lost` | the proxy lost its daemon | **the transport-stability metric.** The disconnect that makes a user reopen `/mcp` is invisible without it |
| `init_completed` | `reticle init` finished | does install actually work, outside the fixtures gate |
| `bug_found` | a defect was detected in the app under test | the value delivered, as opposed to the work done |
| `tool_refused` | a tool could not do what was asked | WHY the largest cohort in the funnel goes quiet. See below |

## The install has two halves: `app_instrumented`

Reticle is only usable when both halves are done: the MCP server is registered so the agent has the tools, and the SDK is loaded by a running page so there is something for those tools to look at. They are done by different commands, at different times, often in different directories. Almost everyone completes the first. The second is where the users go.

Nothing measured the second. `daemon_started` and `mcp_client_connected` describe the agent half. `session_appConnects` describes the app half but is a **window counter**: it resets on every flush, so a user whose app connected in one window reads zero in every other. The population it under-counts is precisely the population being measured, and a funnel built on it reported fewer instrumented users than there were users calling tools, which is impossible on its face.

`app_instrumented` fires **once per daemon run**, on the first session-ready only, so `daemon_started` → `app_instrumented` is a rate rather than an inference and a reloading page cannot inflate it. It carries `initialized` (had `init` run here), `agentAttached` (was an agent already waiting), and `msToFirstApp` (how long the daemon sat with nothing wired). It deliberately carries no stack and no framework: `project_profiled` already reports both for the same run, and the two join on `sessionId`.

### The counterpart: `instrumentation_stalled`

`app_instrumented` fires on success and only on success, so the larger population, runs where no app ever arrives, exists in the data as an **absence**. An absence is the one thing telemetry cannot interpret: it cannot separate "nothing was ever wired" from "the process was killed before it could say so" from "we never sent the event". Since the funnel breaks at this step and nowhere else, this is the one silence worth converting into a signal.

`instrumentation_stalled` fires **once per daemon run**, only after the daemon has been up past a generous threshold, and **never once an app has connected**. A run that starts slowly and then works reports nothing at all. It carries the same three facts as its success counterpart so the two are directly comparable, with `msWaited` in place of `msToFirstApp`.

Read it against `agentAttached`, which is what makes it actionable rather than merely sad. A stalled daemon with no agent attached is somebody who installed and walked away, and is not a defect. A stalled daemon **with** an agent attached is the failure the product actually has: the tools are loaded, something is asking for them, and there is nothing on the other end to drive.

It deliberately carries no diagnosis. Whether a dev server is listening is a live probe, and running one on a timer to enrich a metric would be collecting for the metric's sake. The diagnosis belongs where a human or an agent asks for it.

What neither event can see is **why** an app never connected. Every cause for that is page-side (the non-localhost gate, a port mismatch, a stale build, a dev server never restarted), where the daemon has no visibility. That needs the SDK to report its own refusals, and it is the next thing to build.

## Sessions: `daemon_stopped` vs `session_progress`

Count sessions with **`daemon_stopped`** (`final: true`). It fires once, at a clean exit.

A running daemon rolls its window up every 5 minutes as **`session_progress`** (`final: false`), same payload shape. Sum work across both; count sessions with neither summed nor doubled.

This split exists because the flush used to be emitted AS `daemon_stopped`, an event named for an exit, fired while the process was alive. Anything counting sessions over the raw event therefore over-stated, and the two populations it merged are opposites: a flush comes from a daemon that has served tool calls, while a clean exit comes from one that has not, because a daemon that has served a tool never idle-exits and so never reaches a clean shutdown. A funnel over the raw event describes active sessions at one end and abandoned ones at the other.

The flush interval is also the **bound on what is lost**: nothing calls shutdown when a working daemon is finally killed, so its last partial window dies with it. The old 30-minute interval was long enough to lose most of a typical session that way. Only non-empty windows emit, so a short interval costs nothing on the daemons that never serve a tool.

## The session summary's newer fields

Four counters and one flag were added because the data could not answer questions we were already asking. All are properties on events that already exist (no new kinds), and all four counters are **omitted rather than sent as zero**, so a field's presence is itself the signal.

| Field | On | Means |
| --- | --- | --- |
| `noSessionErrors` | session summary | tool calls that failed because there was no app to reach: no session, no session by that id, or several with none named. The largest drop-off in the funnel; it was previously reachable only by unpacking `errors[]`. |
| `consecutiveRepeats` | session summary | longest back-to-back run per tool name. `toolCounts` reports five useful calls and five retries of one failing call identically, and those are opposite facts. |
| `abandonedActions` | session summary | actions driven with no verdict AFTER them (the trailing unsettled run, not `actions - verifications`). That difference ignores order, so a verdict that drove nothing (a `flow_verify` over saved flows) silently paid for an abandoned action elsewhere. |
| `endedWithVerdict` | session summary (final only) | did this session ever produce a verdict. The headline metric, and previously the only thing in the payload that had to be COMPUTED, from lifetime counters sitting next to windowed ones, which is a subtraction that gets read wrong. Sent as `false` rather than omitted: a session that drove an app and never asked whether it worked is the finding. |
| `verification.browser` | `verification_completed` | `headless` \| `headed` \| `attached`: who DROVE the browser. `attached` (Reticle launched nothing, the SDK connected from a browser somebody else opened) is the common case in production, so on its own this is mostly "somebody's own browser". |
| `verification.brand` | `verification_completed` | WHICH browser it was: `chrome` \| `edge` \| `arc` \| `dia` \| `brave` \| `opera` \| `firefox` \| `safari` \| `other`, the closed `BrowserBrand` list in core. The axis `engine` cannot answer, since Chrome, Edge, Arc, Dia and Brave are all `blink`. The SDK reads `navigator.userAgentData.brands` (and the UA string on Firefox/Safari, which expose no `userAgentData`) and normalises IN THE PAGE: a raw brand or UA string is unbounded and fingerprintable and never leaves. Anything unrecognised is `other`. **Omitted rather than `"unknown"`** when the page did not say. A desktop webview has no brand and an older SDK does not report one, and a guess is indistinguishable from a measurement on a dashboard. |
| `verification.reason` | `verification_completed` | WHICH clause of `decideVerified` produced the verdict, from core's closed `VerifiedReason`: `inconclusive` \| `observation_lost` \| `assertion_failed` \| `contradicted` \| `already_true` \| `unclean_capture` \| `vacuous_grade` \| `outcome_pending` \| `outcome_unread` \| `unsettled` (the page never went idle and no consequence was declared) \| `evidence_incomplete` (the assertion held, but a channel's outcome had not arrived when the window closed) \| `proved`. See below. |
| `verification.uncleanLoss` | `verification_completed` | WHAT was lost when `reason` is `unclean_capture`, from core's closed `CaptureLoss`: `buffer_loss` (our server ring buffer evicted evidence from the window) \| `transport_gap` (our browser queue overflowed) \| `blind_spot` (a boundary in the page, such as a cross-origin frame or a closed shadow root) \| `other`. Three owners, three fixes, and one bar on a dashboard until this existed. ONE value, not a list: a multi-value property is not something a breakdown can group by, so the first is sent, ours before the page's. **Absent whenever the capture was clean**, so its presence is itself the signal. Reported as `other` rather than omitted when the block says dirty and names nothing: a gap there would read as "no unclean verdicts happened". |
| `bug.attribution` | `bug_found` | `app` \| `request` \| `reticle`: whose fault the defect was. **Absent means unclassified**, never `app`. See below. |
| `outage.stage` / `outage.reason` / `outage.attempts` | `mcp_connection_lost` | which stage of the outage, why the stream went away (closed `OutageReason`, `other` for anything unnamed), and how many reconnects had been tried. See below. |
| `installSource` | `reticle_installed`, `init_completed` | WHICH published route brought this install in, from core's closed `InstallSource`. Read from one self-declared marker (`RETICLE_INSTALL_SOURCE`) and NEVER inferred, so `unknown` is expected to dominate until every channel's own copy of the install command carries it. See below. |
| `licenseId` / `licenseStatus` | every event, on a licensed build | Enterprise activation. `licenseStatus` is core's closed `LicenseActivation` (`active` \| `missing` \| `invalid` \| `expired`) and rides through the FAILURE states too, which is what makes a lapse distinguishable from a churn. `licenseId` is present only while a key verifies, so on identity alone a customer whose key expired and one who left are the same silence. `licenseId` is an opaque uuid that resolves to a company only against the issuance ledger held locally, so the analytics backend never holds a customer list. The organisation NAME is never sent. **All three absent on a build with no issuer key baked**, which is every OSS install, so absence means "not a licensed build" and costs nothing to say. See below. |
| `init.confirmation` | `init_completed` | what `init` SAW after writing, from core's closed `InitConfirmation`: `connected` (an app carrying the SDK reached the daemon while it watched, and it is the only value that means installed) \| `no_daemon` (nothing was listening, so no session could arrive) \| `no_session` (a daemon was up and no app connected inside the window). **Absent means it never looked**, which is every scripted run: `init` waits only when a human is at the terminal. Read absent as "not measured", never as a failure to connect. |
| `automation` | every event | ADVISORY hint that the run looks automated when `CI` does not say so, from core's closed `AutomationHint`: `container` \| `hosted_workspace` \| `no_tty`. `ci` reads one environment variable set only by a runner, so a gate driven from a cloud sandbox lands as a human at a machine. **Never a filter**: people work in containers, in Codespaces, and over ssh with no terminal, and dropping a row because this is set drops real users. Absent means nothing looked automated, not that a human was present. |
| `tzOffsetMin` | every event | minutes offset from UTC. One integer, no location. |
| `versionChange.nudged` | `version_changed` | an agent had been told about exactly this version recently, so the nudge plausibly caused the update. The daemon that nudges and the `reticle update` that acts are different processes, so a marker file joins them. |

## Enterprise activation: `licenseId`, `licenseStatus`

A licensed deployment reports which licence it is running under, so per-customer usage can be answered at all. Three things make this different from every other property here, and all three are deliberate:

**It is on every event, not on an activation event.** The questions a licensed customer generates are "how much is this org using it", "what is breaking for them", "did their key lapse", and every one of those is answered by an event that has nothing to do with licensing. A status riding only its own event would say a key verified once and nothing about the sessions it covered.

**Status is separate from identity, and reports failures.** `licenseId` exists only while a key verifies. If that were the whole signal, a lapse would look exactly like a departure, and the renewal conversation would start after the customer noticed rather than before. `licenseStatus` keeps arriving through `expired` and `invalid`. A mis-built release (production with no issuer key baked) reports `invalid` rather than staying quiet, because that one is ours to fix.

**The plan is not sent, and neither is the organisation name.** They are left out for different reasons and both are worth stating. The name is free text somebody typed when the key was signed, so rule 3 forbids it. The plan is merely redundant, which is the quieter reason and the easier one to lose sight of: the issuance ledger already holds it against this same id, so sending it would be a per-event cost, from every machine, forever, for something the join that resolves the id resolves at the same moment. `reticle license` still reports it locally, where it costs nothing.

**The organisation name never goes on the wire.** It is free text somebody typed when the key was signed, so it falls under rule 3. The id is opaque; the map from id to company is a local ledger. An analytics-side breach therefore cannot expose who is evaluating Reticle.

Resolution reads the EVENT's clock, not one captured at daemon start: sessions here run to eleven hours, and a key that expires mid-session has to start reporting `expired` from the event it expired on.

> **This changes what a licensed deployment sends, so it is a contract term, not a quiet addition.** The enterprise agreement has to say that licensed deployments report usage attributed to their licence id, and list these fields. `RETICLE_TELEMETRY=0` and `DO_NOT_TRACK` still switch it off exactly as they switch off everything else. There is no exception for licensed installs, and adding one would put a hole in the kill switch that a security review is entitled to find.

## Why they stopped: `tool_refused`

The refusal path computes a precise diagnosis, hands it to the agent as prose, and throws it away. So the biggest cohort in the funnel, the users who attach an agent and never drive, emitted nothing at all and was reachable only by subtracting two other numbers. Half of issue #172.

- `refusal_tool`: which tool, from our own fixed namespace. Never app data.
- `refusal_reason`: the closed `RefusalReason`: `no_session` | `no_match` | `unsupported` | `bad_args` | `not_ready` | `other`. Four different owners, and one undifferentiated "they stopped" number is actionable by none of them.
- `refusal_retried`: the call immediately before this one was the same tool, also refused.

Two things about it are deliberate and easy to get wrong later.

**The reason is derived from the recovery table, not from a second list of patterns.** `error-recovery.ts` is the one place a thrown message becomes a next action; `REASON_OF` is a `Record` over its keys, so a recovery added without a reason does not compile. A parallel regex list would have been correct the day it was written and silently wrong at the next addition. That is rule 4, on the exact kind of value that cannot be recovered afterwards.

**`retried` lands on the RETRY, not on the first refusal.** Reporting it the other way round means holding the first event back until the next call reveals whether one came, which loses it entirely for an agent that gives up, and that agent is the whole population this event exists to describe. So a refusal is sent the moment it happens, and the retry that follows carries the flag. Count `retried: true` for retries; the ratio against all refusals is whether our diagnosis gets anybody unstuck.

Capped at 50 per daemon run. Volume is part of this taxonomy's design and a stuck agent is exactly the shape that produces hundreds; `consecutiveRepeats` on the session summary still reports how long the loop ran.

## Which route brought them in: `installSource`

Four install routes ship at once (the SKILL.md paste URL, an `npx skills add` package, a Claude Code plugin, and docs.reticle.sh), and not one install could be attributed to any of them. Every decision about where to spend distribution effort was made blind.

There is exactly ONE mechanism, and it is a declaration rather than a detection: the channel sets `RETICLE_INSTALL_SOURCE` on the process that runs the install, and `install-source.ts` narrows it against core's `InstallSource`. Anything unrecognised reports `unknown`; an echo would put whatever somebody exported onto the wire.

Nothing infers. Three things look like signals and are not: `npm_config_user_agent` says npm ran us, and all four routes go through npx; a `.claude-plugin/` directory or an installed skill folder says a route is PRESENT, not that it ran `init`, and both are present on any machine that tried more than one; and which command ran first says nothing about who told the user to run it.

So `plugin` is the only route detectable without anybody typing anything (the plugin registers the MCP server and sets the marker in its `env`). `skill_file`, `npx_skill`, `docs_site` and `readme` are detectable only where that channel's own published copy of the install command carries the marker, and each of those is a separately published artifact. `cli_direct` is not detectable at all.

**`unknown` is therefore expected to be the largest bucket, and shrinking it is a distribution job rather than a classifier job.** Read a small `unknown` as a marker that spread. A guessed attribution would be worse than none: it is the number distribution decisions get steered on, and once a guess sits in the same column as a measurement the two cannot be told apart.

## Why a verdict came out that way: `verification.reason`

`verified` has three values. The rule that produces it has **eleven clauses**. Everything in between was thrown away at the moment it was known.

Captured against the real classifier: `verified: 'unknown'` covered "the agent malformed the call", "the consequence was already true", "the app answered 202", "a 2xx body went unread", "the capture was not clean", "nothing was asserted at a real grade" and "the page never settled": **seven causes, two wire payloads**. They belong to three different owners (the agent, the app, Reticle) and need opposite responses: teach the agent, wait and re-check, or ship a fix. On a dashboard they were one bar. `verified: 'no'` collapsed the same way: "channels disagree" (Reticle earning its keep) and "the agent's predicate failed" were the same string.

`VerifiedReason` lives in `@reticlehq/core` and is the **single list**. `decideVerified` returns a member from every clause, so a new clause cannot compile without one; `verified.test.ts` drives every member and fails if a member exists that no clause produces. `verification-of.ts` narrows the result field against `Object.values(VerifiedReason)`, and anything else is dropped rather than forwarded, because a string nobody can group by is worse than a gap. **Nothing re-lists these**, including the battery spec, which imports the enum from core's build.

Optional on purpose: a suite verdict (`flow_verify`) is a pass/fail with no clause behind it, and an older sender has none. Absent means unclassified.

## Whose defect it was: `bug.attribution`

It shipped twice and was wrong both times. A real drive found that across two full runs EVERY `attribution: 'app'` was a misattribution, while the one defect that genuinely was a bad agent predicate carried none. A single session would have published "2 defects in the app" against a true count of 0. So it was removed, and then absence made "nobody classified this" and "we looked and could not tell" the same fact, which is the other half of the same problem.

It is back with two rules, and both are the thing the earlier versions lacked. Issue #122.

**Always present.** `unclassified` is a value, not a gap. Absence would mean an old sender or a path that forgot; a value means the classifier ran and declined. Count `app` for defects in anybody's product; exclude `unclassified` rather than folding it in.

**`app` requires positive evidence.** Something the app itself did: a request that came back failed, a signal the app fired carrying data that disagrees with its own screen, a written field echoed back changed. Never "nothing else explained it". That line already exists in core, as `ABSENCE_DERIVED_CONTRADICTIONS`, the kinds inferred from something NOT having happened inside a window Reticle chose the end of, and it is the same line that decides whether a verdict may say `no`. Reusing it rather than inventing a second judgement beside it is the point: every historical misattribution was an absence-derived kind, so this rule produces zero of them on the data that broke the last two versions.

Everything else is `unclassified` on purpose. A failed `element.present` covers "the button is missing", "the API is down" and "the agent mistyped a testid" identically. A console error can be the app, a browser extension, or a framework's dev overlay, and one of those was a real false positive here. A replay regression says a flow that used to pass no longer does, which is a regression somewhere, and the row does not say whether the app changed or a selector strategy of ours did.

Driver-side causes need no bucket of their own: a stale ref, a malformed call and a lost session produce no `bug_found` at all, because those paths are excluded upstream in `bugsInResult` before anything is counted.

## What is NOT a crash: expected disconnects

`runtime_crashed` answers exactly one question: is Reticle stable. One real session put **nine** events into it, all `write EPIPE`: the MCP client closed its half of the stdio pipe and the next `process.stdout.write` failed, which is how a client is supposed to leave.

`daemon-resilience.ts` matches `err.code` against `EPIPE` / `ECONNRESET` / `ERR_STREAM_DESTROYED` and logs `reticle_daemon_client_disconnected` (or `reticle_mcp_proxy_client_disconnected`) instead of emitting. Two rules make this safe rather than a hole:

- **Code, never message.** Prose gets wrapped, localised and rewritten; matching it would eventually swallow a real crash that merely mentioned a pipe. `daemon-resilience.test.ts` drives an error whose message says `write EPIPE` and carries no `code`, and asserts it is still a crash.
- **Visible, never swallowed.** It still logs a line with the code. A daemon emitting a hundred of these is a finding, just not a crash.

A disconnect is also **no longer fatal for the daemon**: Node's "process state is undefined" guidance is about a throw that escaped everything, not about writing to a socket somebody closed, and exiting there let one departing client take down the daemon serving every other agent.

## Did MCP stay up: the `outage` block

The transport-stability metric shipped with an **empty payload** for months, and it is the exact failure this page opens with. `reportMcpOutage` passed `{ outage: { stage, reason, attempts } }`, `TelemetryExtra` declared the field, and it typechecked. But `emit()` builds its event from an **explicit allow-list of keys** and `outage` was not on it, nor in the `blocks` flattening map, nor in core's `TelemetryEventSchema`. Two deliberately different outages produced byte-identical events. Nothing threw, no test went red, and the data for that whole period cannot be recovered.

The lesson is not "wire the field". It is that **the battery asserted the event ARRIVED and never that it carried anything**, and a kind-only assertion cannot see an empty payload. When you add an event kind, the live check has to assert the FIELDS.

- `stage` is `first` (this session lost MCP at all) or `budget_spent` (it stopped retrying). These are the two facts the event exists to separate: the share of sessions that lose MCP, and the share where it never came back on its own.
- `reason` is the closed `OutageReason`: `sse_ended` | `sse_error` | `sse_aborted` | `sse_closed` | `connect_error` | `other`. The proxy's own reason strings are free text that also feeds a log, so `mcp-outage.ts` narrows them and reports **`other`** for anything unnamed. A classifier that cannot say "I don't know" lies instead, and an unbounded string must never reach the wire.
- `attempts`: consecutive reconnects tried when this was reported.

Still true and worth knowing when you query it: `mcp_connection_lost` carries **no `sessionId`** (it fires from the proxy process, not the daemon), and is capped at two per proxy process by design.

## Recording locally instead of sending: `RETICLE_TELEMETRY_FILE`

Set it to a path and every event is appended there as one JSON object per line, and **nothing is sent**. The payload is the one the wire would have carried, built by the same code and redacted by the same rules, so what a run records is what a user would have sent.

It exists for two reasons that pull the same way:

- **A release sweep is not a user.** Driving dozens of sessions through a gate emits real `daemon_started` / `verification_completed` / `bug_found` events, indistinguishable in PostHog from people. Test runs polluting the numbers is the same class of error as counting `cli_command_run { mcp }` as human intent: the metric stops describing what it claims to.
- **Verifying telemetry should not need a hand-rolled HTTP server.** Ad-hoc harnesses are how a check ends up measuring nothing.

One deliberate exception to the rules above: `RETICLE_TELEMETRY_FILE` keeps telemetry ENABLED inside a Reticle source checkout. The checkout guard exists to stop us phoning home, and writing a local file is not phoning home, while a release sweep is driven from exactly there, so a sink that inherited the guard would record nothing and look like it had worked.

`sent: true` from `reticle_feedback` means the record landed in the file, which is the honest reading of "captured" for a recorded run. An unwritable path degrades to a no-op and reports `false`; it never takes the daemon down.

## Adding things: what to do

| You are adding | Do this | Enforced by |
| --- | --- | --- |
| **A tool** | Add it to `TOOLS`. Nothing else. If its name implies a verdict (`assert`/`verify`), also add it to `VERIFICATION_TOOLS` | `telemetry-contract.test.ts` |
| **A verdict-producing tool** | Add it to `VERIFICATION_TOOLS`. Otherwise it emits no `verification_completed` and stops counting toward the product's headline metric | ✓ |
| **A contradiction / anomaly kind** | Add it to core's enum only. `bug-found.ts` derives from it | ✓ |
| **A new finding shape** in a tool result | Teach `bugsInResult` the field. Add a case to the contract test | ✓ |
| **A failure path** (connect, install, crash) | Classify it into an enum with an explicit `OTHER` bucket; a classifier that cannot say "I don't know" lies instead | ✓ |
| **An event kind** | Add to `TelemetryEventKind` + a payload schema + emit it + add a live check to `apps/e2e/specs/telemetry-events-test.mjs` that asserts the **fields**, not just that it arrived | partly; the live check is on you |
| **A block on `TelemetryExtra`** | Also add it to the `emit()` event build, the `blocks` flattening map, AND `TelemetryEventSchema`. Missing any one of the three drops the payload in silence (see `outage`) | ✗ **not enforced; be careful** |
| **A dispatch path** that bypasses `runTool` | Give it a reporter like `run-telemetry.ts`, or it is invisible | ✗ **not enforced; be careful** |

## Verifying it actually works

Unit tests cannot see the failure mode that matters, because nothing throws. Two things do:

```bash
pnpm test:unit                                  # the contract test + the fingerprint/redaction guards
node apps/e2e/specs/telemetry-events-test.mjs   # fires every event at a real endpoint, checks it lands
```

The second is the one that matters. It drives the real built modules against a real capture server (real network, real process semantics, real redaction) and asserts each event **arrives**. Half its checks are leak checks, asserting that secrets, passwords, customer emails and home directories are _absent_.

**Both halves are mutation-tested.** Reintroducing the fire-and-forget bug fails 9 checks; disabling redaction fails 3. A guard that cannot fail is theatre, so these are periodically proven to bite.

## The privacy line, in one sentence

We measure **that** something happened and **what class** of thing it was, never **what** it was, in whose app, or containing what.
