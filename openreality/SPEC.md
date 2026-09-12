# The Open Verification Protocol, version 1

> A protocol for establishing machine-verifiable evidence that an intended action produced a claimed outcome in a real environment.

An agent changes something and says it works. Usually nobody checks. When something does check, it is normally the agent reading its own output — which proves that output was produced, and nothing else.

OVP describes what is needed so that "it works" can be checked **from outside the thing making the claim**. It is not a testing format. Testing formats record what was asserted; this records what was _observed_, where the observation came from, whether that source could have been influenced by the action it is evidence for, and what the verifier could not see at all.

**Normative keywords.** MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

**The schemas are the contract.** Everything in this document is prose about the JSON Schemas published under `schema/`, which are generated from `src/` at build time. Where the two disagree, the schemas are what the specification means. They are generated, never authored — two hand-written definitions of one contract is the drift problem, not the fix.

---

## 1. The shape of the thing

Two planes and one loop. The planes exist so that the actor's account of events and the environment's account of events are never the same account.

```text
            INTENT PLANE                        REALITY PLANE
     what was supposed to be true          what a place can do and show

        Intent                                   Subject
          └── Claim                               ├── Capability
               ├── Assertion                      ├── Action  ──► Receipt
               └── Constraint                     ├── Window
                                                  ├── Channel
                                                  └── Observation
                    │                                   │
                    └───────────────┬───────────────────┘
                                    ▼
                              ADJUDICATION
                    Evidence · Coverage · Anomaly
                                    ▼
                  yes   ·   no   ·   unknown   ·   no-fault
                                    ▼
                        Repair ──► Flow ──► Belief
```

The semantic chain, which is the part an implementation must get right:

```text
INTENT → CLAIM → ACTION → OBSERVATION → EVIDENCE → VERDICT
                                  ▲
                     PROVENANCE ──┴── COVERAGE
```

---

## 2. Subject — what was verified

Every noun in this protocol is scoped to a subject. An observation that cannot say which running thing it came from, or which round of edits that thing was carrying, is not evidence about anything.

| Field | Meaning |
| --- | --- |
| `surface` | The kind of place: `web`, `desktop`, `mobile`, `service`, `game`, `device`, or anything else. Open by design — a protocol that must be revised to admit a new kind of computer has an expiry date. |
| `instance` | The identity that **dies**. When the thing it names is replaced, this value MUST change. |
| `epoch` | The round of source edits. Moves when the code changes _without_ the instance being replaced. |

An implementation MUST NOT return a constant `instance`. The failure it produces is invisible: evidence outlives the thing it was about and goes on answering for a world that no longer exists.

`epoch` is optional, and **absence is not zero**. Absent means the implementation cannot observe edits. Zero is a claim that the code has not been touched.

Why both: a navigation is _total_ — it discards the state, the in-flight work and everything referring to them, so nothing recorded under the old instance is still about the world. A hot update is _partial_ — most of the code, most of the surface and the whole record survive, so discarding that window would empty verdicts holding real findings, and an emptied window reads as "nothing happened", which is the more expensive wrong answer. So they invalidate differently, and both MUST be reportable (`evidence-superseded`, `evidence-predates-edit`).

---

## 3. Channels — where evidence comes from

**This is the load-bearing wall.** Every other verification format records _what_ was observed and, at best, where it came from. None records whether the observation was _caused by_ the thing it is evidence for — and without that, an application's own report of its own success is evidence with impeccable provenance.

| Channel   | Holds                                         | Independence      | Grade       |
| --------- | --------------------------------------------- | ----------------- | ----------- |
| `ui`      | What is on screen and can be pointed at       | actuation-derived | presence    |
| `net`     | Requests leaving, answers arriving            | independent       | consequence |
| `state`   | Application state somebody can read           | actuation-derived | consequence |
| `signal`  | Events the application announces about itself | actuation-derived | consequence |
| `log`     | Where errors and messages go                  | independent       | context     |
| `route`   | Where the user is                             | actuation-derived | presence    |
| `storage` | Values that outlive a screen                  | actuation-derived | consequence |
| `time`    | What settled, what is still in flight         | independent       | context     |
| `visual`  | Pixels                                        | actuation-derived | presence    |

An implementation MAY observe channels this table does not name and MUST prefix them `x-`. It MAY declare a channel _less_ trustworthy than this table. It MUST NOT declare one more trustworthy.

### 3.1 Independence

**Actuation-derived** means produced by the same code path that handled the action. The screen renders from state, state is set by the handler, the signal is fired by the handler, the pixels photograph the screen. An application wrong about what it did is wrong on all of them at once, _in agreement_ — which is exactly why their agreement proves nothing.

**Independent** means not decided by that path. A request crosses the subject's boundary and another party answers. An uncaught exception reaches the log without the application choosing to report it.

