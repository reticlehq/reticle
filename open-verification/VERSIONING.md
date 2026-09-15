# Versioning

How the protocol is numbered, what a number change may do, and what two implementations that disagree about a version do today.

**Normative keywords.** MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Four numbers, and what each one names

A reader who sees "version 1" here cannot otherwise tell which is meant. They are independent, and none may be inferred from another.

| Number | Where it lives | What it names |
| --- | --- | --- |
| **Protocol version** | `OVP_VERSION = '1.0'` (`src/vocabulary/run.ts`) | The specification an artifact was produced under. Stamped on a `VerificationRun`. |
| **Wire version** | SPEC §12, "the current wire protocol version is 1" | The framing of the four reference-transport messages, nothing else. §12 is non-normative, so it binds only implementations that chose that transport. |
| **Package version** | `open-verification` on npm, currently `3.0.0` | The TypeScript distribution: exported code, generated schemas, tests. Semver over the published JS API. |
| **Flow grammar version** | `OVP_FLOW_GRAMMAR_VERSION = 2` (`src/vocabulary/memory.ts`) | The Flow document grammar only, so a reader can tell "predates that field" from "omitted it". |

Package `3.0.0` carries protocol `1.0`, wire `1` and flow grammar `2`. The package has moved two majors while the protocol stayed at one, which is expected: a package major breaks the code an implementer imports, and most implementers import nothing. The schema `$id` base is `https://open-verification.dev/schema/v1`, and the `v1` there is the PROTOCOL major.

## Which artifact is authoritative for what

SPEC §0 says the schemas decide when prose disagrees. SPEC §7.1 says `adjudicate()` decides when an implementation disagrees. Two tiebreakers, two questions: **shape** (which members exist, their types, which values are permitted) is the schemas'; **decision** (which verdict and which ground a valid input produces) is the §7.1 clause order and `adjudicate()`. A schema-valid document can still be adjudicated wrongly, and a correct verdict over a malformed document proves nothing. If the two conflict on ONE question, that is a defect here and SHOULD be reported, not resolved locally.

## What a MINOR version MAY do

A MINOR change MUST be ignorable by a receiver written against the previous minor. It MAY add an optional member, a member of an open vocabulary (an `x-` channel, anomaly kind or surface, see [EXTENSIONS.md](./EXTENSIONS.md)), a close condition, non-normative prose, or a conformance scenario a previously conformant implementation could already answer.

It MUST NOT remove or rename a member, make an optional member required, narrow a type or a pattern, add a member to a closed vocabulary (`Verdict`, `Ground`), change the meaning of an existing member, or change the adjudication order.

`.refine()` is banned package-wide: `zod-to-json-schema` drops a refinement silently, so the rule would bind people who install the code and not people who validate against the published schema. Every constraint is a type, a pattern or a union and survives into `dist/schema/*.json`. The versioning consequence: a rule that reaches an implementer only as prose constrains nobody, so writing it down is MINOR and publishing it into the schema is MAJOR.

## What a MAJOR version MAY do

Anything a MINOR must not: change the adjudication order or the ground codes, which changes what "verified" means; remove a field; tighten a constraint; add a required field; remove an `x-` name that has graduated.

## The receiver rule

A receiver MUST ignore a member it does not recognise, MUST NOT fail on it, and MUST NOT treat its presence as evidence for or against anything. A receiver that forwards a document SHOULD preserve unrecognised members unchanged. The one exception is ambiguity, which MUST be rejected: see the receiver rule in EXTENSIONS.md.

## Absence is not negation

A capability, channel or optional declaration that is missing means NOBODY SAID, not `false`. An implementation MUST NOT read absence as a negative answer and MUST NOT synthesise a default for an absent declaration. `consequenceHeldBefore` is the worked example: `undefined` means nobody checked the before-state.

## Two versions meeting, today

There is no negotiation. SPEC §11 states it plainly: both ends assume version 1. Nothing in the wire, in `hello` or in a `VerificationRun` asks the other side what it speaks.

Until there is a version to negotiate, an implementation SHOULD stamp `ovp` on every run, and on reading a run whose protocol major it does not implement SHOULD refuse to adjudicate and say which version it read. It MUST NOT downgrade silently, and MUST NOT return `no` for a document it merely could not read: an unreadable artifact is `unknown`.

## A negotiation design, for a future version (non-normative)

This version does not define version negotiation. When one is defined, the shape that has worked elsewhere, notably in MCP, is: the initiator proposes a version in its first message; the responder answers with that version, or with the most recent one it does support; the initiator proceeds at the answered version or disconnects. Neither side guesses, neither proceeds at a version the other did not name, and a downgrade is a message rather than an inference. Here the first message is `hello`, so the proposal travels realm to decider.

## Support window

Protocol major 1 is the only major and the only one supported. When a major 2 exists, implementations SHOULD remain able to READ major 1 artifacts for at least twelve months after it is published; producing them is not required. Only the current package major is supported: a fix lands on the latest published package and is not backported to an earlier one.
