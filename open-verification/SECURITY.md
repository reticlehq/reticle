# Security considerations, version 1

> The security and privacy considerations for the Open Verification Protocol, companion to [`SPEC.md`](SPEC.md). This is not a vulnerability-reporting policy; a short note on reporting is at the end.

**Normative keywords.** MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119, as in the specification itself.

The artifact this protocol produces is an **evidence bundle**: observations carrying an opaque `value` and a human-readable `summary`, with provenance, coverage and verdicts. Its security properties follow from what that bundle contains and from who is trusted to have produced it. Where this version has no defence, this document says so rather than implying one.

## 1. Trust model

**The subject** is the running thing under test, and it is trusted for nothing. It is the party the protocol is arranged not to believe.

**The realm** drives and observes the subject. It is trusted to declare its channels, capabilities and determinism profile honestly, and to report what it saw without editing it. **Nothing in this protocol can compel that.** What the protocol does instead is make the declaration explicit and checkable: `channels()` is an assertion made on connect, conformance scores later behaviour against it, and the rules in §2 limit what a false declaration can buy.

**The witness** is a vantage point that cannot act (§10.1), trusted for the same honesty and worth more, because it cannot be the thing that caused what it reports. A witness declaring itself `independent` while reading the application's own cache is the costliest lie available here: it looks like corroboration and is an echo. An implementation MUST NOT declare a witness channel independent unless the data reaching it crossed the subject's boundary.

**The adjudicator** holds the decision and is trusted to apply §7.1 in order and nothing else. It sees only what it was handed, so every defence it offers is against a mistaken realm, never a fabricating one.

**The reader of a run** is trusted with everything in the bundle, which is §3's problem.

## 2. Threat: the lying or buggy realm

A realm that reports observations that never happened produces a run indistinguishable from an honest one. **The protocol does not defend against this and version 1 cannot.** There is no signature over an observation, no attestation of the observing code, no required second observer.

What it does defend against is the commoner case: a realm that is correct and would still grade its own homework. Three defences do that, and they are structural rather than behavioural.

- A `Realm` has **no method that returns a verdict**. `dispatch` returns a receipt, `perform` is sealed. An implementer cannot forget the rule because there is nowhere to put the answer.
- **Independence** (§3.1). Evidence for a consequence MUST NOT come from the channel that performed the action, and a disagreement convicts only when one of the two channels is independent. That check runs on the adjudicator's side over the declared channels, so a realm reporting its own screen contradicting its own store gets the anomaly recorded and deciding nothing.
- **Grade** (§3.2). Only `consequence`-grade evidence buys a `yes`. An implementation MAY declare a channel less trustworthy than `CHANNEL_DEFAULTS` and MUST NOT declare one more trustworthy.

These are defences against self-grading, not against malice. A realm that declares `net` independent and then synthesises network observations defeats all three. Weigh a run as you would weigh its producer.

## 3. Threat: evidence as an exfiltration channel

This is the largest risk in the protocol and the one it currently does least about.

An `Observation` carries `value: unknown` and a `summary`, on channels including `net` (request and response bodies and headers, and whatever authorises them), `log` (console output, which carries whatever anyone ever debugged), `storage` (values that outlive a screen: cookies, tokens, preferences), `state`, and `visual` (pixels, via the optional `photograph()`). One run over a signed-in session can hold session cookies, bearer tokens, personal data and a screenshot of somebody's account. That bundle is then written to disk, attached to a CI job, pasted into an issue, and kept.

**What this version requires: nothing.** `BlindSpotKind.REDACTED` is the only redaction-adjacent concept in the specification, and it records that something was withheld rather than requiring that anything is. There is no sensitivity flag, no policy object, and no schema-level difference between a request body and a password.

- An implementation observing `net`, `storage`, `log` or `visual` **MUST** provide a redaction mechanism and **MUST** apply it by default to credential-bearing material: `Authorization` and `Cookie` headers, `Set-Cookie`, and any storage key or state path an operator marked secret. Capturing everything by default is a decision to exfiltrate by default.
- An implementation that redacts **MUST** record a `redacted` blind spot, carrying the `channel` where one applies. Silent redaction produces a bundle that reads as complete and is not, which is the failure §6 exists to prevent.
- An implementation **SHOULD** capture only the channels the run's claims read, and **SHOULD** treat `photograph()` as opt-in. A screenshot of a logged-in session is the highest-value, least-reviewed artifact this protocol can produce.
- An implementation **MAY** offer a mode recording only shapes: a status code, a byte count, a key name without its value.

Redaction is lossy, and that is the right trade. A `redacted` spot that impeaches a claim yields `unknown`, which sends a reader to look again. A leaked token yields an incident.

## 4. Threat: the forged or replayed run

§11 states it plainly: runs are unsigned and carry no envelope existing tooling verifies. A reader must trust whoever handed the document over. A bundle can be authored by hand, edited afterwards, or replayed from an earlier execution and presented as current.

One internal check exists and **MUST** be used: the summary is recomputable from the verdicts, and a consumer **MUST** recompute and reject on mismatch. That catches a producer whose summary disagrees with its own verdicts. It catches nothing about a bundle that is coherent and invented.