> **The independence rule.** Evidence for a consequence MUST NOT come from the channel that performed the action. A disagreement MAY be reported as a fault only if at least one of the two channels is independent.

This has an exact precedent that cost lives. Two-of-three sensor voting is a correct doctrine, and MCAS implemented it over a single angle-of-attack vane. The doctrine was right; nothing in the system knew the votes were not independent. A protocol that states the rule in prose and does not let an implementation _declare_ independence has built the same aeroplane.

### 3.2 Grade — a green has a price

`consequence` — the subject provably did something. **Only this grade can buy a `yes`.** `presence` — something was there to see. Real information, never proof an action worked. `context` — useful background; establishes nothing alone.

Measured on a deterministic corpus: a locator resolving to the wrong element satisfies a presence check and cannot satisfy a consequence check. That distinction is the difference between 1 false green in 88 and 29.

### 3.3 Declaration

An implementation MUST declare its channels when it connects. A claim reading an undeclared channel MUST be `unknown` — never a failure. "Nothing was watching" and "it did not happen" produce identical empty evidence and mean opposite things; an implementation reporting them alike has produced its first false verdict before observing anything.

---

## 4. The Intent Plane

### Intent

Why somebody acted, in prose, captured early. Origin MUST be recorded (`user`, `developer`, `agent`, `system`, `workflow`, `derived`).

Intent has two properties moving in opposite directions. **Fidelity** is highest the moment somebody asks and decays with every restatement. **Bindability** — whether it can be written as something checkable — starts near zero, because there is no route, no element and often no code, and rises as the code appears. Demanding a predicate at declare time collects _mechanisms_, which is what assertions already are. Waiting until verify time collects a _re-derivation_, which is the weak artifact this exists to replace.

So `statement` is prose and mandatory; binding to claims is optional and may arrive later or never. An intent is in one of three states: `declared` (said, and nothing can verify it yet), `bound` (attached to at least one claim something can evaluate), or `abandoned` (deliberately closed without ever being bound, and the reason MUST be recorded).

An intent that stays `declared` is not a failure. It names something a team meant that nothing can prove, which is the most interesting row in any ledger. `abandoned` exists so that giving up is a decision somebody wrote down rather than a row that quietly stopped moving.

### Claim

What is supposed to be true. **Claims are what verification evaluates.** One intent decomposes into several, and the decomposition is where honesty enters:

> _Turn off the fan_ → the command was received · the reported state is off · the motor has stopped · nothing else changed

Those four have wildly different evidence available. Collapsing them into one boolean is how a smart-home API's cheerful `success: true` comes to mean a fan that is still spinning.

Every claim MUST record `declaredAt`: `before-action` or `after-action`. This is the difference between a check and a rationalisation — afterwards, anything that happened can be described as what you meant. A claim declared after the action MUST NOT reach `yes`.

### Assertion and Constraint

An **assertion** is one condition and MUST name the channels answering it requires. The protocol does not standardise a predicate language — that ages badly and belongs to the realm. It standardises which channels are read, because that is what decides whether the assertion can prove anything.

**But it does name a few forms it evaluates itself**, because an opaque predicate cannot be compared across implementations, and a clause nobody can reach is not a rule. `predicate` stays `unknown` and an implementation may accept anything it likes; alongside that, `Predicate` names four shapes — `count`, `present`, `absent`, `measure` — selecting observations by channel, by exact `summary`, and by a substring of the rendered value. They read only what an `Observation` carries in every realm, so a service, a robot and a browser answer them identically, and they cover what a claim about a consequence mostly is: counting and presence.

`evaluate(predicate, observations)` returns `true`, `false`, or **`undefined` meaning nobody evaluated this**. That third answer is normative and load-bearing: a predicate written in a language this specification does not speak is NOT a failed claim, and an adjudicator MUST NOT read it as one. `assertionsHeld` is three-valued for the same reason, answers from whatever subset it could evaluate, and any single `false` decides.

`count` carries one of three comparisons: `exactly`, `at-least`, `at-most`. A claim that names a count is the honest route to disproving a duplicate: two writes where one was claimed fails the assertion clause directly, without any anomaly detector having to notice.

`measure` compares a MEASURED QUANTITY with a number the claim named, and it exists because the other three forms answer "how many" and "was it there" and nothing answered "what was the reading, and was it close enough". `count` takes a non-negative integer and counts MATCHES, not values, so _"the temperature held at 37 ± 0.5"_, _"the arm reached 30.2° ± 0.5"_, _"the frame budget stayed under 16.7 ms"_, _"the light drew at least 8 W"_ and _"p99 latency was at most 250 ms"_ were inexpressible. Those are biotechnology, physical AI, games, smart home and backends, which between them is most of what this specification claims to serve.

