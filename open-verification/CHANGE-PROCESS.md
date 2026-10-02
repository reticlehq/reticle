# How a change to this protocol is proposed, reviewed and lands

This document describes the process. [GOVERNANCE.md](./GOVERNANCE.md) describes who is running it and why that is a problem; read both, because a process is only as good as the parties bound by it, and today there is one.

It is modelled on the Matrix MSC process for one property in particular. There, a proposal is not accepted because it reads well: the Spec Core Team requires evidence of the MSC working, and an implementation must be shown to prove that it works well in practice. That rule does the heavy lifting here too, because this specification's own history is the argument for it: three clauses of the adjudication order were unreachable for months, defined in prose, agreed to by everybody and fired by nothing, and only running an implementation against the suite found it. Prose review had already passed them.

## What counts as a change

Every proposal declares which of three kinds it is, and the kind decides the version rule in [VERSIONING.md](./VERSIONING.md).

**Editorial.** Wording, examples, rationale, a corrected cross reference, a non-normative section. No number moves. The test is mechanical: if an implementation could become conformant or non-conformant because of the edit, it is not editorial, whatever it looks like. Correcting a false entry in section 11 is editorial, and worth doing promptly, because a list of gaps rots first and is trusted most.

**Additive.** A new optional member, a new close condition, a new member of an open vocabulary, a conformance scenario a previously conformant implementation could already answer. A MINOR change. A receiver written against the previous minor must be able to ignore it, so a change that is additive on paper and mandatory in practice is not additive.

**Breaking.** Removing or renaming a member, making an optional member required, narrowing a type or a pattern, adding to a closed vocabulary (`Verdict`, `Ground`), or changing the adjudication order. A MAJOR change. Publishing into the schema a rule that previously reached implementers only as prose is breaking too, since a rule nobody could validate against constrained nobody.

## What a proposal must contain

1. **The defect, named.** What goes wrong today, with a case. "This could drift" is not a defect, and a proposal resting on one is closed.
2. **Which kind of change it is**, and the version consequence that follows from the section above.
3. **The normative text**, written as it would appear, not described.
4. **The schema change**, since the schemas are the contract and prose about them is prose. `.refine()` is banned package wide: a constraint `zod-to-json-schema` silently drops binds people who install the code and not people who validate against the schema, which is the opposite of who a specification is for. Shape the rule as a type, a pattern or a union.
5. **Evidence it works.** A running implementation that has done the thing, and what it produced.
6. **What it does not do.** A proposal with no stated limitation has not been thought about, and section 11 is where the answer eventually goes.

## Two specific requirements

**A change affecting the adjudication order ships with a test vector.** The order decides what "verified" means, it is the change most likely to be made accidentally while fixing something else, and since this version the document rather than `adjudicate()` is the authority for it. That inversion is only safe while agreement stays checkable, so a clause added, reordered or given a new ground arrives with its entry in `vectors/adjudication.json`, pinned to the reference adjudicator by a test. Without the vector, a second implementation learns that it disagrees only by being told.

**A new channel, anomaly kind or surface follows the naming rule in [EXTENSIONS.md](./EXTENSIONS.md) first.** Those vocabularies are open so that nobody needs this process to describe their own world: `x-<name>`, matching `^x-[a-z0-9-]+$`, a reverse DNS owner if it crosses an organisational boundary, independence declared and graded truthfully. Proposing `thermal` as a named member when `x-thermal` would do asks everyone else to carry your vocabulary. A name graduates only when two independent implementations use it with the same meaning, it is describable without knowing whether the subject is a page, a service or a robot, and a conformance scenario names it.

## Who decides, today

The author of this specification, who also sells an implementation of it. That is the strongest predictor there is of a specification that never gets a second implementation, not through malice but because the vendor is the only party in the room when an ambiguity is resolved. It is stated here because it is the weakest part of this process, not a footnote to it.

What would make it untrue is not a governance document. It is a second independent implementation reaching any profile, including `effect`, at which point there is a party whose interests differ from ours and a real disagreement to arbitrate. Donation to a neutral foundation is intended after that, not before.

Until then the mitigations are structural: the normative core is small on purpose, and the conformance suite ships with the reference implementation's own failures in it. A run of that suite in which an independent implementation is right and this one is wrong is the most valuable thing anybody can send us.

## A proposal nobody implements

It stays open, and it does not land. This is not a judgement about the idea: an unimplemented proposal is an untested one, and merging it makes every future implementer satisfy a rule nobody has ever satisfied. Such a proposal may instead be recorded in section 11 as something this version does not specify, reasoning kept, which is where the `locate()` entry sat until an implementation closed it: the honest place for a good idea with no evidence behind it yet.
