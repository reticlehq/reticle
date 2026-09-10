# @reticlehq/openreality

The specification Reticle implements, and the four verbs a realm has to answer.

**Read [SPEC.md](SPEC.md).** That is the specification; this file says what the package is.

## What is in the package

Very little on purpose: the four realm verbs as data, so code can enumerate them, and nothing else. It has no dependencies at all, because a contract that needs a library to read is a contract with a dependency somebody else has to accept.

## Where the normative part lives

The message shapes and event payloads are defined once, as schemas, in `@reticlehq/core`, and both ends of the connection are checked against them. They are NOT copied into the specification document: two definitions of one contract is the drift problem rather than the fix. SPEC.md points at them and explains what they mean, and a check in this repository fails if the document and the code stop agreeing about the message kinds, the verdicts or the protocol version.

## What this is not, yet

SPEC.md ends with the gaps, stated plainly: no required transport, no conformance suite you can run against your own realm, no version negotiation, and no way to discover which realms exist. Those are real, and listing them is the point -- somebody deciding whether to build on this deserves to know what they would be building on.