It carries `op` — one of `equals`, `at-least`, `at-most` — a `value`, and a `tolerance` which defaults to `0`. The tolerance is on every operator rather than only on a `within` form, so exactness is a tolerance of zero and there is no conditional requirement to state. It always widens the band in the reading's favour: `equals` holds when the reading differs from `value` by at most `tolerance`, `at-least` allows the tolerance BELOW the value, `at-most` allows it ABOVE. A negative tolerance would narrow the band instead, which is a different predicate written by accident, and is refused.

The reading is the observation's `value` when that is a finite number. When it is not — a realm reporting its temperature as the string `"37C"` — the predicate evaluates to `undefined`, NOBODY CHECKED, and never to `false`: reading a formatting choice as a failed claim would invent a defect out of it. A selection that matched no observation is also `undefined`, because a measurement over no reading is not a reading of zero; that is the difference between `measure` and `absent`. One matching reading inside the band satisfies it, the way `present` is satisfied by one matching observation.

**The unit is not a field.** It is carried by the exact `summary` a `match` selects on, so `sensor.temperature.celsius` and `sensor.temperature.kelvin` are different selections rather than one selection with a unit nobody compares. A unit an engine could not check would be a field that exists to be ignored, and two implementations disagreeing about it would disagree silently.

There is deliberately ONE measurement form rather than one per domain. A number means the same thing in every realm; a `temperature` predicate would not, and the moment this vocabulary grows a domain-shaped entry it stops being a generic contract and becomes a list of the domains its author happened to think of.

Two deliberate limits. `summary` matches exactly and never as a pattern — a regular expression over it would be a predicate language arriving through the back door. And `valueContains` is the weakest thing in the protocol: rendering is an implementation's own, so two conformant implementations may legitimately disagree about a substring. The rendering function is specified and exported so a disagreement has one place to be resolved; a claim MUST NOT rest on `valueContains` alone.

A **constraint** must hold _throughout_, not at the end. "The invoice exists" is a claim, checked once. "No payment is duplicated" is a constraint, and a verifier that only inspects the end state cannot see it violated in the middle. A verifier that cannot evaluate over the whole window MUST declare a blind spot rather than report the constraint held.

A broken constraint is recorded on the run as a **violation**, and a violated `blocking` constraint makes the run's outcome `fail` ahead of every other consideration. That sentence used to be unkeepable: `severity: blocking` said it "stops the run", the run listed its constraints and never their fate, and `outcomeOf` counted only verdicts. So a run could satisfy every claim, break the one condition that was supposed to hold throughout, and report a pass. Something proved beside a duplicated payment is not a partial success.

A violation is deliberately not an anomaly. An anomaly is something nobody asked about; a violation is a condition somebody declared MUST hold, which is why it can end a run and an anomaly cannot.

---

## 5. The Reality Plane

### Capability — no universal verbs

There is no `click()` in this protocol. A robot does not click, a database has no pointer, a service has no screen. A protocol built on the browser's vocabulary is a browser protocol wearing a general name, and every other realm implementing it has to lie about what it is doing.

A realm **declares** capabilities in domain language (`turn_off_device`, not `tap`). Anything it has not declared, it MUST **refuse** — never attempt, never approximate, never guess.

Refusal is the main defence against a false pass. An implementation that quietly does something _adjacent_ to what was asked produces a result that looks like evidence and is not; measured here, a locator resolving to the element beside the button was driven and reported as a clean green over a page where nothing had happened. A refusal is a worse experience and a better answer.

| Reason | When |
| --- | --- |
| `undeclared` | The capability was never declared. |
| `unsupported` | Declared, and this realm cannot honestly drive this particular target. |
| `unresolved` | The target could not be found. |
| `unavailable` | Found, and not in a state that can accept this. |
| `guarded` | Refused on purpose: destructive, and not authorised for this run. |
| `malformed` | The arguments were malformed. An implementation MUST NOT substitute a default and proceed. |

### Action and Receipt

An action produces a **receipt**, never a verdict. `dispatched: true` means the action was delivered. It says nothing about whether anything happened.

> A realm MUST NOT return a verdict. A realm that could decide whether its own action succeeded would be the thing under test grading its own work.

### Detect — who finds an anomaly

§8 defines twelve anomaly kinds, `adjudicate` takes them as an input, and for a while nothing in this document said who produces one. A conformant implementation could be built in which the whole of §8 was unreachable, and one was: the reference binding passed an empty array because there was nothing to ask, and three planted defects came back `yes`.

`detect` closes it. It is **optional** — finding these needs to know what a request or a render IS, and a realm with neither has nothing to compare.

