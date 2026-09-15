# How this specification changes, and who it belongs to

Written at version 1, when there is exactly one implementation and the author of the specification also sells a verifier. Both facts are problems, both are stated here rather than discovered later, and this document exists to say what is being done about them.

## The conflict, named

**The author of this specification sells the thing it describes.** Historically that is the single strongest predictor of a specification that never gets a second implementation: every ambiguity resolves in the vendor's favour, not by malice but because the vendor is the only party in the room when it is resolved.

We are not going to claim this is fine. What we can do is make the failure detectable:

1. **Profiles, designed in from the start.** The central rule — only consequence-grade evidence earns a `yes` — means an out-of-process verifier can reach `effect` and can never reach `in-realm`, because that needs code inside the subject's world. Left implicit, that silently sorts implementations by architecture and only ours scores full marks. Named as profiles, it becomes an honest statement about what different architectures can see. Any future rule with the same property MUST be given the same treatment.
2. **The conformance suite ships with our own failures in it.** Two scenarios currently fail for the reference implementation and stay on the list. A suite whose author passes everything is a suite shaped around its author, and publishing the gaps is the only way anybody can tell the difference.
3. **The normative core is small on purpose.** Everything a second implementer must agree with us about is a place we can win an argument by default. `Flow`, `Repair` and `Belief` are in this specification because the semantics matter, and a conformant implementation may ignore all three.

## What "version 1" means

The **schemas** under `schema/` are the contract, generated from `src/`. Prose in `SPEC.md` describes them; where the two disagree, the schemas are what the specification means.

- **Additive changes** — a new optional field, a new `x-` channel or anomaly kind, a new close condition — do not change the version.
- **Anything that could make a previously-conformant implementation non-conformant** changes the major version. Removing a field, tightening a constraint, adding a required field, and changing the adjudication order are all breaking.
- **The adjudication order in §7.1 is normative.** Changing it changes what "verified" means, and it is the change most likely to be made accidentally while fixing something else. It is pinned by tests in this package for that reason.

## Extending it without forking it

Two prefixes exist so an implementation can be honest about doing something this document does not describe:

- `x-` on a **channel id** — you observe something this specification does not name. Declare its independence and grade truthfully; the adjudication rules then apply to it unchanged.
- `x-` on an **anomaly kind** — you detect a contradiction this specification does not name.

Both are first-class. An implementation using them is conformant. What is _not_ conformant is redefining a name this document already assigns, or declaring a channel more trustworthy than §3 allows.

If you find yourself needing to break a normative rule to describe your domain, that is a bug in this specification and we would rather hear about it than have you fork quietly.

## Donation

The intended path is donation to a neutral foundation, and the intended timing is **after there is a second independent implementation, not before**.

That ordering is deliberate and is the opposite of what looks generous. A specification donated before anyone has implemented it hands a foundation a governance process with nothing to govern; the foundations that worked took on standards that already had multiple implementations and a live disagreement to arbitrate. Donating early would be a press release. Donating once there is a genuine second party makes the governance real, because there is then someone whose interests differ from ours.

Until then, the honest description is: **this is an open specification with a single vendor implementation, published under Apache-2.0, with a conformance suite anyone can run against us.**

## What would tell us this is working

Not stars, and not adopters. Three things, in order:

1. **A second implementation reaches a profile** — any profile, including `effect`. That is the first evidence the specification describes something other than our own architecture.
2. **Somebody's conformance run fails us.** A scenario where an independent implementation is right and the reference implementation is wrong is worth more than a hundred adopters, and it is the moment the suite stops being marketing.
3. **A consumer requires the artifact.** A deploy gate, a platform, a procurement checklist — anything that asks for a verification run and refuses to proceed without one. This is the precondition currently missing, and no amount of specification quality substitutes for it.

Until (3) exists, this document's value is discipline: writing the rules down as data has already found defects in the implementation that prose never would. That return is real and immediate. Adoption is a separate bet and should not be claimed until it happens.
