# Glossary

**Non-normative.** This file explains, it does not bind. The normative definitions live in [SPEC.md](../SPEC.md), and where the two differ the spec is right. Section pointers are to SPEC.md unless another document is named.

## Terms

**Adjudicator.** The function that turns evidence into a verdict, given a claim, a window, the declared channels, evidence, coverage and anomalies. It never touches the subject. (§7.1; `adjudicate`.)

**Anomaly.** Something nobody asked about: two things observed in one window that cannot both be true. Twelve kinds in three tiers, and only an `observed` one can force a `no`. (§8.)

**Assertion.** One condition inside a claim, which names the channels answering it requires. The protocol standardises the channels, not the predicate language. (§4.)

**Blind spot.** A named thing the verifier could not see, on a named channel, in a window. Six kinds, including `still-in-flight` and `buffer-truncated`. (§6.)

**Capability.** Something a realm declares it can do, in its own domain language (`turn_off_device`). There is no universal `click()`, and anything undeclared is refused. (§5.)

**Channel.** Where evidence comes from: `ui`, `net`, `state`, `signal`, `log`, `route`, `storage`, `time`, `visual`, plus `x-` extensions. Each carries an independence and a grade. (§3.)

**Claim.** One thing that is supposed to be true, and the unit verification evaluates. (§4.)

**Constraint.** A condition that has to hold throughout a window rather than at the end, such as "no payment is duplicated". (§4.)

**Coverage.** The verifier's own statement of what it could not see in a window. An empty `blindSpots` array is a positive claim that nothing was hidden, never a default. (§6.)

**Declaration.** Two uses: a claim's `declaredAt`, either `before-action` or `after-action`, and what a realm announces on connect, being its channels and capabilities. (§3.3, §4.)

**Epoch.** The round of source edits the subject carries, moving when code changes without the running thing being replaced. Absent is not zero. (§2.)

**Evidence.** An observation whose provenance is good enough to bear on a claim, carrying its own independence and grade. (§6.)

**Grade.** What evidence can buy: `consequence` (the subject provably did something), `presence` (something was there to see), `context` (background). Only `consequence` buys a `yes`. (§3.2.)

**Ground.** The code naming which clause decided, returned beside the verdict. In clause order: `nothing-declared`, `channel-not-observed`, `contradicted`, `assertion-failed`, `window-not-closed`, `coverage-impeached`, `suspicion-unresolved`, `declared-after-action`, `no-independent-consequence`, `already-true`, `proved`. (§7.1.)

**Handle.** An opaque `ref` a realm minted for something in it, plus a `describes` string for whoever reads the verdict. An action takes the `ref`, never a selector. (§5.)

**Independence.** Whether a channel could have been influenced by the action it is evidence for: `independent` or `actuation-derived`. Evidence for a consequence cannot come from the channel that performed the action. (§3.1.)

**Instance.** The identity that dies: when the thing it names is replaced, this value changes, and a constant one lets evidence outlive its own subject. (§2.)

**Intent.** Why somebody acted, in prose, captured early. It is `declared`, `bound` to claims, or `abandoned` with a recorded reason. (§4.)

**Observation.** Something a channel reported inside a window, before provenance and before it counts as evidence. (§6.)

**Profile.** Which channels an implementation observes, cumulative from the bottom up: `effect` (`net`, `log`), `in-realm` (plus `state`, `signal`), `surface` (plus `ui`). (§10; [CONFORMANCE.md](../CONFORMANCE.md) §3.)

**Provenance.** How an observation was obtained and how far that can be trusted, in four classes from most to least authoritative: `authoritative`, `derived`, `observed`, `learned`. `confidence` is meaningful only on `learned`. (§6.)

**Realm.** An environment that can be observed and driven. It extends `Witness` with `determinism()`, `capabilities()`, `describe()` and a protected `dispatch()`, and has no method returning a verdict. (§10; `src/spi/realm.ts`.)

**Receipt.** What performing an action returns. `dispatched: true` means the action was delivered, and nothing more. (§5.)

**Refusal.** A realm declining to act, with a reason: `undeclared`, `unsupported`, `unresolved`, `unavailable`, `guarded`, `malformed`. It is the main defence against a false pass. (§5.)

**Revision.** A later verdict superseding an earlier one by citing it as `<runId>#<verdictId>`. It never edits what it replaces. (§7, "Revision".)

**Subject.** The running thing every noun is scoped to: `surface`, `instance`, optionally `epoch`. (§2.)

**Surface.** The kind of place a subject is: `web`, `desktop`, `mobile`, `service`, `game`, `device`, or anything else. The list is open on purpose. (§2.)

**Verdict.** The answer about one claim: `yes`, `no`, `unknown`, `no-fault`. (§7.)

**Window.** A bounded stretch of time holding what was seen in it. Its close condition belongs to the realm: `quiescence`, `ticks`, `ack`, `signal`, `settled-physical`, `budget-exhausted`. (§5.)

**Witness.** A vantage point that can look and cannot touch, such as the orders database beside the app. It provides `identity()`, `channels()`, `openWindow()`, `observe()` and `coverage()`. (§10.1; `src/spi/witness.ts`.)

## The pairs people mix up

**Intent vs claim vs assertion.** An intent is why somebody acted, in prose, and may never be checkable. A claim is one thing supposed to be true, and is what the adjudicator evaluates. An assertion is one condition inside a claim, naming the channels it reads. "Turn off the fan", "the motor has stopped", "no rotation on `sensor.rpm`".

**Witness vs realm.** Both observe, only a realm acts, and `Realm extends Witness` rather than the reverse. That direction is the point: a witness cannot be the thing that caused what it reports, so it settles what no evidence from inside the subject can. Modelling one as a realm with empty action methods gives that property straight back.

**Grade vs independence.** Orthogonal, and a `yes` needs both. Independence asks whether the channel could have been influenced by the action: the app's own store agreeing with its own screen is not corroboration. Grade asks what the observation is worth if you do trust it, and a rendered element is `presence`, which never proves an action worked.

**Verdict vs ground.** The verdict is the answer, the ground is which rule produced it. They are not redundant: `no` comes from two clauses, one for contradicting independent channels and one for a failed assertion. Conformance compares grounds and never wording, since prose would pin every implementation to one vocabulary.

**`unknown` vs `no`.** "I could not see" and "it did not happen" produce identical empty evidence and send an actor in opposite directions, one at instrumentation and one at a bug. The adjudication order exists largely to evaluate the first before the second.