**Why an implementation may do this, when it may never return a verdict.** An anomaly is not a verdict. It is the observation that two channels disagree, and what that is worth is decided elsewhere. More to the point it is **gated**: a disagreement may only convict when at least one of the two channels is independent of the action (§3.1), and that check runs on the adjudicator's side over the declared channels. An implementation reporting its own screen contradicting its own store gets the anomaly recorded and deciding nothing. **It cannot convict itself however hard it tries** — which is the property that makes this safe, and it is structural rather than a matter of good behaviour.

An implementation MUST set the tier honestly, and an implementation that cannot tell SHOULD say `absence-derived`: that tier may only downgrade a verdict to `unknown`, so an uncertain classification costs a `no` that was never proved rather than inventing one.

### Locate — how a name becomes a target

An action names a `target`, and until a driver was written against this interface nothing said where a target comes from. A caller holding _"the button called Pay"_ had no defined route to something `act` would accept, and every action it attempted was refused — correctly, because a selector a person writes is not a handle.

`locate` closes that. It takes a description and returns **handles**: an opaque `ref` the realm minted, and a `describes` for the human who reads the verdict later.

It is **optional**, like `photograph`, and for the same reason: a realm with no addressable surface has nothing to locate. A service answers requests; there is no _"the button called Pay"_ in it.

It is a **read**, so it returns data — and that is why it cannot be folded into `perform`, which returns a receipt and never results. A receipt that carried data would be one step from a receipt that carried a verdict, which is the separation the whole protocol rests on.

A realm MAY return several handles and MUST NOT choose between them. Returning the first plausible match for an ambiguous description is how a driver acts on the element beside the one it meant — measured on a real dashboard, reported as a clean green.

### Window — and the mistake most implementations make

Everything a realm reports is scoped to a **window**: a bounded stretch of time with a beginning and an end, holding what was seen in it. A window is not an implementation detail. An observation with no window cannot be argued with — "the request went out" is not checkable unless you can say _when_, and relative to what. So every observation belongs to a window, and any verdict built from observations is a claim about that window and no other.

The **close condition belongs to the realm**: `quiescence`, `ticks`, `ack`, `signal`, `settled-physical`, or `budget-exhausted`.

Quiescence — wait until it goes quiet — is _one_ close condition, not the concept. A game never goes quiet. A service's truth arrives after the acknowledgement. A robot settles physically and a separate sensor confirms it. **An engine that hard-codes quiescence has excluded every asynchronous domain while appearing to support them.**

`budget-exhausted` MUST NOT be treated as a clean close, and a clean close is required for `yes` and for `no-fault`.

**"The verifier gave up" and "this realm cannot measure the close condition" are different facts, and an implementation MUST NOT report the second as the first.** A hidden browser tab never flushes the frame that quiescence is read from, and a hidden tab is the _normal_ state for agent-driven verification — so an implementation that reports an unmeasurable settle signal as `budget-exhausted` makes every backgrounded subject permanently unprovable. The honest report is a blind spot on `time` (§6), non-impeaching for a claim that does not read it.

This distinction was found by adjudicating the same situation through two independent implementations and comparing; it is written down because both were right and the mapping between them was not.

---

## 6. Observation, Provenance, Evidence, Coverage

Three links, not one:

- **Observation** — something a channel reported, in a window.
- **Provenance** — how it was obtained and how far that can be trusted.
- **Evidence** — an observation whose provenance is sufficient to bear on a claim, carrying its `independence` and `grade`.

### Provenance classes

`authoritative` — stated by something entitled to state it. `derived` — computed from authoritative inputs by a written rule. `observed` — seen, this time, by an observer. The ordinary case. `learned` — inferred from repetition. **Probabilistic, and never sufficient alone.**

`confidence` is meaningful only on `learned`. A confidence on an observed fact is a category error — either the observer saw it or it did not — and attaching one is how a probabilistic gloss gets applied to a hard fact.

### Coverage — the part with no prior art

**Every other verification format in existence is silent about its own blind spots.** A verdict that cannot say what it could not see is indistinguishable from a verdict that saw everything, and those are the two facts a reader most needs to tell apart.

A blind spot is **impeaching** when it falls on a channel the claim actually needed. Only impeaching blind spots prevent a `yes`. Without that distinction an honest implementation is punished for declaring blind spots and learns to declare fewer.

**Who decides that is specified, because leaving it open made clause 6 unreachable.** A realm MUST NOT judge relevance: it does not see the claim, so it has no honest basis for the flag, and every implementation written against an earlier draft of this section set `impeaching: false` everywhere and documented that the adjudicator would decide — while the adjudicator filtered on the flag. Between them, a window that closed over an operation still in flight was proving things.

So the rule is: a blind spot impeaches when the implementation says so **or** when it names a `channel` the claim reads. A realm's job is to say which channel each gap falls on; matching that against the claim is the adjudicator's. A blind spot naming no channel can only impeach by its flag — it is a statement about the observation as a whole, and only the implementation knows what it bears on.