An implementation **SHOULD** therefore establish integrity out of band: an authenticated transport, a signature from whatever the surrounding system already uses (a CI artifact attestation, a detached signature, a content hash recorded where the run is cited), and a record of who produced it. A consumer **SHOULD NOT** treat a bundle of untrusted origin as evidence of more than "somebody sent me this JSON".

Two partial defences against **stale** evidence already exist as ordinary protocol rules. `instance` MUST change when the thing it names is replaced, and `epoch` moves when code changes beneath a surviving instance; evidence under a replaced instance is `evidence-superseded`, and evidence predating the edits under test is `evidence-predates-edit`. A consumer **MUST** check both, because a replayed green from a build that no longer exists is the cheapest forgery there is and an invariant already in the protocol defeats it.

A future version MAY add a signing envelope. Note that version 1 has no version negotiation: both ends assume version 1, so there is no downgrade to negotiate and equally no way to require a stronger peer.

## 5. Threat: the mutating capability and the conformance plant

Driving a subject has real effects. `perform()` refuses an undeclared capability before dispatch, but a **declared** `mutating` capability does what it says: it sends the payment, moves the arm, deletes the row.

- A caller **MUST NOT** resume a flow whose realm declares `replayPrefix: 'unsafe'`. Reading the reset cost first and concluding "cheap reset, go ahead" is the reasoning that re-sends the payment.
- A realm **SHOULD** refuse a destructive capability with `guarded` unless the run was explicitly authorised for it, and **MUST NOT** substitute a default for a malformed argument and proceed. Against a mutating capability a silently defaulted argument is a write nobody asked for.

`mutate()` and the conformance binding are sharper. The binding's `command(name, args)` accepts one command, `x-conformance.plant`, whose purpose is to **break the subject deliberately** so detection can be tested. That is a remote instruction to damage a running system.

- A subject answering `x-conformance.plant`, or implementing `mutate()`, **MUST NOT** be a production system and **MUST NOT** hold production data or credentials.
- That endpoint **MUST NOT** be reachable from an untrusted network, and an implementation **MUST NOT** ship it enabled in a release build.
- A command name **MUST** be an allowlist lookup, never a dispatch into arbitrary code, and `args` is `unknown` arriving from off-process: it **MUST** be validated before use.
- A `Reversal` is not optional politeness. A break nobody can undo is damage.

## 6. Privacy considerations

A bundle is a recording of somebody's session.

**Minimisation.** Capture the channels the claims read. Declining to watch one is a first-class, honestly-reportable outcome: a blind spot on a channel no claim reads impeaches nothing.

**Retention.** No lifetime is specified, and runs accumulate: a revision keeps the earlier verdict rather than editing it, so the record grows and never shrinks in place. An operator **MUST** set a retention period and **SHOULD** make it short. The immutability rule governs correcting the record, not deletion: deleting an expired run wholesale is conformant, editing one is not.

**`summary` is the field to worry about.** It exists so a verdict is legible without the realm, so it is the field that gets logged, printed, quoted in a report and pasted into a ticket by somebody who never opened `value`. It is a plain string with no schema constraining it. An implementation **SHOULD** write summaries that identify an observation without reproducing it (`POST /orders 201, 412 bytes`, or a storage key's name rather than its value) and **MUST NOT** place credential material there, including in a rendering of a value redacted elsewhere. The exported rendering function that `valueContains` compares against is also what turns an opaque `value` into text, so redact before rendering, not after.

**Learned beliefs** are inferred from repetition across stored runs. They carry the privacy weight of the runs they came from and **SHOULD** expire with them.

## 7. What this version does not defend against

1. **A realm that fabricates observations.** No attestation, no signature, no required second observer.
2. **A realm that misdeclares its channels.** An `actuation-derived` channel declared `independent` defeats the independence rule and nothing inside the protocol detects it.
3. **A forged, edited or replayed bundle.** Runs are unsigned. Only summary recomputation and the `instance`/`epoch` rules check anything.
4. **Sensitive content in a bundle.** No redaction is required, no field is marked sensitive, and `redacted` only records a decision an implementation already made.
5. **Access control on a stored run.** The protocol says nothing about who may read one.
6. **A compromised subject influencing what is observed.** Every in-realm channel is the subject describing itself; such a subject controls everything but an independent channel and a witness.
7. **Resource exhaustion.** No bounds on observation count, `value` size or window budget. `buffer-truncated` describes the result rather than preventing it.
8. **Downgrade and negotiation attacks, in either direction.** There is nothing to negotiate.
9. **A malicious `x-` channel, capability, anomaly kind or command name.** The namespace is open by design and validated for shape, never for intent.

## Reporting

Report a security problem in this specification or its reference implementation privately rather than in a public issue: use the contact and process named in [`GOVERNANCE.md`](GOVERNANCE.md). Where this repository has GitHub private vulnerability reporting enabled, that is the preferred channel. A gap in this document counts. If the specification permits something this section claims it prevents, that is a defect in the specification and worth the same report.