Six kinds are named, and an implementation reports the closest one: `channel-unobserved` (a channel exists here and this implementation does not watch it), `boundary-uncrossable` (part of the subject is somewhere this observer cannot enter), `buffer-truncated` (the record was capped and older entries dropped), `redacted` (content withheld deliberately: a secret), `still-in-flight` (the window closed while something was outstanding), and `effect-elsewhere` (the consequence happened somewhere this observer cannot follow).

`still-in-flight` is the one most often reported as something else. An operation that had not finished when the window closed is a gap in the OBSERVATION, because the window's end was the verifier's choice; reporting it as an anomaly would let a slow backend convict an application that did nothing wrong.

An empty `blindSpots` array is a positive claim that nothing was hidden. An implementation that cannot enumerate its blind spots MUST omit the field rather than send `[]`.

---

## 7. Verdict

| Verdict | Meaning |
| --- | --- |
| `yes` | Proved. Requires independent, consequence-grade evidence over a cleanly closed window. |
| `no` | Disproved, or independent channels contradict each other. |
| `unknown` | Nobody could tell. |
| `no-fault` | Everything was watched, nothing was wrong, and nothing was declared to prove. |

`unknown` MUST NOT collapse into either neighbour. "The capture was truncated so I could not see" and "the application is broken" lead an actor to opposite next moves: one says look again with better coverage, the other says go and fix something.

`no-fault` requires a cleanly closed window and is never `yes`. Without the first it becomes the green-forever button that an always-available "nothing was wrong" always becomes.

### A verdict, and a summary of verdicts

A run over many claims needs a word for "some held and some did not", and no single claim can be that. So there are two vocabularies for two different questions, and an implementation MUST NOT use one for the other:

| Summary   | Meaning                           |
| --------- | --------------------------------- |
| `pass`    | Everything that was decided held. |
| `fail`    | Something did not hold.           |
| `partial` | Some held, some did not.          |
| `unknown` | Nothing was proved either way.    |

A verdict of `unknown` or `no-fault` counts towards neither the passes nor the failures, and MUST still be recorded. Dropping it shortens the document by exactly the part describing what the verifier could not see.

The summary MUST be recomputable from the verdicts. A producer that can write its own summary can write one its verdicts do not support, and that is the one lie this artifact must not be able to tell; a consumer recomputes and rejects on mismatch.

### 7.1 The adjudication order — normative

The clauses are checked in this order, and the order _is_ the specification. It is arranged so that **"I could not see" is always evaluated before "it did not happen"** — the single ordering mistake that turns a verification tool into a bug generator.

1. Nothing declared → `no-fault` (clean close) or `unknown`.
2. The claim reads an undeclared channel → `unknown`.
3. An observed anomaly on independent channels → `no`. _Outranks a passing assertion._
4. The assertions failed → `no`.
5. The window did not close cleanly → `unknown`.
6. An impeaching blind spot → `unknown`.
7. An absence-derived anomaly → `unknown`.
8. The claim was declared after the action → `unknown`.
9. Nothing independent and consequence-grade supports it → `unknown`.
10. The consequence was already true before the action → `unknown`.
11. Otherwise → `yes` at consequence grade.

Clause 10 exists because the specification could not express its own scenario. `adjudicate` answered `yes` to a consequence that had been true all along: every input was healthy, and nothing in `AdjudicationInput` could say that the evidence was about something which had already happened. The conformance suite has demanded `unknown` for that case since it was written, so the normative function could not pass the normative suite, and the gap was found by mapping one real implementation's verdict reasons onto these grounds and looking for one with no home.

`consequenceHeldBefore` is optional, and `undefined` means NOBODY CHECKED rather than `false`. An implementation that cannot read the before-state says so by omission and gets the verdict it would have got anyway; one that can, and finds the consequence already true, must not report a proof.

Clause 8 is the one an implementation passes by accident. An implementation that ignores `declaredAt` entirely answers a late claim exactly as it answers a pre-registered one, and nothing about its output looks wrong. The conformance suite therefore drives the two as a PAIR: the same application, the same action, the same evidence, differing only in when the claim was written down. If both come back `yes`, the field is being ignored.

Each clause has a **ground**: a code naming which one decided, returned alongside the prose. In clause order: `nothing-declared`, `channel-not-observed`, `contradicted`, `assertion-failed`, `window-not-closed`, `coverage-impeached`, `suspicion-unresolved`, `declared-after-action`, `no-independent-consequence`, `already-true`, `proved`.

The ground exists because a verdict alone is too coarse and its sentence is too fine. `no` is returned by both clause 3 and clause 4, so "disproved because independent channels contradicted" is not expressible in the verdict; and comparing the sentence would score every implementation against this one's vocabulary. The prose stays for a person to read. **A conformance scenario names a ground, never a wording.**

The reference implementation of this order is `adjudicate()`. Where an implementation disagrees with it, that function is what this specification means.

### Revision

A judgement made across a bounded stretch of time and presented as final is a claim the evidence does not support — the evidence supports _"this is what it looked like by the time we stopped watching"_. Late evidence lands.

A later verdict MAY **supersede** an earlier one, citing it as `<runId>#<verdictId>`. A revision MUST NOT edit the verdict it replaces. Both are kept, so a reader can see the first answer was given, when it changed, and why. **"We always knew" stops being expressible.**

A verdict that does not name its claim cannot be cited and therefore cannot be corrected.

---

## 8. Anomalies

A verdict answers a question somebody asked. An **anomaly** is something worth knowing that nobody asked about — an observation in the window that no claim covers and that contradicts something else in the same window.

It is the only part of this model producing output the caller did not request, and the part least dependent on knowing what kind of application this is, which makes it the piece most worth agreeing on across implementations.

Three tiers, because two were not enough and the gap had a measured cost:

- **observed** — positively seen, on independent channels. MAY force `no`.
- **absence-derived** — "the thing I expected had not happened _yet_ when I stopped looking". MAY downgrade to `unknown`; MUST NOT force `no`. A verifier treating these alike overrules consequence evidence with a timing observation.
- **advisory** — true, worth reporting, not about the claim. Decides nothing.

Twelve kinds are named. Each can be described without knowing whether the subject is a page, a service or a robot — that is the test for belonging in this list, and an implementation's own registry will be larger.

| Kind | Two things that cannot both be true |
| --- | --- |
| `advanced-over-failure` | The subject moved forward while an operation in the same window failed. |
| `claimed-over-failure` | The subject announced success while an operation in the same window failed. |
| `effect-discarded` | An operation succeeded at the boundary and nothing in the subject moved. |
| `claim-uncorroborated` | The subject announced success and nothing anywhere corroborated it. |
| `failure-inside-success` | A transport-level success carrying a failure in its payload. |
| `value-not-applied` | A value came back at a different scale or type than it was sent. |
| `duplicated-effect` | The same mutating operation happened more than once for one action. |
| `stale-applied` | Two operations settled out of order and the later-displayed one is stale. |
| `no-effect` | The action was delivered and no channel recorded anything at all. |
| `fault-misattributed` | The far side faulted and the subject blamed the actor. |
| `evidence-superseded` | Every observation belongs to a subject instance that has since been replaced. |
| `evidence-predates-edit` | Every observation predates the round of edits under test. |

Implementations MAY add `x-` kinds.

---

## 9. Flow, Repair and Belief

### Flow

A route that established a claim, recorded so it can be walked again without rediscovery. `mayRebind` is **off by default**: a self-healing replay that rebinds to a different target and passes has reported on a route nobody took.

### Repair

What a failed verification hands back. Evidence-driven: not _"try something else"_, but _"this claim failed because this evidence contradicts this assertion, and here is the responsible code"_. A repair packet with no evidence pointer is a suggestion, and an actor acting on suggestions is guessing with extra steps.

### Belief — and the fence around it

A verification system that learns what "normal" looks like and then treats normal as correct has become an expensive way of confirming that yesterday happened again. That is the standard failure of every invariant miner since Daikon, and an anti-false-green protocol cannot survive it.

So memory is in this specification, and it is fenced:

> **A `learned` belief MUST NOT, by itself, produce a `yes`.**

It may raise a question. It may direct attention. It may downgrade a verdict to `unknown`, which is the honest verdict for a suspicion and which sends an actor to gather evidence rather than to fix something that may not be broken.

A belief is about one of two things: a `failure-mode` (this is how this subject tends to break) or a `repair-outcome` (this is what fixing it tended to do). Both are memory about the past, and neither is evidence about the window under test.

The only route from `learned` to authoritative is **promotion by a named person or specification**. Not by repetition. Not by a confidence threshold — a threshold is a number somebody picked. Not as a side effect of being right a lot.

---

## 10. Conformance

### Profiles

A single pass mark quietly sorts implementations by architecture, and only the one the spec was written against scores full marks. That is the WS-\* failure: _a specification you cannot implement without the author's product is a product with a spec-shaped cover._

| Profile | Must observe | Who it is for |
| --- | --- | --- |
| `effect` | `net`, `log` | The floor. Something watching from outside the subject can reach this. |
| `in-realm` | + `state`, `signal` | Code running inside the subject's own world. |
| `surface` | + `ui` | Adds addressing things and checking they are there. |

An implementation that cannot address things on screen is not a worse implementation. It is a different one, and it MUST be able to say so and remain conformant.

### The rules that decide the outcome

1. **A scenario that could not be planted is never a pass.** A scenario that quietly stops being plantable and stays in the denominator is how a scoreboard stays perfect while testing less every month.
2. **The negative control is mandatory.** Almost every scenario asks for something _other_ than a confident yes, so an implementation answering "I could not tell" to everything satisfies nearly all of them. One scenario is a healthy subject with a real claim, and it MUST produce `yes`.
3. **What you registered MUST match what you declared on connect.** The declaration is itself the first assertion.
4. **A profile is a claim about what you can see**, not only about what you answered.

### Implementing it

Extend `Realm` from `@reticlehq/openreality`. The compiler names what you must answer; the rules you must not break are already written and are not yours to override.

```ts
class MyRealm extends Realm {
  identity(); // what this is, and what invalidates evidence about it
  channels(); // what you can see — and whether any of it is independent
  determinism(); // how you may be DRIVEN — resume, reset, clock, reads, reversibility
  // identity/channels/openWindow/observe/coverage come from Witness — see §10.1
  capabilities(); // what an actor may ask for
  describe(); // what is here now, as structure
  dispatch(); // do one thing; report that you did it, never that it worked
  openWindow(); // when "done" happens in YOUR world  ← most-got-wrong
  observe(); // what was seen
  coverage(); // what you could NOT see
  photograph?(); // optional
}
```

`perform()` is sealed and refuses undeclared capabilities on your behalf. There is no method that returns a verdict, and that is not an oversight.

### 10.1 A witness — a vantage point that cannot act

Every channel a realm declares is, in the end, the subject describing itself. The DOM says the order was saved because the app wrote that on the screen; the network says so because the app made the call. When an application lies to itself — the optimistic update that was never committed, the write that returned `200` and rolled back — every channel inside it repeats the lie consistently, and no quantity of evidence from in there settles it.

The database is not in there.

```ts
class OrdersDb extends Witness {
  identity(); // what is being looked at
  channels(); // usually independent — and still a declaration, checked like any other
  openWindow(); // when "done" happens from HERE, which is rarely when it happens in the subject
  observe(); // what was seen
  coverage(); // what could NOT be seen
}
```

A `Witness` is a `Realm` minus the ability to act, and the omission is the point: it cannot be the thing that caused what it reports. `Realm extends Witness`, which is the honest direction — observing is the base, acting is the addition. A witness modelled as a realm with its action methods left unimplemented is an interface inviting the coupling that makes the evidence worthless, and an implementer who _can_ act through that object eventually will.

`witnessDisagreement(actor, witness)` turns the subject's claim and the witness's silence into an `observed` anomaly of kind `claim-uncorroborated`, between the two channels. §7.1 clause 3 then outranks a passing assertion with it, because one of the two is independent — so _"the UI says it saved and the database has no row"_ is a `no`, not a pass with a note.

It returns **nothing** when the witness could not look. A witness that was unreachable saw nothing for a reason that has nothing to do with the application, and reporting that as _"the write never happened"_ would be the protocol inventing a defect out of its own blind spot — the same rule that makes an empty `blindSpots` array a positive claim rather than a default.

### 10.2 The determinism profile

Every other question here is about what a realm can SEE. `determinism()` is about what it can be PUT THROUGH, and it exists because the rest of this specification had inherited a browser's answer to a question no browser has to ask.

_"Resume is nearly free — re-drive steps 0..N-1 at a few milliseconds each"_ is true of a web page. On a service a `POST` is not idempotent, so re-driving the prefix re-submits every write it contained. On hardware it moves a physical arm, costs real time, and may not repeat. A protocol that silently re-drove a payment or a servo would be a defect, not a feature.

```ts
interface DeterminismProfile {
  reset: 'none' | 'cheap' | 'costly'; // can the subject be returned to a known start?
  replayPrefix: 'free' | 'costly' | 'unsafe'; // may steps 0..N-1 be re-driven?
  time: 'wall' | 'injectable' | 'stepped'; // is the clock ours?
  observation: 'exact' | 'sampled'; // do two reads of an unchanged subject agree?
  actions: 'reversible' | 'irreversible'; // does an action commit something?
}
```

It is abstract, like `channels()`, and for the same reason: **declaring a property you do not have is the lie the conformance suite exists to catch.** A default would be wrong either way — `free` would tell a payment service it is a browser, `unsafe` would silently downgrade every realm that is honestly cheap to re-drive. This is the more expensive half of that rule, because a channel you cannot observe costs a wrong verdict and a `replayPrefix` you do not have costs a re-sent payment.

Callers do not read `replayPrefix` themselves. They derive the strategy, so the decision is made once and identically everywhere:

| the profile says | `resumeStrategy` returns | what it means |
| --- | --- | --- |
| `replayPrefix: 'free'` | `replay-prefix` | re-drive 0..N-1 silently and report from N |
| `replayPrefix: 'costly'`, and a reset exists | `reset-then-replay` | return to a known start first; resume is a budget decision |
| `replayPrefix: 'costly'`, `reset: 'none'` | `replay-prefix` | a reset is not a way out if there is no reset |
| `replayPrefix: 'unsafe'` | `refuse` | do not resume. Report the stop and require an explicit instruction |

`unsafe` is checked first and alone. It is not a cost to be weighed against a cheap reset — reading the reset first and concluding _"cheap reset, so go ahead"_ is exactly the reasoning that re-sends the payment.

`ServiceRealm` declares `replayPrefix: 'unsafe'` and `actions: 'irreversible'`. A web realm declares `{reset:'cheap', replayPrefix:'free', time:'injectable', observation:'exact', actions:'reversible'}` — and `reversible` there is a claim about the REALM, that a click can be undone by a reload, not a promise about the application behind it.

---

## 11. What this does not specify

Stated plainly, because a specification hiding its gaps is worse than a short one.

- **No transport is required.** One is _described_ in §12 and using it is optional.
- **No signing.** Runs are unsigned and carry no envelope existing tooling verifies. A reader must trust whoever handed the document over.
- **One realm ships here, and it is not the flagship.** `ServiceRealm` is a working implementation for a subject with no screen, written to test whether the adjudicator is genuinely realm-blind. It reaches the `effect` profile. A second _independent_ implementation — by somebody who is not us — is what §10 is actually waiting for, and it does not exist.
- **The conformance suite has no transport binding.** The scenarios, the scoring, and the driver that walks an implementation through them all exist and are tested. What is not specified is how the driver reaches _your_ implementation: it is handed a client with `hello`, `command` and `verify`, and wiring that to your process is yours to do. A reference binding for the wire in §12 does not exist yet.
- **No version negotiation.** Both ends assume version 1.
- **No registry service.** `Implementation` describes an entry; nothing says where entries live.
- **A driver cannot resolve a reference through the interface.** `perform` returns a receipt and never data, which is right for an action and wrong for a query — a query is a read, and reads go through `describe`, which takes an opaque query and returns an opaque structure. There is no defined way to ask "what is the handle for the thing called X" and get an answer a later `act` can use. Found by writing a driver against it: every plant was refused because the selector a person writes is not the handle an action takes, and nothing in the interface bridges the two. Routing reads through `perform` would fix it by making a receipt carry data, which is the shape the separation exists to prevent, so it needs a real answer rather than a patch.
- ~~**Nothing in the interface produces an anomaly.**~~ _Closed._ `Realm.detect` is optional and named; an implementation may find anomalies and still cannot convict itself, because a disagreement only convicts when one of the two channels is independent (§3.1) and that check runs on the adjudicator's side. Kept here, struck through, because the shape of the defect recurred twice more afterwards — `impeaching` and `predicate` were both fields defined, deferred to somebody, and evaluated by nobody, each making a clause of §7.1 unreachable. **Three of ten clauses could not fire, and only running the conformance suite found it.** The original entry read: §8 defines twelve kinds across three tiers, and `adjudicate` takes them as an input — but `Realm` has no method that returns one, and no role in this document is given the job of finding them. A realm should not do it (it would be the subject reporting faults in itself), and the adjudicator cannot (it is handed them). So a conformant implementation can be built in which the whole of §8 is unreachable, and one was: the reference binding passes an empty array because it has nothing to ask, and three planted defects came back `yes`. **A false green produced by the specification's own gap.** The fix is a design decision — name a detector role, or make the adjudicator derive anomalies from the observations it already has — and it is not a patch.
- **No predicate language.** Assertions carry an opaque predicate and a human rendering. Two implementations agree on which channels a claim reads, and not on how to write the condition.
- **Nothing revises a verdict yet in practice.** §7 says how a correction is written and the mechanism exists; no shipping adjudication currently re-opens a window when late evidence lands.

---

## 12. A reference transport (non-normative)

Nothing in this specification requires a particular transport, and an implementation that carries these nouns over HTTP, a file on disk or a function call is fully conformant. What follows is the wire the reference implementation uses, published because "transport-neutral" too often means "no two implementations can talk".

Four kinds of message travel between a realm and whoever is deciding:

| Kind | Direction | Meaning |
| --- | --- | --- |
| `hello` | realm → decider | I am here, this is my subject, and these are the channels and capabilities I have. |
| `command` | decider → realm | Do this. |
| `command_result` | realm → decider | Here is the receipt. Never a verdict. |
| `event` | realm → decider | Something happened that nobody asked for. |

The current wire protocol version is **1**.

`hello` carries the declaration described in §3.3 and §5, and it is the first assertion an implementation makes: everything it later reports is scored against what it said here. A `command_result` carries an `ActionReceipt` (§5) and MUST NOT carry a verdict. An `event` carries an `Observation` (§6) and MUST name the window it belongs to.
